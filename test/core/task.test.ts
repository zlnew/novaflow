import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEvents } from '../../src/core/events.js';
import {
  addTaskNote,
  attachTaskArtifact,
  cancelTask,
  createTask,
  getTaskContext,
  getTaskStatus,
  listTasks,
  nextTasks,
  resolveTaskRow,
  updateTask,
} from '../../src/core/task.js';
import type { WorkspaceConfig } from '../../src/store/workspace.js';
import type { TaskPriority } from '../../src/core/model.js';
import { NOW, expectNovaError, later, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();

function workspaceConfig(defaultProject: string | null): WorkspaceConfig {
  return {
    schema_version: 1,
    workspace_id: '01JNABCDEFGHJKMNPQRSTVWXYZ',
    name: 'personal',
    created_at: '2026-11-28T03:30:00.000Z',
    defaults: { project: defaultProject },
  };
}

function countRows(db: import('node:sqlite').DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint }).count);
}

describe('core/task creation and keys', () => {
  it('allocates PREFIX-N keys monotonically from projects.next_seq', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const first = seedTask(box, project.slug, 'jwt-authentication');
    const second = seedTask(box, project.slug, 'refresh-token-rotation');

    assert.equal(first.key, 'NV3-1');
    assert.equal(second.key, 'NV3-2');
    assert.equal(first.status, 'todo');
    assert.equal(first.priority, 'medium');
    assert.equal(first.seq, 1);
  });

  it('never reuses a key after a cancel', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const first = seedTask(box, project.slug, 'jwt-authentication');
    cancelTask(box.db, { id: first.key, reason: 'dropped' });
    const second = seedTask(box, project.slug, 'replacement');
    assert.equal(second.key, 'NV3-2');
    assert.equal(second.seq, 2);
  });

  it('suffixes an auto-derived slug but rejects an explicit duplicate with exit 3', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    assert.equal(seedTask(box, project.slug, 'JWT Authentication').slug, 'jwt-authentication');
    assert.equal(seedTask(box, project.slug, 'JWT Authentication').slug, 'jwt-authentication-2');

    assert.throws(
      () => createTask(box.db, { project: project.slug, title: 'other', slug: 'jwt-authentication', env: {} }),
      expectNovaError('STATE_CONFLICT', 3),
    );
  });

  it('returns the existing task for an exact idempotency_key match without upserting', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const first = createTask(box.db, {
      project: project.slug,
      title: 'jwt-authentication',
      idempotency_key: 'dispatch-42',
      priority: 'high',
      env: {},
    });
    assert.equal(first.idempotent_hit, false);

    const second = createTask(box.db, {
      project: project.slug,
      title: 'a completely different title',
      idempotency_key: 'dispatch-42',
      priority: 'low',
      assignee: 'someone-else',
      env: {},
    });
    assert.equal(second.idempotent_hit, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.task.title, 'jwt-authentication');
    assert.equal(second.task.priority, 'high');
    assert.equal(countRows(box.db, 'tasks'), 1);
  });

  it('scopes idempotency keys per project', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const beta = seedProject(box, 'jwt-auth');

    const first = createTask(box.db, { project: alpha.slug, title: 'one', idempotency_key: 'same', env: {} });
    const second = createTask(box.db, { project: beta.slug, title: 'two', idempotency_key: 'same', env: {} });
    assert.equal(first.idempotent_hit, false);
    assert.equal(second.idempotent_hit, false);
    assert.notEqual(first.task.id, second.task.id);
  });

  it('records objective, assignee, priority, tags, and dependencies', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const upstream = seedTask(box, project.slug, 'jwt-authentication');
    const created = createTask(box.db, {
      project: project.slug,
      title: 'refresh-token-rotation',
      objective: 'Rotate on every use',
      assignee: 'backend-agent',
      priority: 'urgent',
      tags: ['auth', 'auth', 'security'],
      depends_on: [upstream.key],
      env: {},
    });

    assert.equal(created.task.objective, 'Rotate on every use');
    assert.equal(created.task.assignee, 'backend-agent');
    assert.equal(created.task.priority, 'urgent');
    assert.deepEqual(created.task.tags, ['auth', 'security']);
    assert.deepEqual(created.task.unmet_deps.map((dependency) => dependency.key), ['NV3-1']);
    assert.equal(created.task.is_ready, false);

    const events = listEvents(box.db, { project_id: project.id });
    assert.equal(events.filter((event) => event.event_type === 'task.created').length, 2);
    assert.deepEqual(events.at(-1)?.payload.depends_on, ['NV3-1']);
  });

  it('fails exit 4 when a dependency does not exist and exit 2 on an invalid priority', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    assert.throws(
      () => createTask(box.db, { project: project.slug, title: 'x', depends_on: ['NV3-99'], env: {} }),
      expectNovaError('NOT_FOUND', 4),
    );
    assert.throws(
      () => createTask(box.db, { project: project.slug, title: 'x', priority: 'blocker' as TaskPriority, env: {} }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('writes nothing on a dry run, including the sequence counter', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const planned = createTask(box.db, { project: project.slug, title: 'jwt-authentication', dry_run: true, env: {} });
    assert.equal(planned.task.key, 'NV3-1');
    assert.equal(countRows(box.db, 'tasks'), 0);
    assert.equal(countRows(box.db, 'events'), 1);

    const real = createTask(box.db, { project: project.slug, title: 'jwt-authentication', env: {} });
    assert.equal(real.task.key, 'NV3-1', 'the rolled-back allocation is reused, not leaked');
  });

  it('does not burn a sequence number when creation fails', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    seedTask(box, project.slug, 'jwt-authentication');

    assert.throws(
      () => createTask(box.db, { project: project.slug, title: 'dup', slug: 'jwt-authentication', env: {} }),
      expectNovaError('STATE_CONFLICT', 3),
    );
    const next = seedTask(box, project.slug, 'refresh-token-rotation');
    assert.equal(next.key, 'NV3-2');
  });
});

describe('core/task reference resolution', () => {
  it('resolves keys case-insensitively, workspace-wide', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.equal(resolveTaskRow(box.db, { id: 'nv3-1', env: {} }).task.id, task.id);
    assert.equal(resolveTaskRow(box.db, { id: ' NV3-1 ', env: {} }).task.id, task.id);
  });

  it('resolves <project_slug>/<task_slug> and the internal ULID', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.equal(resolveTaskRow(box.db, { id: 'novaflow-v3/jwt-authentication', env: {} }).task.id, task.id);
    assert.equal(resolveTaskRow(box.db, { id: task.id, env: {} }).task.id, task.id);
  });

  it('resolves a bare slug only when a project is in scope', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, alpha.slug, 'jwt-authentication');

    assert.equal(resolveTaskRow(box.db, { id: 'jwt-authentication', project: alpha.slug, env: {} }).task.id, task.id);
    assert.throws(() => resolveTaskRow(box.db, { id: 'jwt-authentication', env: {} }), expectNovaError('NOT_FOUND', 4));
    assert.throws(() => resolveTaskRow(box.db, { id: 'NV3-99', env: {} }), expectNovaError('NOT_FOUND', 4));
    assert.throws(() => resolveTaskRow(box.db, { id: 'ghost/slug', env: {} }), expectNovaError('NOT_FOUND', 4));
  });
});

describe('core/task project context resolution', () => {
  it('prefers --project, then NOVAFLOW_PROJECT, then defaults.project', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const beta = seedProject(box, 'jwt-auth');
    const config = workspaceConfig(alpha.slug);

    const fromFlag = createTask(box.db, { title: 'one', project: beta.slug, env: { NOVAFLOW_PROJECT: alpha.slug }, config });
    assert.equal(fromFlag.task.project_slug, beta.slug);

    const fromEnv = createTask(box.db, { title: 'two', env: { NOVAFLOW_PROJECT: beta.slug }, config });
    assert.equal(fromEnv.task.project_slug, beta.slug);

    const fromDefault = createTask(box.db, { title: 'three', env: {}, config });
    assert.equal(fromDefault.task.project_slug, alpha.slug);
  });

  it('fails exit 2 on task create when no project is set, naming the available projects', () => {
    const box = pool.make();
    seedProject(box, 'novaflow-v3');
    seedProject(box, 'jwt-auth');

    try {
      createTask(box.db, { title: 'orphan', env: {}, config: workspaceConfig(null) });
      assert.fail('expected a validation error');
    } catch (error) {
      assert.ok(error instanceof Error);
      const nova = error as { code?: string; exitCode?: number; message: string; hint?: string };
      assert.equal(nova.code, 'VALIDATION_ERROR');
      assert.equal(nova.exitCode, 2);
      assert.match(nova.message + (nova.hint ?? ''), /novaflow-v3/);
      assert.match(nova.message + (nova.hint ?? ''), /jwt-auth/);
    }
  });

  it('lists tasks across every project when --project is omitted', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const beta = seedProject(box, 'jwt-auth');
    seedTask(box, alpha.slug, 'alpha-one');
    seedTask(box, beta.slug, 'beta-one');

    const all = listTasks(box.db, {});
    assert.deepEqual(all.map((task) => task.key).sort(), ['JA-1', 'NV3-1']);

    const scoped = listTasks(box.db, { project: beta.slug });
    assert.deepEqual(scoped.map((task) => task.key), ['JA-1']);
  });
});

describe('core/task reads', () => {
  it('filters by status, assignee, tag, and limit', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const one = seedTask(box, project.slug, 'one', { assignee: 'agent-a', tags: ['core'] });
    seedTask(box, project.slug, 'two', { assignee: 'agent-b', tags: ['ui'] });
    cancelTask(box.db, { id: one.key, reason: 'dropped' });

    assert.deepEqual(listTasks(box.db, { status: ['cancelled'] }).map((task) => task.title), ['one']);
    assert.deepEqual(listTasks(box.db, { assignee: 'agent-b' }).map((task) => task.title), ['two']);
    assert.deepEqual(listTasks(box.db, { tag: 'core' }).map((task) => task.title), ['one']);
    assert.equal(listTasks(box.db, { limit: 1 }).length, 1);
  });

  it('orders next by priority then created_at, default limit 10', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    seedTask(box, project.slug, 'low', { priority: 'low', now: new Date('2026-11-28T03:00:00.000Z') });
    seedTask(box, project.slug, 'urgent-late', { priority: 'urgent', now: new Date('2026-11-28T05:00:00.000Z') });
    seedTask(box, project.slug, 'urgent-early', { priority: 'urgent', now: new Date('2026-11-28T04:00:00.000Z') });
    seedTask(box, project.slug, 'high', { priority: 'high', now: new Date('2026-11-28T06:00:00.000Z') });

    assert.deepEqual(nextTasks(box.db, {}).map((task) => task.title), ['urgent-early', 'urgent-late', 'high', 'low']);

    for (let index = 0; index < 12; index += 1) {
      seedTask(box, project.slug, `bulk-${index}`, { now: later(index + 1) });
    }
    assert.equal(nextTasks(box.db, {}).length, 10);
    assert.equal(nextTasks(box.db, { limit: 3 }).length, 3);
  });

  it('reports status with relation counts and a chronological timeline', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    addTaskNote(box.db, { id: task.key, message: 'keys in env', by: 't3-agent' });
    attachTaskArtifact(box.db, { id: task.key, uri: 'src/auth/jwt.ts' });

    const status = getTaskStatus(box.db, { id: task.key });
    assert.equal(status.task.key, 'NV3-1');
    assert.deepEqual(status.counts, { notes: 1, artifacts: 1, dependencies: 0, dependents: 0 });
    assert.deepEqual(status.recent_events.map((event) => event.event_type), ['task.created', 'task.noted', 'task.attached']);
  });

  it('assembles the documented handoff context shape', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3', {
      objective: 'Rebuild as a clean CLI/MCP ledger',
      repo_path: 'repo/novaflow',
      verify_cmd: 'npm test',
    });
    const upstream = seedTask(box, project.slug, 'jwt-authentication');
    addTaskNote(box.db, { id: upstream.key, message: 'Keys in env', by: 't3-agent', now: NOW });
    attachTaskArtifact(box.db, { id: upstream.key, uri: 'src/auth/jwt.ts', kind: 'file', now: NOW });
    box.db
      .prepare("UPDATE tasks SET status = 'done', summary = 'Implemented RS256 issue/verify' WHERE id = ?")
      .run(upstream.id);

    const downstreamTask = seedTask(box, project.slug, 'api-gateway-auth', { depends_on: [upstream.key] });
    addTaskNote(box.db, { id: downstreamTask.key, message: 'blocked on upstream', by: 't3-agent', now: NOW });

    const context = getTaskContext(box.db, { id: downstreamTask.key });
    assert.deepEqual(Object.keys(context).sort(), [
      'artifacts',
      'downstream',
      'notes',
      'project',
      'recent_events',
      'task',
      'upstream',
    ]);
    assert.deepEqual(Object.keys(context.task).sort(), [
      'assignee',
      'claimed_by',
      'id',
      'is_ready',
      'key',
      'objective',
      'priority',
      'session_ref',
      'slug',
      'status',
      'title',
      'unmet_deps',
    ]);
    assert.deepEqual(context.project, {
      slug: 'novaflow-v3',
      prefix: 'NV3',
      title: 'novaflow-v3',
      objective: 'Rebuild as a clean CLI/MCP ledger',
      repo_path: 'repo/novaflow',
      verify_cmd: 'npm test',
    });
    assert.equal(context.upstream.length, 1);
    assert.equal(context.upstream[0]?.key, 'NV3-1');
    assert.equal(context.upstream[0]?.summary, 'Implemented RS256 issue/verify');
    assert.deepEqual(context.upstream[0]?.artifacts, [{ uri: 'src/auth/jwt.ts', label: null, kind: 'file' }]);
    assert.deepEqual(context.upstream[0]?.notes, [
      { author: 't3-agent', body: 'Keys in env', created_at: '2026-11-28T03:30:00.000Z' },
    ]);
    assert.deepEqual(context.downstream, []);
    assert.equal(context.notes.length, 1);
    assert.equal(context.artifacts.length, 0);

    const upstreamContext = getTaskContext(box.db, { id: upstream.key });
    assert.deepEqual(upstreamContext.downstream, [{ key: 'NV3-2', title: 'api-gateway-auth', status: 'todo' }]);
    assert.equal(upstreamContext.task.is_ready, false, 'done tasks are never ready');
  });
});

describe('core/task update, notes, and artifacts', () => {
  it('clears objective and assignee with null or an empty string', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication', { objective: 'do it', assignee: 'agent-a' });

    const cleared = updateTask(box.db, { id: task.key, objective: '', assignee: null });
    assert.equal(cleared.task.objective, '');
    assert.equal(cleared.task.assignee, null);
    assert.deepEqual(cleared.changed, true);

    const events = listEvents(box.db, { task_id: task.id });
    assert.equal(events.at(-1)?.event_type, 'task.updated');
  });

  it('replaces tags and does not change lifecycle state', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication', { tags: ['a'] });
    const updated = updateTask(box.db, { id: task.key, tags: ['b', 'c'], priority: 'high' });
    assert.deepEqual(updated.task.tags, ['b', 'c']);
    assert.equal(updated.task.priority, 'high');
    assert.equal(updated.task.status, 'todo');
  });

  it('rejects an empty title on update', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    assert.throws(() => updateTask(box.db, { id: task.key, title: '' }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('appends notes and artifacts with canonical events', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');

    const note = addTaskNote(box.db, { id: task.key, message: 'Keys in env', by: 't3-agent' });
    assert.equal(note.task.author, 't3-agent');
    assert.equal(note.task.body, 'Keys in env');

    const artifact = attachTaskArtifact(box.db, { id: task.key, uri: 'https://github.com/x/y/pull/1', kind: 'pr' });
    assert.equal(artifact.artifact.kind, 'pr');

    assert.throws(
      () => attachTaskArtifact(box.db, { id: task.key, uri: 'x', kind: 'image' }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.throws(() => addTaskNote(box.db, { id: task.key, message: '  ' }), expectNovaError('VALIDATION_ERROR', 2));

    const events = listEvents(box.db, { task_id: task.id });
    assert.deepEqual(events.map((event) => event.event_type), ['task.created', 'task.noted', 'task.attached']);
  });

  it('writes nothing on a dry run for notes and artifacts', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const task = seedTask(box, project.slug, 'jwt-authentication');
    addTaskNote(box.db, { id: task.key, message: 'would note', dry_run: true });
    attachTaskArtifact(box.db, { id: task.key, uri: 'src/auth/jwt.ts', dry_run: true });
    assert.equal(countRows(box.db, 'task_notes'), 0);
    assert.equal(countRows(box.db, 'task_artifacts'), 0);
  });
});
