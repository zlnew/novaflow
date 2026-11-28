/**
 * Child-process worker for the concurrent `task start` race test.
 *
 * Usage: node --import tsx start-worker.ts <dbPath> <taskKey> <actor> [waitUntilMs]
 *
 * Prints exactly one JSON line on stdout and exits with the domain exit code, so
 * the parent test can assert a single winner and one `ALREADY_CLAIMED`.
 */
import { openDatabase } from '../../../src/store/db.js';
import { isNovaError } from '../../../src/store/errors.js';
import { startTask } from '../../../src/core/task.js';

const [dbPath, taskKey, actor, waitUntilRaw] = process.argv.slice(2);
const waitUntil = Number(waitUntilRaw ?? 0);

if (dbPath === undefined || taskKey === undefined || actor === undefined) {
  process.stderr.write('usage: start-worker.ts <dbPath> <taskKey> <actor> [waitUntilMs]\n');
  process.exit(2);
}

// Align both processes on the same wall-clock instant so the claim really races.
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < waitUntil) {
  Atomics.wait(sleeper, 0, 0, 2);
}

const db = openDatabase(dbPath);
try {
  const result = startTask(db, { id: taskKey, by: actor, lease_sec: 60 });
  process.stdout.write(
    `${JSON.stringify({ ok: true, key: result.task.key, status: result.task.status, claimed_by: result.task.claimed_by })}\n`,
  );
  process.exitCode = 0;
} catch (error) {
  const nova = isNovaError(error);
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: nova ? error.code : 'INTERNAL_ERROR',
      exitCode: nova ? error.exitCode : 1,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = nova ? error.exitCode : 1;
} finally {
  db.close();
}
