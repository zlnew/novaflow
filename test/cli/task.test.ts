import assert from 'node:assert/strict';
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

/** Workspace + one project, the shape most task tests need. */
function fixture(name: string): {
  box: ReturnType<typeof cliBox>;
  root: string;
  project: { slug: string; prefix: string };
  ws: string[];
} {
  const box = makeBox();
  const workspace = createWorkspace(box, name);
  const project = createProject(box, workspace, `${name} project`);
  return { box, root: workspace.root, project, ws: ['-w', workspace.root, '-p', project.slug] };
}

describe('cli task create', () => {
  it('allocates PREFIX-N, defaults to todo/medium and prints the key under --quiet', () => {
    const { box, ws, project } = fixture('create');
    const envelope = box.json(['task', 'create', '--title', 'jwt-authentication', '--assignee', 'backend-agent', '--priority', 'high', '--tag', 'auth', ...ws]);
    const task = envelope.data.task;
    assert.equal(envelope.command, 'task.create');
    assert.equal(task.key, `${project.prefix}-1`);
    assert.equal(task.slug, 'jwt-authentication');
    assert.equal(task.status, 'todo');
    assert.equal(task.priority, 'high');
    assert.equal(task.assignee, 'backend-agent');
    assert.deepEqual(task.tags, ['auth']);
    assert.equal(task.is_ready, true);
    assert.equal(envelope.data.idempotent_hit, false);
    assert.ok(envelope.next_actions.some((action) => /task start/.test(action.command)));

    const quiet = box.run(['task', 'create', '--title', 'second', ...ws, '-q']);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stdout, `${project.prefix}-2\n`);
  });

  it('creates dependency edges from a comma-separated --depends-on list', () => {
    const { box, root, project, ws } = fixture('deps');
    const first = createTask(box, { root }, project, 'first');
    const second = createTask(box, { root }, project, 'second');
    const envelope = box.json([
      'task',
      'create',
      '--title',
      'third',
      '--depends-on',
      `${first.key},${second.key}`,
      ...ws,
    ]);
    assert.deepEqual(
      envelope.data.task.unmet_deps.map((dep: any) => dep.key),
      [first.key, second.key],
    );
    assert.equal(envelope.data.task.is_ready, false);

    const ready = box.json(['task', 'list', '--ready', ...ws]);
    assert.deepEqual(
      ready.data.tasks.map((task: any) => task.key),
      [first.key, second.key],
    );
  });

  it('is idempotent on an exact --idempotency-key hit without touching fields', () => {
    const { box, root, project, ws } = fixture('idempotent');
    const first = box.json(['task', 'create', '--title', 'once', '--idempotency-key', 'run-1', ...ws]);
    const again = box.json(['task', 'create', '--title', 'different title', '--idempotency-key', 'run-1', ...ws]);
    assert.equal(again.data.idempotent_hit, true);
    assert.equal(again.data.task.key, first.data.task.key);
    assert.equal(again.data.task.title, 'once');
    assert.deepEqual(again.next_actions, []);
  });

  it('fails exit 2 without --title or without a resolvable project', () => {
    const { box, root, project, ws } = fixture('create-errors');
    assert.equal(box.jsonError(['task', 'create', ...ws]).code, 'VALIDATION_ERROR');

    const bare = box.box.mkdir('bare-ws');
    box.json(['workspace', 'create', '--name', 'bare-ws', '--path', bare]);
    const error = box.jsonError(['task', 'create', '--title', 'orphan', '-w', bare]);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /No project selected/);
    assert.match(error.hint ?? '', /--project/);

    assert.equal(box.jsonError(['task', 'create', '--title', 'bad', '--priority', 'nope', ...ws]).code, 'VALIDATION_ERROR');
    void root;
  });

  it('resolves the default project from config.yaml', () => {
    const { box, root, project, ws } = fixture('default-project');
    box.json(['workspace', 'update', '--default-project', project.slug, '-w', root]);
    const envelope = box.json(['task', 'create', '--title', 'implicit', '-w', root]);
    assert.equal(envelope.data.task.project_slug, project.slug);
    void ws;
  });
});

describe('cli task list and next', () => {
  it('filters by repeatable and csv --status, --assignee, --tag and --limit', () => {
    const { box, root, project, ws } = fixture('filters');
    const one = createTask(box, { root }, project, 'one', ['--assignee', 'alice', '--tag', 'auth']);
    const two = createTask(box, { root }, project, 'two', ['--assignee', 'bob']);
    const three = createTask(box, { root }, project, 'three');
    box.json(['task', 'start', one.key, '--by', 'alice', ...ws]);
    box.json(['task', 'start', two.key, ...ws]);
    box.json(['task', 'complete', two.key, ...ws]);

    const repeat = box.json(['task', 'list', '--status', 'in_progress', '--status', 'done', ...ws]);
    assert.deepEqual(repeat.data.tasks.map((task: any) => task.key).sort(), [one.key, two.key].sort());

    const csv = box.json(['task', 'list', '--status', 'done,todo', ...ws]);
    assert.deepEqual(csv.data.tasks.map((task: any) => task.key).sort(), [two.key, three.key].sort());

    const byAssignee = box.json(['task', 'list', '--assignee', 'alice', ...ws]);
    assert.deepEqual(byAssignee.data.tasks.map((task: any) => task.key), [one.key]);

    const byTag = box.json(['task', 'list', '--tag', 'auth', ...ws]);
    assert.deepEqual(byTag.data.tasks.map((task: any) => task.key), [one.key]);

    const byClaim = box.json(['task', 'list', '--claimed-by', 'alice', ...ws]);
    assert.deepEqual(byClaim.data.tasks.map((task: any) => task.key), [one.key]);

    const limited = box.json(['task', 'list', '--limit', '1', ...ws]);
    assert.equal(limited.data.tasks.length, 1);

    const quiet = box.run(['task', 'list', ...ws, '-q']);
    assert.equal(quiet.stdout, [one.key, two.key, three.key].join('\n') + '\n');
  });

  it('lists across every project when --project is omitted', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'multi-project');
    const alpha = createProject(box, workspace, 'Alpha board');
    const beta = createProject(box, workspace, 'Beta board');
    createTask(box, workspace, alpha, 'alpha task');
    createTask(box, workspace, beta, 'beta task');
    const envelope = box.json(['task', 'list', '-w', workspace.root]);
    assert.equal(envelope.data.tasks.length, 2);
  });

  it('returns ready work ordered by priority then creation, default limit 10', () => {
    const { box, root, project, ws } = fixture('next');
    const low = createTask(box, { root }, project, 'low', ['--priority', 'low']);
    const urgent = createTask(box, { root }, project, 'urgent', ['--priority', 'urgent']);
    const medium = createTask(box, { root }, project, 'medium');

    const envelope = box.json(['task', 'next', ...ws]);
    assert.equal(envelope.command, 'task.next');
    assert.deepEqual(envelope.data.tasks.map((task: any) => task.key), [urgent.key, medium.key, low.key]);

    for (let index = 0; index < 10; index += 1) {
      createTask(box, { root }, project, `extra-${index}`);
    }
    assert.equal(box.json(['task', 'next', ...ws]).data.tasks.length, 10);
    assert.equal(box.json(['task', 'next', '--limit', '2', ...ws]).data.tasks.length, 2);
  });
});

describe('cli task read views', () => {
  it('shows full task state with counts and recent events', () => {
    const { box, root, project, ws } = fixture('status');
    const task = createTask(box, { root }, project, 'inspectable');
    box.json(['task', 'note', task.key, 'first note', ...ws]);

    const envelope = box.json(['task', 'status', task.key, ...ws]);
    assert.equal(envelope.command, 'task.status');
    assert.equal(envelope.data.task.key, task.key);
    assert.equal(envelope.data.counts.notes, 1);
    assert.equal(envelope.data.counts.artifacts, 0);
    assert.ok(envelope.data.recent_events.length >= 2);

    const human = box.run(['task', 'status', task.key, ...ws]);
    assert.match(human.stdout, new RegExp(task.key));
    assert.match(human.stdout, /status/);
  });

  it('assembles the handoff context with upstream and downstream', () => {
    const { box, root, project, ws } = fixture('context');
    const upstream = createTask(box, { root }, project, 'upstream');
    box.json(['task', 'complete', upstream.key, '--summary', 'shipped', '--artifact', 'src/auth/jwt.ts', ...ws]);
    const downstream = createTask(box, { root }, project, 'downstream', ['--depends-on', upstream.key]);

    const envelope = box.json(['task', 'context', downstream.key, ...ws]);
    assert.equal(envelope.command, 'task.context');
    assert.equal(envelope.data.task.key, downstream.key);
    assert.equal(envelope.data.project.slug, project.slug);
    assert.equal(envelope.data.upstream.length, 1);
    assert.equal(envelope.data.upstream[0].key, upstream.key);
    assert.equal(envelope.data.upstream[0].summary, 'shipped');
    assert.deepEqual(envelope.data.upstream[0].artifacts.map((artifact: any) => artifact.uri), ['src/auth/jwt.ts']);
  });

  it('looks task keys up case-insensitively and fails exit 4 for unknown keys', () => {
    const { box, root, project, ws } = fixture('lookup');
    const task = createTask(box, { root }, project, 'cased');
    const envelope = box.json(['task', 'status', task.key.toLowerCase(), ...ws]);
    assert.equal(envelope.data.task.key, task.key);
    assert.equal(box.jsonError(['task', 'status', 'ZZZ-9', ...ws]).code, 'NOT_FOUND');
  });
});

describe('cli task update', () => {
  it('updates fields, clears nullable ones and replaces tags', () => {
    const { box, root, project, ws } = fixture('task-update');
    const task = createTask(box, { root }, project, 'editable', [
      '--objective',
      'original',
      '--assignee',
      'alice',
      '--tag',
      'one',
      '--tag',
      'two',
    ]);

    const tags = box.json(['task', 'update', task.key, '--tag', 'three', ...ws]);
    assert.deepEqual(tags.data.task.tags, ['three']);

    const clearedTags = box.json(['task', 'update', task.key, '--clear-tags', ...ws]);
    assert.deepEqual(clearedTags.data.task.tags, []);

    const clearedObjective = box.json(['task', 'update', task.key, '--clear-objective', ...ws]);
    assert.equal(clearedObjective.data.task.objective, '');

    const clearedAssignee = box.json(['task', 'update', task.key, '--clear-assignee', ...ws]);
    assert.equal(clearedAssignee.data.task.assignee, null);

    const renamed = box.json(['task', 'update', task.key, '--title', 'renamed', '--priority', 'urgent', ...ws]);
    assert.equal(renamed.data.task.title, 'renamed');
    assert.equal(renamed.data.task.priority, 'urgent');
    assert.equal(renamed.data.task.status, 'todo');

    const noop = box.json(['task', 'update', task.key, ...ws]);
    assert.equal(noop.data.changed, false);
  });
});

describe('cli task lifecycle', () => {
  it('starts a task with actor, session ref and lease', () => {
    const { box, root, project, ws } = fixture('start');
    const task = createTask(box, { root }, project, 'startable');
    const envelope = box.json(['task', 'start', task.key, '--by', 't3-agent', '--ref', 'thread://abc123', '--lease', '60', '--note', 'begun', ...ws]);
    assert.equal(envelope.command, 'task.start');
    assert.equal(envelope.data.task.status, 'in_progress');
    assert.equal(envelope.data.task.claimed_by, 't3-agent');
    assert.equal(envelope.data.task.session_ref, 'thread://abc123');
    assert.ok(envelope.data.task.lease_expires_at !== null);
    assert.equal(envelope.data.from_state, 'todo');
    assert.equal(envelope.data.to_state, 'in_progress');
    assert.ok(envelope.next_actions.some((action) => /task complete/.test(action.command)));
  });

  it('refuses an unmet dependency with exit 3 and --force overrides it', () => {
    const { box, root, project, ws } = fixture('unmet');
    const first = createTask(box, { root }, project, 'first');
    const second = createTask(box, { root }, project, 'second', ['--depends-on', first.key]);

    const error = box.jsonError(['task', 'start', second.key, ...ws]);
    assert.equal(error.code, 'UNMET_DEPENDENCIES');
    assert.match(error.message, new RegExp(first.key));
    assert.equal(box.run(['task', 'start', second.key, ...ws]).code, 3);

    const forced = box.json(['task', 'start', second.key, '--force', ...ws]);
    assert.equal(forced.data.task.status, 'in_progress');
  });

  it('refuses a live claim with ALREADY_CLAIMED exit 3', () => {
    const { box, root, project, ws } = fixture('claimed');
    const task = createTask(box, { root }, project, 'contested');
    box.json(['task', 'start', task.key, '--by', 'alice', ...ws]);

    const error = box.jsonError(['task', 'start', task.key, '--by', 'bob', ...ws]);
    assert.equal(error.code, 'ALREADY_CLAIMED');
    assert.match(error.hint ?? '', /--force/);

    const claimed = box.json(['task', 'claim', task.key, '--by', 'bob', '--force', ...ws]);
    assert.equal(claimed.data.task.claimed_by, 'bob');

    assert.equal(box.jsonError(['task', 'claim', task.key, ...ws]).code, 'VALIDATION_ERROR');
  });

  it('refuses to start a blocked task and requires unblock --start', () => {
    const { box, root, project, ws } = fixture('blocked-start');
    const task = createTask(box, { root }, project, 'blocked-task');
    box.json(['task', 'block', task.key, '--reason', 'waiting on decision', ...ws]);

    const error = box.jsonError(['task', 'start', task.key, ...ws]);
    assert.equal(error.code, 'STATE_CONFLICT');
    assert.match(error.hint ?? '', /unblock/);

    const resumed = box.json(['task', 'unblock', task.key, '--start', '--by', 'alice', ...ws]);
    assert.equal(resumed.data.task.status, 'in_progress');
    assert.equal(resumed.data.task.block_reason, null);
  });

  it('blocks with a reason or --on, and --on adds a cycle-checked dependency', () => {
    const { box, root, project, ws } = fixture('block-errors');
    const task = createTask(box, { root }, project, 'blocked');
    assert.equal(box.jsonError(['task', 'block', task.key, ...ws]).code, 'VALIDATION_ERROR');

    const other = createTask(box, { root }, project, 'other');
    const envelope = box.json(['task', 'block', task.key, '--on', other.key, ...ws]);
    assert.equal(envelope.data.task.status, 'blocked');
    assert.equal(envelope.data.task.blocked_by_ref, other.key);
    assert.deepEqual(envelope.data.task.unmet_deps.map((dep: any) => dep.key), [other.key]);
  });

  it('completes from todo without a start timestamp and stores artifacts', () => {
    const { box, root, project, ws } = fixture('complete');
    const task = createTask(box, { root }, project, 'completable');
    const envelope = box.json([
      'task',
      'complete',
      task.key,
      '--summary',
      'done in one pass',
      '--artifact',
      'src/auth/jwt.ts',
      '--artifact',
      'https://example.test/pr/1',
      ...ws,
    ]);
    assert.equal(envelope.data.task.status, 'done');
    assert.equal(envelope.data.task.summary, 'done in one pass');
    assert.equal(envelope.data.task.started_at, null);
    assert.ok(envelope.data.task.completed_at !== null);
    assert.ok(envelope.next_actions.some((action) => /task next/.test(action.command)));

    const detail = box.json(['task', 'status', task.key, ...ws]);
    assert.equal(detail.data.counts.artifacts, 2);
  });

  it('cancels, reopens, and releases back to todo', () => {
    const { box, root, project, ws } = fixture('terminal');
    const task = createTask(box, { root }, project, 'cycle-me');
    box.json(['task', 'start', task.key, '--by', 'alice', ...ws]);

    const released = box.json(['task', 'release', task.key, '--to-todo', ...ws]);
    assert.equal(released.data.task.status, 'todo');
    assert.equal(released.data.task.claimed_by, null);

    const cancelled = box.json(['task', 'cancel', task.key, '--reason', 'not needed', ...ws]);
    assert.equal(cancelled.data.task.status, 'cancelled');

    const reopened = box.json(['task', 'reopen', task.key, '--reason', 'needed again', ...ws]);
    assert.equal(reopened.data.task.status, 'todo');
    assert.equal(reopened.data.task.completed_at, null);
  });

  it('rejects a dependency cycle with exit 3', () => {
    const { box, root, project, ws } = fixture('cycles');
    const first = createTask(box, { root }, project, 'one');
    const second = createTask(box, { root }, project, 'two', ['--depends-on', first.key]);

    const error = box.jsonError(['task', 'depend', first.key, '--on', second.key, ...ws]);
    assert.equal(error.code, 'CYCLE_DETECTED');
    assert.equal(box.run(['task', 'depend', first.key, '--on', second.key, ...ws]).code, 3);
    assert.equal(box.jsonError(['task', 'depend', first.key, '--on', first.key, ...ws]).code, 'CYCLE_DETECTED');

    const removed = box.json(['task', 'undepend', second.key, '--on', first.key, ...ws]);
    assert.equal(removed.data.task.unmet_deps.length, 0);
  });

  it('appends notes and attaches artifacts with a kind', () => {
    const { box, root, project, ws } = fixture('notes');
    const task = createTask(box, { root }, project, 'noted');

    const note = box.json(['task', 'note', task.key, 'decided to use RS256', '--by', 'alice', ...ws]);
    assert.equal(note.command, 'task.note');
    assert.equal(note.data.note.body, 'decided to use RS256');
    assert.equal(note.data.note.author, 'alice');

    const attach = box.json(['task', 'attach', task.key, 'logs/run.log', '--label', 'worker log', '--kind', 'log', ...ws]);
    assert.equal(attach.command, 'task.attach');
    assert.equal(attach.data.artifact.uri, 'logs/run.log');
    assert.equal(attach.data.artifact.kind, 'log');
    assert.equal(attach.data.artifact.label, 'worker log');

    assert.equal(box.jsonError(['task', 'attach', task.key, 'x.log', '--kind', 'nope', ...ws]).code, 'VALIDATION_ERROR');
  });

  it('mutations honour --dry-run without writing state or events', () => {
    const { box, root, project, ws } = fixture('task-dry');
    const task = createTask(box, { root }, project, 'dry-run-me');
    const envelope = box.json(['task', 'start', task.key, '--by', 'alice', ...ws, '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.task.status, 'in_progress');

    const after = box.json(['task', 'status', task.key, ...ws]);
    assert.equal(after.data.task.status, 'todo');
    assert.equal(after.data.task.claimed_by, null);
    const events = box.json(['events', '--task', task.key, ...ws]);
    assert.equal(events.data.events.filter((event: any) => event.event_type === 'task.started').length, 0);
  });
});
