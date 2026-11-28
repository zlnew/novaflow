import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cliBox, createProject, createTask, createWorkspace } from './helpers.js';

const boxes: Array<ReturnType<typeof cliBox>> = [];
function makeBox(): ReturnType<typeof cliBox> {
  const box = cliBox();
  boxes.push(box);
  return box;
}
after(() => {
  for (const box of boxes) box.dispose();
});

describe('cli status', () => {
  it('emits the pinned board shape', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'board');
    const project = createProject(box, workspace, 'Board project');
    const ready = createTask(box, workspace, project, 'ready one');
    const started = createTask(box, workspace, project, 'started one');
    const blocked = createTask(box, workspace, project, 'blocked one');
    const waiting = createTask(box, workspace, project, 'waiting one', ['--depends-on', ready.key]);
    box.json(['task', 'start', started.key, '--by', 'alice', '-w', workspace.root]);
    box.json(['task', 'block', blocked.key, '--reason', 'decision', '-w', workspace.root]);

    const envelope = box.json(['status', '-w', workspace.root]);
    assert.equal(envelope.command, 'status');
    assert.deepEqual(Object.keys(envelope.data).sort(), ['blocked', 'counts', 'in_progress', 'ready', 'recent_events', 'workspace']);
    assert.deepEqual(
      Object.keys(envelope.data.counts).sort(),
      ['blocked', 'cancelled', 'done', 'in_progress', 'ready', 'todo', 'waiting'],
    );
    assert.equal(envelope.data.counts.todo, 2);
    assert.equal(envelope.data.counts.ready, 1);
    assert.equal(envelope.data.counts.waiting, 1);
    assert.equal(envelope.data.counts.in_progress, 1);
    assert.equal(envelope.data.counts.blocked, 1);
    assert.equal(envelope.data.counts.done, 0);
    assert.equal(envelope.data.counts.cancelled, 0);
    assert.deepEqual(envelope.data.in_progress.map((task: any) => task.key), [started.key]);
    assert.deepEqual(envelope.data.ready.map((task: any) => task.key), [ready.key]);
    assert.deepEqual(envelope.data.blocked.map((task: any) => task.key), [blocked.key]);
    assert.ok(Array.isArray(envelope.data.recent_events));
    assert.equal(envelope.data.workspace.name, 'board');
    void waiting;
  });

  it('filters the board to one project and prints a human board', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'board-project');
    const alpha = createProject(box, workspace, 'Alpha');
    const beta = createProject(box, workspace, 'Beta');
    createTask(box, workspace, alpha, 'alpha task');
    createTask(box, workspace, beta, 'beta task');

    const scoped = box.json(['status', '-w', workspace.root, '-p', alpha.slug]);
    assert.equal(scoped.data.counts.todo, 1);
    assert.equal(scoped.data.counts.total, undefined);
    assert.deepEqual(scoped.data.ready.map((task: any) => task.project_slug), [alpha.slug]);

    const human = box.run(['status', '-w', workspace.root]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /workspace/);
    assert.match(human.stdout, /todo/);

    const quiet = box.run(['status', '-w', workspace.root, '-q']);
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout, '');
  });
});

describe('cli events', () => {
  it('treats `events` and `events list` as the same query', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'events');
    const project = createProject(box, workspace, 'Events project');
    const task = createTask(box, workspace, project, 'evented');
    box.json(['task', 'start', task.key, '--by', 'alice', '-w', workspace.root]);

    const bare = box.json(['events', '-w', workspace.root]);
    const listed = box.json(['events', 'list', '-w', workspace.root]);
    assert.equal(bare.command, listed.command);
    assert.equal(bare.command, 'events.list');
    assert.deepEqual(
      bare.data.events.map((event: any) => event.seq),
      listed.data.events.map((event: any) => event.seq),
    );
    assert.ok(bare.data.events.length >= 3);
    assert.equal(bare.data.next_after_seq, bare.data.events[bare.data.events.length - 1].seq);
  });

  it('filters by --task, --after-seq and --limit', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'events-filter');
    const project = createProject(box, workspace, 'Filter project');
    const first = createTask(box, workspace, project, 'first');
    const second = createTask(box, workspace, project, 'second');

    const byTask = box.json(['events', '--task', second.key, '-w', workspace.root]);
    assert.ok(byTask.data.events.length > 0);
    assert.ok(byTask.data.events.every((event: any) => event.entity_id === second.id));

    const all = box.json(['events', '-w', workspace.root]);
    assert.equal(box.json(['events', '--limit', '1', '-w', workspace.root]).data.events.length, 1);
    const cursor = all.data.events[0].seq;
    const after = box.json(['events', '--after-seq', String(cursor), '-w', workspace.root]);
    assert.ok(after.data.events.every((event: any) => event.seq > cursor));
    assert.equal(after.data.events.length, all.data.events.length - 1);
    void first;
  });

  it('accepts relative and ISO --since values and rejects invalid ones', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'events-since');
    const project = createProject(box, workspace, 'Since project');
    createTask(box, workspace, project, 'recent');

    for (const since of ['30m', '7d', '2020-01-01', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00+02:00']) {
      const envelope = box.json(['events', '--since', since, '-w', workspace.root]);
      assert.ok(envelope.data.events.length >= 1, `expected events for --since ${since}`);
    }
    const future = box.json(['events', '--since', '2999-01-01T00:00:00Z', '-w', workspace.root]);
    assert.equal(future.data.events.length, 0);

    for (const bad of ['0m', 'abc', '5y', '2026-13-01']) {
      const error = box.jsonError(['events', '--since', bad, '-w', workspace.root]);
      assert.equal(error.code, 'VALIDATION_ERROR', `expected validation error for --since ${bad}`);
      assert.equal(box.run(['events', '--since', bad, '-w', workspace.root]).code, 2);
    }
  });

  it('prints one event id per line under --quiet', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'events-quiet');
    const project = createProject(box, workspace, 'Quiet project');
    createTask(box, workspace, project, 'quiet task');
    const envelope = box.json(['events', '-w', workspace.root]);
    const quiet = box.run(['events', '-w', workspace.root, '-q']);
    assert.equal(quiet.stdout, envelope.data.events.map((event: any) => event.id).join('\n') + '\n');
  });
});

describe('cli export', () => {
  it('prints the portable snapshot to stdout when --out is omitted', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'export-stdout');
    const project = createProject(box, workspace, 'Export project');
    const task = createTask(box, workspace, project, 'exported task');
    box.json(['task', 'note', task.key, 'a note', '-w', workspace.root]);

    const json = box.json(['export', '-w', workspace.root]);
    assert.equal(json.command, 'export');
    assert.equal(json.data.export_version, 1);
    assert.ok(json.data.projects.length >= 1);
    assert.ok(json.data.tasks.some((entry: any) => entry.key === task.key));
    assert.ok(json.data.notes.some((entry: any) => entry.task === task.key));

    const plain = box.run(['export', '-w', workspace.root]);
    assert.equal(plain.code, 0, plain.stderr);
    const snapshot = JSON.parse(plain.stdout);
    assert.equal(snapshot.export_version, 1);
    assert.equal(plain.stderr, '');
  });

  it('writes --out atomically and reports the file', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'export-file');
    const project = createProject(box, workspace, 'Export file project');
    createTask(box, workspace, project, 'exported');
    const out = join(box.box.root, 'artifacts', 'snapshot.json');

    const envelope = box.json(['export', '-w', workspace.root, '--out', out]);
    assert.equal(envelope.data.written, true);
    assert.equal(envelope.data.dry_run, false);
    assert.equal(envelope.data.out, out);
    assert.ok(envelope.data.bytes > 0);
    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(snapshot.export_version, 1);
    assert.equal(snapshot.workspace.name, 'export-file');

    const quiet = box.run(['export', '-w', workspace.root, '--out', join(box.box.root, 'snapshot2.json'), '-q']);
    assert.equal(quiet.stdout, join(box.box.root, 'snapshot2.json') + '\n');
  });

  it('--dry-run does not write the --out file', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'export-dry');
    const out = join(box.box.root, 'dry', 'snapshot.json');
    const envelope = box.json(['export', '-w', workspace.root, '--out', out, '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.written, false);
    assert.equal(existsSync(out), false);
  });
});

describe('cli extension hooks', () => {
  it('answers mcp and skill with a clean not-implemented VALIDATION_ERROR', () => {
    const box = makeBox();
    for (const args of [['mcp'], ['skill', 'install'], ['skill', 'status'], ['skill', 'uninstall']]) {
      const error = box.jsonError(args);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /not available in this build|not implemented/i);
      assert.notEqual(box.run(args).code, 0);
    }
  });
});
