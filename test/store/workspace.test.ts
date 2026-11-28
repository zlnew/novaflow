import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  NOVAFLOW_GITIGNORE,
  createWorkspace,
  ensureRootGitignore,
  ensureWorkspaceGitignore,
  findWorkspaceRoot,
  gitRootFor,
  parseWorkspaceConfig,
  readWorkspaceConfig,
  resolveWorkspace,
  workspacePaths,
  writeWorkspaceConfig,
} from '../../src/store/workspace.js';
import { readRegistry, registerWorkspace, setDefaultWorkspace } from '../../src/store/registry.js';
import { isNovaError } from '../../src/store/errors.js';
import { sandbox, seedWorkspaceConfig, writeText } from './helpers.js';

const VALID_CONFIG = `schema_version: 1
workspace_id: 01JNABCDEFGHJKMNPQRSTVWXYZ
name: personal
created_at: 2026-11-28T03:30:00.000Z
defaults:
  project: null
`;

function expectNovaError(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(isNovaError(error), `expected NovaError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

describe('store/workspace config', () => {
  const boxes: Array<{ dispose(): void }> = [];
  after(() => {
    for (const box of boxes) box.dispose();
  });
  function freshBox() {
    const box = sandbox();
    boxes.push(box);
    return box;
  }

  it('parses the documented config.yaml shape', () => {
    assert.deepEqual(parseWorkspaceConfig(VALID_CONFIG), {
      schema_version: 1,
      workspace_id: '01JNABCDEFGHJKMNPQRSTVWXYZ',
      name: 'personal',
      created_at: '2026-11-28T03:30:00.000Z',
      defaults: { project: null },
    });
  });

  it('accepts a set default project', () => {
    const parsed = parseWorkspaceConfig(VALID_CONFIG.replace('project: null', 'project: novaflow-v3'));
    assert.equal(parsed.defaults.project, 'novaflow-v3');
  });

  it('reads and writes config.yaml under .novaflow/ with a stable round-trip', () => {
    const box = freshBox();
    const root = box.mkdir('ws');
    const config = parseWorkspaceConfig(VALID_CONFIG);
    writeWorkspaceConfig(root, config);
    assert.deepEqual(workspacePaths(root), {
      dir: join(root, '.novaflow'),
      configPath: join(root, '.novaflow', 'config.yaml'),
      dbPath: join(root, '.novaflow', 'state.db'),
      gitignorePath: join(root, '.novaflow', '.gitignore'),
    });
    assert.deepEqual(readWorkspaceConfig(root), config);
  });

  it('rejects a newer schema_version with VALIDATION_ERROR exit 2', () => {
    assert.throws(
      () => parseWorkspaceConfig(VALID_CONFIG.replace('schema_version: 1', 'schema_version: 2')),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('rejects missing required keys', () => {
    for (const key of ['schema_version', 'workspace_id', 'name', 'created_at', 'defaults']) {
      const lines = VALID_CONFIG.split('\n').filter((line) => !line.startsWith(`${key}:`) && line.trim() !== 'project: null');
      assert.throws(
        () => parseWorkspaceConfig(`${lines.join('\n')}\n`),
        expectNovaError('VALIDATION_ERROR', 2),
        `expected ${key} to be required`,
      );
    }
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    assert.throws(
      () => parseWorkspaceConfig(`${VALID_CONFIG}extra: true\n`),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('rejects an unknown key inside defaults', () => {
    assert.throws(
      () => parseWorkspaceConfig(VALID_CONFIG.replace('  project: null', '  project: null\n  bogus: 1')),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('rejects a non-ULID workspace_id and a non-ISO created_at', () => {
    assert.throws(
      () => parseWorkspaceConfig(VALID_CONFIG.replace('01JNABCDEFGHJKMNPQRSTVWXYZ', 'not-a-ulid')),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.throws(
      () => parseWorkspaceConfig(VALID_CONFIG.replace('2026-11-28T03:30:00.000Z', 'yesterday')),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('rejects malformed YAML and non-string defaults.project', () => {
    assert.throws(() => parseWorkspaceConfig('schema_version: [unclosed'), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(
      () => parseWorkspaceConfig(VALID_CONFIG.replace('  project: null', '  project: 7')),
      expectNovaError('VALIDATION_ERROR', 2),
    );
  });

  it('reports a missing config.yaml as WORKSPACE_NOT_FOUND exit 4', () => {
    const box = freshBox();
    assert.throws(() => readWorkspaceConfig(box.mkdir('empty')), expectNovaError('WORKSPACE_NOT_FOUND', 4));
  });
});

describe('store/workspace .gitignore', () => {
  const boxes: Array<{ dispose(): void }> = [];
  after(() => {
    for (const box of boxes) box.dispose();
  });
  function freshBox() {
    const box = sandbox();
    boxes.push(box);
    return box;
  }

  it('pins the exact .novaflow/.gitignore contents from architecture 3.1', () => {
    assert.equal(
      NOVAFLOW_GITIGNORE,
      [
        '# NovaFlow runtime state (keep config.yaml inspectable; ignore local DB & locks)',
        'state.db',
        'state.db-wal',
        'state.db-shm',
        '*.lock',
        '*.tmp',
        '',
      ].join('\n'),
    );
  });

  it('writes .novaflow/.gitignore once and leaves an existing file untouched', () => {
    const box = freshBox();
    const root = box.mkdir('ws');
    assert.equal(ensureWorkspaceGitignore(root), true);
    assert.equal(readFileSync(join(root, '.novaflow', '.gitignore'), 'utf8'), NOVAFLOW_GITIGNORE);
    writeText(join(root, '.novaflow', '.gitignore'), 'custom\n');
    assert.equal(ensureWorkspaceGitignore(root), false);
    assert.equal(readFileSync(join(root, '.novaflow', '.gitignore'), 'utf8'), 'custom\n');
  });

  it('never touches a repository root .gitignore on its own', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const root = join(repo, 'nested', 'ws');
    mkdirSync(root, { recursive: true });
    ensureWorkspaceGitignore(root);
    assert.equal(existsSync(join(repo, '.gitignore')), false);
  });

  it('finds the nearest .git root, including a .git file (worktree)', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const deep = box.mkdir('repo', 'a', 'b', 'c');
    assert.equal(gitRootFor(deep), repo);

    const worktreeRepo = box.mkdir('wt');
    writeText(join(worktreeRepo, '.git'), 'gitdir: /tmp/somewhere\n');
    assert.equal(gitRootFor(join(worktreeRepo, 'child')), worktreeRepo);
    assert.equal(gitRootFor(box.mkdir('outside')), null);
  });

  it('creates and idempotently appends .novaflow/ to the nearest git root', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const workspaceRoot = box.mkdir('repo', 'nested', 'ws');
    seedWorkspaceConfig(workspaceRoot, 'nested');

    const first = ensureRootGitignore(workspaceRoot);
    assert.deepEqual(first, { root: repo, changed: true });
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.novaflow/\n');

    const second = ensureRootGitignore(workspaceRoot);
    assert.deepEqual(second, { root: repo, changed: false });
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.novaflow/\n');
  });

  it('preserves existing root .gitignore lines and appends exactly once', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeText(join(repo, '.gitignore'), 'node_modules/\ndist/');
    const workspaceRoot = box.mkdir('repo', 'ws');
    seedWorkspaceConfig(workspaceRoot, 'ws');

    ensureRootGitignore(workspaceRoot);
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n.novaflow/\n');
    ensureRootGitignore(workspaceRoot);
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n.novaflow/\n');
  });

  it('fails VALIDATION_ERROR exit 2 outside a git repository', () => {
    const box = freshBox();
    const workspaceRoot = box.mkdir('loose');
    seedWorkspaceConfig(workspaceRoot, 'loose');
    assert.throws(() => ensureRootGitignore(workspaceRoot), expectNovaError('VALIDATION_ERROR', 2));
  });
});

describe('store/workspace createWorkspace', () => {
  const boxes: Array<{ dispose(): void }> = [];
  after(() => {
    for (const box of boxes) box.dispose();
  });
  function freshBox() {
    const box = sandbox();
    boxes.push(box);
    return box;
  }

  it('creates .novaflow/{config.yaml,.gitignore,state.db} and registers the workspace', () => {
    const box = freshBox();
    const root = box.mkdir('personal');
    const created = createWorkspace({ root, name: 'personal', env: box.env });

    assert.equal(created.root, root);
    assert.equal(created.config.name, 'personal');
    assert.equal(created.config.schema_version, 1);
    assert.match(created.config.workspace_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(new Date(created.config.created_at).toISOString(), created.config.created_at);
    assert.deepEqual(created.config.defaults, { project: null });
    assert.deepEqual(readWorkspaceConfig(root), created.config);
    assert.equal(readFileSync(join(root, '.novaflow', '.gitignore'), 'utf8'), NOVAFLOW_GITIGNORE);
    assert.equal(existsSync(join(root, '.novaflow', 'state.db')), true);
    assert.deepEqual(readRegistry(box.env).workspaces.personal?.path, root);
  });

  it('migrates state.db to the known schema version on create', () => {
    const box = freshBox();
    const root = box.mkdir('ws');
    const created = createWorkspace({ root, name: 'ws', env: box.env });
    const db = new DatabaseSync(created.dbPath);
    try {
      const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Record<string, unknown>;
      assert.equal(Number(version.version), 1);
      const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as Record<string, unknown>;
      assert.equal(Number(tables.count), 1);
    } finally {
      db.close();
    }
  });

  it('defaults the name to the slugified directory basename', () => {
    const box = freshBox();
    const root = box.mkdir('My Fancy Workspace');
    const created = createWorkspace({ root, env: box.env });
    assert.equal(created.config.name, 'my-fancy-workspace');
    assert.equal(readRegistry(box.env).workspaces['my-fancy-workspace']?.path, root);
  });

  it('fails STATE_CONFLICT exit 3 when .novaflow already exists', () => {
    const box = freshBox();
    const root = box.mkdir('ws');
    seedWorkspaceConfig(root, 'ws');
    assert.throws(() => createWorkspace({ root, name: 'ws', env: box.env }), expectNovaError('STATE_CONFLICT', 3));
  });

  it('fails VALIDATION_ERROR exit 2 on an invalid workspace name', () => {
    const box = freshBox();
    assert.throws(
      () => createWorkspace({ root: box.mkdir('ws'), name: 'Bad Name', env: box.env }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.equal(existsSync(join(box.root, 'ws', '.novaflow')), false);
  });

  it('fails STATE_CONFLICT exit 3 when the name is registered to another path', () => {
    const box = freshBox();
    registerWorkspace('personal', box.mkdir('other'), box.env);
    assert.throws(
      () => createWorkspace({ root: box.mkdir('fresh'), name: 'personal', env: box.env }),
      expectNovaError('STATE_CONFLICT', 3),
    );
  });

  it('with gitignore: true appends .novaflow/ to the nearest git root', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const root = join(repo, 'personal');
    mkdirSync(root, { recursive: true });
    createWorkspace({ root, name: 'personal', gitignore: true, env: box.env });
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '.novaflow/\n');
  });

  it('with gitignore: true outside a git repo fails exit 2 before writing anything', () => {
    const box = freshBox();
    const root = box.mkdir('loose');
    assert.throws(
      () => createWorkspace({ root, name: 'loose', gitignore: true, env: box.env }),
      expectNovaError('VALIDATION_ERROR', 2),
    );
    assert.equal(existsSync(join(root, '.novaflow')), false);
    assert.deepEqual(readRegistry(box.env).workspaces, {});
  });

  it('without gitignore leaves the repository root .gitignore untouched', () => {
    const box = freshBox();
    const repo = box.mkdir('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const root = join(repo, 'personal');
    mkdirSync(root, { recursive: true });
    createWorkspace({ root, name: 'personal', env: box.env });
    assert.equal(existsSync(join(repo, '.gitignore')), false);
  });
});

describe('store/workspace resolution', () => {
  const boxes: Array<{ dispose(): void }> = [];
  after(() => {
    for (const box of boxes) box.dispose();
  });
  function freshBox() {
    const box = sandbox();
    boxes.push(box);
    return box;
  }

  it('resolves the nearest walk-up workspace from cwd', () => {
    const box = freshBox();
    const root = box.mkdir('personal');
    seedWorkspaceConfig(root, 'personal');
    const deep = box.mkdir('personal', 'src', 'app');
    const resolved = resolveWorkspace({ cwd: deep, env: box.env });
    assert.equal(resolved.root, root);
    assert.equal(resolved.name, 'personal');
    assert.equal(resolved.source, 'walkup');
    assert.equal(resolved.dir, join(root, '.novaflow'));
    assert.equal(resolved.configPath, join(root, '.novaflow', 'config.yaml'));
    assert.equal(findWorkspaceRoot(deep), root);
  });

  it('keeps nested workspaces independent', () => {
    const box = freshBox();
    const outer = box.mkdir('outer');
    seedWorkspaceConfig(outer, 'outer');
    const inner = box.mkdir('outer', 'inner');
    seedWorkspaceConfig(inner, 'inner');
    const deep = box.mkdir('outer', 'inner', 'pkg');
    assert.equal(resolveWorkspace({ cwd: deep, env: box.env }).name, 'inner');
    assert.equal(resolveWorkspace({ cwd: outer, env: box.env }).name, 'outer');
    assert.equal(resolveWorkspace({ cwd: box.mkdir('outer', 'sibling'), env: box.env }).name, 'outer');
  });

  it('resolves --workspace by registered name from anywhere', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'personal');
    seedWorkspaceConfig(root, 'personal');
    registerWorkspace('personal', root, box.env);
    const resolved = resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: 'personal' });
    assert.equal(resolved.root, root);
    assert.equal(resolved.source, 'flag');
  });

  it('resolves --workspace path forms: relative, absolute and ~', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'by-path');
    seedWorkspaceConfig(root, 'by-path');
    const homeWorkspace = join(box.home, 'by-path');
    seedWorkspaceConfig(homeWorkspace, 'by-path');

    assert.equal(resolveWorkspace({ cwd: box.root, env: box.env, workspace: './ws/by-path' }).root, root);
    assert.equal(resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: root }).root, root);
    assert.equal(resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: '~/by-path' }).root, homeWorkspace);
  });

  it('resolves --workspace name from ./<name>/.novaflow when unregistered', () => {
    const box = freshBox();
    const root = box.mkdir('local');
    seedWorkspaceConfig(root, 'local');
    const resolved = resolveWorkspace({ cwd: box.root, env: box.env, workspace: 'local' });
    assert.equal(resolved.root, root);
    assert.equal(resolved.source, 'flag');
  });

  it('precedence: --workspace beats NOVAFLOW_WORKSPACE beats walk-up beats default_workspace', () => {
    const box = freshBox();
    const walkupRoot = box.mkdir('walkup');
    seedWorkspaceConfig(walkupRoot, 'walkup');
    const envRoot = box.mkdir('envws');
    seedWorkspaceConfig(envRoot, 'envws');
    const flagRoot = box.mkdir('flagws');
    seedWorkspaceConfig(flagRoot, 'flagws');
    const defaultRoot = box.mkdir('defaultws');
    seedWorkspaceConfig(defaultRoot, 'defaultws');
    registerWorkspace('envws', envRoot, box.env);
    registerWorkspace('flagws', flagRoot, box.env);
    registerWorkspace('defaultws', defaultRoot, box.env);
    setDefaultWorkspace('defaultws', box.env);

    const cwd = box.mkdir('walkup', 'sub');
    const env = { ...box.env, NOVAFLOW_WORKSPACE: 'envws' };

    const flagged = resolveWorkspace({ cwd, env, workspace: 'flagws' });
    assert.equal(flagged.root, flagRoot);
    assert.equal(flagged.source, 'flag');

    const fromEnv = resolveWorkspace({ cwd, env });
    assert.equal(fromEnv.root, envRoot, 'NOVAFLOW_WORKSPACE beats walk-up');
    assert.equal(fromEnv.source, 'env');

    const fromWalkup = resolveWorkspace({ cwd, env: box.env });
    assert.equal(fromWalkup.root, walkupRoot, 'walk-up beats a configured default');
    assert.equal(fromWalkup.source, 'walkup');

    const fromDefault = resolveWorkspace({ cwd: box.cwd, env: box.env });
    assert.equal(fromDefault.root, defaultRoot);
    assert.equal(fromDefault.source, 'default');
  });

  it('falls back to default_workspace when cwd is outside any workspace', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'personal');
    seedWorkspaceConfig(root, 'personal');
    registerWorkspace('personal', root, box.env);
    setDefaultWorkspace('personal', box.env);
    const resolved = resolveWorkspace({ cwd: box.cwd, env: box.env });
    assert.equal(resolved.root, root);
    assert.equal(resolved.source, 'default');
  });

  it('accepts a path in NOVAFLOW_WORKSPACE', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'via-env');
    seedWorkspaceConfig(root, 'via-env');
    const resolved = resolveWorkspace({ cwd: box.cwd, env: { ...box.env, NOVAFLOW_WORKSPACE: root } });
    assert.equal(resolved.root, root);
    assert.equal(resolved.source, 'env');
  });

  it('does not need workspaces.json for walk-up discovery', () => {
    const box = freshBox();
    const root = box.mkdir('personal');
    seedWorkspaceConfig(root, 'personal');
    assert.equal(existsSync(join(box.env.NOVAFLOW_HOME as string, 'workspaces.json')), false);
    assert.equal(resolveWorkspace({ cwd: root, env: box.env }).root, root);
  });

  it('fails WORKSPACE_NOT_FOUND exit 4 with remediation when nothing resolves', () => {
    const box = freshBox();
    assert.throws(
      () => resolveWorkspace({ cwd: box.cwd, env: box.env }),
      (error: unknown) => {
        assert.ok(isNovaError(error));
        assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
        assert.equal(error.exitCode, 4);
        assert.match(String(error.hint), /novaflow workspace create/);
        assert.match(String(error.hint), /novaflow workspace list/);
        return true;
      },
    );
  });

  it('fails WORKSPACE_NOT_FOUND for an unknown --workspace name and a path without .novaflow', () => {
    const box = freshBox();
    registerWorkspace('known', box.mkdir('known'), box.env);
    assert.throws(
      () => resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: 'unknown' }),
      expectNovaError('WORKSPACE_NOT_FOUND', 4),
    );
    assert.throws(
      () => resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: './not-a-workspace' }),
      expectNovaError('WORKSPACE_NOT_FOUND', 4),
    );
  });

  it('fails WORKSPACE_NOT_FOUND when a registered path no longer has .novaflow', () => {
    const box = freshBox();
    registerWorkspace('stale', box.mkdir('stale'), box.env);
    assert.throws(
      () => resolveWorkspace({ cwd: box.cwd, env: box.env, workspace: 'stale' }),
      expectNovaError('WORKSPACE_NOT_FOUND', 4),
    );
  });
});
