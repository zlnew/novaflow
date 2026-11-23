import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate, MIGRATIONS_DIR } from "../../src/store/migrate.ts";

/**
 * novaflow-v030/readme W1 R1.3 (amendments row 1) — migration 0004:
 * `task_runs.worktree_root TEXT NULL`. The novaflow-v1/data DDL block
 * carries the statement verbatim (golden one-source rule,
 * test/golden/ddl.test.ts); this file pins the APPLIED shape and the NULL
 * rule the field reference states: NULL means the run executed in place.
 */

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

test("migration 0004 applies and adds a NULLABLE TEXT worktree_root", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-mig0004-"));
  const db = openDb(join(dir, "state.db"));
  try {
    // 0001_init + 0002_project_phase_log + 0003_cache_tokens + 0004_worktree_root
    assert.equal(migrate(db), 4);

    const cols = db.prepare("PRAGMA table_info(task_runs)").all() as ColumnInfo[];
    const col = new Map(cols.map((c) => [c.name, c])).get("worktree_root");
    assert.ok(col !== undefined, "task_runs is missing the worktree_root column");
    assert.equal(col.type, "TEXT");
    assert.equal(col.notnull, 0, "worktree_root must be NULLABLE (in-place runs)");
    assert.equal(col.dflt_value, null, "no DEFAULT — NULL is the meaningful value");

    // the cache columns from 0003 keep their shape (no drift on an earlier ALTER)
    const cache = new Map(cols.map((c) => [c.name, c])).get("cache_read_tokens");
    assert.ok(cache !== undefined);
    assert.equal(cache.notnull, 1);
    assert.equal(cache.dflt_value, "0");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old rows read worktree_root back as NULL (in place, never invented)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-mig0004b-"));
  const db = openDb(join(dir, "state.db"));
  try {
    migrate(db);
    db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES ('w1', 'w', 'w', '/tmp/w')").run();
    db.prepare(
      "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES ('p1', 'w1', 'p', 'p', 'o')",
    ).run();
    db.prepare(
      `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
       VALUES ('a1', NULL, 'dev', 'anthropic', 'm', 'p.md')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
       VALUES ('t1', 'p1', 'T-1', 't', 'o', 'a1')`,
    ).run();
    // a row written with no worktree_root value at all: the pre-0004 shape
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, pi_session_id, pi_session_dir, model_used, events_log_path)
       VALUES ('r1', 't1', 1, 'r1', '/tmp/r1', 'm', '/tmp/r1/events.jsonl')`,
    ).run();
    const row = db.prepare("SELECT worktree_root FROM task_runs WHERE id = 'r1'").get() as {
      worktree_root: string | null;
    };
    assert.equal(row.worktree_root, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 0004 holds exactly the spec's one ALTER statement (verbatim — never reformatted)", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, "0004_worktree_root.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  assert.equal(statements, "ALTER TABLE task_runs ADD COLUMN worktree_root TEXT NULL;");
});
