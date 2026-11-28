import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEvents } from '../../src/core/events.js';
import {
  blockTask,
  cancelTask,
  claimTask,
  completeTask,
  getTaskStatus,
  releaseTask,
  reopenTask,
  startTask,
  unblockTask,
} from '../../src/core/task.js';
import { NOW, expectNovaError, later, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();

function events(db: import('node:sqlite').DatabaseSync, taskId: string): Array<{ event_type: string; from_state: string | null; to_state: string | null; payload: Record<string, unknown> }> {
  return listEvents(db, { task_id: taskId }).map((event) => ({
    event_type: event.event_type,
    from_state: event.from_state,
    to_state: event.to_state,
    payload: event.payload,
  }));
}

describe('core/fsm start', () => {
  it('moves todo to in_progress and records the claim, session, lease, and start time', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    const result = startTask(box.db, {
      id: task.key,
      by: 't3-agent',
      session_ref: 'thread://abc123',
      lease_sec: 300,
      now: NOW,
    });

    assert.equal(result.from_state, 'todo');
    assert.equal(result.to_state, 'in_progress');
    assert.equal(result.task.status, 'in_progress');
    assert.equal(result.task.claimed_by, 't3-agent');
    assert.equal(result.task.session_ref, 'thread://abc123');
    assert.equal(result.task.lease_expires_at, later(300).toISOString());
    assert.equal(result.task.started_at, NOW.toISOString());
    assert.equal(result.task.is_ready, false);

    assert.deepEqual(events(box.db, task.id).at(-1), {
      event_type: 'task.started',
      from_state: 'todo',
      to_state: 'in_progress',
      payload: {},
    });
  });

  it('records a start note in the same transaction', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    const result = startTask(box.db, { id: task.key, by: 't3-agent', note: 'picking this up', now: NOW });
    assert.deepEqual(result.event_seqs.length, 2);
    const status = getTaskStatus(box.db, { id: task.key, now: NOW });
    assert.equal(status.counts.notes, 1);
    assert.deepEqual(status.recent_events.map((event) => event.event_type), [
      'task.created',
      'task.started',
      'task.noted',
    ]);
  });

  it('refuses to start a blocked task, pointing at unblock --start', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    blockTask(box.db, { id: task.key, reason: 'needs decision', now: NOW });

    assert.throws(() => startTask(box.db, { id: task.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('refuses to start terminal tasks', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const done = seedTask(box, project.slug, 'finished');
    completeTask(box.db, { id: done.key, now: NOW });
    const cancelled = seedTask(box, project.slug, 'dropped');
    cancelTask(box.db, { id: cancelled.key, now: NOW });

    assert.throws(() => startTask(box.db, { id: done.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
    assert.throws(() => startTask(box.db, { id: cancelled.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('refuses unmet dependencies with exit 3 and honours --force', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const upstream = seedTask(box, project.slug, 'jwt-authentication');
    const downstream = seedTask(box, project.slug, 'refresh-token-rotation', { depends_on: [upstream.key] });

    try {
      startTask(box.db, { id: downstream.key, now: NOW });
      assert.fail('expected UNMET_DEPENDENCIES');
    } catch (error) {
      const nova = error as { code?: string; exitCode?: number; message: string };
      assert.equal(nova.code, 'UNMET_DEPENDENCIES');
      assert.equal(nova.exitCode, 3);
      assert.match(nova.message, /NV3-1 \(todo\)/);
    }

    const forced = startTask(box.db, { id: downstream.key, force: true, now: NOW });
    assert.equal(forced.task.status, 'in_progress');
  });

  it('refuses a live claim held by another actor and allows --force', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 600, now: NOW });

    assert.throws(
      () => startTask(box.db, { id: task.key, by: 'agent-b', now: later(10) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );
    assert.throws(
      () => startTask(box.db, { id: task.key, by: 'agent-a', now: later(10) }),
      expectNovaError('STATE_CONFLICT', 3),
    );

    const forced = startTask(box.db, { id: task.key, by: 'agent-b', force: true, now: later(10) });
    assert.equal(forced.task.claimed_by, 'agent-b');
  });

  it('takes over an expired lease without --force and records the takeover', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', session_ref: 'thread://a', lease_sec: 30, now: NOW });

    const takeover = startTask(box.db, { id: task.key, by: 'agent-b', lease_sec: 60, now: later(31) });
    assert.equal(takeover.task.claimed_by, 'agent-b');
    assert.equal(takeover.task.session_ref, null, 'session_ref clears when claimant changes without --ref');
    assert.equal(takeover.task.lease_expires_at, later(91).toISOString());
    assert.deepEqual(takeover.task.started_at, NOW.toISOString(), 'started_at is preserved');
    const payload = events(box.db, task.id).at(-1)?.payload as { take_over?: { claimed_by: string; expired: boolean } };
    assert.equal(payload.take_over?.claimed_by, 'agent-a');
    assert.equal(payload.take_over?.expired, true);
  });

  it('treats a NULL lease as a permanent claim that never expires', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', now: NOW });

    assert.equal(getTaskStatus(box.db, { id: task.key }).task.lease_expires_at, null);
    assert.throws(
      () => startTask(box.db, { id: task.key, by: 'agent-b', now: later(10_000) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );
  });

  it('rejects a non-positive lease with exit 2', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.throws(() => startTask(box.db, { id: task.key, lease_sec: 0, now: NOW }), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => startTask(box.db, { id: task.key, lease_sec: 1.5, now: NOW }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('writes nothing on a dry run', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    const before = events(box.db, task.id).length;

    const planned = startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 60, dry_run: true, now: NOW });
    assert.equal(planned.task.status, 'in_progress');
    assert.equal(getTaskStatus(box.db, { id: task.key }).task.status, 'todo');
    assert.equal(events(box.db, task.id).length, before);
  });
});

describe('core/fsm complete', () => {
  it('completes straight from todo without setting started_at', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    const result = completeTask(box.db, { id: task.key, summary: 'done early', artifacts: ['src/auth/jwt.ts'], now: NOW });
    assert.equal(result.task.status, 'done');
    assert.equal(result.task.started_at, null);
    assert.equal(result.task.completed_at, NOW.toISOString());
    assert.equal(result.task.summary, 'done early');
    assert.equal(result.task.lease_expires_at, null);

    const status = getTaskStatus(box.db, { id: task.key });
    assert.equal(status.counts.artifacts, 1);
    assert.deepEqual(events(box.db, task.id).at(-1), {
      event_type: 'task.completed',
      from_state: 'todo',
      to_state: 'done',
      payload: { summary: 'done early', artifacts: ['src/auth/jwt.ts'] },
    });
  });

  it('completes from in_progress and from blocked, clearing the lease and blocker', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const running = seedTask(box, project.slug, 'running');
    startTask(box.db, { id: running.key, by: 'agent-a', lease_sec: 60, now: NOW });
    const completed = completeTask(box.db, { id: running.key, by: 'agent-a', now: later(5) });
    assert.equal(completed.task.status, 'done');
    assert.equal(completed.task.started_at, NOW.toISOString());
    assert.equal(completed.task.claimed_by, 'agent-a');
    assert.equal(completed.task.lease_expires_at, null);

    const blocked = seedTask(box, project.slug, 'blocked-one');
    blockTask(box.db, { id: blocked.key, reason: 'waiting', waiting_on: 'upstream PR', now: NOW });
    const unblockedThenDone = completeTask(box.db, { id: blocked.key, now: later(6) });
    assert.equal(unblockedThenDone.task.status, 'done');
    assert.equal(unblockedThenDone.task.block_reason, null);
    assert.equal(unblockedThenDone.task.blocked_by_ref, null);
  });

  it('refuses terminal states and a live foreign claim unless forced', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 600, now: NOW });

    assert.throws(
      () => completeTask(box.db, { id: task.key, by: 'agent-b', now: later(1) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );
    const forced = completeTask(box.db, { id: task.key, by: 'agent-b', force: true, now: later(1) });
    assert.equal(forced.task.status, 'done');

    assert.throws(() => completeTask(box.db, { id: task.key, now: later(2) }), expectNovaError('STATE_CONFLICT', 3));
    const again = completeTask(box.db, { id: task.key, force: true, now: later(2) });
    assert.equal(again.task.status, 'done');
  });
});

describe('core/fsm block and unblock', () => {
  it('requires a reason or --on', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.throws(() => blockTask(box.db, { id: task.key, now: NOW }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('blocks, keeps the claimant, clears the lease, and can be re-blocked', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 600, now: NOW });

    const blocked = blockTask(box.db, { id: task.key, reason: 'Need RS256 decision', waiting_on: 'PR #12', now: later(1) });
    assert.equal(blocked.task.status, 'blocked');
    assert.equal(blocked.task.block_reason, 'Need RS256 decision');
    assert.equal(blocked.task.blocked_by_ref, 'PR #12');
    assert.equal(blocked.task.claimed_by, 'agent-a');
    assert.equal(blocked.task.lease_expires_at, null);

    const again = blockTask(box.db, { id: task.key, reason: 'still stuck', now: later(2) });
    assert.equal(again.from_state, 'blocked');
    assert.equal(again.task.block_reason, 'still stuck');
  });

  it('adds a dependency with --on and blocks terminal tasks outright', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const upstream = seedTask(box, project.slug, 'jwt-authentication');
    const downstream = seedTask(box, project.slug, 'refresh-token-rotation');

    const blocked = blockTask(box.db, { id: downstream.key, on: upstream.key, now: NOW });
    assert.equal(blocked.task.status, 'blocked');
    assert.deepEqual(blocked.task.unmet_deps.map((dependency) => dependency.key), ['NV3-1']);
    assert.equal(blocked.task.blocked_by_ref, 'NV3-1');
    assert.match(blocked.task.block_reason ?? '', /NV3-1/);
    assert.deepEqual(
      events(box.db, downstream.id).map((event) => event.event_type),
      ['task.created', 'task.dep_added', 'task.blocked'],
    );

    const done = seedTask(box, project.slug, 'done-one');
    completeTask(box.db, { id: done.key, now: NOW });
    assert.throws(() => blockTask(box.db, { id: done.key, reason: 'x', now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('unblocks to todo and clears the blocker', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    blockTask(box.db, { id: task.key, reason: 'waiting', waiting_on: 'PR #12', now: NOW });

    const unblocked = unblockTask(box.db, { id: task.key, note: 'decision made', now: later(1) });
    assert.equal(unblocked.from_state, 'blocked');
    assert.equal(unblocked.to_state, 'todo');
    assert.equal(unblocked.task.block_reason, null);
    assert.equal(unblocked.task.blocked_by_ref, null);
  });

  it('is the only path from blocked to in_progress via --start', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    blockTask(box.db, { id: task.key, reason: 'waiting', now: NOW });

    assert.throws(() => startTask(box.db, { id: task.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));

    const resumed = unblockTask(box.db, {
      id: task.key,
      start: true,
      by: 'agent-b',
      session_ref: 'thread://xyz',
      lease_sec: 120,
      now: later(1),
    });
    assert.equal(resumed.to_state, 'in_progress');
    assert.equal(resumed.task.status, 'in_progress');
    assert.equal(resumed.task.claimed_by, 'agent-b');
    assert.equal(resumed.task.session_ref, 'thread://xyz');
    assert.equal(resumed.task.lease_expires_at, later(121).toISOString());
    assert.equal(resumed.task.started_at, later(1).toISOString());
  });

  it('enforces dependency and claim guards when starting from blocked', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const upstream = seedTask(box, project.slug, 'jwt-authentication');
    const downstream = seedTask(box, project.slug, 'refresh-token-rotation');
    blockTask(box.db, { id: downstream.key, on: upstream.key, now: NOW });

    assert.throws(
      () => unblockTask(box.db, { id: downstream.key, start: true, now: later(1) }),
      expectNovaError('UNMET_DEPENDENCIES', 3),
    );
    const forced = unblockTask(box.db, { id: downstream.key, start: true, force: true, now: later(1) });
    assert.equal(forced.task.status, 'in_progress');
  });

  it('refuses to unblock a task that is not blocked', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.throws(() => unblockTask(box.db, { id: task.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });
});

describe('core/fsm cancel, reopen, claim, release', () => {
  it('cancels from todo, in_progress, and blocked, but not from done', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const todo = seedTask(box, project.slug, 'todo-one');
    const running = seedTask(box, project.slug, 'running-one');
    const blocked = seedTask(box, project.slug, 'blocked-one');
    startTask(box.db, { id: running.key, by: 'agent-a', lease_sec: 600, now: NOW });
    blockTask(box.db, { id: blocked.key, reason: 'waiting', now: NOW });

    assert.equal(cancelTask(box.db, { id: todo.key, reason: 'dropped', now: NOW }).task.status, 'cancelled');
    const cancelledRunning = cancelTask(box.db, { id: running.key, now: later(1) });
    assert.equal(cancelledRunning.task.status, 'cancelled');
    assert.equal(cancelledRunning.task.lease_expires_at, null);
    assert.equal(cancelTask(box.db, { id: blocked.key, now: later(2) }).task.status, 'cancelled');

    const done = seedTask(box, project.slug, 'done-one');
    completeTask(box.db, { id: done.key, now: NOW });
    assert.throws(() => cancelTask(box.db, { id: done.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('reopens only terminal tasks and resets completion, claim, and summary', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const done = seedTask(box, project.slug, 'done-one');
    startTask(box.db, { id: done.key, by: 'agent-a', lease_sec: 60, now: NOW });
    completeTask(box.db, { id: done.key, summary: 'finished', by: 'agent-a', now: later(1) });

    const reopened = reopenTask(box.db, { id: done.key, reason: 'regression', now: later(2) });
    assert.equal(reopened.from_state, 'done');
    assert.equal(reopened.to_state, 'todo');
    assert.equal(reopened.task.completed_at, null);
    assert.equal(reopened.task.started_at, null);
    assert.equal(reopened.task.summary, null);
    assert.equal(reopened.task.claimed_by, null);
    assert.equal(reopened.task.session_ref, null);
    assert.equal(reopened.task.lease_expires_at, null);

    const cancelled = seedTask(box, project.slug, 'cancelled-one');
    cancelTask(box.db, { id: cancelled.key, now: NOW });
    assert.equal(reopenTask(box.db, { id: cancelled.key, now: later(3) }).task.status, 'todo');

    const blocked = seedTask(box, project.slug, 'blocked-one');
    blockTask(box.db, { id: blocked.key, reason: 'waiting', now: NOW });
    assert.throws(() => reopenTask(box.db, { id: blocked.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));

    const todo = seedTask(box, project.slug, 'todo-one');
    assert.throws(() => reopenTask(box.db, { id: todo.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('claims without changing state and requires --by', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    assert.throws(() => claimTask(box.db, { id: task.key, by: '   ', now: NOW }), expectNovaError('VALIDATION_ERROR', 2));

    const claimed = claimTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 60, now: NOW });
    assert.equal(claimed.from_state, 'todo');
    assert.equal(claimed.to_state, 'todo');
    assert.equal(claimed.task.claimed_by, 'agent-a');
    assert.equal(claimed.task.lease_expires_at, later(60).toISOString());
    assert.equal(claimed.task.is_ready, false, 'a live claim blocks ready');

    assert.throws(
      () => claimTask(box.db, { id: task.key, by: 'agent-b', now: later(1) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );

    // An expired lease is taken over without --force.
    const expired = claimTask(box.db, { id: task.key, by: 'agent-c', lease_sec: 30, now: later(61) });
    assert.equal(expired.task.claimed_by, 'agent-c');

    // Without --lease the new claim is permanent, so a later caller needs --force.
    const forced = claimTask(box.db, { id: task.key, by: 'agent-b', force: true, now: later(62) });
    assert.equal(forced.task.claimed_by, 'agent-b');
    assert.equal(forced.task.lease_expires_at, null);
    assert.throws(
      () => claimTask(box.db, { id: task.key, by: 'agent-d', now: later(100_000) }),
      expectNovaError('ALREADY_CLAIMED', 3),
    );
  });

  it('refuses claims on terminal states', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    completeTask(box.db, { id: task.key, now: NOW });
    assert.throws(() => claimTask(box.db, { id: task.key, by: 'agent-a', now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('releases the claim and can return an in_progress task to todo', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 600, now: NOW });

    const released = releaseTask(box.db, { id: task.key, by: 'agent-a', now: later(1) });
    assert.equal(released.from_state, 'in_progress');
    assert.equal(released.to_state, 'in_progress');
    assert.equal(released.task.claimed_by, null);
    assert.equal(released.task.session_ref, null);
    assert.equal(released.task.lease_expires_at, null);

    const backToTodo = releaseTask(box.db, { id: task.key, to_todo: true, now: later(2) });
    assert.equal(backToTodo.to_state, 'todo');
    assert.equal(backToTodo.task.status, 'todo');
    assert.equal(backToTodo.task.started_at, NOW.toISOString());

    const done = seedTask(box, project.slug, 'done-one');
    completeTask(box.db, { id: done.key, now: NOW });
    assert.throws(() => releaseTask(box.db, { id: done.key, now: NOW }), expectNovaError('STATE_CONFLICT', 3));
  });
});

describe('core/fsm event integrity', () => {
  it('appends exactly one event per transition with from/to states', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    startTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 60, now: NOW });
    blockTask(box.db, { id: task.key, reason: 'waiting', now: later(1) });
    unblockTask(box.db, { id: task.key, start: true, by: 'agent-a', now: later(2) });
    completeTask(box.db, { id: task.key, by: 'agent-a', now: later(3) });
    reopenTask(box.db, { id: task.key, reason: 'regression', now: later(4) });
    cancelTask(box.db, { id: task.key, reason: 'dropped', now: later(5) });

    assert.deepEqual(
      events(box.db, task.id).map((event) => [event.event_type, event.from_state, event.to_state]),
      [
        ['task.created', null, 'todo'],
        ['task.started', 'todo', 'in_progress'],
        ['task.blocked', 'in_progress', 'blocked'],
        ['task.unblocked', 'blocked', 'in_progress'],
        ['task.completed', 'in_progress', 'done'],
        ['task.reopened', 'done', 'todo'],
        ['task.cancelled', 'todo', 'cancelled'],
      ],
    );
  });
});
