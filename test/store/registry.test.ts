import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  emptyRegistry,
  lookupWorkspace,
  readRegistry,
  registerWorkspace,
  registryFilePath,
  setDefaultWorkspace,
  unregisterWorkspace,
  writeRegistry,
} from '../../src/store/registry.js';
import { isNovaError } from '../../src/store/errors.js';
import { sandbox } from './helpers.js';

describe('store/registry', () => {
  const boxes: Array<{ dispose(): void }> = [];

  after(() => {
    for (const box of boxes) box.dispose();
  });

  function freshBox() {
    const box = sandbox();
    boxes.push(box);
    return box;
  }

  it('resolves NOVAFLOW_HOME/workspaces.json when NOVAFLOW_HOME is set', () => {
    const box = freshBox();
    assert.equal(registryFilePath(box.env), join(box.env.NOVAFLOW_HOME as string, 'workspaces.json'));
  });

  it('falls back to XDG_CONFIG_HOME/novaflow/workspaces.json', () => {
    const box = freshBox();
    const env = { XDG_CONFIG_HOME: box.xdg, HOME: box.home };
    assert.equal(registryFilePath(env), join(box.xdg, 'novaflow', 'workspaces.json'));
  });

  it('falls back to HOME/.config/novaflow/workspaces.json without XDG_CONFIG_HOME', () => {
    const box = freshBox();
    assert.equal(registryFilePath({ HOME: box.home }), join(box.home, '.config', 'novaflow', 'workspaces.json'));
  });

  it('starts from an empty registry when the file is missing', () => {
    const box = freshBox();
    assert.deepEqual(readRegistry(box.env), emptyRegistry());
    assert.equal(existsSync(registryFilePath(box.env)), false, 'reading must not create the file');
  });

  it('writes atomically: valid JSON and no leftover temp files', () => {
    const box = freshBox();
    const registry = registerWorkspace('personal', join(box.root, 'ws-personal'), box.env);
    const file = registryFilePath(box.env);
    assert.deepEqual(readdirSync(dirname(file)), ['workspaces.json']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), registry);
    writeRegistry(registry, box.env);
    assert.deepEqual(readdirSync(dirname(file)), ['workspaces.json']);
  });

  it('registerWorkspace stores an absolute path with an ISO registered_at', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'personal');
    const registry = registerWorkspace('personal', root, box.env);
    const entry = registry.workspaces.personal;
    assert.ok(entry);
    assert.equal(entry.path, root);
    assert.equal(new Date(entry.registered_at).toISOString(), entry.registered_at);
    assert.equal(registry.version, 1);
    assert.equal(registry.default_workspace, null);
    assert.deepEqual(readRegistry(box.env), registry);
  });

  it('registerWorkspace re-points an existing name at the new path', () => {
    const box = freshBox();
    const first = box.mkdir('ws', 'first');
    const second = box.mkdir('ws', 'second');
    registerWorkspace('personal', first, box.env);
    const registry = registerWorkspace('personal', second, box.env);
    assert.equal(registry.workspaces.personal?.path, second);
  });

  it('unregisterWorkspace removes only the named entry', () => {
    const box = freshBox();
    registerWorkspace('one', box.mkdir('ws', 'one'), box.env);
    registerWorkspace('two', box.mkdir('ws', 'two'), box.env);
    const registry = unregisterWorkspace('one', box.env);
    assert.deepEqual(Object.keys(registry.workspaces), ['two']);
    assert.deepEqual(readRegistry(box.env), registry);
    assert.deepEqual(unregisterWorkspace('missing', box.env), registry, 'unknown name is a no-op');
  });

  it('setDefaultWorkspace sets and clears default_workspace', () => {
    const box = freshBox();
    registerWorkspace('personal', box.mkdir('ws', 'personal'), box.env);
    assert.equal(setDefaultWorkspace('personal', box.env).default_workspace, 'personal');
    assert.equal(readRegistry(box.env).default_workspace, 'personal');
    assert.equal(setDefaultWorkspace(null, box.env).default_workspace, null);
  });

  it('lookupWorkspace returns the entry or undefined', () => {
    const box = freshBox();
    const root = box.mkdir('ws', 'personal');
    registerWorkspace('personal', root, box.env);
    assert.equal(lookupWorkspace('personal', box.env)?.path, root);
    assert.equal(lookupWorkspace('nope', box.env), undefined);
  });

  it('survives a deleted registry file (missing means empty, not broken)', () => {
    const box = freshBox();
    registerWorkspace('personal', box.mkdir('ws', 'personal'), box.env);
    rmSync(registryFilePath(box.env));
    assert.deepEqual(readRegistry(box.env), emptyRegistry());
  });

  it('fails with INTERNAL_ERROR (exit 1) on a corrupt registry file', () => {
    const box = freshBox();
    const file = registryFilePath(box.env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json', 'utf8');
    assert.throws(
      () => readRegistry(box.env),
      (error: unknown) => {
        assert.ok(isNovaError(error));
        assert.equal(error.code, 'INTERNAL_ERROR');
        assert.equal(error.exitCode, 1);
        return true;
      },
    );
  });
});
