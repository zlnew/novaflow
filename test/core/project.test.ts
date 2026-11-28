import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  archiveProject,
  createProject,
  listProjects,
  showProject,
  updateProject,
} from '../../src/core/project.js';
import type { ProjectStatus } from '../../src/core/model.js';
import { blockTask, cancelTask, startTask } from '../../src/core/task.js';
import { listEvents } from '../../src/core/events.js';
import { expectNovaError, sandboxPool, seedProject, seedTask } from './helpers.js';

const pool = sandboxPool();

function rowCount(db: import('node:sqlite').DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint }).count);
}

describe('core/project creation', () => {
  it('derives slug from the title and the deterministic prefix', () => {
    const box = pool.make();
    const created = createProject(box.db, { title: 'novaflow-v3' });
    assert.equal(created.project.slug, 'novaflow-v3');
    assert.equal(created.project.prefix, 'NV3');
    assert.equal(created.project.status, 'active');
    assert.deepEqual(created.changed.includes('slug'), true);
  });

  it('derives JA and BAC for the documented examples', () => {
    const box = pool.make();
    assert.equal(createProject(box.db, { title: 'jwt-auth' }).project.prefix, 'JA');
    assert.equal(createProject(box.db, { title: 'backend' }).project.prefix, 'BAC');
  });

  it('suffixes a colliding derived prefix instead of failing', () => {
    const box = pool.make();
    const first = createProject(box.db, { title: 'jwt-auth' });
    const second = createProject(box.db, { title: 'jwt-api' });
    assert.equal(first.project.prefix, 'JA');
    assert.equal(second.project.prefix, 'JA2');
    assert.notEqual(first.project.slug, second.project.slug);
  });

  it('fails exit 2 when the whole prefix family is taken', () => {
    const box = pool.make();
    const insert = box.db.prepare(
      `INSERT INTO projects (id, slug, prefix, title, objective, status, next_seq, tags_json, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'active', 1, '[]', '{}', '2026-11-28T03:30:00.000Z', '2026-11-28T03:30:00.000Z')`,
    );
    const basePrefixes = ['NV3'];
    for (let n = 2; n <= 99; n += 1) basePrefixes.push(`NV3${n}`);
    basePrefixes.forEach((prefix, index) => {
      insert.run(`01JEXHAUST${String(index).padStart(16, '0')}`, `taken-${index}`, prefix, `taken ${index}`);
    });

    assert.throws(
      () => createProject(box.db, { title: 'novaflow-v3' }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('suffixes the derived slug when the title repeats', () => {
    const box = pool.make();
    const first = createProject(box.db, { title: 'Refresh Tokens' });
    const second = createProject(box.db, { title: 'Refresh Tokens' });
    assert.equal(first.project.slug, 'refresh-tokens');
    assert.equal(second.project.slug, 'refresh-tokens-2');
    assert.equal(second.project.prefix, 'RT2');
  });

  it('fails exit 3 on an explicit duplicate slug or prefix', () => {
    const box = pool.make();
    createProject(box.db, { title: 'novaflow-v3' });
    assert.throws(
      () => createProject(box.db, { title: 'other', slug: 'novaflow-v3' }),
      expectNovaError('STATE_CONFLICT', 3),
    );
    assert.throws(
      () => createProject(box.db, { title: 'other', prefix: 'NV3' }),
      expectNovaError('STATE_CONFLICT', 3),
    );
  });

  it('fails exit 2 on an invalid explicit slug, prefix, or empty title', () => {
    const box = pool.make();
    assert.throws(() => createProject(box.db, { title: 'x', slug: 'Bad_Slug' }), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => createProject(box.db, { title: 'x', prefix: 'nv3' }), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => createProject(box.db, { title: '   ' }), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('stores objective, repo path, verify command, tags, and emits project.created', () => {
    const box = pool.make();
    const created = createProject(box.db, {
      title: 'novaflow-v3',
      objective: 'Rebuild as a clean CLI/MCP ledger',
      repo_path: 'repo/novaflow',
      verify_cmd: 'npm test',
      tags: ['core', 'core', ' v1 '],
    });

    assert.equal(created.project.objective, 'Rebuild as a clean CLI/MCP ledger');
    assert.equal(created.project.repo_path, 'repo/novaflow');
    assert.equal(created.project.verify_cmd, 'npm test');
    assert.deepEqual(created.project.tags, ['core', 'v1']);

    const events = listEvents(box.db, { entity_type: 'project' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'project.created');
    assert.equal(events[0]?.entity_key, 'novaflow-v3');
    assert.equal(events[0]?.to_state, 'active');
  });

  it('writes nothing on a dry run', () => {
    const box = pool.make();
    const planned = createProject(box.db, { title: 'novaflow-v3', dry_run: true });
    assert.equal(planned.project.slug, 'novaflow-v3');
    assert.equal(planned.dry_run, true);
    assert.equal(rowCount(box.db, 'projects'), 0);
    assert.equal(rowCount(box.db, 'events'), 0);
  });
});

describe('core/project reads', () => {
  it('lists active projects by default and filters by status', () => {
    const box = pool.make();
    createProject(box.db, { title: 'novaflow-v3' });
    const paused = createProject(box.db, { title: 'jwt-auth' });
    updateProject(box.db, { project: paused.project.slug, status: 'paused' });

    assert.deepEqual(listProjects(box.db).map((project) => project.slug), ['novaflow-v3']);
    assert.deepEqual(listProjects(box.db, { status: 'paused' }).map((project) => project.slug), ['jwt-auth']);
    assert.deepEqual(listProjects(box.db, { status: 'all' }).map((project) => project.slug).sort(), ['jwt-auth', 'novaflow-v3']);
  });

  it('counts tasks by status, including derived ready and waiting', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const ready = seedTask(box, project.slug, 'jwt-authentication');
    const started = seedTask(box, project.slug, 'refresh-token-rotation');
    const blocked = seedTask(box, project.slug, 'api-gateway');
    const cancelled = seedTask(box, project.slug, 'legacy-cleanup');
    const waiting = seedTask(box, project.slug, 'downstream', { depends_on: [ready.key] });

    startTask(box.db, { id: started.key, by: 't3-agent' });
    blockTask(box.db, { id: blocked.key, reason: 'needs decision' });
    cancelTask(box.db, { id: cancelled.key, reason: 'dropped' });

    const shown = showProject(box.db, { project: project.slug });
    assert.equal(shown.counts.todo, 2);
    assert.equal(shown.counts.ready, 1);
    assert.equal(shown.counts.waiting, 1);
    assert.equal(shown.counts.in_progress, 1);
    assert.equal(shown.counts.blocked, 1);
    assert.equal(shown.counts.cancelled, 1);
    assert.equal(shown.counts.done, 0);
    assert.equal(shown.counts.total, 5);
    assert.equal(waiting.status, 'todo');
  });

  it('resolves by slug or prefix and fails exit 4 when missing', () => {
    const box = pool.make();
    seedProject(box, 'novaflow-v3');
    assert.equal(showProject(box.db, { project: 'novaflow-v3' }).prefix, 'NV3');
    assert.equal(showProject(box.db, { project: 'nv3' }).slug, 'novaflow-v3');
    assert.throws(() => showProject(box.db, { project: 'ghost' }), expectNovaError('NOT_FOUND', 4));
  });
});

describe('core/project update', () => {
  it('clears nullable text fields with null or an empty string', () => {
    const box = pool.make();
    const project = createProject(box.db, { title: 'novaflow-v3', objective: 'obj', repo_path: 'repo/novaflow', verify_cmd: 'npm test' }).project;

    const cleared = updateProject(box.db, {
      project: project.slug,
      objective: '',
      repo_path: null,
      verify_cmd: '   ',
    });
    assert.equal(cleared.project.objective, '');
    assert.equal(cleared.project.repo_path, null);
    assert.equal(cleared.project.verify_cmd, null);
    assert.deepEqual(cleared.changed.sort(), ['objective', 'repo_path', 'verify_cmd']);
  });

  it('replaces the full tag list and records project.updated', () => {
    const box = pool.make();
    const project = createProject(box.db, { title: 'novaflow-v3', tags: ['a', 'b'] }).project;

    const updated = updateProject(box.db, { project: project.slug, tags: ['c'] });
    assert.deepEqual(updated.project.tags, ['c']);

    const clearedTags = updateProject(box.db, { project: project.slug, tags: null });
    assert.deepEqual(clearedTags.project.tags, []);

    const events = listEvents(box.db, { project_id: project.id });
    assert.deepEqual(
      events.map((event) => event.event_type),
      ['project.created', 'project.updated', 'project.updated'],
    );
  });

  it('is a no-op when nothing changes', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const result = updateProject(box.db, { project: project.slug, title: project.title });
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.event_seqs, []);
  });

  it('keeps the prefix immutable once tasks exist', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    seedTask(box, project.slug, 'jwt-authentication');

    assert.throws(
      () => updateProject(box.db, { project: project.slug, prefix: 'NVX' }),
      expectNovaError('STATE_CONFLICT', 3),
    );

    const empty = seedProject(box, 'jwt-auth');
    const renamed = updateProject(box.db, { project: empty.slug, prefix: 'JWT' });
    assert.equal(renamed.project.prefix, 'JWT');
  });

  it('rejects an unknown status and an unknown project', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    assert.throws(
      () => updateProject(box.db, { project: project.slug, status: 'pausedx' as ProjectStatus }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.throws(() => updateProject(box.db, { project: 'ghost', title: 'x' }), expectNovaError('NOT_FOUND', 4));
  });

  it('archives with project.archived and is idempotent', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');

    const archived = archiveProject(box.db, { project: project.slug });
    assert.equal(archived.project.status, 'archived');
    assert.deepEqual(archived.changed, ['status']);

    const again = archiveProject(box.db, { project: project.slug });
    assert.deepEqual(again.changed, []);

    const events = listEvents(box.db, { project_id: project.id });
    assert.deepEqual(events.map((event) => event.event_type), ['project.created', 'project.archived']);
    assert.deepEqual(listProjects(box.db), []);
    assert.equal(listProjects(box.db, { status: 'archived' }).length, 1);
  });

  it('writes nothing on a dry run', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    const planned = updateProject(box.db, { project: project.slug, title: 'renamed', dry_run: true });
    assert.equal(planned.project.title, 'renamed');
    assert.equal(showProject(box.db, { project: project.slug }).title, 'novaflow-v3');
    assert.equal(rowCount(box.db, 'events'), 1);
  });
});
