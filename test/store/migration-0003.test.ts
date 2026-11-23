import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate, MIGRATIONS_DIR } from "../../src/store/migrate.ts";

/**
 * novaflow-v02/spend.md — the cache-aware run-costing columns.
 *
 * The spec's novaflow-v1/data DDL block carries migration 0003's statements
 * verbatim (golden one-source rule, test/golden/ddl.test.ts); this file pins
 * the APPLIED shape: the two columns exist on task_runs, INTEGER, NOT NULL,
 * DEFAULT 0 — so a row written by earlier code is still valid and reports 0
 * cache tokens rather than NULL.
 */

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

test("migration 0003 applies and adds cache_read_tokens/cache_write_tokens (INTEGER NOT NULL DEFAULT 0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-mig0003-"));
  const db = openDb(join(dir, "state.db"));
  try {
    // 0001_init + 0002_project_phase_log + 0003_cache_tokens + 0004_worktree_root
    assert.equal(migrate(db), 4);

    const cols = db.prepare("PRAGMA table_info(task_runs)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ["cache_read_tokens", "cache_write_tokens"]) {
      const col = byName.get(name);
      assert.ok(col !== undefined, `task_runs is missing the ${name} column`);
      assert.equal(col.type, "INTEGER", `${name} must be INTEGER`);
      assert.equal(col.notnull, 1, `${name} must be NOT NULL`);
      assert.equal(col.dflt_value, "0", `${name} must DEFAULT 0`);
    }

    // the pre-existing token counters keep their shape (no drift on 0001)
    const input = byName.get("input_tokens");
    assert.ok(input !== undefined);
    assert.equal(input.type, "INTEGER");
    assert.equal(input.notnull, 1);
    assert.equal(input.dflt_value, "0");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 0003 holds exactly the spec's two ALTER statements (verbatim — never reformatted)", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, "0003_cache_tokens.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  assert.equal(
    statements,
    [
      "ALTER TABLE task_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE task_runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
    ].join("\n"),
  );
});

test("migration 0003 is recorded in schema_migrations (the legacy-row marker a reader compares against)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-mig0003-"));
  const db = openDb(join(dir, "state.db"));
  try {
    migrate(db);
    const row = db
      .prepare("SELECT filename, applied_at FROM schema_migrations WHERE filename = ?")
      .get("0003_cache_tokens.sql") as { filename: string; applied_at: string } | undefined;
    assert.ok(row !== undefined, "0003_cache_tokens.sql must be recorded");
    assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
