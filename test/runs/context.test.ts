import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import {
  buildEngineContext,
  writeEngineContext,
  type EngineContext,
} from "../../src/runs/context.ts";

function seededDb() {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/ws')",
  ).run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run(ulid(), projectId, profileId);
  const taskId = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
  return { db, taskId, projectId };
}

const BUDGET = { max_timeout_sec: 60, max_cost_usd: 1.5 };

test("buildEngineContext: no target scopes → empty structures, null inline schema", () => {
  const { db, taskId } = seededDb();
  try {
    const ctx = buildEngineContext(db, { id: taskId, output_schema_version: "1.0.0" }, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "execution", BUDGET);
    assert.deepEqual(ctx.scopes, []);
    assert.deepEqual(ctx.verification_commands, []);
    assert.equal(ctx.task_id, taskId);
    assert.equal(ctx.run_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(ctx.attempt_kind, "execution");
    // the task's output_schema_version is the id; no inline schema file is
    // configured anywhere in the v1 data model → carry null plus the version
    assert.deepEqual(ctx.output_schema, { id: "1.0.0", inline: null });
    assert.deepEqual(ctx.budget, BUDGET);
  } finally {
    db.close();
  }
});

test("buildEngineContext: scopes carry write/protected globs per target; verification_commands union in order", () => {
  const { db, taskId, projectId } = seededDb();
  try {
    const t1 = ulid();
    const t2 = ulid();
    db.prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'app', 'git_repo', '/repo/app')",
    ).run(t1, projectId);
    db.prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'docs', 'directory', '/repo/docs')",
    ).run(t2, projectId);
    db.prepare(
      `INSERT INTO task_target_scopes
         (id, task_id, target_id, access_mode, write_scope_globs_json, protected_test_globs_json, verification_commands_json)
       VALUES (?, ?, ?, 'read_write', '["src/**"]', '["tests/**"]', '["npm test", "npm run typecheck"]')`,
    ).run(ulid(), taskId, t1);
    db.prepare(
      `INSERT INTO task_target_scopes
         (id, task_id, target_id, access_mode, write_scope_globs_json, protected_test_globs_json, verification_commands_json)
       VALUES (?, ?, ?, 'read_only', '["**/*"]', '[]', '["npm test", "lint docs"]')`,
    ).run(ulid(), taskId, t2);

    const ctx = buildEngineContext(db, { id: taskId, output_schema_version: "1.0.0" }, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "repair", BUDGET);
    assert.equal(ctx.attempt_kind, "repair");
    assert.deepEqual(ctx.scopes, [
      {
        target_id: t1,
        alias: "app",
        access_mode: "read_write",
        write_scope_globs: ["src/**"],
        protected_test_globs: ["tests/**"],
      },
      {
        target_id: t2,
        alias: "docs",
        access_mode: "read_only",
        write_scope_globs: ["**/*"],
        protected_test_globs: [],
      },
    ]);
    // union across scopes, first-seen order, deduped
    assert.deepEqual(ctx.verification_commands, ["npm test", "npm run typecheck", "lint docs"]);
  } finally {
    db.close();
  }
});

test("writeEngineContext writes engine-context.json into the run dir and round-trips", () => {
  const { db, taskId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-ctx-"));
  try {
    const ctx: EngineContext = buildEngineContext(db, { id: taskId, output_schema_version: "1.0.0" }, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "execution", BUDGET);
    const path = writeEngineContext(dir, ctx);
    assert.equal(path, join(dir, "engine-context.json"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ctx);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
