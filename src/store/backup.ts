import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Db } from "./db.ts";

/**
 * Live store backup (novaflow-v1/data 1.1, "Database Backup Strategy"),
 * quoted verbatim:
 *
 *   "Live backups of `~/.novaflow/state.db` MUST use the SQLite online
 *    backup API (`.backup` command or `sqlite3_backup_*` C API) to
 *    guarantee transactional consistency without interrupting concurrent
 *    WAL readers and writers."
 *
 * better-sqlite3's `db.backup(destinationFile)` IS that API: it drives
 * `sqlite3_backup_*` page by page, restoring the source's snapshot while
 * the source keeps serving readers and writers. A file copy of a live WAL
 * store is NOT equivalent — the `-wal` file holds committed frames that a
 * plain `cp` of `state.db` misses, so the copy is torn. This module is the
 * only sanctioned backup path; the daemon op and the CLI verb both call it,
 * and the CLI never opens the store (the daemon owns it).
 *
 * Spec-silent choices (documented, minimal-convention readings):
 *   - the default destination sits ALONGSIDE the store:
 *     `<store dir>/state.db.bak-<YYYYMMDDTHHMMSSZ>` (UTC, second
 *     precision, sortable; the same canonical-timestamp discipline the
 *     scheduler uses). Not a retention system — backups are the
 *     operator's files.
 *   - an EXISTING destination is refused (`BackupRefusedError`): the
 *     online API would overwrite its pages page by page, i.e. a second
 *     run inside the same second would destroy the first backup. Refusing
 *     is the only behavior that never loses an earlier backup.
 *   - a missing destination DIRECTORY is refused before the API runs (the
 *     backup API itself would throw a TypeError; a typed refusal names the
 *     path the operator got wrong).
 *   - the copy is left at mode 0600: a state store is operator-private
 *     (same posture as the socket, security TB-1).
 *
 * CONCURRENCY SEMANTICS (measured on this box, documented because it
 * bounds what "consistent" can promise): SQLite's backup API copies page
 * batches in setImmediate-sized steps; when a FOREIGN connection (a second
 * handle on the same file) commits while the copy is in flight, the API
 * restarts the batch so the copy reflects the newest committed snapshot —
 * `progress.remainingPages` jumps back up. The run therefore always ends
 * with a consistent, transactionally-valid copy, and a foreign burst of
 * writes delays it (never fails it). A foreign writer that commits without
 * pausing prevents the copy from ever converging; the fix is on the caller
 * side (bound the churn, or take the backup while traffic pauses). The
 * daemon's OWN connection is exempt from the restart — writes committed on
 * the handle that owns the backup are mirrored into the copy as they land,
 * which is the semantic the p7 tests pin (a mid-backup committed row is IN
 * the backup).
 */

/** A refusal that is the operator's input, not a store failure. */
export class BackupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupRefusedError";
  }
}

export type BackupResult = {
  destination: string;
  /** Pages in the source snapshot at the end of the copy. */
  totalPages: number;
  /** Always 0 on success (the API finished the transfer). */
  remainingPages: number;
};

export type BackupOptions = {
  /**
   * Per-batch progress hook, passed straight to the online backup API.
   * Tests use it to commit a row mid-transfer; the daemon passes nothing.
   */
  progress?: ((info: { totalPages: number; remainingPages: number }) => number | void) | undefined;
};

/** `<dir>/state.db.bak-<YYYYMMDDTHHMMSSZ>` — the documented default. */
export function defaultBackupPath(storePath: string, now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-11-22T08:05:09.123Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return join(dirname(resolve(storePath)), `${resolve(storePath).split("/").pop()}.bak-${stamp}`);
}

/**
 * Copy the live store to `destination` through the SQLite online backup
 * API. Concurrent WAL readers and writers keep running throughout.
 */
export async function backupStore(
  db: Db,
  destination: string,
  opts: BackupOptions = {},
): Promise<BackupResult> {
  const dest = resolve(destination);
  const parent = dirname(dest);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new BackupRefusedError(
      `backup destination directory does not exist: ${parent} — create it or pick another --out path`,
    );
  }
  if (existsSync(dest)) {
    throw new BackupRefusedError(
      `backup destination already exists: ${dest} — refusing to overwrite an earlier backup`,
    );
  }
  const progress = opts.progress;
  const meta = await db.backup(
    dest,
    progress === undefined
      ? undefined
      : { progress: (info) => progress(info) ?? undefined as never },
  );
  return {
    destination: dest,
    totalPages: meta.totalPages,
    remainingPages: meta.remainingPages,
  };
}
