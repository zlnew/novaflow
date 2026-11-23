import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/store/db.ts";
import { openReadOnlyDb } from "../../src/store/readonly.ts";
import { migrate, MIGRATIONS_DIR } from "../../src/store/migrate.ts";

test("openDb creates a WAL database with foreign keys enforced", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate applies every migration in filename order and records filename + sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  const applied = migrate(db);
  assert.equal(applied, 3); // 0001_init + 0002_project_phase_log + 0003_cache_tokens
  const rows = db.prepare("SELECT filename, sha256 FROM schema_migrations").all() as Array<{
    filename: string;
    sha256: string;
  }>;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.filename, "0001_init.sql");
  assert.equal(rows[1]?.filename, "0002_project_phase_log.sql");
  assert.equal(rows[2]?.filename, "0003_cache_tokens.sql");
  for (const row of rows) {
    const sql = readFileSync(join(MIGRATIONS_DIR, row.filename), "utf8");
    assert.equal(row.sha256, createHash("sha256").update(sql).digest("hex"));
  }
  // 0001's twelve tables plus 0002's project_phase_logs (0003 ALTERs task_runs)
  const tables = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
    .get()?.["n"];
  assert.equal(tables, 13);
  // 0002 is a code-only surface: the spec DDL golden knows nothing of it
  // (documented divergence — the parent decides whether to amend the spec)
  const phaseLog = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_phase_logs'")
    .get();
  assert.ok(phaseLog);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate is idempotent and refuses a tampered applied migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  migrate(db);
  assert.equal(migrate(db), 0); // idempotent

  // A new unapplied file must block boot (the block-on-contract-mismatch rule).
  // DEBT-004: the probe file goes into a COPY of the migrations directory —
  // writing into the repo's own dir raced every concurrently running daemon
  // boot (they legitimately refused with "unapplied migration exists"), which
  // is what failed whole suite copies while each test passed alone.
  const copy = mkdtempSync(join(tmpdir(), "novaflow-migrations-"));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    copyFileSync(join(MIGRATIONS_DIR, name), join(copy, name));
  }
  try {
    writeFileSync(join(copy, "0003_sneaky.sql"), "CREATE TABLE nope (a);");
    assert.throws(() => migrate(db, { migrationsDir: copy }));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("openDb applies the data.md 1.1 storage-layer pragmas (WAL, FK, busy_timeout 5000, synchronous NORMAL)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-pragmas-"));
  const dbPath = join(dir, "state.db");
  try {
    const db = openDb(dbPath);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
    // data.md 1.1 pins FOUR settings; synchronous NORMAL is the fourth
    // (judge A finding 1 — the first sweep pass pinned only three)
    assert.equal(db.pragma("synchronous", { simple: true }), 1);
    db.close();
    // the read-only handle carries the same busy timeout (data.md 1.1)
    const ro = openReadOnlyDb(dbPath);
    assert.equal(ro.pragma("busy_timeout", { simple: true }), 5000);
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
