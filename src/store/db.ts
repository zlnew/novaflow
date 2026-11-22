import Database from "better-sqlite3";

/**
 * Opens the NovaFlow state store (novaflow-v1/data 1.1): SQLite in WAL mode
 * with foreign keys enforced. Synchronous per the SRS persistence constraint.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // data.md 1.1 storage-layer allocation: busy timeout 5000 ms
  db.pragma("busy_timeout = 5000");
  // data.md 1.1: synchronous = NORMAL (WAL's documented companion)
  db.pragma("synchronous = NORMAL");
  return db;
}

export type Db = Database.Database;
