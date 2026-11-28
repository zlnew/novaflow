/**
 * Child-process worker for the concurrent `task create` key-allocation test.
 *
 * Usage: node --import tsx create-worker.ts <dbPath> <project> <title> [waitUntilMs]
 *
 * Proves `PREFIX-N` allocation is serialized by `BEGIN IMMEDIATE`: no duplicate
 * keys, no gaps from the same batch.
 */
import { openDatabase } from '../../../src/store/db.js';
import { isNovaError } from '../../../src/store/errors.js';
import { createTask } from '../../../src/core/task.js';

const [dbPath, project, title, waitUntilRaw] = process.argv.slice(2);
const waitUntil = Number(waitUntilRaw ?? 0);

if (dbPath === undefined || project === undefined || title === undefined) {
  process.stderr.write('usage: create-worker.ts <dbPath> <project> <title> [waitUntilMs]\n');
  process.exit(2);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < waitUntil) {
  Atomics.wait(sleeper, 0, 0, 2);
}

const db = openDatabase(dbPath);
try {
  const result = createTask(db, { project, title, env: {} });
  process.stdout.write(`${JSON.stringify({ ok: true, key: result.task.key, seq: result.task.seq })}\n`);
  process.exitCode = 0;
} catch (error) {
  const nova = isNovaError(error);
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: nova ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = nova ? error.exitCode : 1;
} finally {
  db.close();
}
