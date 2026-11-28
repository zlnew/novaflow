/**
 * Mutating core operations run here so `--dry-run` can never persist anything
 * (`novaflow-v100/cli` §2, `novaflow-v100/testing` CLI Contract).
 *
 * A dry run executes the exact same code path inside a real transaction and
 * then throws a private sentinel, so `BEGIN IMMEDIATE` rolls the whole thing
 * back: validation, sequencing, and event emission all happen, nothing stays.
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTx } from '../store/db.js';
import { NovaError } from './errors.js';

class DryRunRollback {
  constructor(readonly value: unknown) {}
}

/**
 * Runs `fn` in `BEGIN IMMEDIATE ... COMMIT`, or in a rolled-back transaction
 * when `dryRun` is set. Either way `fn` sees the same transactional database.
 */
export function runMutation<T>(db: DatabaseSync, dryRun: boolean, fn: (db: DatabaseSync) => T): T {
  if (!dryRun) return withTx(db, fn);

  try {
    withTx(db, (tx) => {
      throw new DryRunRollback(fn(tx));
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.value as T;
    throw error;
  }

  throw new NovaError('INTERNAL_ERROR', 'dry-run transaction did not roll back.');
}
