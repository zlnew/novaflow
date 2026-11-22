import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "./store/db.ts";
import { ulid } from "./store/ids.ts";

/**
 * Workspace provisioning service (srs FR-WS-01/02/03; data.md DDL).
 *
 * The daemon's workspace ops (src/daemon/server.ts) are the single
 * writer: they validate the request shape and call this module for
 * every store + filesystem effect.
 *
 * Spec-silent choices (documented):
 *   - Name discipline: FR-WS-01 says "unique alphanumeric name"; data.md
 *     5.1 pins identifiers to lower-case kebab-case. This module enforces
 *     `^[a-z0-9-]+$` and uses the name AS the slug (slug = name), so the
 *     unique-name constraint and the UNIQUE slug column are the same rule.
 *   - The FR-WS-02 "exactly" list wins over architecture 7.2's tree: the
 *     scaffold creates `.novaflow/{profiles,prompts,projects,worktrees,
 *     runs,schemas}`, `workspace.json` in `.novaflow/`, and `docs/` at
 *     the root — and NOTHING else. 7.2 also shows `.novaflow/config.yaml`
 *     (data 4.4), which is deliberately NOT scaffolded: the workspace
 *     config loader treats a missing file as defaults, so the "exactly"
 *     list stays exact.
 *   - `workspace.json` shape: `{id, name, created_at}` — the card's
 *     documented minimum. Bare ULID id (data 5.1 stored id form).
 *   - Unregister removes only the DB row (FR-WS-03 AC1). A workspace
 *     that still has tasks is refused by the store's own FK guard
 *     (tasks.profile_id ON DELETE RESTRICT) — honest v1 behavior, no
 *     task-delete surface exists yet.
 */

/** data.md 5.1: identifiers are lower-case kebab-case. */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9-]+$/;

/** FR-WS-02's exact directory list (all under `.novaflow/`). */
export const WORKSPACE_LAYOUT_DIRS = [
  "profiles",
  "prompts",
  "projects",
  "worktrees",
  "runs",
  "schemas",
] as const;

export type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  root_path: string;
  description: string | null;
  default_branch: string;
  status: string;
  created_at: string;
  updated_at: string;
};

/** FR-WS-02: scaffold the exact canonical layout at the workspace root. */
export function scaffoldWorkspaceLayout(
  rootPath: string,
  meta: { id: string; name: string; created_at: string },
): void {
  const nf = join(rootPath, ".novaflow");
  mkdirSync(nf);
  for (const dir of WORKSPACE_LAYOUT_DIRS) {
    mkdirSync(join(nf, dir));
  }
  mkdirSync(join(rootPath, "docs"));
  writeFileSync(
    join(nf, "workspace.json"),
    JSON.stringify({ id: meta.id, name: meta.name, created_at: meta.created_at }, null, 2) + "\n",
  );
}

export function getWorkspace(db: Db, id: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
}

/**
 * Insert the registry row after scaffolding the layout. Callers
 * pre-validate (name pattern, unique slug, unique root, writable root)
 * — the daemon is the single writer, so the insert cannot race a
 * second creator.
 */
export function createWorkspace(
  db: Db,
  input: { name: string; rootPath: string; defaultBranch: string },
): WorkspaceRow {
  const id = ulid();
  const createdAt = new Date().toISOString();
  scaffoldWorkspaceLayout(input.rootPath, { id, name: input.name, created_at: createdAt });
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, root_path, default_branch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.name, input.rootPath, input.defaultBranch);
  const row = getWorkspace(db, id);
  if (!row) throw new Error(`created workspace ${id} is missing from the store`);
  return row;
}

export function listWorkspaces(db: Db): WorkspaceRow[] {
  return db.prepare("SELECT * FROM workspaces ORDER BY created_at, id").all() as WorkspaceRow[];
}

/**
 * FR-WS-03 AC2: archiving disables task execution. The status write is
 * this module's; the enforcement is dispatch's candidate selection
 * (`w.status = 'active'`). Logs stay read-only — reads are reads.
 */
export function setWorkspaceStatus(db: Db, id: string, status: "active" | "archived" | "disabled"): void {
  db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    id,
  );
}

/**
 * FR-WS-03 AC1: unregistering removes the DB entry and NEVER touches
 * files. Cascades (DDL) remove the workspace's projects, profiles, and
 * schedules; the RESTRICT guard on tasks.profile_id refuses the delete
 * while tasks still reference a profile.
 */
export function deleteWorkspace(db: Db, id: string): void {
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

/**
 * Resolve the op arg shape `{workspace_id} | {slug}` to a row. Returns
 * undefined when neither names a workspace.
 */
export function resolveWorkspaceArg(
  db: Db,
  arg: { workspace_id?: unknown; slug?: unknown },
): WorkspaceRow | undefined {
  if (typeof arg.workspace_id === "string" && arg.workspace_id !== "") {
    return getWorkspace(db, arg.workspace_id);
  }
  if (typeof arg.slug === "string" && arg.slug !== "") {
    return db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(arg.slug) as WorkspaceRow | undefined;
  }
  return undefined;
}

/** True when rootPath is an existing, writable directory (FR-WS-01 AC1). */
export function isWritableDirectory(rootPath: string): boolean {
  try {
    if (!statSync(rootPath).isDirectory()) return false;
    accessSync(rootPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The canonical `.novaflow` dir under a workspace root. */
export function novaflowDir(rootPath: string): string {
  return join(resolve(rootPath), ".novaflow");
}
