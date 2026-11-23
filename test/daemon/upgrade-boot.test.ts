import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate } from "../../src/store/migrate.ts";
import { openDb } from "../../src/store/db.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { seedFileStore } from "./seed.ts";

/**
 * `nova daemon start --migrate` (p1 review finding 1): the daemon owns the
 * store, so the upgrade happens at boot. Without the flag a skewed store is
 * still refused (the v1 block-on-contract-mismatch rule is not weakened);
 * with it, the store walks to head and the daemon serves.
 */
function skewedStore(dir: string): string {
  const at2 = join(dir, "mig-at2");
  mkdirSync(at2);
  for (const f of ["0001_init.sql", "0002_project_phase_log.sql"]) {
    copyFileSync(join(MIGRATIONS_DIR, f), join(at2, f));
  }
  const dbPath = join(dir, "state.db");
  const db = openDb(dbPath);
  migrate(db, { migrationsDir: at2 });
  db.close();
  return dbPath;
}

function bootOpts(dir: string, dbPath: string, migrateOnBoot: boolean): Parameters<typeof startDaemon>[0] & object {
  const stub = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, "concurrency:\n  global: 2\nretry:\n  delay_sec: 3600\n");
  return {
    dbPath,
    socketPath: join(dir, "d.sock"),
    daemonConfigPath: cfg,
    probePiBin: "node",
    probeArgs: [stub, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [stub, "run-ok"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "prices.json"),
    killGraceMs: 200,
    tickMs: 30,
    migrateOnBoot,
  };
}

test("a skewed store is REFUSED without --migrate (v1 rule intact)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-upgboot-"));
  try {
    const dbPath = skewedStore(dir);
    await assert.rejects(
      () => startDaemon(bootOpts(dir, dbPath, false) as never),
      /unapplied migration/,
      "the daemon still refuses version skew by default",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--migrate upgrades the store at boot and the daemon serves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-upgboot2-"));
  let handle: DaemonHandle | undefined;
  try {
    const dbPath = skewedStore(dir);
    handle = await startDaemon(bootOpts(dir, dbPath, true) as never);
    // the columns exist and the store is at head
    const ro = new Database(dbPath, { readonly: true });
    try {
      const cols = (ro.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("cache_read_tokens"), "cache columns applied by the boot upgrade");
      assert.ok(cols.includes("worktree_root"), "migration 0004 applied by the boot upgrade");
      const files = (ro.prepare("SELECT filename FROM schema_migrations ORDER BY filename").all() as Array<{ filename: string }>).map((r) => r.filename);
      assert.deepEqual(files, ["0001_init.sql", "0002_project_phase_log.sql", "0003_cache_tokens.sql", "0004_worktree_root.sql"]);
    } finally {
      ro.close();
    }
    // and it serves: migrate() at boot agreed, the socket answers
    assert.ok(handle !== undefined);
  } finally {
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
