/**
 * Per-call workspace resolution (`novaflow-v100/mcp` §1, `novaflow-v100/architecture` §5.1).
 *
 * Precedence under test: `workspace` tool param > `novaflow mcp --workspace` >
 * `NOVAFLOW_WORKSPACE` > `cwd` walk-up > `default_workspace` > `WORKSPACE_NOT_FOUND`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sandbox, type Sandbox } from '../store/helpers.js';
import { createHarness, type McpHarness } from './helpers.js';

let box: Sandbox;
let workspaceA: string;
let workspaceB: string;

/** Runs one call against a freshly started server, then closes it. */
async function withServer(
  options: Parameters<typeof createHarness>[1],
  fn: (h: McpHarness) => Promise<void>,
): Promise<void> {
  const created = await createHarness(box, options);
  try {
    await fn(created);
  } finally {
    await created.close();
  }
}

before(async () => {
  box = sandbox();
  const setup = await createHarness(box);
  try {
    const a = await setup.ok('novaflow_workspace_create', {
      name: 'ws-a',
      path: box.mkdir('a'),
      set_default: true,
    });
    const b = await setup.ok('novaflow_workspace_create', { name: 'ws-b', path: box.mkdir('b') });
    workspaceA = a.workspace.root;
    workspaceB = b.workspace.root;
  } finally {
    await setup.close();
  }
});

after(() => {
  box.dispose();
});

describe('workspace resolution', () => {
  it('falls back to the --workspace given to the server', async () => {
    await withServer({ workspace: workspaceA }, async (h) => {
      const board = await h.ok('novaflow_status');
      assert.equal(board.workspace.root, workspaceA);
    });
  });

  it('lets the per-call workspace param override the server --workspace', async () => {
    await withServer({ workspace: workspaceA }, async (h) => {
      const board = await h.ok('novaflow_status', { workspace: workspaceB });
      assert.equal(board.workspace.root, workspaceB);
    });
  });

  it('accepts a workspace name as the per-call param', async () => {
    await withServer({}, async (h) => {
      const board = await h.ok('novaflow_status', { workspace: 'ws-b' });
      assert.equal(board.workspace.root, workspaceB);
    });
  });

  it('falls back to NOVAFLOW_WORKSPACE when no flag or param is given', async () => {
    await withServer({ env: { ...box.env, NOVAFLOW_WORKSPACE: 'ws-b' } }, async (h) => {
      const board = await h.ok('novaflow_status');
      assert.equal(board.workspace.root, workspaceB);
    });
  });

  it('walks up from cwd to the nearest workspace', async () => {
    const nested = box.mkdir('a', 'nested', 'deeper');
    await withServer({ cwd: nested }, async (h) => {
      const board = await h.ok('novaflow_status');
      assert.equal(board.workspace.root, workspaceA);
    });
    assert.equal(join(workspaceA, 'nested', 'deeper'), nested);
  });

  it('falls back to the registry default_workspace', async () => {
    await withServer({ cwd: box.mkdir('outside') }, async (h) => {
      const board = await h.ok('novaflow_status');
      assert.equal(board.workspace.root, workspaceA);
    });
  });

  it('fails with WORKSPACE_NOT_FOUND when nothing resolves', async () => {
    const empty = sandbox();
    const created = await createHarness(empty, { cwd: empty.mkdir('nowhere') });
    try {
      await created.fail('novaflow_status', undefined, 'WORKSPACE_NOT_FOUND');
    } finally {
      await created.close();
      empty.dispose();
    }
  });

  it('pins next_actions to the workspace it actually resolved', async () => {
    const nested = box.mkdir('a', 'nested');
    await withServer({ cwd: nested }, async (h) => {
      const actions = await h.nextActions('novaflow_project_create', { title: 'Walk-up Project' });
      assert.ok(actions.length > 0);
      const workspace = actions[0]?.args.workspace;
      assert.equal(workspace, 'ws-a', 'the follow-up call names the resolved workspace');
      const shown = await h.ok('novaflow_workspace_show', { workspace });
      assert.equal(shown.root, workspaceA);
    });
  });

  it('resolves the same workspace for every workspace-scoped tool', async () => {
    await withServer({ workspace: workspaceB }, async (h) => {
      const project = await h.ok('novaflow_project_create', { title: 'Resolution Probe' });
      const task = await h.ok('novaflow_task_create', { project: project.project.slug, title: 'Probe task' });
      const status = await h.ok('novaflow_task_status', { id: task.task.key });
      assert.equal(status.task.key, task.task.key);
      const snapshot = await h.ok('novaflow_export');
      assert.equal(snapshot.workspace.root, workspaceB);
      assert.equal(snapshot.projects.length, 1);
    });
  });
});
