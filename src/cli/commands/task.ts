/**
 * `novaflow task` — the full lifecycle surface (`novaflow-v100/cli` §3.3).
 *
 * Every verb resolves the workspace, then delegates to `src/core/task.ts`; the CLI
 * owns flag spelling, `--clear-*` semantics, human rendering, and envelopes.
 */
import { TASK_PRIORITIES, type ArtifactKind, type TaskPriority, type TaskStatus } from '../../core/model.js';
import {
  addTaskDep,
  addTaskNote,
  attachTaskArtifact,
  blockTask,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  getTaskContext,
  getTaskStatus,
  listTasks,
  nextTasks,
  releaseTask,
  removeTaskDep,
  reopenTask,
  startTask,
  unblockTask,
  updateTask,
  type TaskMutationResult,
} from '../../core/task.js';
import { rejectCombined, requireFlag, splitList } from '../args.js';
import { withWorkspace } from '../context.js';
import { detail, orDash, snippet, table } from '../format.js';
import { identifiers } from '../output.js';
import {
  afterTaskAttach,
  afterTaskBlocked,
  afterTaskCancelled,
  afterTaskClaim,
  afterTaskComplete,
  afterTaskCreate,
  afterTaskDep,
  afterTaskNote,
  afterTaskRelease,
  afterTaskReopened,
  afterTaskStart,
  afterTaskUnblocked,
  afterTaskUpdate,
} from '../next-actions.js';
import type { CommandModule, CommandResult, NextAction, VerbSpec } from '../types.js';

const TASK_COLUMNS = ['KEY', 'STATUS', 'PRIORITY', 'READY', 'ASSIGNEE', 'CLAIMED', 'TITLE'] as const;

function taskRows(tasks: readonly { key: string; status: string; priority: string; is_ready: boolean; assignee: string | null; claimed_by: string | null; title: string }[]): string[][] {
  return tasks.map((task) => [
    task.key,
    task.status,
    task.priority,
    task.is_ready ? 'yes' : 'waiting',
    orDash(task.assignee),
    orDash(task.claimed_by),
    snippet(task.title),
  ]);
}

function mutationResult(result: TaskMutationResult, nextActions: NextAction[]): CommandResult {
  const task = result.task;
  const transition =
    result.from_state === result.to_state ? task.status : `${result.from_state} -> ${result.to_state}`;
  const suffix = result.dry_run ? ' (dry run, nothing written)' : '';
  return {
    data: result,
    human: `Task ${task.key}: ${transition}${suffix}\n`,
    quiet: identifiers([task.key]),
    next_actions: result.dry_run ? [] : nextActions,
  };
}

const createVerb: VerbSpec = {
  verb: 'create',
  command: 'task.create',
  summary: 'Create a task in todo, allocating the next PREFIX-N key',
  usage:
    'novaflow task create --title <title> [--project <p>] [--slug <s>] [--objective <text>] [--assignee <a>] [--priority low|medium|high|urgent] [--depends-on <k1,k2>] [--tag <t>]... [--idempotency-key <k>]',
  positionals: [],
  flags: [
    { name: 'title', kind: 'string', placeholder: '<title>', description: 'Task title (required)' },
    { name: 'slug', kind: 'string', placeholder: '<s>', description: 'Explicit kebab-case slug (default: derived from --title)' },
    { name: 'objective', kind: 'string', placeholder: '<text>', description: 'Task objective' },
    { name: 'assignee', kind: 'string', placeholder: '<a>', description: 'Intended actor' },
    { name: 'priority', kind: 'string', placeholder: '<low|medium|high|urgent>', description: 'Priority (default: medium)' },
    { name: 'depends-on', kind: 'string', placeholder: '<k1,k2>', repeatable: true, description: 'Dependency keys or slugs (comma-separated, repeatable)' },
    { name: 'tag', kind: 'string', placeholder: '<t>', repeatable: true, description: 'Task tag (repeatable)' },
    { name: 'idempotency-key', kind: 'string', placeholder: '<k>', description: 'Return the existing task with this key instead of creating' },
  ],
  examples: [
    'novaflow task create --title jwt-authentication --assignee backend-agent --priority high',
    'novaflow task create --title refresh-token-rotation --depends-on NV3-1',
  ],
  run: (ctx) => {
    requireFlag(ctx.args, 'title', 'task.create');
    const result = withWorkspace(ctx, (db, resolved) =>
      createTask(db, {
        title: ctx.args.get('title') as string,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        slug: ctx.args.get('slug') ?? null,
        objective: ctx.args.get('objective') ?? null,
        assignee: ctx.args.get('assignee') ?? null,
        priority: (ctx.args.get('priority') as TaskPriority | undefined) ?? null,
        depends_on: splitList(ctx.args.getAll('depends-on')),
        tags: ctx.args.getAll('tag'),
        idempotency_key: ctx.args.get('idempotency-key') ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    const task = result.task;
    const human = result.idempotent_hit
      ? `Task ${task.key} already exists for this idempotency key.\n`
      : result.dry_run
        ? `Dry run: would create task ${task.key} (${task.status}, ${task.priority}).\nNo rows written.\n`
        : `Created task ${task.key} — ${task.title} [${task.status}, ${task.priority}]\n`;
    return {
      data: result,
      human,
      quiet: identifiers([task.key]),
      next_actions: result.idempotent_hit || result.dry_run ? [] : afterTaskCreate(task),
    };
  },
};

const listVerb: VerbSpec = {
  verb: 'list',
  command: 'task.list',
  summary: 'List tasks across the workspace or filtered to one project',
  usage:
    'novaflow task list [--project <p>] [--status <s>]... [--ready] [--assignee <a>] [--claimed-by <a>] [--tag <t>] [--limit <n>]',
  positionals: [],
  flags: [
    { name: 'status', kind: 'string', placeholder: '<s>', repeatable: true, description: 'Status filter (repeatable or comma-separated)' },
    { name: 'ready', kind: 'boolean', description: 'Only todo tasks whose dependencies are all done and unclaimed' },
    { name: 'assignee', kind: 'string', placeholder: '<a>', description: 'Filter by intended actor' },
    { name: 'claimed-by', kind: 'string', placeholder: '<a>', description: 'Filter by current claim holder' },
    { name: 'tag', kind: 'string', placeholder: '<t>', description: 'Filter by tag' },
    { name: 'limit', kind: 'int', min: 1, placeholder: '<n>', description: 'Maximum rows returned' },
  ],
  examples: ['novaflow task list --ready', 'novaflow task list --status todo,blocked --limit 20'],
  run: (ctx) => {
    const tasks = withWorkspace(ctx, (db) =>
      listTasks(db, {
        project: ctx.options.project ?? null,
        status: splitList(ctx.args.getAll('status')) as TaskStatus[],
        ready: ctx.args.has('ready'),
        assignee: ctx.args.get('assignee') ?? null,
        claimed_by: ctx.args.get('claimed-by') ?? null,
        tag: ctx.args.get('tag') ?? null,
        limit: ctx.args.int('limit') ?? null,
        now: ctx.now,
      }),
    );
    return {
      data: { tasks },
      human:
        tasks.length === 0
          ? `${table(TASK_COLUMNS, [])}(no tasks matched)\n`
          : table(TASK_COLUMNS, taskRows(tasks)),
      quiet: identifiers(tasks.map((task) => task.key)),
      next_actions: [
        { command: 'novaflow task next', description: 'Dispatch the next ready task' },
        { command: 'novaflow status', description: 'Review the board summary' },
      ],
    };
  },
};

const nextVerb: VerbSpec = {
  verb: 'next',
  command: 'task.next',
  summary: 'Return ready tasks ordered by priority, then creation time',
  usage: 'novaflow task next [--project <p>] [--assignee <a>] [--limit <n>]',
  positionals: [],
  flags: [
    { name: 'assignee', kind: 'string', placeholder: '<a>', description: 'Only tasks assigned to this actor' },
    { name: 'limit', kind: 'int', min: 1, placeholder: '<n>', description: 'Maximum tasks returned (default 10)' },
  ],
  examples: ['novaflow task next', 'novaflow task next --limit 3 --json'],
  run: (ctx) => {
    const tasks = withWorkspace(ctx, (db, resolved) =>
      nextTasks(db, {
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        assignee: ctx.args.get('assignee') ?? null,
        limit: ctx.args.int('limit') ?? null,
        now: ctx.now,
      }),
    );
    return {
      data: { tasks },
      human:
        tasks.length === 0
          ? 'No ready tasks. Unblock or complete in-flight work first.\n'
          : table(TASK_COLUMNS, taskRows(tasks)),
      quiet: identifiers(tasks.map((task) => task.key)),
      next_actions:
        tasks.length === 0
          ? [{ command: 'novaflow status', description: 'Review what is in flight or blocked' }]
          : [
              {
                command: `novaflow task start ${tasks[0]?.key} --by <actor>`,
                description: 'Claim and start the highest-priority ready task',
              },
              {
                command: `novaflow task context ${tasks[0]?.key}`,
                description: 'Load the handoff bundle for it',
              },
            ],
    };
  },
};

const statusVerb: VerbSpec = {
  verb: 'status',
  command: 'task.status',
  summary: 'Show full task state, readiness, claim, blocker and recent timeline',
  usage: 'novaflow task status <ID>',
  positionals: ['<ID>'],
  flags: [],
  examples: ['novaflow task status NV3-1', 'novaflow task status NV3-1 --json'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      getTaskStatus(db, { id, project: ctx.options.project ?? null, env: ctx.env, config: resolved.config, now: ctx.now }),
    );
    const task = result.task;
    const unmet = task.unmet_deps.map((dep) => `${dep.key} (${dep.status})`).join(', ');
    const human = detail([
      ['key', task.key],
      ['title', task.title],
      ['project', task.project_slug],
      ['status', task.status],
      ['priority', task.priority],
      ['ready', task.is_ready ? 'yes' : 'no'],
      ['unmet_deps', unmet === '' ? '-' : unmet],
      ['assignee', orDash(task.assignee)],
      ['claimed_by', orDash(task.claimed_by)],
      ['session_ref', orDash(task.session_ref)],
      ['lease_expires_at', orDash(task.lease_expires_at)],
      ['block_reason', orDash(task.block_reason)],
      ['blocked_by_ref', orDash(task.blocked_by_ref)],
      ['objective', orDash(task.objective)],
      ['summary', orDash(task.summary)],
      ['tags', task.tags.length === 0 ? '-' : task.tags.join(', ')],
      ['counts', `notes ${result.counts.notes}, artifacts ${result.counts.artifacts}, deps ${result.counts.dependencies}, dependents ${result.counts.dependents}`],
      ['created_at', task.created_at],
      ['updated_at', task.updated_at],
    ]) + (result.recent_events.length === 0 ? '' : `recent events: ${result.recent_events.map((event) => event.event_type).join(', ')}\n`);
    return {
      data: result,
      human,
      quiet: identifiers([task.key]),
      next_actions:
        task.status === 'blocked'
          ? afterTaskBlocked(task)
          : task.status === 'in_progress'
            ? afterTaskStart(task)
            : afterTaskCreate(task),
    };
  },
};

const contextVerb: VerbSpec = {
  verb: 'context',
  command: 'task.context',
  summary: 'Assemble the agent handoff bundle: upstream summaries, notes, artifacts, downstream list',
  usage: 'novaflow task context <ID>',
  positionals: ['<ID>'],
  flags: [],
  examples: ['novaflow task context NV3-2', 'novaflow task context NV3-2 --json'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      getTaskContext(db, { id, project: ctx.options.project ?? null, env: ctx.env, config: resolved.config, now: ctx.now }),
    );
    const lines: string[] = [];
    lines.push(detail([
      ['task', `${result.task.key} — ${result.task.title}`],
      ['status', result.task.status],
      ['objective', orDash(result.task.objective)],
      ['project', `${result.project.slug} (${result.project.prefix})`],
      ['project objective', orDash(result.project.objective)],
      ['repo_path', orDash(result.project.repo_path)],
      ['verify_cmd', orDash(result.project.verify_cmd)],
    ]));
    lines.push(`upstream: ${result.upstream.length === 0 ? '-' : result.upstream.map((entry) => `${entry.key} (${entry.status})`).join(', ')}\n`);
    lines.push(`downstream: ${result.downstream.length === 0 ? '-' : result.downstream.map((entry) => `${entry.key} (${entry.status})`).join(', ')}\n`);
    lines.push(`notes: ${result.notes.length}, artifacts: ${result.artifacts.length}\n`);
    return {
      data: result,
      human: lines.join(''),
      quiet: identifiers([result.task.key]),
      next_actions: afterTaskStart({ key: result.task.key, project_slug: result.project.slug }),
    };
  },
};

const updateVerb: VerbSpec = {
  verb: 'update',
  command: 'task.update',
  summary: 'Update mutable task fields without changing lifecycle state',
  usage: 'novaflow task update <ID> [--title <t>] [--objective <o>] [--clear-objective] [--priority <p>] [--assignee <a>] [--clear-assignee] [--tag <t>]... [--clear-tags]',
  positionals: ['<ID>'],
  flags: [
    { name: 'title', kind: 'string', placeholder: '<t>', description: 'New title' },
    { name: 'objective', kind: 'string', placeholder: '<o>', description: 'New objective' },
    { name: 'clear-objective', kind: 'boolean', description: 'Clear the objective' },
    { name: 'priority', kind: 'string', placeholder: `<${TASK_PRIORITIES.join('|')}>`, description: 'New priority' },
    { name: 'assignee', kind: 'string', placeholder: '<a>', description: 'New intended actor' },
    { name: 'clear-assignee', kind: 'boolean', description: 'Clear the assignee' },
    { name: 'tag', kind: 'string', placeholder: '<t>', repeatable: true, description: 'Replace the full tag list (repeatable)' },
    { name: 'clear-tags', kind: 'boolean', description: 'Clear every tag' },
  ],
  examples: [
    'novaflow task update NV3-1 --priority urgent',
    'novaflow task update NV3-1 --clear-assignee',
    'novaflow task update NV3-1 --tag auth --tag security',
  ],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    rejectCombined(ctx.args, 'objective', 'clear-objective');
    rejectCombined(ctx.args, 'assignee', 'clear-assignee');
    rejectCombined(ctx.args, 'tag', 'clear-tags');

    const objective = ctx.args.has('clear-objective') ? '' : ctx.args.get('objective');
    const assignee = ctx.args.has('clear-assignee') ? null : ctx.args.get('assignee');
    const tags = ctx.args.getAll('tag');
    const title = ctx.args.get('title');
    const priority = ctx.args.get('priority');

    const result = withWorkspace(ctx, (db, resolved) =>
      updateTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        ...(title === undefined ? {} : { title }),
        ...(objective === undefined ? {} : { objective }),
        ...(priority === undefined ? {} : { priority: priority as TaskPriority }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(tags.length === 0 && !ctx.args.has('clear-tags') ? {} : { tags: ctx.args.has('clear-tags') ? [] : tags }),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskUpdate(result.task));
  },
};

const startVerb: VerbSpec = {
  verb: 'start',
  command: 'task.start',
  summary: 'Transition todo -> in_progress atomically, with claim and lease',
  usage: 'novaflow task start <ID> [--by <actor>] [--ref <session_uri>] [--lease <sec>] [--note <text>] [--force]',
  positionals: ['<ID>'],
  flags: [
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor claiming the task' },
    { name: 'ref', kind: 'string', placeholder: '<session_uri>', description: 'Session reference (thread, run, shell id)' },
    { name: 'lease', kind: 'int', min: 1, placeholder: '<sec>', description: 'Lease length in seconds (omit for a permanent claim)' },
    { name: 'note', kind: 'string', placeholder: '<text>', description: 'Progress note recorded with the start' },
    { name: 'force', kind: 'boolean', description: 'Override unmet dependencies, a live claim, or a restart' },
  ],
  examples: [
    'novaflow task start NV3-1 --by t3-agent --ref "thread://abc123" --lease 900',
    'novaflow task start NV3-1 --force',
  ],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const refValue = ctx.args.get('ref');
    const result = withWorkspace(ctx, (db, resolved) =>
      startTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        by: ctx.args.get('by') ?? null,
        ...(refValue === undefined ? {} : { session_ref: refValue }),
        lease_sec: ctx.args.int('lease') ?? null,
        note: ctx.args.get('note') ?? null,
        force: ctx.args.has('force'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskStart(result.task));
  },
};

const completeVerb: VerbSpec = {
  verb: 'complete',
  command: 'task.complete',
  summary: 'Transition todo/in_progress/blocked -> done with an optional summary and artifacts',
  usage: 'novaflow task complete <ID> [--summary <text>] [--by <actor>] [--artifact <uri>]... [--force]',
  positionals: ['<ID>'],
  flags: [
    { name: 'summary', kind: 'string', placeholder: '<text>', description: 'Completion summary' },
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor completing the task' },
    { name: 'artifact', kind: 'string', placeholder: '<uri>', repeatable: true, description: 'Artifact URI (repeatable)' },
    { name: 'force', kind: 'boolean', description: 'Override a live claim or a terminal state' },
  ],
  examples: [
    'novaflow task complete NV3-1 --summary "Implemented JWT RS256 issue/verify" --artifact src/auth/jwt.ts',
  ],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      completeTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        summary: ctx.args.get('summary') ?? null,
        by: ctx.args.get('by') ?? null,
        artifacts: ctx.args.getAll('artifact'),
        force: ctx.args.has('force'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskComplete(result.task));
  },
};

const blockVerb: VerbSpec = {
  verb: 'block',
  command: 'task.block',
  summary: 'Transition todo/in_progress/blocked -> blocked with a reason or a dependency',
  usage: 'novaflow task block <ID> [--reason <text>] [--waiting-on <ref>] [--on <OTHER_ID>] [--by <actor>]',
  positionals: ['<ID>'],
  flags: [
    { name: 'reason', kind: 'string', placeholder: '<text>', description: 'Why the task is blocked' },
    { name: 'waiting-on', kind: 'string', placeholder: '<ref>', description: 'External reference being awaited' },
    { name: 'on', kind: 'string', placeholder: '<OTHER_ID>', description: 'Add a dependency on another task (cycle-checked)' },
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor recording the blocker' },
  ],
  examples: [
    'novaflow task block NV3-1 --reason "Need RS256 key rotation decision"',
    'novaflow task block NV3-2 --on NV3-1',
  ],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      blockTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        reason: ctx.args.get('reason') ?? null,
        waiting_on: ctx.args.get('waiting-on') ?? null,
        on: ctx.args.get('on') ?? null,
        by: ctx.args.get('by') ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskBlocked(result.task));
  },
};

const unblockVerb: VerbSpec = {
  verb: 'unblock',
  command: 'task.unblock',
  summary: 'Clear the blocker and return to todo (or in_progress with --start)',
  usage: 'novaflow task unblock <ID> [--note <text>] [--start] [--by <actor>] [--ref <uri>] [--lease <sec>] [--force]',
  positionals: ['<ID>'],
  flags: [
    { name: 'note', kind: 'string', placeholder: '<text>', description: 'Note recorded with the unblock' },
    { name: 'start', kind: 'boolean', description: 'Resume straight into in_progress' },
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor resuming the task' },
    { name: 'ref', kind: 'string', placeholder: '<uri>', description: 'Session reference when starting' },
    { name: 'lease', kind: 'int', min: 1, placeholder: '<sec>', description: 'Lease length in seconds when starting' },
    { name: 'force', kind: 'boolean', description: 'Override dependency and claim guards' },
  ],
  examples: ['novaflow task unblock NV3-1', 'novaflow task unblock NV3-1 --start --by alice'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const refValue = ctx.args.get('ref');
    const result = withWorkspace(ctx, (db, resolved) =>
      unblockTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        note: ctx.args.get('note') ?? null,
        start: ctx.args.has('start'),
        by: ctx.args.get('by') ?? null,
        ...(refValue === undefined ? {} : { session_ref: refValue }),
        lease_sec: ctx.args.int('lease') ?? null,
        force: ctx.args.has('force'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskUnblocked(result.task));
  },
};

const cancelVerb: VerbSpec = {
  verb: 'cancel',
  command: 'task.cancel',
  summary: 'Transition todo/in_progress/blocked -> cancelled',
  usage: 'novaflow task cancel <ID> [--reason <text>] [--by <actor>]',
  positionals: ['<ID>'],
  flags: [
    { name: 'reason', kind: 'string', placeholder: '<text>', description: 'Why the task is being cancelled' },
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor cancelling the task' },
  ],
  examples: ['novaflow task cancel NV3-4 --reason "Superseded by NV3-7"'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      cancelTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        reason: ctx.args.get('reason') ?? null,
        by: ctx.args.get('by') ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskCancelled(result.task));
  },
};

const reopenVerb: VerbSpec = {
  verb: 'reopen',
  command: 'task.reopen',
  summary: 'Reset a done or cancelled task back to todo',
  usage: 'novaflow task reopen <ID> [--reason <text>] [--by <actor>]',
  positionals: ['<ID>'],
  flags: [
    { name: 'reason', kind: 'string', placeholder: '<text>', description: 'Why the task is being reopened' },
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor reopening the task' },
  ],
  examples: ['novaflow task reopen NV3-1 --reason "Regression found"'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      reopenTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        reason: ctx.args.get('reason') ?? null,
        by: ctx.args.get('by') ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskReopened(result.task));
  },
};

const claimVerb: VerbSpec = {
  verb: 'claim',
  command: 'task.claim',
  summary: 'Acquire or renew a lease without changing state',
  usage: 'novaflow task claim <ID> --by <actor> [--ref <uri>] [--lease <sec>] [--force]',
  positionals: ['<ID>'],
  flags: [
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor acquiring the claim (required)' },
    { name: 'ref', kind: 'string', placeholder: '<uri>', description: 'Session reference' },
    { name: 'lease', kind: 'int', min: 1, placeholder: '<sec>', description: 'Lease length in seconds (omit for a permanent claim)' },
    { name: 'force', kind: 'boolean', description: 'Take over a live claim held by another actor' },
  ],
  examples: ['novaflow task claim NV3-1 --by t3-agent --lease 600'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const by = requireFlag(ctx.args, 'by', 'task.claim');
    const refValue = ctx.args.get('ref');
    const result = withWorkspace(ctx, (db, resolved) =>
      claimTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        by,
        ...(refValue === undefined ? {} : { session_ref: refValue }),
        lease_sec: ctx.args.int('lease') ?? null,
        force: ctx.args.has('force'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskClaim(result.task));
  },
};

const releaseVerb: VerbSpec = {
  verb: 'release',
  command: 'task.release',
  summary: 'Clear the active claim and lease, optionally returning to todo',
  usage: 'novaflow task release <ID> [--by <actor>] [--to-todo]',
  positionals: ['<ID>'],
  flags: [
    { name: 'by', kind: 'string', placeholder: '<actor>', description: 'Actor releasing the claim' },
    { name: 'to-todo', kind: 'boolean', description: 'Also transition in_progress back to todo' },
  ],
  examples: ['novaflow task release NV3-1', 'novaflow task release NV3-1 --to-todo'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      releaseTask(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        by: ctx.args.get('by') ?? null,
        to_todo: ctx.args.has('to-todo'),
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskRelease(result.task));
  },
};

const dependVerb: VerbSpec = {
  verb: 'depend',
  command: 'task.depend',
  summary: 'Add `ID depends_on OTHER_ID` after a cycle check (idempotent)',
  usage: 'novaflow task depend <ID> --on <OTHER_ID>',
  positionals: ['<ID>'],
  flags: [{ name: 'on', kind: 'string', placeholder: '<OTHER_ID>', description: 'Task this one must wait for (required)' }],
  examples: ['novaflow task depend NV3-2 --on NV3-1'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const on = requireFlag(ctx.args, 'on', 'task.depend');
    const result = withWorkspace(ctx, (db, resolved) =>
      addTaskDep(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        on,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskDep(result.task));
  },
};

const undependVerb: VerbSpec = {
  verb: 'undepend',
  command: 'task.undepend',
  summary: 'Remove a dependency edge',
  usage: 'novaflow task undepend <ID> --on <OTHER_ID>',
  positionals: ['<ID>'],
  flags: [{ name: 'on', kind: 'string', placeholder: '<OTHER_ID>', description: 'Dependency edge to remove (required)' }],
  examples: ['novaflow task undepend NV3-2 --on NV3-1'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const on = requireFlag(ctx.args, 'on', 'task.undepend');
    const result = withWorkspace(ctx, (db, resolved) =>
      removeTaskDep(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        on,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return mutationResult(result, afterTaskDep(result.task));
  },
};

const noteVerb: VerbSpec = {
  verb: 'note',
  command: 'task.note',
  summary: 'Append a timestamped progress or decision note without changing status',
  usage: 'novaflow task note <ID> <message> [--by <actor>]',
  positionals: ['<ID>', '<message>'],
  flags: [{ name: 'by', kind: 'string', placeholder: '<actor>', description: 'Note author' }],
  examples: ['novaflow task note NV3-1 "Keys live in env, rotation documented" --by alice'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const message = ctx.args.positionals[1] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      addTaskNote(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        message,
        by: ctx.args.get('by') ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return {
      data: { note: result.task, event_seqs: result.event_seqs, dry_run: result.dry_run },
      human: result.dry_run ? 'Dry run: would append the note.\nNo rows written.\n' : `Noted on ${id}.\n`,
      quiet: identifiers([id]),
      next_actions: result.dry_run ? [] : afterTaskNote({ key: id }),
    };
  },
};

const attachVerb: VerbSpec = {
  verb: 'attach',
  command: 'task.attach',
  summary: 'Attach a file path, PR URL, or log pointer for handoff',
  usage: 'novaflow task attach <ID> <uri> [--label <text>] [--kind file|pr|log|url]',
  positionals: ['<ID>', '<uri>'],
  flags: [
    { name: 'label', kind: 'string', placeholder: '<text>', description: 'Human label for the artifact' },
    { name: 'kind', kind: 'string', placeholder: '<file|pr|log|url>', description: 'Artifact kind (default: file)' },
  ],
  examples: ['novaflow task attach NV3-1 src/auth/jwt.ts --label "JWT module"', 'novaflow task attach NV3-1 https://example.test/pr/1 --kind pr'],
  run: (ctx) => {
    const id = ctx.args.positionals[0] as string;
    const uri = ctx.args.positionals[1] as string;
    const result = withWorkspace(ctx, (db, resolved) =>
      attachTaskArtifact(db, {
        id,
        project: ctx.options.project ?? null,
        env: ctx.env,
        config: resolved.config,
        uri,
        label: ctx.args.get('label') ?? null,
        kind: (ctx.args.get('kind') as ArtifactKind | undefined) ?? null,
        now: ctx.now,
        dry_run: ctx.options.dryRun,
      }),
    );
    return {
      data: result,
      human: result.dry_run
        ? 'Dry run: would attach the artifact.\nNo rows written.\n'
        : `Attached ${result.artifact.uri} (${result.artifact.kind}) to ${id}.\n`,
      quiet: identifiers([id]),
      next_actions: result.dry_run ? [] : afterTaskAttach({ key: id }),
    };
  },
};

export const taskModule: CommandModule = {
  name: 'task',
  summary: 'Create, dispatch, and drive tasks through the 5-state lifecycle.',
  verbs: [
    createVerb,
    listVerb,
    nextVerb,
    statusVerb,
    contextVerb,
    updateVerb,
    startVerb,
    completeVerb,
    blockVerb,
    unblockVerb,
    cancelVerb,
    reopenVerb,
    claimVerb,
    releaseVerb,
    dependVerb,
    undependVerb,
    noteVerb,
    attachVerb,
  ],
};
