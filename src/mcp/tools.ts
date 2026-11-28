/**
 * The MCP tool surface: 30 tools, 1:1 with `src/core/` (`novaflow-v100/mcp` §2).
 *
 * Nothing here duplicates validation or SQL. Each handler reads its arguments,
 * resolves the workspace, and calls the same core function the CLI calls, so a
 * tool can never drift from its command. Machine-local setup (`workspace
 * register`, `workspace unregister`, `skill *`) is deliberately absent: an MCP
 * agent must not be able to rewrite global registry or host symlinks.
 */
import type { DatabaseSync } from 'node:sqlite';
import { TASK_PRIORITIES, TASK_STATUSES, type ArtifactKind, type TaskPriority, type TaskStatus } from '../core/model.js';
import { listEvents } from '../core/events.js';
import {
  archiveProject,
  createProject,
  listProjects,
  resolveProjectRef,
  showProject,
  updateProject,
} from '../core/project.js';
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
  resolveTaskRow,
  startTask,
  unblockTask,
  updateTask,
} from '../core/task.js';
import {
  createWorkspace,
  exportWorkspace,
  getOverviewStatus,
  listWorkspaces,
  openWorkspaceConnection,
  showWorkspace,
  updateWorkspace,
} from '../core/workspace.js';
import { resolveWorkspace, type ResolvedWorkspace } from '../store/workspace.js';
import type { ToolArgs } from './args.js';
import type { McpNextAction } from './results.js';
import {
  afterEvents,
  afterExport,
  afterProjectArchive,
  afterProjectCreate,
  afterProjectList,
  afterProjectUpdate,
  afterStatus,
  afterTaskAttach,
  afterTaskCancelled,
  afterTaskClaim,
  afterTaskComplete,
  afterTaskContext,
  afterTaskCreate,
  afterTaskDep,
  afterTaskList,
  afterTaskNext,
  afterTaskNote,
  afterTaskRelease,
  afterTaskReopened,
  afterTaskStart,
  afterTaskStatus,
  afterTaskUnblocked,
  afterTaskUpdate,
  afterWorkspaceCreate,
  afterWorkspaceList,
  afterWorkspaceUpdate,
} from './next-actions.js';

/** JSON Schema for a tool's `arguments`; the SDK forwards it verbatim. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, object>;
  required?: string[];
  /** Forward-compatible: the MCP wire type allows extra JSON Schema keywords. */
  [key: string]: unknown;
}

/** One tool call's resolved context. */
export interface ToolContext {
  args: ToolArgs;
  /** Workspace override: the `workspace` param, else the `--workspace` given to `novaflow mcp`. */
  workspace: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  now: Date;
}

/** What a handler produced, before envelope wrapping. */
export interface ToolOutcome {
  data: unknown;
  next_actions?: McpNextAction[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler(context: ToolContext): ToolOutcome;
}

/** Schema builders, so 30 tool definitions stay readable and consistent. */
const S = {
  workspace: (): object => ({
    type: 'string',
    description:
      'Workspace name or path. Overrides the server --workspace, NOVAFLOW_WORKSPACE, the cwd walk-up, and default_workspace.',
  }),
  project: (): object => ({ type: 'string', description: 'Project slug or prefix.' }),
  nullableProject: (): object => ({ type: ['string', 'null'], description: 'Project slug or prefix; null clears it.' }),
  text: (description: string): object => ({ type: 'string', description }),
  nullableText: (description: string): object => ({ type: ['string', 'null'], description }),
  flag: (description: string): object => ({ type: 'boolean', description }),
  count: (description: string, minimum = 1): object => ({ type: 'integer', minimum, description }),
  list: (description: string): object => ({ type: 'array', items: { type: 'string' }, description }),
  nullableList: (description: string): object => ({
    type: ['array', 'null'],
    items: { type: 'string' },
    description,
  }),
  id: (): object => ({ type: 'string', description: 'Task key (NV3-1), project/slug reference, or ULID.' }),
} as const;

function schema(properties: Record<string, object>, required: readonly string[] = []): ToolInputSchema {
  return required.length === 0 ? { type: 'object', properties } : { type: 'object', properties, required: [...required] };
}

/** Resolves the workspace for this call and opens its database. */
function withWorkspace<T>(ctx: ToolContext, fn: (db: DatabaseSync, resolved: ResolvedWorkspace) => T): T {
  const connection = openWorkspaceConnection({ workspace: ctx.workspace, env: ctx.env, cwd: ctx.cwd });
  try {
    return fn(connection.db, connection.resolved);
  } finally {
    connection.close();
  }
}

/** `--project`-equivalent reference inputs for one call. */
function projectRef(ctx: ToolContext, resolved: ResolvedWorkspace, name = 'project') {
  return {
    project: ctx.args.nullableString(name) ?? null,
    env: ctx.env,
    config: resolved.config,
  };
}

/** The workspace identifier used in `next_actions`: always pin the resolved root path. */
function workspaceLabel(_ctx: ToolContext, resolved: { root: string }): string {
  return resolved.root;
}

/**
 * Workspace root path for `next_actions` when the handler only has the core result.
 *
 * Pinning the resolved absolute root path guarantees follow-up calls land in
 * the exact same workspace even for unregistered walk-up directories or
 * colliding workspace names.
 */
function workspaceName(ctx: ToolContext): string {
  try {
    return resolveWorkspace({
      ...(ctx.workspace !== null ? { workspace: ctx.workspace } : {}),
      env: ctx.env,
      cwd: ctx.cwd,
    }).root;
  } catch {
    return '';
  }
}

export const TOOLS: readonly McpTool[] = [
  {
    name: 'novaflow_workspace_create',
    description:
      'Create a workspace: scaffold .novaflow/ (config.yaml, .gitignore, state.db) and register it in the global index. CLI-only commands (workspace register/unregister, skill *) are intentionally not exposed.',
    inputSchema: schema({
      name: S.text('Workspace name (lowercase kebab-case). Defaults to the slugified --path basename.'),
      path: S.text('Directory that will contain .novaflow/. Defaults to the server cwd.'),
      gitignore: S.flag('Append .novaflow/ to the nearest git repository root .gitignore.'),
      set_default: S.flag('Mark the new workspace as the registry default_workspace.'),
    }),
    handler: (ctx) => {
      const result = createWorkspace({
        name: ctx.args.nullableString('name') ?? null,
        path: ctx.args.nullableString('path') ?? null,
        gitignore: ctx.args.boolean('gitignore') === true,
        set_default: ctx.args.boolean('set_default') === true,
        env: ctx.env,
        cwd: ctx.cwd,
        now: ctx.now,
      });
      return { data: result, next_actions: afterWorkspaceCreate(result.workspace.name) };
    },
  },
  {
    name: 'novaflow_workspace_list',
    description: 'List every registered workspace with its path, default/active markers, and default project.',
    inputSchema: schema({}),
    handler: (ctx) => ({
      data: listWorkspaces({ env: ctx.env, cwd: ctx.cwd }),
      next_actions: afterWorkspaceList(),
    }),
  },
  {
    name: 'novaflow_workspace_show',
    description: 'Show the resolved workspace metadata, its path, project counts, and task counts by status.',
    inputSchema: schema({ workspace: S.workspace() }),
    handler: (ctx) => {
      const result = showWorkspace({
        workspace: ctx.workspace,
        env: ctx.env,
        cwd: ctx.cwd,
        now: ctx.now,
      });
      return { data: result, next_actions: afterWorkspaceUpdate(result.name) };
    },
  },
  {
    name: 'novaflow_workspace_update',
    description:
      'Rename the workspace, set or clear its default project (JSON null clears), or mark it as the registry default. Metadata and registry are written together or not at all.',
    inputSchema: schema({
      workspace: S.workspace(),
      name: S.text('New workspace name (lowercase kebab-case).'),
      default_project: S.nullableProject(),
      set_default: S.flag('Mark this workspace as the registry default_workspace.'),
    }),
    handler: (ctx) => {
      const result = updateWorkspace({
        workspace: ctx.workspace,
        name: ctx.args.nullableString('name'),
        default_project: ctx.args.nullableString('default_project'),
        set_default: ctx.args.boolean('set_default') === true,
        env: ctx.env,
        cwd: ctx.cwd,
        now: ctx.now,
      });
      return { data: result, next_actions: afterWorkspaceUpdate(result.workspace.name) };
    },
  },
  {
    name: 'novaflow_status',
    description:
      'Compact board summary for the workspace or one project: counts by bucket, in-progress tasks, ready tasks, blocked tasks, and recent events.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project() }),
    handler: (ctx) => {
      const result = getOverviewStatus({
        workspace: ctx.workspace,
        project: ctx.args.nullableString('project') ?? null,
        env: ctx.env,
        cwd: ctx.cwd,
        now: ctx.now,
      });
      const label = ctx.workspace ?? result.workspace.name;
      return { data: result, next_actions: afterStatus(label) };
    },
  },
  {
    name: 'novaflow_project_create',
    description:
      'Create a project, deriving a kebab-case slug from the title and a free uppercase prefix from the slug when omitted.',
    inputSchema: schema(
      {
        workspace: S.workspace(),
        title: S.text('Project title (required).'),
        slug: S.text('Explicit kebab-case slug (default: derived from title).'),
        prefix: S.text('Explicit uppercase prefix, e.g. NV3 (default: derived from slug).'),
        objective: S.text('Project objective.'),
        repo_path: S.text('Repository path relative to the workspace root.'),
        verify_cmd: S.text('Verification command for this project.'),
        tags: S.list('Initial tags.'),
      },
      ['title'],
    ),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db) =>
        createProject(db, {
          title: ctx.args.requiredString('title'),
          slug: ctx.args.nullableString('slug') ?? null,
          prefix: ctx.args.nullableString('prefix') ?? null,
          objective: ctx.args.nullableString('objective') ?? null,
          repo_path: ctx.args.nullableString('repo_path') ?? null,
          verify_cmd: ctx.args.nullableString('verify_cmd') ?? null,
          tags: ctx.args.stringList('tags') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterProjectCreate({ slug: result.project.slug, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_project_list',
    description: 'List projects with derived task counts. Defaults to active projects; pass "all" to include archived.',
    inputSchema: schema({
      workspace: S.workspace(),
      status: {
        type: 'string',
        enum: ['active', 'paused', 'archived', 'all'],
        description: 'Status filter (default: active).',
      },
    }),
    handler: (ctx) => {
      const status = ctx.args.oneOf('status', ['active', 'paused', 'archived', 'all'] as const) ?? 'active';
      return withWorkspace(ctx, (db, resolved) => ({
        data: { projects: listProjects(db, { status, now: ctx.now }) },
        next_actions: afterProjectList(workspaceLabel(ctx, resolved)),
      }));
    },
  },
  {
    name: 'novaflow_project_show',
    description: 'Show one project with its metadata, tags, and task counts.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project() }, ['project']),
    handler: (ctx) => {
      const project = withWorkspace(ctx, (db, resolved) =>
        showProject(db, { project: ctx.args.requiredString('project'), now: ctx.now }),
      );
      return {
        data: project,
        next_actions: afterProjectUpdate({ slug: project.slug, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_project_update',
    description:
      'Update project metadata. JSON null clears a nullable field (or "" for text fields); tags replaces the full list.',
    inputSchema: schema(
      {
        workspace: S.workspace(),
        project: S.project(),
        title: S.text('New title (cannot be cleared).'),
        objective: S.nullableText('New objective; null or "" clears it.'),
        repo_path: S.nullableText('New repository path; null or "" clears it.'),
        verify_cmd: S.nullableText('New verification command; null or "" clears it.'),
        tags: S.nullableList('Replaces the full tag list; null clears every tag.'),
        status: { type: ['string', 'null'], enum: ['active', 'paused', 'archived', null], description: 'New status.' },
      },
      ['project'],
    ),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db) =>
        updateProject(db, {
          project: ctx.args.requiredString('project'),
          title: ctx.args.nullableString('title'),
          objective: ctx.args.nullableString('objective'),
          repo_path: ctx.args.nullableString('repo_path'),
          verify_cmd: ctx.args.nullableString('verify_cmd'),
          tags: ctx.args.nullableStringList('tags'),
          status: ctx.args.oneOf('status', ['active', 'paused', 'archived'] as const),
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterProjectUpdate({ slug: result.project.slug, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_project_archive',
    description: 'Archive a project (status archived) and emit project.archived.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project() }, ['project']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db) =>
        archiveProject(db, { project: ctx.args.requiredString('project'), now: ctx.now }),
      );
      return {
        data: result,
        next_actions: afterProjectArchive({ slug: result.project.slug, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_task_create',
    description:
      'Create a task in todo, allocating the next PREFIX-N key. An existing idempotency_key returns the original task instead of creating another.',
    inputSchema: schema(
      {
        workspace: S.workspace(),
        title: S.text('Task title (required).'),
        project: S.project(),
        slug: S.text('Explicit kebab-case slug (default: derived from title).'),
        objective: S.text('Task objective.'),
        assignee: S.text('Intended actor.'),
        priority: {
          type: 'string',
          enum: [...TASK_PRIORITIES],
          description: 'Priority (default: medium).',
        },
        depends_on: S.list('Dependencies: task keys, project/slug references, slugs, or ULIDs.'),
        tags: S.list('Initial tags.'),
        idempotency_key: S.text('Return the existing task with this key instead of creating another.'),
      },
      ['title', 'project'],
    ),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db) =>
        createTask(db, {
          title: ctx.args.requiredString('title'),
          project: ctx.args.requiredString('project'),
          env: ctx.env,
          slug: ctx.args.nullableString('slug') ?? null,
          objective: ctx.args.nullableString('objective') ?? null,
          assignee: ctx.args.nullableString('assignee') ?? null,
          priority: (ctx.args.oneOf('priority', TASK_PRIORITIES) ?? null) as TaskPriority | null,
          depends_on: ctx.args.stringList('depends_on') ?? null,
          tags: ctx.args.stringList('tags') ?? null,
          idempotency_key: ctx.args.nullableString('idempotency_key') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskCreate({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_list',
    description:
      'List tasks across the workspace, or filtered to one project, status, tag, assignee, or claim holder. ready=true keeps only dispatchable tasks.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      status: S.list(`Status filter (${TASK_STATUSES.join('|')}); repeatable or comma-separated.`),
      ready: S.flag('Only todo tasks whose dependencies are all done and which nothing claims.'),
      assignee: S.text('Filter by intended actor.'),
      claimed_by: S.text('Filter by current claim holder.'),
      tag: S.text('Filter by tag.'),
      limit: S.count('Maximum rows returned.'),
    }),
    handler: (ctx) =>
      withWorkspace(ctx, (db, resolved) => ({
        data: {
          tasks: listTasks(db, {
            project: ctx.args.nullableString('project') ?? null,
            status: (ctx.args.stringList('status') ?? []) as TaskStatus[],
            ready: ctx.args.boolean('ready') === true,
            assignee: ctx.args.nullableString('assignee') ?? null,
            claimed_by: ctx.args.nullableString('claimed_by') ?? null,
            tag: ctx.args.nullableString('tag') ?? null,
            limit: ctx.args.integer('limit', 1) ?? null,
            now: ctx.now,
          }),
        },
        next_actions: afterTaskList(workspaceLabel(ctx, resolved)),
      })),
  },
  {
    name: 'novaflow_task_next',
    description:
      'Dispatch query: ready tasks ordered by priority (urgent > high > medium > low), then creation time (default limit 10).',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      assignee: S.text('Only tasks assigned to this actor.'),
      limit: S.count('Maximum tasks returned (default 10).'),
    }),
    handler: (ctx) =>
      withWorkspace(ctx, (db, resolved) => {
        const tasks = nextTasks(db, {
          ...projectRef(ctx, resolved),
          assignee: ctx.args.nullableString('assignee') ?? null,
          limit: ctx.args.integer('limit', 1) ?? null,
          now: ctx.now,
        });
        return { data: { tasks }, next_actions: afterTaskNext(tasks, workspaceLabel(ctx, resolved)) };
      }),
  },
  {
    name: 'novaflow_task_status',
    description: 'Show one task: state, readiness, claim and lease, blocker, relation counts, and recent events.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project(), id: S.id() }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        getTaskStatus(db, { id: ctx.args.requiredString('id'), ...projectRef(ctx, resolved), now: ctx.now }),
      );
      return {
        data: result,
        next_actions: afterTaskStatus({
          key: result.task.key,
          project_slug: result.task.project_slug,
          status: result.task.status,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_context',
    description:
      'Assemble the handoff bundle: task and project context, upstream summaries with their notes and artifacts, downstream dependents, own notes and artifacts, recent timeline.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project(), id: S.id() }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        getTaskContext(db, { id: ctx.args.requiredString('id'), ...projectRef(ctx, resolved), now: ctx.now }),
      );
      return {
        data: result,
        next_actions: afterTaskContext({
          key: result.task.key,
          project_slug: result.project.slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_update',
    description:
      'Update mutable task fields without changing lifecycle state. JSON null clears a nullable field (or "" for text fields); tags replaces the full list.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      title: S.text('New title (cannot be cleared).'),
      objective: S.nullableText('New objective; null or "" clears it.'),
      priority: {
        type: ['string', 'null'],
        enum: [...TASK_PRIORITIES, null],
        description: 'New priority; null leaves it unchanged.',
      },
      assignee: S.nullableText('New intended actor; null clears it.'),
      tags: S.nullableList('Replaces the full tag list; null clears every tag.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        updateTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          title: ctx.args.nullableString('title'),
          objective: ctx.args.nullableString('objective'),
          priority: ctx.args.oneOf('priority', TASK_PRIORITIES),
          assignee: ctx.args.nullableString('assignee'),
          tags: ctx.args.nullableStringList('tags'),
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskUpdate({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_start',
    description:
      'Transition todo -> in_progress atomically with a claim and optional lease. Refuses a live claim by another actor, unmet dependencies, or a blocked/terminal task unless force is set.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      by: S.text('Actor claiming the task.'),
      session_ref: S.text('Session reference (thread, run, shell id).'),
      lease_sec: S.count('Lease length in seconds; omit for a permanent claim.'),
      note: S.text('Progress note recorded with the start.'),
      force: S.flag('Override unmet dependencies, a live claim, or a restart.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        startTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          by: ctx.args.nullableString('by') ?? null,
          session_ref: ctx.args.nullableString('session_ref'),
          lease_sec: ctx.args.integer('lease_sec', 1) ?? null,
          note: ctx.args.nullableString('note') ?? null,
          force: ctx.args.boolean('force') === true,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskStart({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_complete',
    description:
      'Transition todo/in_progress/blocked -> done with an optional summary and artifacts. Completing straight from todo leaves started_at null.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      summary: S.nullableText('Completion summary; null clears it.'),
      by: S.text('Actor completing the task.'),
      artifacts: {
        type: 'array',
        description: 'Artifacts to attach: URI strings, or { uri, label?, kind? } with kind file|pr|log|url.',
        items: { type: ['string', 'object'] },
      },
      force: S.flag('Override a live claim or a terminal state.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        completeTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          summary: ctx.args.nullableString('summary') ?? null,
          by: ctx.args.nullableString('by') ?? null,
          artifacts: ctx.args.artifacts('artifacts') ?? null,
          force: ctx.args.boolean('force') === true,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskComplete({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_block',
    description:
      'Transition todo/in_progress/blocked -> blocked with a reason, an external reference, or a dependency on another task (cycle-checked).',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      reason: S.text('Why the task is blocked (required unless on_task is set).'),
      waiting_on: S.text('External reference being awaited.'),
      on_task: S.text('Another task key to depend on; the edge is cycle-checked.'),
      by: S.text('Actor recording the blocker.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        blockTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          reason: ctx.args.nullableString('reason') ?? null,
          waiting_on: ctx.args.nullableString('waiting_on') ?? null,
          on: ctx.args.nullableString('on_task') ?? null,
          by: ctx.args.nullableString('by') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskStatus({
          key: result.task.key,
          project_slug: result.task.project_slug,
          status: result.task.status,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_unblock',
    description:
      'Clear the blocker and return to todo, or resume straight into in_progress with start=true. Sole path out of blocked.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      note: S.text('Note recorded with the unblock.'),
      start: S.flag('Resume straight into in_progress.'),
      by: S.text('Actor resuming the task.'),
      session_ref: S.text('Session reference when starting.'),
      lease_sec: S.count('Lease length in seconds when starting.'),
      force: S.flag('Override dependency and claim guards.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        unblockTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          note: ctx.args.nullableString('note') ?? null,
          start: ctx.args.boolean('start') === true,
          by: ctx.args.nullableString('by') ?? null,
          session_ref: ctx.args.nullableString('session_ref'),
          lease_sec: ctx.args.integer('lease_sec', 1) ?? null,
          force: ctx.args.boolean('force') === true,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskUnblocked({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_cancel',
    description: 'Transition todo/in_progress/blocked -> cancelled. Keys are never reused.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      reason: S.text('Why the task is being cancelled.'),
      by: S.text('Actor cancelling the task.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        cancelTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          reason: ctx.args.nullableString('reason') ?? null,
          by: ctx.args.nullableString('by') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskCancelled({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_reopen',
    description: 'Reset a done or cancelled task back to todo, clearing completion fields and the claim.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      reason: S.text('Why the task is being reopened.'),
      by: S.text('Actor reopening the task.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        reopenTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          reason: ctx.args.nullableString('reason') ?? null,
          by: ctx.args.nullableString('by') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskReopened({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_claim',
    description:
      'Acquire or renew a claim and lease without changing state. An expired lease may be taken over without force.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      by: S.text('Actor acquiring the claim (required).'),
      session_ref: S.text('Session reference.'),
      lease_sec: S.count('Lease length in seconds; omit for a permanent claim.'),
      force: S.flag('Take over a live claim held by another actor.'),
    }, ['id', 'by']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        claimTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          by: ctx.args.requiredString('by'),
          session_ref: ctx.args.nullableString('session_ref'),
          lease_sec: ctx.args.integer('lease_sec', 1) ?? null,
          force: ctx.args.boolean('force') === true,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskClaim({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_release',
    description: 'Clear the active claim, session reference, and lease; to_todo also returns in_progress to todo.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      by: S.text('Actor releasing the claim.'),
      to_todo: S.flag('Also transition in_progress back to todo.'),
    }, ['id']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        releaseTask(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          by: ctx.args.nullableString('by') ?? null,
          to_todo: ctx.args.boolean('to_todo') === true,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskRelease({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_depend',
    description: 'Add "id depends_on on" after a breadth-first cycle check. An existing edge is a documented no-op.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project(), id: S.id(), on: S.id() }, ['id', 'on']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        addTaskDep(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          on: ctx.args.requiredString('on'),
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskDep({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_undepend',
    description: 'Remove a dependency edge; a missing edge is NOT_FOUND.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project(), id: S.id(), on: S.id() }, ['id', 'on']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        removeTaskDep(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          on: ctx.args.requiredString('on'),
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskDep({
          key: result.task.key,
          project_slug: result.task.project_slug,
          workspace: workspaceName(ctx),
        }),
      };
    },
  },
  {
    name: 'novaflow_task_note',
    description: 'Append a timestamped progress or decision note without changing status.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      message: S.text('Note body (required).'),
      by: S.text('Note author.'),
    }, ['id', 'message']),
    handler: (ctx) => {
      const result = withWorkspace(ctx, (db, resolved) =>
        addTaskNote(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          message: ctx.args.requiredString('message'),
          by: ctx.args.nullableString('by') ?? null,
          now: ctx.now,
        }),
      );
      return {
        data: { note: result.task, event_seqs: result.event_seqs, dry_run: result.dry_run },
        next_actions: afterTaskNote({ key: result.task_key, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_task_attach',
    description: 'Attach a file path, PR URL, or log pointer to the task so the next agent inherits it.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      id: S.id(),
      uri: S.text('Artifact URI (required).'),
      label: S.text('Human label for the artifact.'),
      kind: { type: 'string', enum: ['file', 'pr', 'log', 'url'], description: 'Artifact kind (default: file).' },
    }, ['id', 'uri']),
    handler: (ctx) => {
      const kind = ctx.args.oneOf('kind', ['file', 'pr', 'log', 'url'] as const) as ArtifactKind | null;
      const result = withWorkspace(ctx, (db, resolved) =>
        attachTaskArtifact(db, {
          id: ctx.args.requiredString('id'),
          ...projectRef(ctx, resolved),
          uri: ctx.args.requiredString('uri'),
          label: ctx.args.nullableString('label') ?? null,
          kind,
          now: ctx.now,
        }),
      );
      return {
        data: result,
        next_actions: afterTaskAttach({ key: result.task_key, workspace: workspaceName(ctx) }),
      };
    },
  },
  {
    name: 'novaflow_events_list',
    description:
      'Query the immutable audit log in chronological (seq) order. after_seq is the polling cursor; next_after_seq is the value to pass next.',
    inputSchema: schema({
      workspace: S.workspace(),
      project: S.project(),
      task: S.id(),
      after_seq: S.count('Cursor: only events with seq > after_seq.', 0),
      since: S.text('ISO-8601 timestamp or compact duration (30m, 2h, 7d).'),
      limit: S.count('Maximum events returned (default 100).'),
    }),
    handler: (ctx) =>
      withWorkspace(ctx, (db, resolved) => {
        const project = ctx.args.nullableString('project');
        const projectRow =
          project === undefined || project === null
            ? null
            : resolveProjectRef(db, { project, env: ctx.env, config: resolved.config });
        const task = ctx.args.nullableString('task');
        const taskId =
          task === undefined || task === null
            ? null
            : resolveTaskRow(db, {
                id: task,
                project: project ?? null,
                env: ctx.env,
                config: resolved.config,
              }).task.id;
        const afterSeq = ctx.args.integer('after_seq', 0) ?? null;
        const events = listEvents(db, {
          task_id: taskId,
          project_id: projectRow?.id ?? null,
          after_seq: afterSeq,
          since: ctx.args.nullableString('since') ?? null,
          limit: ctx.args.integer('limit', 1) ?? null,
          now: ctx.now,
        });
        const nextAfterSeq = events.length === 0 ? afterSeq : (events.at(-1)?.seq ?? afterSeq);
        return {
          data: { events, next_after_seq: nextAfterSeq },
          next_actions: afterEvents(workspaceLabel(ctx, resolved), nextAfterSeq),
        };
      }),
  },
  {
    name: 'novaflow_export',
    description:
      'Export projects, tasks, dependencies, notes, artifacts, and events as a portable JSON snapshot for the workspace or one project.',
    inputSchema: schema({ workspace: S.workspace(), project: S.project() }),
    handler: (ctx) => {
      const snapshot = exportWorkspace({
        workspace: ctx.workspace,
        project: ctx.args.nullableString('project') ?? null,
        env: ctx.env,
        cwd: ctx.cwd,
        now: ctx.now,
      });
      const label = ctx.workspace ?? snapshot.workspace.name;
      return { data: snapshot, next_actions: afterExport(label) };
    },
  },
];

/** Tool names, in documented order (`novaflow-v100/mcp` §2). */
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** Looks up one tool by exact name. */
export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
