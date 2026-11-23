import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export class BootRefusedError extends Error {}

/**
 * The migration root is INJECTABLE (default: the shipped directory).
 *
 * Why the seam exists (DEBT-004's actual root cause): `migrate()` reads
 * `MIGRATIONS_DIR`, which lives inside the repository. A test that proved
 * the block-on-contract-mismatch rule by writing a temporary
 * `0002_sneaky.sql` INTO that directory raced every other test file's
 * daemon boot — those boots legitimately refused with "unapplied migration
 * exists" while the file was present, so a whole concurrent suite copy
 * failed while each test passed in isolation. The fix is not a longer wait:
 * it is to let a caller point `migrate` at a COPY of the migrations, so no
 * test ever mutates state that another test reads. Production passes
 * nothing and behaves exactly as before.
 */
export type MigrateOptions = {
  /** Directory holding the `*.sql` migration files (default MIGRATIONS_DIR). */
  migrationsDir?: string | undefined;
};

/**
 * Plain SQL files applied in filename order, one row per file
 * (novaflow-v1/data, SCHEMA MIGRATIONS section).
 *
 * First boot (no schema_migrations table): every file applies in order —
 * migration 0001 creates the table itself.
 *
 * Subsequent boots: every file must already be applied with a matching
 * sha256. An unapplied file (version skew) or a changed file (tamper) means
 * the store refuses to boot — the block-on-contract-mismatch rule.
 * Returns the number of migrations applied.
 */
export function migrate(db: Db, opts: MigrateOptions = {}): number {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();

  if (tableExists) {
    const applied = new Map(
      (
        db
          .prepare("SELECT filename, sha256 FROM schema_migrations")
          .all() as Array<{ filename: string; sha256: string }>
      ).map((r) => [r.filename, r.sha256]),
    );
    for (const filename of files) {
      const sha256 = sha256Of(join(migrationsDir, filename));
      const recorded = applied.get(filename);
      if (recorded === undefined) {
        throw new BootRefusedError(
          `unapplied migration exists: ${filename} — refusing to boot (version skew)`,
        );
      }
      if (recorded !== sha256) {
        throw new BootRefusedError(
          `applied migration ${filename} changed on disk — refusing to boot`,
        );
      }
    }
    return 0;
  }

  // First boot: apply everything in filename order.
  for (const filename of files) {
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)",
    ).run(filename, sha256Of(join(migrationsDir, filename)));
  }
  return files.length;
}

/** What `applyPending` did, for the CLI to print. */
export type UpgradeReport = {
  applied: string[];
  alreadyApplied: number;
};

/**
 * THE UPGRADE PATH (`nova daemon migrate`, p1 review finding 1).
 *
 * `migrate()` deliberately refuses to boot on version skew — but adding a
 * migration to a shipped engine then leaves every existing store with no
 * sanctioned way forward. This function is that way, and it is the ONLY
 * writer of `schema_migrations` outside first boot:
 *
 *   - every already-recorded file must still hash identically (a changed
 *     file is tamper, refused);
 *   - every unrecorded file applies in filename order, each inside the
 *     same transaction, recording its sha256;
 *   - a partial failure rolls the whole upgrade back (SQLite DDL is
 *     transactional) — a half-migrated store is never left behind.
 *
 * It requires exclusive access, so the caller must have stopped the daemon
 * (the CLI verb refuses when the socket answers).
 */
export function applyPending(db: Db, opts: MigrateOptions = {}): UpgradeReport {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!tableExists) {
    // nothing to upgrade — a fresh store is migrate()'s first-boot job
    return { applied: [], alreadyApplied: 0 };
  }

  const applied = new Map(
    (
      db.prepare("SELECT filename, sha256 FROM schema_migrations").all() as Array<{
        filename: string;
        sha256: string;
      }>
    ).map((r) => [r.filename, r.sha256]),
  );

  // drift first: a changed file must never be "upgraded past"
  for (const [filename, recordedSha] of applied) {
    if (!files.includes(filename)) continue; // file removed: tolerated (nothing to apply)
    const sha = sha256Of(join(migrationsDir, filename));
    if (sha !== recordedSha) {
      throw new BootRefusedError(
        `applied migration ${filename} changed on disk — refusing to upgrade (tamper)`,
      );
    }
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return { applied: [], alreadyApplied: applied.size };

  const run = db.transaction(() => {
    for (const filename of pending) {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)").run(
        filename,
        sha256Of(join(migrationsDir, filename)),
      );
    }
  });
  run();
  return { applied: pending, alreadyApplied: applied.size };
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
