import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendEvent, appendEventWithSeq, listEvents, parseSince, recentEventsFor } from '../../src/core/events.js';
import { startTask } from '../../src/core/task.js';
import { withTx } from '../../src/store/db.js';
import { NOW, expectNovaError, later, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();

describe('core/events append and list', () => {
  it('appends immutable rows with actor, states, and payload', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 't3-agent', lease_sec: 60, now: NOW });

    const events = listEvents(box.db, { task_id: task.id });
    assert.deepEqual(
      events.map((event) => event.event_type),
      ['task.created', 'task.started'],
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      [...events.map((event) => event.seq)].sort((left, right) => left - right),
    );
    assert.equal(events[1]?.actor, 't3-agent');
    assert.equal(events[1]?.from_state, 'todo');
    assert.equal(events[1]?.to_state, 'in_progress');
    assert.equal(events[1]?.entity_key, 'NV3-1');
    assert.deepEqual(events[1]?.payload, {});
  });

  it('filters by project, including that project\'s task events only', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const beta = seedProject(box, 'jwt-auth');
    const alphaTask = seedTask(box, alpha.slug, 'alpha-one');
    seedTask(box, beta.slug, 'beta-one');

    const alphaEvents = listEvents(box.db, { project_id: alpha.id });
    assert.deepEqual(alphaEvents.map((event) => event.entity_key).sort(), ['NV3-1', 'novaflow-v3']);
    assert.ok(alphaEvents.every((event) => event.entity_key !== 'JA-1'));

    assert.deepEqual(listEvents(box.db, { project_id: beta.id }).map((event) => event.entity_key).sort(), ['JA-1', 'jwt-auth']);
    assert.equal(listEvents(box.db, { task_id: alphaTask.id }).length, 1);
    assert.equal(listEvents(box.db, { entity_type: 'project' }).length, 2);
    assert.equal(listEvents(box.db, { event_types: ['task.created'] }).length, 2);
  });

  it('supports the --after-seq cursor and --limit', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', now: NOW });

    const all = listEvents(box.db, {});
    assert.equal(all.length, 3);
    const cursor = all[0]?.seq as number;
    assert.deepEqual(listEvents(box.db, { after_seq: cursor }).map((event) => event.seq), all.slice(1).map((event) => event.seq));

    assert.equal(listEvents(box.db, { limit: 1 }).length, 1);
    assert.throws(() => listEvents(box.db, { limit: 0 }), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => listEvents(box.db, { after_seq: 1.5 }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('filters by --since as a relative duration or an ISO timestamp', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    seedTask(box, project.slug, 'old', { now: later(-7200) });
    seedTask(box, project.slug, 'recent', { now: NOW });

    assert.deepEqual(
      listEvents(box.db, { since: '30m', now: NOW }).map((event) => event.entity_key),
      ['novaflow-v3', 'NV3-2'],
    );
    assert.deepEqual(
      listEvents(box.db, { since: '7d', now: NOW }).map((event) => event.entity_key),
      ['novaflow-v3', 'NV3-1', 'NV3-2'],
    );
    assert.deepEqual(
      listEvents(box.db, { since: '2026-11-28T03:29:00.000Z', now: NOW }).map((event) => event.entity_key),
      ['novaflow-v3', 'NV3-2'],
    );
    assert.throws(() => listEvents(box.db, { since: 'yesterday', now: NOW }), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => listEvents(box.db, { since: '0m', now: NOW }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('returns the newest events for one entity, newest first', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    startTask(box.db, { id: task.key, by: 'agent-a', now: NOW });

    const recent = recentEventsFor(box.db, { entity_type: 'task', entity_id: task.id }, 1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.event_type, 'task.started');
  });

  it('writes events inside the caller transaction only', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');

    assert.throws(() => {
      withTx(box.db, (tx) => {
        appendEvent(tx, {
          entity_type: 'project',
          entity_id: project.id,
          entity_key: project.slug,
          event_type: 'project.updated',
          now: NOW,
        });
        throw new Error('boom');
      });
    }, /boom/);

    assert.equal(listEvents(box.db, {}).length, 1, 'only project.created survives the rollback');
    assert.equal(appendEventWithSeq(box.db, {
      entity_type: 'workspace',
      entity_id: 'ws',
      entity_key: 'personal',
      event_type: 'workspace.updated',
      now: NOW,
    }).seq > 0, true);
  });
});

describe('core/events since parsing', () => {
  it('parses compact durations', () => {
    assert.equal(parseSince('30s', NOW), '2026-11-28T03:29:30.000Z');
    assert.equal(parseSince('30m', NOW), '2026-11-28T03:00:00.000Z');
    assert.equal(parseSince('2h', NOW), '2026-11-28T01:30:00.000Z');
    assert.equal(parseSince('7d', NOW), '2026-11-21T03:30:00.000Z');
    assert.equal(parseSince('2w', NOW), '2026-11-14T03:30:00.000Z');
  });

  it('assumes UTC when no offset is given and keeps explicit offsets', () => {
    assert.equal(parseSince('2026-11-28T03:30:00.000Z', NOW), '2026-11-28T03:30:00.000Z');
    assert.equal(parseSince('2026-11-28T03:30:00', NOW), '2026-11-28T03:30:00.000Z');
    assert.equal(parseSince('2026-11-28T03:30:00.000', NOW), '2026-11-28T03:30:00.000Z');
    assert.equal(parseSince('2026-11-28T10:30:00+07:00', NOW), '2026-11-28T03:30:00.000Z');
    assert.equal(parseSince('2026-11-28', NOW), '2026-11-28T00:00:00.000Z');
  });

  it('rejects malformed and zero-length durations with exit 2', () => {
    for (const value of ['', '0s', 'm', '30', '1.5h', '2026-13-45T00:00:00Z', 'now']) {
      assert.throws(() => parseSince(value, NOW), expectNovaError('VALIDATION_ERROR', 2), value);
    }
  });
});
