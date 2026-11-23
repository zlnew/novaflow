import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_DIR, applyPending, migrate, BootRefusedError } from "../../src/store/migrate.ts";

/**
 * The upgrade path (p1 review finding 1): migrate() refuses to boot on
 * version skew, so a shipped migration needs a sanctioned way to reach an
 * EXISTING store. These tests build a store at the 0001+0002 level and prove
 * `applyPending` walks it forward — and refuses tamper.
 */
function tempMigrations(level: 2 | 3): string {
  const dir = mkdtempSync(join(tmpdir(), `novaflow-mig-${process.pid}-`));
  const files = ["0001_init.sql", "0002_project_phase_log.sql", "0003_cache_tokens.sql"];
  for (const f of files.slice(0, level)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

test("applyPending walks an existing store from 0001+0002 to 0003 (the upgrade path)", () => {
  const at2 = tempMigrations(2);
  const dir = mkdtempSync(join(tmpdir(), "novaflow-upg-"));
  const dbPath = join(dir, "state.db");
  try {
    // a store as a v0.1 install left it
    const db = new Database(dbPath);
    migrate(db, { migrationsDir: at2 });
    const cols = (): string[] =>
      (db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(cols().includes("cache_read_tokens"), false, "precondition: v0.1 store has no cache columns");
    // the upgrade: nothing to apply yet under the old dir, then the real one
    assert.deepEqual(applyPending(db, { migrationsDir: at2 }).applied, []);
    const report = applyPending(db);
    assert.deepEqual(report.applied, ["0003_cache_tokens.sql"]);
    assert.ok(cols().includes("cache_read_tokens"));
    assert.ok(cols().includes("cache_write_tokens"));
    // recorded, and idempotent
    const rows = db.prepare("SELECT filename FROM schema_migrations ORDER BY filename").all() as Array<{ filename: string }>;
    assert.deepEqual(rows.map((r) => r.filename), ["0001_init.sql", "0002_project_phase_log.sql", "0003_cache_tokens.sql"]);
    assert.deepEqual(applyPending(db).applied, [], "a second run applies nothing");
    // and the store now BOOTS (migrate() sees full agreement)
    assert.equal(migrate(db), 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(at2, { recursive: true, force: true });
  }
});

test("applyPending refuses a TAMPERED applied migration (never upgrades past drift)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-upg2-"));
  const tampered = tempMigrations(2);
  const dbPath = join(dir, "state.db");
  try {
    const db = new Database(dbPath);
    migrate(db, { migrationsDir: tampered });
    // someone edits an already-applied file
    writeFileSync(join(tampered, "0002_project_phase_log.sql"), readFileSync(join(tampered, "0002_project_phase_log.sql"), "utf8") + "\n-- edited\n");
    assert.throws(() => applyPending(db, { migrationsDir: tampered }), (e: Error) => e instanceof BootRefusedError && /changed on disk/.test(e.message));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tampered, { recursive: true, force: true });
  }
});

test("applyPending on a FRESH store applies nothing (first boot is migrate()'s job)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-upg3-"));
  try {
    const db = new Database(join(dir, "fresh.db"));
    assert.deepEqual(applyPending(db), { applied: [], alreadyApplied: 0 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
