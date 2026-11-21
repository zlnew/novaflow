import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * A seeded FILE store for daemon integration tests (the daemon opens
 * the same path; tests read/poll it through their own WAL connection).
 */

export const MODEL = "claude-3-5-sonnet-20241022";

export type SeededStore = {
  dbPath: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
};

export function seedFileStore(dir: string, slug = "ws"): SeededStore {
  const dbPath = join(dir, `store-${slug}.db`);
  const wsRoot = join(dir, `wsroot-${slug}`);
  mkdirSync(join(wsRoot, "prompts"), { recursive: true });
  mkdirSync(join(wsRoot, "docs"), { recursive: true });
  writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
  writeFileSync(join(wsRoot, "docs", "spec.md"), "# Spec\nImplement PKCE.\n");

  // the REAL boot path (openDb + migrate): the daemon's own migrate()
  // must find the store fully applied, never a version-skew refusal
  const db: Database.Database = openDb(dbPath);
  migrate(db);
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, 'ws', ?)").run(
    ulid(),
    slug,
    wsRoot,
  );
  const workspaceId = (db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug) as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects WHERE workspace_id = ?").get(workspaceId) as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, ?, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 3600, 5)`,
  ).run(ulid(), workspaceId, MODEL);
  const profileId = (db.prepare("SELECT id FROM agent_profiles WHERE name = 'dev'").get() as { id: string }).id;
  db.close();
  return { dbPath, wsRoot, workspaceId, projectId, profileId };
}

/** A second WAL connection onto the daemon's store (test-side reads). */
export function readConnection(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true });
}
