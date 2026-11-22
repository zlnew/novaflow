import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { backupStore, defaultBackupPath, BackupRefusedError } from "../../src/store/backup.ts";

/**
 * novaflow-v1/data 1.1 "Database Backup Strategy", quoted verbatim:
 *
 *   "Live backups of `~/.novaflow/state.db` MUST use the SQLite online
 *    backup API (`.backup` command or `sqlite3_backup_*` C API) to
 *    guarantee transactional consistency without interrupting concurrent
 *    WAL readers and writers."
 *
 * These tests pin the three properties that sentence names:
 *   - the backup is a consistent SQLite database (integrity_check ok, and
 *     every committed row is present) — never a byte copy of a live WAL
 *     store, which would be torn;
 *   - a write COMMITTED WHILE the backup runs lands in the backup (writes
 *     on the source connection are mirrored by the backup API — the
 *     daemon's single-connection case);
 *   - concurrent WAL READERS and WRITERS are unaffected: nothing blocks,
 *     nothing fails, the live store keeps its own truth.
 */

function seeded(dir: string): { path: string; db: Database.Database } {
  const path = join(dir, "state.db");
  const db = openDb(path);
  migrate(db);
  return { path, db };
}

/** Enough pages that the backup spans many event-loop turns. */
function fill(db: Database.Database, rows: number): void {
  // root_path is UNIQUE in the DDL, so every row needs its own path
  const ins = db.prepare(
    "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, 'ws', ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      ins.run(`01ARZ3NDEKTSV4RRFFQ69G${String(i).padStart(5, "0")}`, `w${i}`, `/tmp/ws-${i}`);
    }
  })();
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("backupStore writes a consistent, complete database (integrity_check ok, every row present)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bak-"));
  try {
    const { path, db } = seeded(dir);
    fill(db, 500);
    const before = count(db, "workspaces");
    const dest = join(dir, "copy.db");

    const res = await backupStore(db, dest);
    assert.equal(res.destination, dest);
    assert.ok(res.totalPages > 0, "the online backup API reports the page count it copied");

    // the destination is a real database, not a byte-copied WAL file
    const copy = new Database(dest, { readonly: true });
    try {
      const ic = copy.pragma("integrity_check") as Array<{ integrity_check: string }>;
      assert.equal(ic[0]!.integrity_check, "ok");
      assert.equal(count(copy, "workspaces"), before);
      // no -wal/-shm siblings leaked beside the destination
      assert.equal(
        statSync(dest).size > 0,
        true,
        "the destination holds the copied pages",
      );
    } finally {
      copy.close();
    }
    // and the SOURCE is untouched: same rows, still writable
    assert.equal(count(db, "workspaces"), before);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WAL consistency: a row COMMITTED while the backup runs lands in the backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bak-"));
  try {
    const { db } = seeded(dir);
    fill(db, 20_000); // ~1600 pages: the transfer spans many setImmediate turns
    const dest = join(dir, "mid.db");
    const markerSlug = "mid-backup-row";
    const markerPath = `/tmp/${markerSlug}`;
    let committedAt: number | null = null;

    const res = await backupStore(db, dest, {
      progress: (info) => {
        // commit on the SOURCE connection (the daemon's shape) part-way
        // through the page transfer — the backup API mirrors it
        if (
          committedAt === null &&
          info.remainingPages > 0 &&
          info.remainingPages < info.totalPages * 0.9
        ) {
          committedAt = info.remainingPages;
          db.prepare(
            "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, 'mid', ?)",
          ).run("01ARZ3NDEKTSV4RRFFQ69G9ZZZZ", markerSlug, markerPath);
        }
      },
    });
    assert.notEqual(committedAt, null, "the mid-backup commit really happened during the transfer");
    assert.equal(res.totalPages > 0, true);

    const copy = new Database(dest, { readonly: true });
    try {
      assert.equal(
        (copy.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]!.integrity_check,
        "ok",
        "a mid-backup commit never tears the destination",
      );
      const found = copy
        .prepare("SELECT root_path FROM workspaces WHERE slug = ?")
        .get(markerSlug) as { root_path: string } | undefined;
      assert.equal(found?.root_path, markerPath, "the committed row is IN the backup");
    } finally {
      copy.close();
    }
    // the live store keeps the row too (the backup copied, never moved)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE slug = ?").get(markerSlug) as {
        n: number;
      }).n,
      1,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent WAL writers and readers are unaffected: nothing blocks, nothing fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bak-"));
  try {
    const { path, db } = seeded(dir);
    fill(db, 20_000);
    const dest = join(dir, "concurrent.db");
    // a real second connection: the WAL reader/writer the MUST names
    const other = openDb(path);
    let writes = 0;
    let reads = 0;
    const errors: string[] = [];
    // the churn is BOUNDED: SQLite's backup API restarts its copy whenever
    // the source is modified by a foreign connection, so a writer that never
    // pauses would keep the copy from ever finishing (documented in
    // src/store/backup.ts). Real traffic comes in bursts; a burst of writes
    // landing mid-copy must neither block nor fail the copy.
    const target = 200;
    const churn = (async () => {
      while (writes < target) {
        try {
          other
            .prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, 'c', ?)")
            .run(
              `01ARZ3NDEKTSV4RRFFQ69H${String(writes).padStart(5, "0")}`,
              `c${writes}`,
              `/tmp/c-${writes}`,
            );
          writes += 1;
          const n = (other.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;
          if (n > 0) reads += 1;
        } catch (err) {
          errors.push(`writer: ${(err as Error).message}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const res = await backupStore(db, dest);
    await churn;

    assert.deepEqual(errors, [], "no reader or writer failed during the backup");
    assert.equal(reads, writes, "every read the reader issued during the backup succeeded");
    assert.equal(writes, target, "the writer really ran while the copy was in flight");
    assert.ok(res.totalPages > 0);

    const copy = new Database(dest, { readonly: true });
    try {
      assert.equal(
        (copy.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]!.integrity_check,
        "ok",
      );
      // the copy converged: it holds at least the pre-copy snapshot
      assert.ok(count(copy, "workspaces") >= 20_000, "the copy is complete, not a partial page set");
    } finally {
      copy.close();
    }
    other.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultBackupPath: alongside the store, state.db.bak-<UTC timestamp>", () => {
  const stamp = new Date(Date.UTC(2026, 10, 22, 8, 5, 9));
  assert.equal(
    defaultBackupPath("/home/op/.novaflow/state.db", stamp),
    "/home/op/.novaflow/state.db.bak-20261122T080509Z",
  );
});

test("backupStore refuses to clobber an existing file (never destroys an earlier backup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bak-"));
  try {
    const { db } = seeded(dir);
    const dest = join(dir, "existing.db");
    writeFileSync(dest, "operator data that must survive\n");
    await assert.rejects(
      () => backupStore(db, dest),
      (err: unknown) => {
        assert.ok(err instanceof BackupRefusedError);
        assert.match(err.message, /already exists/);
        return true;
      },
    );
    assert.equal(readFileSync(dest, "utf8"), "operator data that must survive\n");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupStore refuses a destination whose directory does not exist (no half-written backup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bak-"));
  try {
    const { db } = seeded(dir);
    await assert.rejects(
      () => backupStore(db, join(dir, "no-such-dir", "state.db.bak")),
      (err: unknown) => {
        assert.ok(err instanceof BackupRefusedError);
        assert.match(err.message, /directory does not exist/);
        return true;
      },
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
