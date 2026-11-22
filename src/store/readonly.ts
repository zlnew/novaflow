import Database from "better-sqlite3";
import { existsSync } from "node:fs";

/**
 * A READ-ONLY store handle for the MCP server's daemon-down path
 * (mcp.md §4: "read-only tools serve from the SQLite store directly").
 *
 * Why not `openDb` (src/store/db.ts): that opener is the DAEMON's —
 * it sets `journal_mode = WAL` and takes write locks. A surface that is
 * not allowed to write must not open a writable handle, and the
 * grep-level discipline test pins that src/mcp never calls it.
 *
 * WAL concurrent-read is safe: a reader sees the last committed state
 * with the writer live or gone (verified: a crashed writer's leftover
 * `-wal`/`-shm` still reads correctly). `fileMustExist` is the honesty
 * rule — a missing store is NOT an empty store, and this function must
 * never create one (a read may not leave a file behind).
 */
export type ReadOnlyDb = Database.Database;

/**
 * Open the store read-only. Throws the driver's error when the file is
 * missing (the caller maps that to `not_found`, never to a fresh store).
 */
export function openReadOnlyDb(path: string): ReadOnlyDb {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // The reader honors the writer's WAL; setting the pragma on a read-only
  // handle is a no-op the driver accepts. Guarded anyway: a store that
  // predates the migration would refuse, and the caller reports it.
  try {
    // data.md 1.1: the same 5000 ms busy timeout on the read-only handle
    db.pragma("busy_timeout = 5000");
  } catch {
    // a pragma failure is not a read failure — the query below decides
  }
  return db;
}

/** Whether a store file exists at all (the pre-flight for the fallback). */
export function storeExists(path: string): boolean {
  return existsSync(path);
}
