import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { extractDdl } from "../helpers/spec.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate, MIGRATIONS_DIR } from "../../src/store/migrate.ts";

const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Strip `--` comment lines so an immutable migration's historical comments
 *  never mask drift against the spec block (comment-stripped comparison). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

test("golden: every migration's SQL appears verbatim in the novaflow-v1/data sql block (one source)", () => {
  // Contract since the p3b spec amendment: the spec block is the FULL
  // normative schema; migrations are ordered deltas of it. Each migration's
  // statements must be a verbatim (comment-stripped) part of the block.
  const block = stripComments(extractDdl());
  for (const f of MIGRATIONS) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    assert.ok(
      block.includes(sql),
      `migration ${f} drifted from the novaflow-v1/data DDL block`,
    );
  }
});

test("golden: the spec DDL executes cleanly and creates the 13 normative tables", () => {
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
    "project_phase_logs",
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

test("golden: a migrated store's table set equals the spec DDL block's table set", () => {
  const db = openDb(":memory:");
  migrate(db);
  const applied = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const block = extractDdl();
  const specTables = [...block.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(applied, [...new Set(specTables)].sort());
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
