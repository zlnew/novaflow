import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { extractDdl } from "../helpers/spec.ts";

// The executable DDL is migration 0001 — the only place it lives.
const DDL_PATH = join(import.meta.dirname, "../../src/store/migrations/0001_init.sql");

test("golden: executable DDL (migration 0001) is byte-identical to the novaflow-v1/data sql block", () => {
  const onDisk = readFileSync(DDL_PATH, "utf8");
  assert.equal(onDisk, extractDdl());
});

test("golden: the DDL executes cleanly and creates the 12 normative tables", () => {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .map((r: { name: string }) => r.name);
  assert.deepEqual(tables, [
    "agent_profiles",
    "chain_runs",
    "project_targets",
    "projects",
    "schedules",
    "schema_migrations",
    "state_transition_logs",
    "task_edges",
    "task_runs",
    "task_target_scopes",
    "tasks",
    "workspaces",
  ]);
  db.close();
});

test("schema_migrations matches the novaflow-v1/data field reference", () => {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  const cols = db
    .prepare("PRAGMA table_info(schema_migrations)")
    .all()
    .map((r: { name: string; type: string }) => `${r.name}:${r.type}`);
  assert.deepEqual(cols, ["applied_at:TEXT", "filename:TEXT", "sha256:TEXT"]);
  db.close();
});
