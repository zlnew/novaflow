/**
 * MCP parity suite: every tool in `novaflow-v100/mcp` §2 over the official SDK
 * client, plus the `novaflow-v100/mcp` §3 response and error contract.
 *
 * One ordered scenario drives all 30 tools end-to-end, then asserts the negative
 * contract (`isError: true`, canonical codes, MCP-shaped `next_actions`) and that
 * the CLI-only machine-local commands are absent from `tools/list`.
 */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  CLI_ONLY_TOOL_NAMES,
  TOOL_NAMES,
  harness,
  type McpHarness,
} from './helpers.js';

let h: McpHarness;
let root: string;
let projectSlug: string;
let archivedSlug: string;
let firstKey: string;
let secondKey: string;
let thirdKey: string;

before(async () => {
  h = await harness();
});

after(async () => {
  await h.close();
});

describe('tools/list', () => {
  it('exposes exactly the 30 documented tools', async () => {
    const tools = await h.tools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  });

  it('gives every tool a description and an object input schema', async () => {
    for (const tool of await h.tools()) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema must be an object`);
      assert.equal(typeof tool.description, 'string');
      assert.ok((tool.description as string).length > 0, `${tool.name} needs a description`);
    }
  });

  it('never exposes the CLI-only machine-local commands', async () => {
    const names = new Set((await h.tools()).map((tool) => tool.name));
    for (const absent of CLI_ONLY_TOOL_NAMES) {
      assert.equal(names.has(absent), false, `${absent} must stay CLI-only`);
    }
    assert.equal(
      [...names].some((name) => name.startsWith('novaflow_skill_')),
      false,
      'skill management must stay CLI-only',
    );
  });
});

describe('workspace tools', () => {
  it('novaflow_workspace_create scaffolds and registers the workspace', async () => {
    const created = await h.ok('novaflow_workspace_create', {
      name: 'parity',
      path: h.box.mkdir('ws', 'parity'),
    });
    root = created.workspace.root;
    assert.equal(root, resolve(h.box.path('ws', 'parity')));
    assert.equal(created.workspace.name, 'parity');
    assert.equal(created.workspace.path, join(root, '.novaflow'));
  });

  it('novaflow_workspace_list lists the registered workspace', async () => {
    const listed = await h.ok('novaflow_workspace_list');
    assert.equal(listed.workspaces.length, 1);
    assert.equal(listed.workspaces[0].name, 'parity');
    assert.equal(listed.workspaces[0].exists, true);
  });

  it('novaflow_workspace_show resolves the workspace by name and by path', async () => {
    const byPath = await h.ok('novaflow_workspace_show', { workspace: root });
    assert.equal(byPath.name, 'parity');
    assert.equal(byPath.root, root);

    const byName = await h.ok('novaflow_workspace_show', { workspace: 'parity' });
    assert.equal(byName.root, root);
  });
});

describe('project tools', () => {
  it('novaflow_project_create derives slug and prefix', async () => {
    const created = await h.ok('novaflow_project_create', {
      workspace: root,
      title: 'Parity Ledger',
      objective: 'Track parity',
      repo_path: 'repo/parity',
      tags: ['alpha'],
    });
    projectSlug = created.project.slug;
    assert.equal(projectSlug, 'parity-ledger');
    assert.deepEqual(created.project.tags, ['alpha']);
    assert.equal(created.project.repo_path, 'repo/parity');
    assert.match(created.project.prefix, /^[A-Z][A-Z0-9]{1,7}$/);
  });

  it('novaflow_project_list and novaflow_project_show read the project back', async () => {
    const listed = await h.ok('novaflow_project_list', { workspace: root });
    assert.deepEqual(listed.projects.map((project: { slug: string }) => project.slug), [projectSlug]);

    const shown = await h.ok('novaflow_project_show', { workspace: root, project: projectSlug });
    assert.equal(shown.slug, projectSlug);
    assert.equal(shown.counts.total, 0);
  });

  it('novaflow_project_update replaces tags and clears nullable fields with null or ""', async () => {
    const updated = await h.ok('novaflow_project_update', {
      workspace: root,
      project: projectSlug,
      title: 'Parity Ledger v2',
      objective: 'Updated objective',
      tags: ['beta', 'gamma'],
    });
    assert.deepEqual(updated.project.tags, ['beta', 'gamma']);
    assert.equal(updated.project.title, 'Parity Ledger v2');

    const cleared = await h.ok('novaflow_project_update', {
      workspace: root,
      project: projectSlug,
      objective: null,
      repo_path: '',
      verify_cmd: null,
      tags: null,
    });
    assert.equal(cleared.project.objective, '');
    assert.equal(cleared.project.repo_path, null);
    assert.equal(cleared.project.verify_cmd, null);
    assert.deepEqual(cleared.project.tags, []);
  });

  it('rejects null for a non-nullable project field', async () => {
    const error = await h.fail(
      'novaflow_project_update',
      { workspace: root, project: projectSlug, title: null },
      'VALIDATION_ERROR',
    );
    assert.match(error.message, /title/i);
  });

  it('novaflow_project_archive moves a project to archived', async () => {
    const created = await h.ok('novaflow_project_create', { workspace: root, title: 'Archive Me' });
    archivedSlug = created.project.slug;
    const archived = await h.ok('novaflow_project_archive', { workspace: root, project: archivedSlug });
    assert.equal(archived.project.status, 'archived');
    assert.equal(archived.changed.includes('status'), true);

    const active = await h.ok('novaflow_project_list', { workspace: root });
    assert.deepEqual(active.projects.map((project: { slug: string }) => project.slug), [projectSlug]);
  });
});

describe('workspace defaults', () => {
  it('novaflow_workspace_update sets and clears the default project', async () => {
    const set = await h.ok('novaflow_workspace_update', { workspace: root, default_project: projectSlug });
    assert.equal(set.workspace.defaults.project, projectSlug);
    assert.equal(set.changed.includes('default_project'), true);

    const cleared = await h.ok('novaflow_workspace_update', { workspace: root, default_project: null });
    assert.equal(cleared.workspace.defaults.project, null);
  });
});

describe('task tools', () => {
  it('novaflow_task_create allocates keys and honours depends_on', async () => {
    const first = await h.ok('novaflow_task_create', {
      workspace: root,
      project: projectSlug,
      title: 'First task',
      assignee: 'alice',
      tags: ['x'],
      priority: 'high',
    });
    firstKey = first.task.key;
    assert.equal(first.task.status, 'todo');
    assert.deepEqual(first.task.tags, ['x']);

    const second = await h.ok('novaflow_task_create', {
      workspace: root,
      project: projectSlug,
      title: 'Second task',
      depends_on: [firstKey],
    });
    secondKey = second.task.key;
    assert.notEqual(secondKey, firstKey);
    assert.deepEqual(second.task.unmet_deps.map((dep: { key: string }) => dep.key), [firstKey]);
  });

  it('novaflow_task_list and novaflow_task_next separate ready from waiting', async () => {
    const listed = await h.ok('novaflow_task_list', { workspace: root, project: projectSlug });
    assert.deepEqual(listed.tasks.map((task: { key: string }) => task.key), [firstKey, secondKey]);

    const ready = await h.ok('novaflow_task_next', { workspace: root, project: projectSlug });
    assert.deepEqual(ready.tasks.map((task: { key: string }) => task.key), [firstKey]);

    const waiting = await h.ok('novaflow_task_list', {
      workspace: root,
      project: projectSlug,
      status: ['todo'],
      ready: true,
    });
    assert.deepEqual(waiting.tasks.map((task: { key: string }) => task.key), [firstKey]);
  });

  it('novaflow_task_status and novaflow_task_context return state and handoff bundle', async () => {
    const status = await h.ok('novaflow_task_status', { workspace: root, id: secondKey });
    assert.equal(status.task.key, secondKey);
    assert.equal(status.task.is_ready, false);
    assert.deepEqual(status.counts, { notes: 0, artifacts: 0, dependencies: 1, dependents: 0 });

    const context = await h.ok('novaflow_task_context', { workspace: root, id: secondKey });
    assert.equal(context.task.key, secondKey);
    assert.deepEqual(context.upstream.map((entry: { key: string }) => entry.key), [firstKey]);
    assert.equal(context.project.slug, projectSlug);
    assert.deepEqual(context.downstream, []);
  });

  it('novaflow_task_update replaces tags and clears nullable fields', async () => {
    const updated = await h.ok('novaflow_task_update', {
      workspace: root,
      id: secondKey,
      objective: 'Wire the ledger',
      assignee: 'bob',
      priority: 'urgent',
      tags: ['backend'],
    });
    assert.equal(updated.task.assignee, 'bob');
    assert.equal(updated.task.priority, 'urgent');
    assert.deepEqual(updated.task.tags, ['backend']);

    const cleared = await h.ok('novaflow_task_update', {
      workspace: root,
      id: secondKey,
      objective: '',
      assignee: null,
      tags: null,
    });
    assert.equal(cleared.task.objective, '');
    assert.equal(cleared.task.assignee, null);
    assert.deepEqual(cleared.task.tags, []);
  });

  it('novaflow_task_start claims the task with a lease', async () => {
    const started = await h.ok('novaflow_task_start', {
      workspace: root,
      id: firstKey,
      by: 'alice',
      session_ref: 'session://parity',
      lease_sec: 600,
      note: 'starting',
    });
    assert.equal(started.task.status, 'in_progress');
    assert.equal(started.task.claimed_by, 'alice');
    assert.equal(started.task.session_ref, 'session://parity');
    assert.notEqual(started.task.lease_expires_at, null);
  });

  it('novaflow_task_note and novaflow_task_attach extend the handoff bundle', async () => {
    const noted = await h.ok('novaflow_task_note', {
      workspace: root,
      id: firstKey,
      message: 'progress recorded',
      by: 'alice',
    });
    assert.equal(noted.note.body, 'progress recorded');

    const attached = await h.ok('novaflow_task_attach', {
      workspace: root,
      id: firstKey,
      uri: 'src/mcp/tools.ts',
      label: 'MCP tools',
      kind: 'file',
    });
    assert.equal(attached.artifact.uri, 'src/mcp/tools.ts');
    assert.equal(attached.artifact.kind, 'file');

    const context = await h.ok('novaflow_task_context', { workspace: root, id: firstKey });
    assert.equal(context.notes.length, 2, 'the start note and the progress note are both kept');
    assert.equal(
      context.notes.some((note: { body: string }) => note.body === 'progress recorded'),
      true,
    );
    assert.equal(context.artifacts.length, 1);
    assert.equal(context.artifacts[0].uri, 'src/mcp/tools.ts');
  });

  it('novaflow_task_claim and novaflow_task_release manage the lease', async () => {
    const claimed = await h.ok('novaflow_task_claim', { workspace: root, id: secondKey, by: 'bob' });
    assert.equal(claimed.task.claimed_by, 'bob');
    assert.equal(claimed.task.status, 'todo');

    const released = await h.ok('novaflow_task_release', { workspace: root, id: secondKey, by: 'bob' });
    assert.equal(released.task.claimed_by, null);
    assert.equal(released.task.lease_expires_at, null);
  });

  it('novaflow_task_depend is idempotent and novaflow_task_undepend removes the edge', async () => {
    const again = await h.ok('novaflow_task_depend', { workspace: root, id: secondKey, on: firstKey });
    assert.equal(again.changed, false, 'an existing edge is a documented no-op');

    const removed = await h.ok('novaflow_task_undepend', { workspace: root, id: secondKey, on: firstKey });
    assert.equal(removed.changed, true);
    assert.deepEqual(removed.task.unmet_deps, []);
  });

  it('novaflow_task_block and novaflow_task_unblock round-trip the blocker', async () => {
    const blocked = await h.ok('novaflow_task_block', {
      workspace: root,
      id: secondKey,
      reason: 'waiting on upstream decision',
      waiting_on: 'decision://keys',
      by: 'bob',
    });
    assert.equal(blocked.task.status, 'blocked');
    assert.equal(blocked.task.block_reason, 'waiting on upstream decision');
    assert.equal(blocked.task.blocked_by_ref, 'decision://keys');

    const unblocked = await h.ok('novaflow_task_unblock', {
      workspace: root,
      id: secondKey,
      note: 'decision landed',
      start: true,
      by: 'bob',
    });
    assert.equal(unblocked.task.status, 'in_progress');
    assert.equal(unblocked.task.block_reason, null);
  });

  it('novaflow_task_complete records the summary and artifacts', async () => {
    const completed = await h.ok('novaflow_task_complete', {
      workspace: root,
      id: firstKey,
      summary: 'MCP server landed',
      by: 'alice',
      artifacts: [{ uri: 'https://example.test/pr/1', label: 'PR 1', kind: 'pr' }],
    });
    assert.equal(completed.task.status, 'done');
    assert.equal(completed.task.summary, 'MCP server landed');

    const context = await h.ok('novaflow_task_context', { workspace: root, id: firstKey });
    assert.deepEqual(
      context.artifacts.map((artifact: { uri: string }) => artifact.uri),
      ['src/mcp/tools.ts', 'https://example.test/pr/1'],
    );
  });

  it('novaflow_task_cancel and novaflow_task_reopen return the task to todo', async () => {
    const cancelled = await h.ok('novaflow_task_cancel', {
      workspace: root,
      id: secondKey,
      reason: 'superseded',
      by: 'bob',
    });
    assert.equal(cancelled.task.status, 'cancelled');

    const reopened = await h.ok('novaflow_task_reopen', {
      workspace: root,
      id: secondKey,
      reason: 'needed again',
      by: 'bob',
    });
    assert.equal(reopened.task.status, 'todo');
    assert.equal(reopened.task.completed_at, null);
  });
});

describe('board and export tools', () => {
  it('novaflow_status summarises the workspace or one project', async () => {
    const board = await h.ok('novaflow_status', { workspace: root });
    assert.equal(board.workspace.root, root);
    assert.equal(board.counts.total, 2);
    assert.equal(board.counts.done, 1);

    const scoped = await h.ok('novaflow_status', { workspace: root, project: projectSlug });
    assert.equal(scoped.project.slug, projectSlug);
    assert.equal(scoped.counts.total, 2);
  });

  it('novaflow_events_list reads the audit log with a polling cursor', async () => {
    const listed = await h.ok('novaflow_events_list', { workspace: root, limit: 5 });
    assert.equal(listed.events.length, 5);
    assert.equal(typeof listed.next_after_seq, 'number');

    const next = await h.ok('novaflow_events_list', {
      workspace: root,
      after_seq: listed.next_after_seq,
      limit: 5,
    });
    for (const event of next.events) {
      assert.ok(event.seq > listed.next_after_seq);
    }
  });

  it('novaflow_export returns a portable snapshot', async () => {
    const snapshot = await h.ok('novaflow_export', { workspace: root });
    assert.equal(snapshot.export_version, 1);
    assert.equal(snapshot.workspace.name, 'parity');
    assert.equal(snapshot.projects.length, 2, 'archived projects are exported too');
    assert.equal(snapshot.tasks.length, 2);
    assert.ok(snapshot.events.length > 0);
  });
});

describe('response contract', () => {
  it('uses MCP tool names and args in next_actions', async () => {
    const created = await h.ok('novaflow_task_create', {
      workspace: root,
      project: projectSlug,
      title: 'Next action probe',
    });
    thirdKey = created.task.key;

    const actions = await h.nextActions('novaflow_task_create', {
      workspace: root,
      project: projectSlug,
      title: 'Next action probe 2',
    });
    assert.ok(actions.length > 0, 'mutating tools advertise follow-ups');
    const known = new Set(TOOL_NAMES);
    for (const action of actions) {
      assert.equal(typeof action.tool, 'string');
      assert.equal(known.has(action.tool as (typeof TOOL_NAMES)[number]), true, `unknown tool ${action.tool}`);
      assert.equal(typeof action.args, 'object');
      assert.equal(typeof action.description, 'string');
      assert.equal('command' in action, false, 'next_actions must not be shell strings');
    }
  });

  it('returns isError: true with canonical codes instead of throwing', async () => {
    const notFound = await h.fail('novaflow_task_status', { workspace: root, id: 'ZZZ-9' }, 'NOT_FOUND');
    assert.match(notFound.message, /ZZZ-9/);

    await h.fail('novaflow_task_start', { workspace: root, id: firstKey }, 'STATE_CONFLICT');
    await h.fail('novaflow_status', { workspace: 'missing-workspace' }, 'WORKSPACE_NOT_FOUND');
    await h.fail('novaflow_task_create', { workspace: root, project: projectSlug }, 'VALIDATION_ERROR');
  });

  it('maps graph and claim conflicts to their canonical codes', async () => {
    const depended = await h.ok('novaflow_task_depend', { workspace: root, id: secondKey, on: firstKey });
    assert.equal(depended.changed, true);
    await h.fail('novaflow_task_depend', { workspace: root, id: firstKey, on: secondKey }, 'CYCLE_DETECTED');
    await h.ok('novaflow_task_undepend', { workspace: root, id: secondKey, on: firstKey });

    await h.ok('novaflow_task_claim', { workspace: root, id: secondKey, by: 'bob' });
    await h.fail(
      'novaflow_task_start',
      { workspace: root, id: secondKey, by: 'alice' },
      'ALREADY_CLAIMED',
    );
    await h.ok('novaflow_task_release', { workspace: root, id: secondKey, by: 'bob' });

    await h.ok('novaflow_task_depend', { workspace: root, id: thirdKey, on: secondKey });
    await h.fail(
      'novaflow_task_start',
      { workspace: root, id: thirdKey, by: 'carol' },
      'UNMET_DEPENDENCIES',
    );
  });

  it('answers an unknown tool with a JSON-RPC error and stays healthy', async () => {
    await assert.rejects(() => h.call('novaflow_not_a_tool'), /not (found|available)/i);
    assert.equal((await h.tools()).length, 30, 'the server keeps serving after a bad request');
  });
});

describe('coverage', () => {
  it('exercised every one of the 30 tools in this run', () => {
    const called = new Set(h.calls);
    const missing = TOOL_NAMES.filter((name) => !called.has(name));
    assert.deepEqual(missing, [], `tools never called: ${missing.join(', ')}`);
  });
});
