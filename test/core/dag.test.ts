import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEvents } from '../../src/core/events.js';
import { dependencyRefs, dependentRefs, reachableFrom, unmetDependencies } from '../../src/core/dag.js';
import {
  addTaskDep,
  blockTask,
  cancelTask,
  claimTask,
  completeTask,
  getTaskContext,
  getTaskStatus,
  listTasks,
  nextTasks,
  removeTaskDep,
} from '../../src/core/task.js';
import { expectNovaError, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();

describe('core/dag cycles', () => {
  it('rejects a self-dependency with exit 3', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.throws(() => addTaskDep(box.db, { id: task.key, on: task.key }), expectNovaError('CYCLE_DETECTED', 3));
  });

  it('rejects a transitive cycle A -> B -> C -> A', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const a = seedTask(box, project.slug, 'alpha');
    const b = seedTask(box, project.slug, 'beta', { depends_on: [a.key] });
    const c = seedTask(box, project.slug, 'gamma', { depends_on: [b.key] });

    assert.throws(() => addTaskDep(box.db, { id: a.key, on: c.key }), expectNovaError('CYCLE_DETECTED', 3));
    assert.equal(unmetDependencies(box.db, a.id).length, 0, 'the rejected edge was not written');
    assert.throws(() => blockTask(box.db, { id: a.key, on: c.key }), expectNovaError('CYCLE_DETECTED', 3));
  });

  it('accepts a chain and treats a duplicate edge as a no-op', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const a = seedTask(box, project.slug, 'alpha');
    const b = seedTask(box, project.slug, 'beta');

    const added = addTaskDep(box.db, { id: b.key, on: a.key });
    assert.equal(added.changed, true);
    assert.deepEqual(added.task.unmet_deps.map((dependency) => dependency.key), ['NV3-1']);

    const again = addTaskDep(box.db, { id: b.key, on: a.key });
    assert.equal(again.changed, false);
    assert.deepEqual(again.event_seqs, []);

    assert.deepEqual(reachableFrom(box.db, a.id), new Set());
    assert.deepEqual([...reachableFrom(box.db, b.id)], [a.id]);
    assert.deepEqual(dependencyRefs(box.db, b.id).map((ref) => ref.key), ['NV3-1']);
    assert.deepEqual(dependentRefs(box.db, a.id).map((ref) => ref.key), ['NV3-2']);
  });

  it('removes an edge and fails exit 4 when it does not exist', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const a = seedTask(box, project.slug, 'alpha');
    const b = seedTask(box, project.slug, 'beta', { depends_on: [a.key] });

    const removed = removeTaskDep(box.db, { id: b.key, on: a.key });
    assert.equal(removed.changed, true);
    assert.deepEqual(removed.task.unmet_deps, []);
    assert.throws(() => removeTaskDep(box.db, { id: b.key, on: a.key }), expectNovaError('NOT_FOUND', 4));

    assert.deepEqual(
      listEvents(box.db, { task_id: b.id }).map((event) => event.event_type),
      ['task.created', 'task.dep_removed'],
    );
  });
});

describe('core/dag cross-project and readiness', () => {
  it('supports dependencies across projects in the same workspace', () => {
    const box = pool.make();
    const backend = seedProject(box, 'backend');
    const web = seedProject(box, 'jwt-auth');
    const api = seedTask(box, backend.slug, 'api-auth');
    const ui = seedTask(box, web.slug, 'login-form', { depends_on: [api.key] });

    assert.equal(api.key, 'BAC-1');
    assert.equal(ui.key, 'JA-1');
    assert.deepEqual(ui.unmet_deps.map((dependency) => dependency.key), ['BAC-1']);
    assert.equal(ui.is_ready, false);

    completeTask(box.db, { id: api.key });
    const refreshed = getTaskStatus(box.db, { id: ui.key });
    assert.equal(refreshed.task.is_ready, true);
    assert.deepEqual(refreshed.task.unmet_deps, []);
    assert.deepEqual(nextTasks(box.db, {}).map((task) => task.key), ['JA-1']);
  });

  it('keeps downstream waiting when an upstream task is cancelled', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const upstream = seedTask(box, project.slug, 'alpha');
    const downstream = seedTask(box, project.slug, 'beta', { depends_on: [upstream.key] });
    cancelTask(box.db, { id: upstream.key, reason: 'dropped' });

    const status = getTaskStatus(box.db, { id: downstream.key });
    assert.equal(status.task.status, 'todo');
    assert.equal(status.task.is_ready, false);
    assert.deepEqual(status.task.unmet_deps, [
      { id: upstream.id, key: 'NV3-1', slug: 'alpha', title: 'alpha', status: 'cancelled' },
    ]);
    assert.deepEqual(listTasks(box.db, { ready: true }), []);
  });

  it('reports a live claim as not ready even with dependencies done', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'alpha');
    claimTask(box.db, { id: task.key, by: 'agent-a', lease_sec: 60 });

    assert.equal(getTaskStatus(box.db, { id: task.key }).task.is_ready, false);
  });
});

describe('core/dag handoff context', () => {
  it('reports upstream dependencies and downstream dependents', () => {
    const box = pool.make();
    const backend = seedProject(box, 'backend', { objective: 'ship the API' });
    const web = seedProject(box, 'jwt-auth');
    const api = seedTask(box, backend.slug, 'api-auth');
    const middle = seedTask(box, web.slug, 'token-refresh', { depends_on: [api.key] });
    const last = seedTask(box, web.slug, 'gateway', { depends_on: [middle.key] });

    completeTask(box.db, { id: api.key, summary: 'RS256 done' });

    const context = getTaskContext(box.db, { id: middle.key });
    assert.deepEqual(context.upstream.map((item) => [item.key, item.status, item.summary]), [['BAC-1', 'done', 'RS256 done']]);
    assert.deepEqual(context.downstream, [{ key: 'JA-2', title: 'gateway', status: 'todo' }]);
    assert.equal(context.project.slug, 'jwt-auth');
    assert.deepEqual(context.task.unmet_deps, []);

    const lastContext = getTaskContext(box.db, { id: last.key });
    assert.deepEqual(lastContext.downstream, []);
    assert.equal(lastContext.upstream.length, 1);
  });
});
