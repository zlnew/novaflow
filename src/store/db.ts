/**
 * SQLite access for NovaFlow (`novaflow-v100/architecture` §6, §7).
 *
 * Uses the built-in `node:sqlite` driver: no native addon, no install scripts.
 * Every connection opens in WAL mode with `foreign_keys` on and a busy timeout,
 * and every schema upgrade runs inside `BEGIN IMMEDIATE`.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NovaError, toNovaError } from './errors.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

/** Pragma values asserted by the store tests. */
export const PRAGMA_SETTINGS = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  foreign_keys: 'ON',
  busy_timeout: 5000,
} as const;

/** Transaction nesting depth per connection; the outer level uses a real transaction. */
const transactionDepth = new WeakMap<DatabaseSync, number>();

export interface MigrationResult {
  /** Versions applied by this call, ascending. Empty when already current. */
  applied: number[];
  /** Schema version after the call. */
  version: number;
}

/** True while `withTx` holds a transaction (or savepoint) on this connection. */
export function isInTransaction(db: DatabaseSync): boolean {
  return (transactionDepth.get(db) ?? 0) > 0;
}

/** Highest applied migration recorded in `schema_migrations`; 0 when the table is absent. */
export function readSchemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | bigint | null }
    | undefined;
  return Number(row?.version ?? 0);
}

/** Opens (creating if needed) a database, applies pragmas, then pending migrations. */
export function openDatabase(file: string): DatabaseSync {
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      applyPragmas(db);
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  } catch (error) {
    throw toNovaError(error);
  }
}

function applyPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = ${PRAGMA_SETTINGS.journal_mode};`);
  db.exec(`PRAGMA synchronous = ${PRAGMA_SETTINGS.synchronous};`);
  db.exec(`PRAGMA foreign_keys = ${PRAGMA_SETTINGS.foreign_keys};`);
  db.exec(`PRAGMA busy_timeout = ${PRAGMA_SETTINGS.busy_timeout};`);
}

/**
 * Applies every migration newer than the recorded schema version.
 *
 * A database written by a newer binary is never touched: the caller gets
 * `SCHEMA_TOO_NEW` (exit 1) and is told to upgrade `novaflow` instead.
 */
export function migrate(db: DatabaseSync): MigrationResult {
  const current = readSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new NovaError(
      'SCHEMA_TOO_NEW',
      `Database schema version ${current} is newer than this binary supports (${LATEST_SCHEMA_VERSION}). Upgrade novaflow before using this workspace.`,
      { hint: 'Upgrade novaflow (npm install -g novaflow@latest) before using this workspace.' },
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  const applied: number[] = [];
  for (const migration of pending) {
    withTx(db, (tx) => {
      tx.exec(migration.sql);
      tx.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    applied.push(migration.version);
  }

  return { applied, version: readSchemaVersion(db) };
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE ... COMMIT`, rolling back on any throw.
 *
 * Nested calls become `SAVEPOINT`s so an inner failure can be caught without
 * discarding the caller's already-written work.
 */
export function withTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  const depth = transactionDepth.get(db) ?? 0;

  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
    transactionDepth.set(db, 1);
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed by SQLite; the original error wins.
      }
      throw error;
    } finally {
      transactionDepth.delete(db);
    }
  }

  const savepoint = `novaflow_sp_${depth}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn(db);
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } catch {
      // Savepoint already released; the original error wins.
    }
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}
