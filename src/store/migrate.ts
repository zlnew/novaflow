import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export class BootRefusedError extends Error {}

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
export function migrate(db: Db): number {
  const files = readdirSync(MIGRATIONS_DIR)
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
      const sha256 = sha256Of(join(MIGRATIONS_DIR, filename));
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
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)",
    ).run(filename, sha256Of(join(MIGRATIONS_DIR, filename)));
  }
  return files.length;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
