import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { listEvents } from '../../src/core/events.js';
import { getTaskStatus, startTask } from '../../src/core/task.js';
import type { CoreSandbox } from './helpers.js';
import { expectNovaError, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();
const WORKER = fileURLToPath(new URL('./fixtures/start-worker.ts', import.meta.url));
const CREATE_WORKER = fileURLToPath(new URL('./fixtures/create-worker.ts', import.meta.url));

interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runWorker(box: CoreSandbox, args: string[], script: string = WORKER): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, box.dbPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: box.box.home,
        XDG_CONFIG_HOME: box.box.xdg,
        NOVAFLOW_HOME: box.env.NOVAFLOW_HOME ?? box.box.home,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('core/fsm lease concurrency', () => {
  it('gives exactly one winner and one ALREADY_CLAIMED when two processes race task start', async () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    const startAt = String(Date.now() + 700);
    const [first, second] = await Promise.all([
      runWorker(box, [task.key, 'agent-a', startAt]),
      runWorker(box, [task.key, 'agent-b', startAt]),
    ]);

    const results = [first, second].map((worker) => {
      assert.equal(worker.stderr, '', `child wrote to stderr: ${worker.stderr}`);
      const lines = worker.stdout.trim().split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1, `expected one JSON line, got ${worker.stdout}`);
      return JSON.parse(lines[0] as string) as { ok: boolean; claimed_by?: string; code?: string; exitCode?: number };
    });

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0]?.code, 'ALREADY_CLAIMED');
    assert.equal(losers[0]?.exitCode, 3);

    const winnerIndex = results.findIndex((result) => result.ok);
    const winnerWorker = [first, second][winnerIndex] as WorkerResult;
    assert.equal(winnerWorker.code, 0);
    const loserWorker = [first, second][1 - winnerIndex] as WorkerResult;
    assert.equal(loserWorker.code, 3);

    const status = getTaskStatus(box.db, { id: task.key });
    assert.equal(status.task.status, 'in_progress');
    assert.ok([results[0]?.claimed_by, results[1]?.claimed_by].includes(status.task.claimed_by ?? ''));
    assert.equal(
      listEvents(box.db, { task_id: task.id }).filter((event) => event.event_type === 'task.started').length,
      1,
    );
  });

  it('serializes four concurrent processes down to a single start event', async () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'refresh-token-rotation');

    const startAt = String(Date.now() + 700);
    const workers = await Promise.all(
      ['agent-1', 'agent-2', 'agent-3', 'agent-4'].map((actor) => runWorker(box, [task.key, actor, startAt])),
    );
    const outcomes = workers.map(
      (worker) => JSON.parse(worker.stdout.trim()) as { ok: boolean; code?: string },
    );
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.code === 'ALREADY_CLAIMED').length, 3);
    assert.equal(
      listEvents(box.db, { task_id: task.id }).filter((event) => event.event_type === 'task.started').length,
      1,
    );
  });

  it('allocates unique PREFIX-N keys when processes race task create', async () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const startAt = String(Date.now() + 700);

    const workers = await Promise.all(
      ['one', 'two', 'three', 'four'].map((title) =>
        runWorker(box, [project.slug, title, startAt], CREATE_WORKER),
      ),
    );
    const created = workers.map((worker) => {
      assert.equal(worker.stderr, '', `child wrote to stderr: ${worker.stderr}`);
      return JSON.parse(worker.stdout.trim()) as { ok: boolean; key: string; seq: number };
    });

    assert.equal(created.every((outcome) => outcome.ok), true);
    assert.deepEqual(created.map((outcome) => outcome.key).sort(), ['NV3-1', 'NV3-2', 'NV3-3', 'NV3-4']);
    assert.deepEqual(created.map((outcome) => outcome.seq).sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.equal(listEvents(box.db, { event_types: ['task.created'] }).length, 4);
  });

  it('lets a second process take over only after the lease expires', async () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    // Child processes use the real wall clock, so the lease has to be live now.
    const wallClock = new Date();
    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 60, now: wallClock });

    const contested = await runWorker(box, [task.key, 'agent-b', String(Date.now())]);
    const parsed = JSON.parse(contested.stdout.trim()) as { ok: boolean; code?: string };
    assert.equal(parsed.code, 'ALREADY_CLAIMED');

    const takeover = startTask(box.db, {
      id: task.key,
      by: 'agent-b',
      lease_sec: 60,
      now: new Date(wallClock.getTime() + 61_000),
    });
    assert.equal(takeover.task.claimed_by, 'agent-b');
    assert.throws(
      () => startTask(box.db, { id: task.key, by: 'agent-c', now: new Date(wallClock.getTime() + 62_000) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );
  });
});
