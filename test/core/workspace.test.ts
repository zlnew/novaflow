import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createWorkspace,
  exportWorkspace,
  getOverviewStatus,
  listWorkspaces,
  registerWorkspace,
  showWorkspace,
  unregisterWorkspace,
  updateWorkspace,
} from '../../src/core/workspace.js';
import { listEvents } from '../../src/core/events.js';
import { blockTask, completeTask, startTask } from '../../src/core/task.js';
import { openDatabase } from '../../src/store/db.js';
import { readRegistry, registryFilePath, writeRegistry } from '../../src/store/registry.js';
import { workspacePaths } from '../../src/store/workspace.js';
import { NOW, expectNovaError, later, sandboxPool, seedProject, seedTask } from './helpers.js';
import { sandbox } from '../store/helpers.js';

const pool = sandboxPool();
const boxes: Array<{ dispose(): void }> = [];
after(() => {
  for (const box of boxes) box.dispose();
});

function rawSandbox() {
  const box = sandbox();
  boxes.push(box);
  return box;
}

describe('core/workspace create', () => {
  it('scaffolds .novaflow, registers the workspace, and emits workspace.created', () => {
    const box = rawSandbox();
    const root = box.path('personal-repo');

    const created = createWorkspace({ name: 'personal', path: root, env: box.env, cwd: box.cwd, now: NOW });
    assert.equal(created.workspace.name, 'personal');
    assert.equal(created.workspace.root, root);
    assert.equal(created.workspace.path, join(root, '.novaflow'));
    assert.equal(created.dry_run, false);

    const paths = workspacePaths(root);
    assert.equal(existsSync(paths.configPath), true);
    assert.equal(existsSync(paths.dbPath), true);
    assert.equal(existsSync(paths.gitignorePath), true);
    assert.match(readFileSync(paths.gitignorePath, 'utf8'), /^state\.db$/m);
    assert.match(readFileSync(paths.configPath, 'utf8'), /name: personal/);

    assert.equal(readRegistry(box.env).workspaces.personal?.path, root);

    const db = openDatabase(paths.dbPath);
    try {
      const events = listEvents(db, { entity_type: 'workspace' });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event_type, 'workspace.created');
      assert.equal(events[0]?.entity_key, 'personal');
    } finally {
      db.close();
    }
  });

  it('derives the name from the directory basename and honours --set-default', () => {
    const box = rawSandbox();
    const root = box.path('my-workspace');
    const created = createWorkspace({ path: root, env: box.env, cwd: box.cwd, set_default: true, now: NOW });
    assert.equal(created.workspace.name, 'my-workspace');
    assert.equal(readRegistry(box.env).default_workspace, 'my-workspace');
  });

  it('writes nothing on a dry run', () => {
    const box = rawSandbox();
    const root = box.path('dry');
    const planned = createWorkspace({ name: 'dry', path: root, env: box.env, cwd: box.cwd, dry_run: true, now: NOW });
    assert.equal(planned.dry_run, true);
    assert.equal(existsSync(join(root, '.novaflow')), false);
    assert.deepEqual(readRegistry(box.env).workspaces, {});
  });

  it('refuses an existing .novaflow, a taken name, and an invalid name', () => {
    const box = rawSandbox();
    const first = createWorkspace({ name: 'personal', path: box.path('one'), env: box.env, cwd: box.cwd, now: NOW });
    assert.ok(first.workspace.name === 'personal');

    assert.throws(
      () => createWorkspace({ name: 'personal', path: box.path('one'), env: box.env, cwd: box.cwd, now: NOW }),
      expectNovaError('STATE_CONFLICT', 3),
    );
    assert.throws(
      () => createWorkspace({ name: 'personal', path: box.path('two'), env: box.env, cwd: box.cwd, now: NOW }),
      expectNovaError('STATE_CONFLICT', 3),
    );
    assert.throws(
      () => createWorkspace({ name: 'Bad Name', path: box.path('three'), env: box.env, cwd: box.cwd, now: NOW }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('requires a git repository for --gitignore and appends .novaflow/ once', () => {
    const box = rawSandbox();
    const repo = box.path('repo');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });

    assert.throws(
      () => createWorkspace({ name: 'nogit', path: box.path('nogit'), gitignore: true, env: box.env, cwd: box.cwd, now: NOW }),
      expectNovaError('VALIDATION_ERROR', 2),
    );

    createWorkspace({ name: 'withgit', path: repo, gitignore: true, env: box.env, cwd: box.cwd, now: NOW });
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.novaflow/\n');
  });
});

describe('core/workspace list and show', () => {
  it('lists registered workspaces with existence, default, and active flags', () => {
    const box = rawSandbox();
    const first = createWorkspace({ name: 'personal', path: box.path('one'), env: box.env, cwd: box.cwd, now: NOW });
    createWorkspace({ name: 'other', path: box.path('two'), env: box.env, cwd: box.cwd, set_default: true, now: NOW });

    const registry = readRegistry(box.env);
    registry.workspaces.ghost = { path: box.path('missing'), registered_at: NOW.toISOString() };
    writeRegistry(registry, box.env);

    const listed = listWorkspaces({ env: box.env, cwd: first.workspace.root });
    assert.equal(listed.active, 'personal');
    assert.equal(listed.default_workspace, 'other');
    assert.deepEqual(listed.workspaces.map((workspace) => workspace.name), ['ghost', 'other', 'personal']);

    const personal = listed.workspaces.find((workspace) => workspace.name === 'personal');
    assert.equal(personal?.exists, true);
    assert.equal(personal?.config_ok, true);
    assert.equal(personal?.is_active, true);
    assert.equal(personal?.is_default, false);
    assert.equal(personal?.defaults?.project, null);

    const ghost = listed.workspaces.find((workspace) => workspace.name === 'ghost');
    assert.equal(ghost?.exists, false);
    assert.equal(ghost?.config_ok, false);
    assert.equal(ghost?.workspace_id, null);
  });

  it('does not need workspaces.json to report the active workspace', () => {
    const box = rawSandbox();
    const created = createWorkspace({ name: 'personal', path: box.path('one'), env: box.env, cwd: box.cwd, now: NOW });
    unlinkSync(registryFilePath(box.env));

    const listed = listWorkspaces({ env: box.env, cwd: created.workspace.root });
    assert.equal(listed.active, 'personal');
    assert.deepEqual(listed.workspaces, []);
    assert.equal(listed.default_workspace, null);
  });

  it('shows metadata, project counts, and task counts by status', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3');
    seedProject(box, 'jwt-auth');
    const running = seedTask(box, project.slug, 'running');
    const blocked = seedTask(box, project.slug, 'blocked');
    const done = seedTask(box, project.slug, 'done');
    seedTask(box, project.slug, 'todo-one');
    startTask(box.db, { id: running.key, by: 'agent-a', lease_sec: 60, now: NOW });
    blockTask(box.db, { id: blocked.key, reason: 'waiting', now: NOW });
    completeTask(box.db, { id: done.key, now: NOW });

    const shown = showWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, now: NOW });
    assert.equal(shown.name, 'personal');
    assert.equal(shown.path, join(box.root, '.novaflow'));
    assert.equal(shown.projects.active, 2);
    assert.equal(shown.projects.total, 2);
    assert.equal(shown.tasks.todo, 1);
    assert.equal(shown.tasks.ready, 1);
    assert.equal(shown.tasks.in_progress, 1);
    assert.equal(shown.tasks.blocked, 1);
    assert.equal(shown.tasks.done, 1);
    assert.equal(shown.tasks.total, 4);
  });
});

describe('core/workspace update', () => {
  it('renames config.yaml and workspaces.json together and emits workspace.updated', () => {
    const box = pool.make();
    const result = updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, name: 'renamed', now: NOW });

    assert.equal(result.workspace.name, 'renamed');
    assert.deepEqual(result.changed, ['name']);
    assert.match(readFileSync(workspacePaths(box.root).configPath, 'utf8'), /^name: renamed$/m);
    assert.equal(readRegistry(box.env).workspaces.renamed?.path, box.root);
    assert.equal(readRegistry(box.env).workspaces.personal, undefined);

    const events = listEvents(box.db, { entity_type: 'workspace' });
    assert.equal(events.at(-1)?.event_type, 'workspace.updated');
    assert.equal(events.at(-1)?.from_state, 'personal');
    assert.equal(events.at(-1)?.to_state, 'renamed');
  });

  it('follows a rename of the registry default workspace', () => {
    const box = pool.make();
    updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, set_default: true, now: NOW });
    assert.equal(readRegistry(box.env).default_workspace, 'personal');
    updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, name: 'renamed', now: NOW });
    assert.equal(readRegistry(box.env).default_workspace, 'renamed');
  });

  it('sets and clears defaults.project, validating the project', () => {
    const box = pool.make();
    seedProject(box, 'novaflow-v3');

    const set = updateWorkspace({
      workspace: box.root,
      env: box.env,
      cwd: box.box.cwd,
      default_project: 'NV3',
      now: NOW,
    });
    assert.equal(set.workspace.defaults.project, 'novaflow-v3');
    assert.deepEqual(set.changed, ['default_project']);
    assert.match(readFileSync(workspacePaths(box.root).configPath, 'utf8'), /project: novaflow-v3/);

    const cleared = updateWorkspace({
      workspace: box.root,
      env: box.env,
      cwd: box.box.cwd,
      default_project: null,
      now: later(1),
    });
    assert.equal(cleared.workspace.defaults.project, null);

    const clearedWithEmptyString = updateWorkspace({
      workspace: box.root,
      env: box.env,
      cwd: box.box.cwd,
      default_project: '',
      now: later(2),
    });
    assert.equal(clearedWithEmptyString.workspace.defaults.project, null);
    assert.deepEqual(clearedWithEmptyString.changed, []);

    assert.throws(
      () => updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, default_project: 'ghost', now: NOW }),
      expectNovaError('NOT_FOUND', 4),
    );
  });

  it('is a no-op when nothing changes and writes nothing on a dry run', () => {
    const box = pool.make();
    const before = readFileSync(workspacePaths(box.root).configPath, 'utf8');
    const unchanged = updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, now: NOW });
    assert.deepEqual(unchanged.changed, []);

    const planned = updateWorkspace({
      workspace: box.root,
      env: box.env,
      cwd: box.box.cwd,
      name: 'planned',
      default_project: null,
      set_default: true,
      dry_run: true,
      now: NOW,
    });
    assert.equal(planned.workspace.name, 'planned');
    assert.equal(readFileSync(workspacePaths(box.root).configPath, 'utf8'), before);
    assert.equal(readRegistry(box.env).workspaces.planned, undefined);
    assert.equal(readRegistry(box.env).default_workspace, null);
  });

  it('refuses an invalid name and a name owned by another workspace', () => {
    const box = pool.make();
    assert.throws(
      () => updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, name: 'Bad Name', now: NOW }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.throws(
      () => updateWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, name: '   ', now: NOW }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });
});

describe('core/workspace register and unregister', () => {
  it('registers an existing workspace and unregisters it without deleting the directory', () => {
    const box = pool.make();
    unregisterWorkspace({ name: 'personal', env: box.env });
    assert.deepEqual(readRegistry(box.env).workspaces, {});
    assert.equal(existsSync(workspacePaths(box.root).configPath), true);

    const registered = registerWorkspace({ name: 'personal', path: box.root, env: box.env, now: NOW });
    assert.equal(registered.name, 'personal');
    assert.equal(readRegistry(box.env).workspaces.personal?.path, box.root);

    const removed = unregisterWorkspace({ name: 'personal', env: box.env });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(workspacePaths(box.root).configPath), true);
  });

  it('fails exit 4 for an unknown path or unknown name, and exit 2 on a name mismatch', () => {
    const box = pool.make();
    assert.throws(
      () => registerWorkspace({ name: 'ghost', path: box.box.path('nowhere'), env: box.env }),
      expectNovaError('WORKSPACE_NOT_FOUND', 4),
    );
    assert.throws(
      () => registerWorkspace({ name: 'other', path: box.root, env: box.env }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.throws(() => unregisterWorkspace({ name: 'ghost', env: box.env }), expectNovaError('NOT_FOUND', 4));
  });

  it('fails exit 3 when the name is already registered elsewhere', () => {
    const box = pool.make();
    const otherRoot = box.box.path('other-ws');
    createWorkspace({ name: 'other', path: otherRoot, env: box.env, cwd: box.box.cwd, now: NOW });
    const registry = readRegistry(box.env);
    registry.workspaces.personal = { path: box.box.path('different'), registered_at: NOW.toISOString() };
    writeRegistry(registry, box.env);

    assert.throws(
      () => registerWorkspace({ name: 'personal', path: box.root, env: box.env }),
      expectNovaError('STATE_CONFLICT', 3),
    );
  });
});

describe('core/workspace status and export', () => {
  it('reports the board summary across the workspace and per project', () => {
    const box = pool.make();
    const alpha = seedProject(box, 'novaflow-v3');
    const beta = seedProject(box, 'jwt-auth');
    const running = seedTask(box, alpha.slug, 'running');
    const ready = seedTask(box, alpha.slug, 'ready-one');
    const blocked = seedTask(box, beta.slug, 'blocked-one');
    startTask(box.db, { id: running.key, by: 'agent-a', lease_sec: 60, now: NOW });
    blockTask(box.db, { id: blocked.key, reason: 'waiting', now: NOW });

    const all = getOverviewStatus({ workspace: box.root, env: box.env, cwd: box.box.cwd, now: NOW });
    assert.equal(all.workspace.name, 'personal');
    assert.equal(all.project, null);
    assert.equal(all.counts.total, 3);
    assert.deepEqual(all.in_progress.map((task) => task.key), [running.key]);
    assert.deepEqual(all.ready.map((task) => task.key), [ready.key]);
    assert.deepEqual(all.blocked.map((task) => task.key), [blocked.key]);
    assert.ok(all.recent_events.length >= 3);

    const scoped = getOverviewStatus({ workspace: box.root, env: box.env, cwd: box.box.cwd, project: 'NV3', now: NOW });
    assert.equal(scoped.project?.slug, 'novaflow-v3');
    assert.equal(scoped.counts.total, 2);
    assert.deepEqual(scoped.blocked, []);
  });

  it('exports a portable snapshot including deps, notes, artifacts, and events', () => {
    const box = pool.make();
    const project = seedProject(box, 'novaflow-v3', { objective: 'ship it' });
    const upstream = seedTask(box, project.slug, 'alpha');
    const downstream = seedTask(box, project.slug, 'beta', { depends_on: [upstream.key] });
    completeTask(box.db, { id: upstream.key, summary: 'done', artifacts: ['src/auth/jwt.ts'], now: NOW });

    const snapshot = exportWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, now: NOW });
    assert.equal(snapshot.export_version, 1);
    assert.equal(snapshot.exported_at, NOW.toISOString());
    assert.equal(snapshot.workspace.name, 'personal');
    assert.deepEqual(snapshot.projects.map((item) => item.slug), ['novaflow-v3']);
    assert.deepEqual(snapshot.tasks.map((item) => item.key), ['NV3-1', 'NV3-2']);
    assert.deepEqual(snapshot.deps, [{ task: 'NV3-2', depends_on: 'NV3-1', created_at: NOW.toISOString() }]);
    assert.deepEqual(snapshot.artifacts.map((artifact) => [artifact.task, artifact.uri, artifact.kind]), [
      ['NV3-1', 'src/auth/jwt.ts', 'file'],
    ]);
    assert.deepEqual(snapshot.notes, []);
    assert.ok(snapshot.events.length >= 3);
    assert.ok(snapshot.tasks.some((task) => task.key === downstream.key && task.unmet_deps.length === 0));

    const scoped = exportWorkspace({ workspace: box.root, env: box.env, cwd: box.box.cwd, project: 'NV3', now: NOW });
    assert.deepEqual(scoped.tasks.map((task) => task.key), ['NV3-1', 'NV3-2']);
  });
});
