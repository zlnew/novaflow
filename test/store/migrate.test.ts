import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDb } from "../../src/store/db.ts";
import { migrate, MIGRATIONS_DIR } from "../../src/store/migrate.ts";

test("openDb creates a WAL database with foreign keys enforced", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate applies migration 0001 and records filename + sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  const applied = migrate(db);
  assert.equal(applied, 1);
  const rows = db.prepare("SELECT filename, sha256 FROM schema_migrations").all() as Array<{
    filename: string;
    sha256: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.filename, "0001_init.sql");
  const sql = readFileSync(join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
  assert.equal(rows[0]?.sha256, createHash("sha256").update(sql).digest("hex"));
  const tables = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
    .get()?.["n"];
  assert.equal(tables, 12);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrate is idempotent and refuses a tampered applied migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-"));
  const db = openDb(join(dir, "state.db"));
  migrate(db);
  assert.equal(migrate(db), 0); // idempotent

  // A new unapplied file must block boot (the block-on-contract-mismatch rule).
  const sneaky = join(MIGRATIONS_DIR, "0002_sneaky.sql");
  writeFileSync(sneaky, "CREATE TABLE nope (a);");
  try {
    assert.throws(() => migrate(db));
  } finally {
    rmSync(sneaky);
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
