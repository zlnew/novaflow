import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cliBox, createProject, createWorkspace } from './helpers.js';

const boxes: Array<ReturnType<typeof cliBox>> = [];
function makeBox(): ReturnType<typeof cliBox> {
  const box = cliBox();
  boxes.push(box);
  return box;
}
after(() => {
  for (const box of boxes) box.dispose();
});

describe('cli workspace commands', () => {
  it('creates a workspace, scaffolds .novaflow/ and registers it', () => {
    const box = makeBox();
    const root = box.box.mkdir('ws-create');
    const envelope = box.json(['workspace', 'create', '--name', 'personal', '--path', root]);

    assert.equal(envelope.command, 'workspace.create');
    assert.equal(envelope.data.workspace.name, 'personal');
    assert.equal(envelope.data.workspace.root, root);
    assert.equal(envelope.data.dry_run, false);
    assert.ok(existsSync(join(root, '.novaflow', 'config.yaml')));
    assert.ok(existsSync(join(root, '.novaflow', '.gitignore')));
    assert.ok(existsSync(join(root, '.novaflow', 'state.db')));

    const registry = JSON.parse(readFileSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json'), 'utf8'));
    assert.equal(registry.workspaces.personal.path, root);
    assert.ok(envelope.next_actions.length > 0);
    assert.match(envelope.next_actions[0]?.command as string, /novaflow /);
  });

  it('derives the workspace name from the directory basename and honours --quiet', () => {
    const box = makeBox();
    const root = box.box.mkdir('derived-name');
    const quiet = box.run(['workspace', 'create', '--path', root, '-q']);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stdout, 'derived-name\n');
    assert.ok(existsSync(join(root, '.novaflow', 'config.yaml')));
  });

  it('fails exit 3 when .novaflow/ already exists', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'twice');
    const error = box.jsonError(['workspace', 'create', '--name', 'twice', '--path', workspace.root]);
    assert.equal(error.code, 'STATE_CONFLICT');
    assert.equal(box.run(['workspace', 'create', '--name', 'twice', '--path', workspace.root]).code, 3);
  });

  it('--dry-run reports the plan without writing anything', () => {
    const box = makeBox();
    const root = box.box.mkdir('dry-ws');
    const envelope = box.json(['workspace', 'create', '--name', 'dry-ws', '--path', root, '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(existsSync(join(root, '.novaflow')), false);
    assert.equal(existsSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json')), false);
  });

  it('--gitignore appends .novaflow/ to the nearest git root, and fails exit 2 outside git', () => {
    const box = makeBox();
    const outside = box.box.mkdir('no-git');
    const error = box.jsonError(['workspace', 'create', '--name', 'no-git', '--path', outside, '--gitignore']);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(existsSync(join(outside, '.novaflow')), false);

    const repo = box.box.mkdir('git-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const nested = join(repo, 'nested');
    mkdirSync(nested, { recursive: true });
    const envelope = box.json(['workspace', 'create', '--name', 'git-ws', '--path', nested, '--gitignore']);
    assert.equal(envelope.data.dry_run, false);
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.novaflow/\n');
  });

  it('lists registered workspaces with the active and default markers', () => {
    const box = makeBox();
    const one = createWorkspace(box, 'alpha');
    const two = createWorkspace(box, 'beta');
    box.json(['workspace', 'update', '--set-default', '-w', two.root]);

    const envelope = box.json(['workspace', 'list'], { cwd: one.root });
    assert.equal(envelope.data.workspaces.length, 2);
    const alpha = envelope.data.workspaces.find((entry: any) => entry.name === 'alpha');
    const beta = envelope.data.workspaces.find((entry: any) => entry.name === 'beta');
    assert.equal(alpha.is_active, true);
    assert.equal(alpha.exists, true);
    assert.equal(beta.is_default, true);
    assert.equal(envelope.data.default_workspace, 'beta');

    const quiet = box.run(['workspace', 'list', '-q']);
    assert.equal(quiet.stdout, 'alpha\nbeta\n');
    const human = box.run(['workspace', 'list']);
    assert.match(human.stdout, /NAME\s+PATH/);
  });

  it('shows workspace metadata, project counts and task counts', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'shown');
    const project = createProject(box, workspace, 'Shown project');
    box.json(['task', 'create', '--title', 'first task', '-w', workspace.root, '-p', project.slug]);

    const envelope = box.json(['workspace', 'show', 'shown']);
    assert.equal(envelope.command, 'workspace.show');
    assert.equal(envelope.data.name, 'shown');
    assert.equal(envelope.data.projects.active, 1);
    assert.equal(envelope.data.tasks.todo, 1);
    assert.equal(envelope.data.tasks.ready, 1);

    const positional = box.json(['workspace', 'show', '-w', workspace.root]);
    assert.equal(positional.data.name, 'shown');
  });

  it('renames a workspace and keeps config.yaml and the registry in sync', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'old-name');
    const envelope = box.json(['workspace', 'update', '--name', 'new-name', '-w', workspace.root]);
    assert.deepEqual(envelope.data.changed, ['name']);
    assert.equal(envelope.data.workspace.name, 'new-name');

    const config = readFileSync(join(workspace.root, '.novaflow', 'config.yaml'), 'utf8');
    assert.match(config, /name: new-name/);
    const registry = JSON.parse(readFileSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json'), 'utf8'));
    assert.deepEqual(Object.keys(registry.workspaces), ['new-name']);
  });

  it('sets and clears the default project, and refuses both flags together', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'defaults');
    const project = createProject(box, workspace, 'Defaults project');

    const set = box.json(['workspace', 'update', '--default-project', project.slug, '-w', workspace.root]);
    assert.equal(set.data.workspace.defaults.project, project.slug);

    const cleared = box.json(['workspace', 'update', '--clear-default-project', '-w', workspace.root]);
    assert.equal(cleared.data.workspace.defaults.project, null);

    const error = box.jsonError([
      'workspace',
      'update',
      '--default-project',
      project.slug,
      '--clear-default-project',
      '-w',
      workspace.root,
    ]);
    assert.equal(error.code, 'VALIDATION_ERROR');
  });

  it('registers and unregisters by name, and fails exit 4 for an unknown name', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'reg-me');
    box.run(['workspace', 'unregister', 'reg-me']);
    const registry = JSON.parse(readFileSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json'), 'utf8'));
    assert.deepEqual(Object.keys(registry.workspaces), []);
    assert.ok(existsSync(join(workspace.root, '.novaflow', 'config.yaml')));

    const registered = box.json(['workspace', 'register', '--name', 'reg-me', '--path', workspace.root]);
    assert.equal(registered.data.name, 'reg-me');

    const error = box.jsonError(['workspace', 'unregister', 'ghost']);
    assert.equal(error.code, 'NOT_FOUND');
  });

  it('reports WORKSPACE_NOT_FOUND exit 4 with remediation outside any workspace', () => {
    const box = makeBox();
    const empty = box.box.mkdir('nowhere');
    const error = box.jsonError(['workspace', 'show'], { cwd: empty });
    assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
    assert.match(error.hint ?? '', /novaflow workspace create/);
  });
});

describe('cli project commands', () => {
  it('creates a project with a derived slug, unique prefix and tags', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'projects');
    const envelope = box.json([
      'project',
      'create',
      '--title',
      'novaflow-v3',
      '--objective',
      'Rebuild novaflow',
      '--tag',
      'core',
      '--tag',
      'v1',
      '--verify',
      'npm test',
      '-w',
      workspace.root,
    ]);
    assert.equal(envelope.command, 'project.create');
    assert.equal(envelope.data.project.slug, 'novaflow-v3');
    assert.equal(envelope.data.project.prefix, 'NV3');
    assert.deepEqual(envelope.data.project.tags, ['core', 'v1']);
    assert.equal(envelope.data.project.verify_cmd, 'npm test');
    assert.equal(envelope.data.dry_run, false);
  });

  it('requires --title and fails exit 2 without it', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'no-title');
    const error = box.jsonError(['project', 'create', '-w', workspace.root]);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /--title/);
  });

  it('fails exit 3 on a duplicate explicit prefix', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'dup-prefix');
    createProject(box, workspace, 'First project', ['--prefix', 'NV3']);
    const error = box.jsonError(['project', 'create', '--title', 'Second project', '--prefix', 'NV3', '-w', workspace.root]);
    assert.equal(error.code, 'STATE_CONFLICT');
  });

  it('lists projects by status and prints slugs under --quiet', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'project-list');
    const first = createProject(box, workspace, 'Alpha project');
    createProject(box, workspace, 'Beta project');
    box.json(['project', 'archive', first.slug, '-w', workspace.root]);

    const active = box.json(['project', 'list', '-w', workspace.root]);
    assert.deepEqual(
      active.data.projects.map((project: any) => project.slug),
      ['beta-project'],
    );
    const all = box.json(['project', 'list', '--status', 'all', '-w', workspace.root]);
    assert.equal(all.data.projects.length, 2);

    const quiet = box.run(['project', 'list', '--status', 'all', '-w', workspace.root, '-q']);
    assert.equal(quiet.stdout, 'alpha-project\nbeta-project\n');
    const human = box.run(['project', 'list', '-w', workspace.root]);
    assert.match(human.stdout, /PREFIX/);
    assert.match(human.stdout, /beta-project/);
  });

  it('shows a project and fails exit 4 for an unknown one', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'project-show');
    createProject(box, workspace, 'Shown');
    const envelope = box.json(['project', 'show', 'shown', '-w', workspace.root]);
    assert.equal(envelope.data.project.slug, 'shown');
    assert.equal(envelope.data.project.counts.total, 0);

    const error = box.jsonError(['project', 'show', 'ghost', '-w', workspace.root]);
    assert.equal(error.code, 'NOT_FOUND');
  });

  it('updates metadata, clears nullable fields and replaces tags wholesale', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'project-update');
    const project = createProject(box, workspace, 'Updatable', ['--objective', 'original', '--tag', 'one', '--tag', 'two']);

    const replaced = box.json(['project', 'update', project.slug, '--tag', 'three', '-w', workspace.root]);
    assert.deepEqual(replaced.data.project.tags, ['three']);

    const clearedTags = box.json(['project', 'update', project.slug, '--clear-tags', '-w', workspace.root]);
    assert.deepEqual(clearedTags.data.project.tags, []);

    const clearedObjective = box.json(['project', 'update', project.slug, '--clear-objective', '-w', workspace.root]);
    assert.equal(clearedObjective.data.project.objective, '');

    const emptyString = box.json(['project', 'update', project.slug, '--objective', 'x', '--clear-verify', '-w', workspace.root]);
    assert.equal(emptyString.data.project.verify_cmd, null);

    const paused = box.json(['project', 'update', project.slug, '--status', 'paused', '-w', workspace.root]);
    assert.equal(paused.data.project.status, 'paused');

    const badStatus = box.jsonError(['project', 'update', project.slug, '--status', 'bogus', '-w', workspace.root]);
    assert.equal(badStatus.code, 'VALIDATION_ERROR');
  });

  it('archives a project as a status transition', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'project-archive');
    const project = createProject(box, workspace, 'Archivable');
    const envelope = box.json(['project', 'archive', project.slug, '-w', workspace.root]);
    assert.equal(envelope.command, 'project.archive');
    assert.equal(envelope.data.project.status, 'archived');

    const again = box.json(['project', 'archive', project.slug, '-w', workspace.root]);
    assert.deepEqual(again.data.changed, []);
  });

  it('--dry-run validates without writing a project or an event', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'project-dry');
    const envelope = box.json(['project', 'create', '--title', 'Planned', '-w', workspace.root, '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.project.slug, 'planned');

    const listed = box.json(['project', 'list', '-w', workspace.root]);
    assert.equal(listed.data.projects.length, 0);
    const events = box.json(['events', '-w', workspace.root]);
    assert.equal(events.data.events.filter((event: any) => event.event_type === 'project.created').length, 0);
  });

  it('writes through NOVAFLOW_WORKSPACE and the walk-up workspace', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'env-ws');
    const envCreate = box.json(['project', 'create', '--title', 'Env project'], {
      env: { NOVAFLOW_WORKSPACE: workspace.root },
    });
    assert.equal(envCreate.data.project.slug, 'env-project');

    const walked = box.json(['project', 'create', '--title', 'Walk project'], { cwd: workspace.root });
    assert.equal(walked.data.project.slug, 'walk-project');

    writeFileSync(join(workspace.root, '.keep'), '');
  });
});
