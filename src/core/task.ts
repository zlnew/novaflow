/**
 * Task service: creation, read models, lifecycle FSM, claims, and the handoff
 * context bundle (`novaflow-v100/data` §1.1, §3, §5).
 *
 * Every mutating verb runs inside one `BEGIN IMMEDIATE` transaction
 * (`novaflow-v100/architecture` §6) so the state check and the write it
 * authorizes can never interleave with another process, and appends its audit
 * event in that same transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '../store/id.js';
import { appendEventWithSeq, recentEventsFor, type EventView } from './events.js';
import {
  alreadyClaimedError,
  conflictError,
  notFoundError,
  unmetDependenciesError,
  validationError,
} from './errors.js';
import {
  assertNoCycle,
  dependentRefs,
  dependencyRefs,
  formatUnmetDependencies,
  isLeaseExpired,
  isReady,
  unmetDependencies,
  unmetDependencyMap,
  type DependencyRef,
} from './dag.js';
import { deriveSlug, formatTaskKey, isValidSlug, normalizeTaskKey, parseTaskKey, uniqueSlug } from './ids.js';
import {
  ARTIFACT_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  findProjectByPrefix,
  findProjectBySlug,
  findTaskById,
  findTaskByKey,
  findTaskBySlug,
  listProjectRows,
  normalizeTags,
  parseJsonArray,
  parseJsonObject,
  readTaskRow,
  serializeMeta,
  serializeTags,
  taskArtifacts,
  taskNotes,
  taskRelationCounts,
  taskSlugs,
  type ArtifactKind,
  type ProjectRow,
  type TaskArtifact,
  type TaskNote,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
} from './model.js';
import {
  describeAvailableProjects,
  requireProject,
  resolveProjectRef,
  type ProjectRefInput,
} from './project.js';
import { runMutation } from './transaction.js';

/** JSON view of a task, including computed readiness (`novaflow-v100/data` §3.2). */
export interface TaskView {
  id: string;
  project_id: string;
  project_slug: string;
  project_prefix: string;
  seq: number;
  key: string;
  slug: string;
  title: string;
  objective: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  claimed_by: string | null;
  session_ref: string | null;
  lease_expires_at: string | null;
  block_reason: string | null;
  blocked_by_ref: string | null;
  summary: string | null;
  idempotency_key: string | null;
  tags: string[];
  meta: Record<string, unknown>;
  is_ready: boolean;
  unmet_deps: DependencyRef[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Result of a mutating task operation. */
export interface TaskMutationResult {
  task: TaskView;
  from_state: TaskStatus;
  to_state: TaskStatus;
  /** False when the call was a documented no-op (idempotent edge, unchanged update). */
  changed: boolean;
  /** `events.seq` values appended by this call, in order. */
  event_seqs: number[];
  dry_run: boolean;
}

export interface CreateTaskResult {
  task: TaskView;
  /** True when `idempotency_key` matched an existing task; nothing was written. */
  idempotent_hit: boolean;
  dry_run: boolean;
  event_seqs: number[];
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function taskStatus(value: string | null | undefined): TaskStatus | null {
  if (value === null || value === undefined) return null;
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw validationError(`Invalid task status ${JSON.stringify(value)}.`, `Use one of: ${TASK_STATUSES.join(', ')}.`);
  }
  return value as TaskStatus;
}

function taskPriority(value: string | null | undefined): TaskPriority | null {
  if (value === null || value === undefined) return null;
  if (!(TASK_PRIORITIES as readonly string[]).includes(value)) {
    throw validationError(`Invalid task priority ${JSON.stringify(value)}.`, `Use one of: ${TASK_PRIORITIES.join(', ')}.`);
  }
  return value as TaskPriority;
}

function artifactKind(value: string | null | undefined): ArtifactKind {
  if (value === null || value === undefined) return 'file';
  if (!(ARTIFACT_KINDS as readonly string[]).includes(value)) {
    throw validationError(`Invalid artifact kind ${JSON.stringify(value)}.`, `Use one of: ${ARTIFACT_KINDS.join(', ')}.`);
  }
  return value as ArtifactKind;
}

function leaseTimestamp(leaseSec: number | null | undefined, now: Date): string | null {
  if (leaseSec === null || leaseSec === undefined) return null;
  if (!Number.isInteger(leaseSec) || leaseSec < 1) {
    throw validationError(
      `--lease must be a positive integer (>= 1) number of seconds, got ${String(leaseSec)}.`,
      'Pass --lease 300 for a five-minute lease, or omit it for a permanent claim.',
    );
  }
  return new Date(now.getTime() + leaseSec * 1000).toISOString();
}

/** Chronological tail of one entity's events, oldest first. */
function eventTail(db: DatabaseSync, entityId: string, limit: number): EventView[] {
  return recentEventsFor(db, { entity_type: 'task', entity_id: entityId }, limit).reverse();
}

/**
 * Builds the JSON view of one task row.
 *
 * `unmetMap` lets list paths share one dependency query instead of one per task.
 */
export function taskView(
  db: DatabaseSync,
  row: TaskRow,
  now: Date,
  projectRow?: ProjectRow,
  unmetMap?: Map<string, DependencyRef[]>,
): TaskView {
  const project =
    projectRow ?? listProjectRows(db).find((candidate) => candidate.id === row.project_id);
  if (project === undefined) {
    throw notFoundError(`Task ${row.key} points at a missing project.`, 'Run "novaflow status" to inspect the workspace.');
  }
  const unmet = unmetMap === undefined ? unmetDependencies(db, row.id) : (unmetMap.get(row.id) ?? []);
  return {
    id: row.id,
    project_id: row.project_id,
    project_slug: project.slug,
    project_prefix: project.prefix,
    seq: row.seq,
    key: row.key,
    slug: row.slug,
    title: row.title,
    objective: row.objective,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    claimed_by: row.claimed_by,
    session_ref: row.session_ref,
    lease_expires_at: row.lease_expires_at,
    block_reason: row.block_reason,
    blocked_by_ref: row.blocked_by_ref,
    summary: row.summary,
    idempotency_key: row.idempotency_key,
    tags: parseJsonArray(row.tags_json),
    meta: parseJsonObject(row.meta_json),
    is_ready: isReady(row, unmet, now),
    unmet_deps: unmet,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function projectIndex(db: DatabaseSync): Map<string, ProjectRow> {
  return new Map(listProjectRows(db).map((row) => [row.id, row]));
}

export interface TaskRefInput extends ProjectRefInput {
  id: string;
}

/**
 * Resolves a task reference (`novaflow-v100/data` §1.1): key (case-insensitive,
 * workspace-wide), `<project_slug>/<task_slug>`, bare slug inside the resolved
 * project, or the internal ULID.
 */
export function resolveTaskRow(db: DatabaseSync, input: TaskRefInput): { task: TaskRow; project: ProjectRow } {
  const raw = typeof input.id === 'string' ? input.id.trim() : '';
  if (raw === '') {
    throw validationError('A task ID is required.', 'Pass a task key like NV3-1, or a ULID.');
  }

  const projects = projectIndex(db);
  const withProject = (task: TaskRow): { task: TaskRow; project: ProjectRow } => {
    const project = projects.get(task.project_id);
    if (project === undefined) {
      throw notFoundError(`Task ${task.key} points at a missing project.`, 'Run "novaflow status" to inspect the workspace.');
    }
    return { task, project };
  };

  if (parseTaskKey(raw) !== null) {
    const byKey = findTaskByKey(db, normalizeTaskKey(raw));
    if (byKey !== undefined) return withProject(byKey);
    throw notFoundError(`Task ${normalizeTaskKey(raw)} does not exist.`, 'List tasks with "novaflow task list".');
  }

  if (raw.includes('/')) {
    const index = raw.lastIndexOf('/');
    const projectPart = raw.slice(0, index);
    const slugPart = raw.slice(index + 1).toLowerCase();
    const project = findProjectBySlug(db, projectPart.toLowerCase()) ?? findProjectByPrefix(db, projectPart.toUpperCase());
    if (project === undefined) {
      throw notFoundError(
        `Project ${JSON.stringify(projectPart)} does not exist.`,
        `Available projects: ${describeAvailableProjects(db)}.`,
      );
    }
    const task = findTaskBySlug(db, project.id, slugPart);
    if (task === undefined) {
      throw notFoundError(
        `Task ${JSON.stringify(slugPart)} does not exist in project ${project.slug}.`,
        'List tasks with "novaflow task list".',
      );
    }
    return withProject(task);
  }

  const scoped = resolveProjectRef(db, input);
  if (scoped !== null) {
    const bySlug = findTaskBySlug(db, scoped.id, raw.toLowerCase());
    if (bySlug !== undefined) return withProject(bySlug);
  }

  const byId = findTaskById(db, raw);
  if (byId !== undefined) return withProject(byId);

  throw notFoundError(`Task ${JSON.stringify(raw)} does not exist.`, 'List tasks with "novaflow task list".');
}

export interface CreateTaskInput extends ProjectRefInput {
  title: string;
  slug?: string | null | undefined;
  objective?: string | null | undefined;
  assignee?: string | null | undefined;
  priority?: TaskPriority | null | undefined;
  /** Task keys, `<project_slug>/<slug>` refs, slugs, or ULIDs. */
  depends_on?: readonly string[] | null | undefined;
  tags?: readonly string[] | null | undefined;
  idempotency_key?: string | null | undefined;
  meta?: Record<string, unknown> | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/**
 * Creates a task in `todo`, allocating `<PREFIX>-<N>` from `projects.next_seq`
 * inside the write transaction (`novaflow-v100/data` §1.1).
 */
export function createTask(db: DatabaseSync, input: CreateTaskInput): CreateTaskResult {
  const now = input.now ?? new Date();
  const title = nonEmpty(input.title);
  if (title === null) {
    throw validationError('A task title is required.', 'Pass --title <title>.');
  }
  const priority = taskPriority(input.priority) ?? 'medium';
  const idempotencyKey = nonEmpty(input.idempotency_key);

  return runMutation(db, input.dry_run === true, (tx) => {
    const project = requireProject(tx, { project: input.project, env: input.env, config: input.config });

    if (idempotencyKey !== null) {
      const existing = tx
        .prepare('SELECT * FROM tasks WHERE project_id = ? AND idempotency_key = ?')
        .get(project.id, idempotencyKey) as unknown as TaskRow | undefined;
      // Exact match only: no upsert and no parameter comparison (`novaflow-v100/data` §1.1).
      if (existing !== undefined) {
        return {
          task: taskView(tx, existing, now, project),
          idempotent_hit: true,
          dry_run: input.dry_run === true,
          event_seqs: [],
        };
      }
    }

    const explicitSlug = nonEmpty(input.slug);
    let slug: string;
    if (explicitSlug !== null) {
      const normalized = explicitSlug.toLowerCase();
      if (!isValidSlug(normalized)) {
        throw validationError(
          `Invalid task slug ${JSON.stringify(explicitSlug)}.`,
          'Use lowercase kebab-case: ^[a-z][a-z0-9-]{0,63}$.',
        );
      }
      if (findTaskBySlug(tx, project.id, normalized) !== undefined) {
        throw conflictError(
          `Task slug ${JSON.stringify(normalized)} already exists in project ${project.slug}.`,
          'Pass a different --slug.',
        );
      }
      slug = normalized;
    } else {
      slug = uniqueSlug(deriveSlug(title), taskSlugs(tx, project.id));
    }

    const dependencies: TaskRow[] = [];
    for (const reference of input.depends_on ?? []) {
      const resolved = resolveTaskRow(tx, { id: reference, project: project.slug, config: null });
      if (dependencies.some((row) => row.id === resolved.task.id)) continue;
      dependencies.push(resolved.task);
    }

    const seq = project.next_seq;
    const key = formatTaskKey(project.prefix, seq);
    const id = ulid(now.getTime());
    const timestamp = now.toISOString();

    tx.prepare('UPDATE projects SET next_seq = ?, updated_at = ? WHERE id = ?').run(seq + 1, timestamp, project.id);
    tx.prepare(
      `INSERT INTO tasks
         (id, project_id, seq, key, slug, title, objective, status, priority, assignee, claimed_by, session_ref,
          lease_expires_at, block_reason, blocked_by_ref, summary, idempotency_key, tags_json, meta_json,
          created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      project.id,
      seq,
      key,
      slug,
      title,
      nonEmpty(input.objective) ?? '',
      priority,
      nonEmpty(input.assignee),
      idempotencyKey,
      serializeTags(normalizeTags(input.tags)),
      serializeMeta(input.meta ?? {}),
      timestamp,
      timestamp,
    );

    for (const dependency of dependencies) {
      tx.prepare('INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)').run(id, dependency.id, timestamp);
    }

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: id,
      entity_key: key,
      event_type: 'task.created',
      from_state: null,
      to_state: 'todo',
      payload: {
        slug,
        priority,
        assignee: nonEmpty(input.assignee),
        depends_on: dependencies.map((row) => row.key),
      },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, id), now, project),
      idempotent_hit: false,
      dry_run: input.dry_run === true,
      event_seqs: [event.seq],
    };
  });
}

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export interface ListTasksInput extends ProjectRefInput {
  status?: readonly TaskStatus[] | null | undefined;
  /** Strictly `todo`, all dependencies `done`, no live claim (`--ready`). */
  ready?: boolean | undefined;
  assignee?: string | null | undefined;
  claimed_by?: string | null | undefined;
  tag?: string | null | undefined;
  limit?: number | null | undefined;
  now?: Date | undefined;
}

/**
 * Lists tasks, across all projects when no project is in scope
 * (`novaflow-v100/architecture` §5.2). Ordered by creation time, then sequence.
 */
export function listTasks(db: DatabaseSync, input: ListTasksInput = {}): TaskView[] {
  const now = input.now ?? new Date();
  // `task list` without an explicit project spans every project in the workspace
  // (`novaflow-v100/architecture` §5.2); env/default project scoping applies to
  // task creation and reference lookups, not to listing.
  const explicitProject = nonEmpty(input.project);
  const project =
    explicitProject === null ? null : resolveProjectRef(db, { project: explicitProject, env: {}, config: null });
  const statuses = (input.status ?? []).map((value) => taskStatus(value)).filter((value): value is TaskStatus => value !== null);

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (project !== null) {
    where.push('project_id = ?');
    params.push(project.id);
  }
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const assignee = nonEmpty(input.assignee);
  if (assignee !== null) {
    where.push('assignee = ?');
    params.push(assignee);
  }
  const claimedBy = nonEmpty(input.claimed_by);
  if (claimedBy !== null) {
    where.push('claimed_by = ?');
    params.push(claimedBy);
  }

  const sql = `SELECT * FROM tasks ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY created_at ASC, project_id ASC, seq ASC`;
  let rows = db.prepare(sql).all(...params) as unknown as TaskRow[];

  const tag = nonEmpty(input.tag);
  if (tag !== null) {
    rows = rows.filter((row) => parseJsonArray(row.tags_json).includes(tag));
  }

  const projects = projectIndex(db);
  // One dependency query for the whole page, shared by filtering and mapping.
  const unmetByTask = unmetDependencyMap(db);
  if (input.ready === true) {
    rows = rows.filter((row) => isReady(row, unmetByTask.get(row.id) ?? [], now));
  }

  const views = rows.map((row) => taskView(db, row, now, projects.get(row.project_id), unmetByTask));
  if (input.limit === null || input.limit === undefined) return views;
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw validationError(`--limit must be an integer >= 1, got ${String(input.limit)}.`, 'Pass a whole number for --limit.');
  }
  return views.slice(0, input.limit);
}

export interface NextTasksInput extends ProjectRefInput {
  assignee?: string | null | undefined;
  limit?: number | null | undefined;
  now?: Date | undefined;
}

/**
 * Orchestrator dispatch query: ready tasks ordered by priority
 * (`urgent` > `high` > `medium` > `low`), then `created_at` ascending
 * (`novaflow-v100/cli` §3.3), default limit 10.
 */
export function nextTasks(db: DatabaseSync, input: NextTasksInput = {}): TaskView[] {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) {
    throw validationError(`--limit must be an integer >= 1, got ${String(limit)}.`, 'Pass a whole number for --limit.');
  }

  const ready = listTasks(db, {
    project: input.project,
    env: input.env,
    config: input.config,
    assignee: input.assignee,
    ready: true,
    now,
  });

  return [...ready]
    .sort((left, right) => {
      const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      if (byPriority !== 0) return byPriority;
      if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    })
    .slice(0, limit);
}

export interface TaskStatusInput extends TaskRefInput {
  now?: Date | undefined;
}

export interface TaskStatusResult {
  task: TaskView;
  counts: { notes: number; artifacts: number; dependencies: number; dependents: number };
  recent_events: EventView[];
}

/** Full task state for `task status` (`novaflow-v100/cli` §3.3). */
export function getTaskStatus(db: DatabaseSync, input: TaskStatusInput): TaskStatusResult {
  const now = input.now ?? new Date();
  const { task, project } = resolveTaskRow(db, input);
  return {
    task: taskView(db, task, now, project),
    counts: taskRelationCounts(db, task.id),
    recent_events: eventTail(db, task.id, 10),
  };
}

/** Artifact shape used by `task context` (`novaflow-v100/data` §5). */
export interface ContextArtifact {
  uri: string;
  label: string | null;
  kind: ArtifactKind;
}

/** Note shape used by `task context` (`novaflow-v100/data` §5). */
export interface ContextNote {
  author: string | null;
  body: string;
  created_at: string;
}

export interface TaskContextResult {
  task: {
    id: string;
    key: string;
    slug: string;
    title: string;
    objective: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee: string | null;
    claimed_by: string | null;
    session_ref: string | null;
    is_ready: boolean;
    unmet_deps: DependencyRef[];
  };
  project: {
    slug: string;
    prefix: string;
    title: string;
    objective: string;
    repo_path: string | null;
    verify_cmd: string | null;
  };
  upstream: Array<{
    key: string;
    title: string;
    status: string;
    summary: string | null;
    artifacts: ContextArtifact[];
    notes: ContextNote[];
  }>;
  downstream: Array<{ key: string; title: string; status: string }>;
  notes: ContextNote[];
  artifacts: ContextArtifact[];
  recent_events: EventView[];
}

function contextArtifacts(db: DatabaseSync, taskId: string): ContextArtifact[] {
  return taskArtifacts(db, taskId).map((artifact) => ({ uri: artifact.uri, label: artifact.label, kind: artifact.kind }));
}

function contextNotes(db: DatabaseSync, taskId: string): ContextNote[] {
  return taskNotes(db, taskId).map((note) => ({ author: note.author, body: note.body, created_at: note.created_at }));
}

/**
 * Deterministic handoff bundle (`novaflow-v100/data` §5): task, project context,
 * upstream summaries with artifacts and notes, downstream dependents, own notes
 * and artifacts, and the recent timeline.
 */
export function getTaskContext(db: DatabaseSync, input: TaskStatusInput): TaskContextResult {
  const now = input.now ?? new Date();
  const { task, project } = resolveTaskRow(db, input);
  const view = taskView(db, task, now, project);

  const upstream = dependencyRefs(db, task.id).map((dependency) => {
    const row = readTaskRow(db, dependency.id);
    return {
      key: row.key,
      title: row.title,
      status: row.status,
      summary: row.summary,
      artifacts: contextArtifacts(db, row.id),
      notes: contextNotes(db, row.id),
    };
  });

  return {
    task: {
      id: view.id,
      key: view.key,
      slug: view.slug,
      title: view.title,
      objective: view.objective,
      status: view.status,
      priority: view.priority,
      assignee: view.assignee,
      claimed_by: view.claimed_by,
      session_ref: view.session_ref,
      is_ready: view.is_ready,
      unmet_deps: view.unmet_deps,
    },
    project: {
      slug: project.slug,
      prefix: project.prefix,
      title: project.title,
      objective: project.objective,
      repo_path: project.repo_path,
      verify_cmd: project.verify_cmd,
    },
    upstream,
    downstream: dependentRefs(db, task.id).map((dependent) => ({
      key: dependent.key,
      title: dependent.title,
      status: dependent.status,
    })),
    notes: contextNotes(db, task.id),
    artifacts: contextArtifacts(db, task.id),
    recent_events: eventTail(db, task.id, 10),
  };
}

export interface UpdateTaskInput extends TaskRefInput {
  title?: string | null | undefined;
  objective?: string | null | undefined;
  priority?: TaskPriority | null | undefined;
  assignee?: string | null | undefined;
  /** Replaces the full tag list; `null` clears it. */
  tags?: readonly string[] | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** Updates mutable task fields without touching lifecycle state. */
export function updateTask(db: DatabaseSync, input: UpdateTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const requestedPriority = taskPriority(input.priority);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);

    const sets: string[] = [];
    const values: Array<string | null> = [];
    const fields: Record<string, { from: unknown; to: unknown }> = {};

    const setColumn = (column: string, value: string | null, from: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
      fields[column] = { from, to: value };
    };

    if (input.title !== undefined) {
      const title = nonEmpty(input.title);
      if (title === null) throw validationError('A task title cannot be empty.', 'Pass --title <title>.');
      if (title !== task.title) setColumn('title', title, task.title);
    }
    if (input.objective !== undefined) {
      const objective = nonEmpty(input.objective) ?? '';
      if (objective !== task.objective) setColumn('objective', objective, task.objective);
    }
    if (requestedPriority !== null && requestedPriority !== task.priority) {
      setColumn('priority', requestedPriority, task.priority);
    }
    if (input.assignee !== undefined) {
      const assignee = nonEmpty(input.assignee);
      if (assignee !== task.assignee) setColumn('assignee', assignee, task.assignee);
    }
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags);
      const serialized = serializeTags(tags);
      if (serialized !== task.tags_json) {
        sets.push('tags_json = ?');
        values.push(serialized);
        fields.tags_json = { from: parseJsonArray(task.tags_json), to: tags };
      }
    }

    const changed = Object.keys(fields);
    if (changed.length === 0) {
      return {
        task: taskView(tx, task, now, project),
        from_state: task.status,
        to_state: task.status,
        changed: false,
        event_seqs: [],
        dry_run: input.dry_run === true,
      };
    }

    sets.push('updated_at = ?');
    values.push(now.toISOString());
    tx.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, task.id);

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.updated',
      from_state: task.status,
      to_state: task.status,
      payload: { fields },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: task.status,
      to_state: task.status,
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

interface ClaimDecision {
  /** Metadata when an existing claim is taken over, else null. */
  takeover: { claimed_by: string; lease_expires_at: string | null; expired: boolean; forced: boolean } | null;
}

/**
 * Claim guard (`novaflow-v100/data` §3.3): a claim held by another actor blocks
 * unless its lease has expired, or `--force` overrides it.
 */
function checkClaim(task: TaskRow, by: string | null, force: boolean, now: Date): ClaimDecision {
  if (task.claimed_by === null) return { takeover: null };
  const expired = isLeaseExpired(task.lease_expires_at, now);
  const own = by !== null && task.claimed_by === by;

  if (own) {
    return expired ? { takeover: { claimed_by: task.claimed_by, lease_expires_at: task.lease_expires_at, expired, forced: false } } : { takeover: null };
  }
  if (expired || force) {
    return { takeover: { claimed_by: task.claimed_by, lease_expires_at: task.lease_expires_at, expired, forced: !expired } };
  }
  throw alreadyClaimedError(
    `Task ${task.key} is claimed by ${task.claimed_by}${task.lease_expires_at === null ? ' (permanent claim)' : ` until ${task.lease_expires_at}`}.`,
    'Wait for the lease to expire, ask the holder to release it, or pass --force.',
  );
}

function assertDependenciesMet(db: DatabaseSync, task: TaskRow, force: boolean): void {
  const unmet = unmetDependencies(db, task.id);
  if (unmet.length === 0 || force) return;
  throw unmetDependenciesError(formatUnmetDependencies(task.key, unmet), 'Wait for the dependencies to complete, or pass --force to override.');
}

interface ClaimFieldInput {
  by: string | null;
  session_ref?: string | null | undefined;
  lease_sec?: number | null | undefined;
  now: Date;
  takeover: ClaimDecision['takeover'];
}

interface ClaimFields {
  claimed_by: string | null;
  session_ref: string | null;
  lease_expires_at: string | null;
}

/** Claim columns after `start`, `claim`, or `unblock --start`. */
function claimFields(task: TaskRow, input: ClaimFieldInput): ClaimFields {
  const claimedBy = input.by !== null ? input.by : input.takeover !== null ? null : task.claimed_by;
  const lease = input.lease_sec === null || input.lease_sec === undefined ? null : leaseTimestamp(input.lease_sec, input.now);
  const hasLeaseArg = input.lease_sec !== null && input.lease_sec !== undefined;
  const leaseExpiresAt = hasLeaseArg
    ? lease
    : input.by !== null || input.takeover !== null
      ? null
      : task.lease_expires_at;
  const claimantChanged = claimedBy !== task.claimed_by;
  const sessionRef =
    input.session_ref !== undefined
      ? nonEmpty(input.session_ref)
      : claimantChanged
        ? null
        : task.session_ref;

  return { claimed_by: claimedBy, session_ref: sessionRef, lease_expires_at: leaseExpiresAt };
}

export interface StartTaskInput extends TaskRefInput {
  by?: string | null | undefined;
  session_ref?: string | null | undefined;
  lease_sec?: number | null | undefined;
  note?: string | null | undefined;
  force?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/**
 * `task start`: `todo` -> `in_progress`, with expired-lease takeover and
 * `--force` as the only overrides (`novaflow-v100/data` §3.3).
 */
export function startTask(db: DatabaseSync, input: StartTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const force = input.force === true;

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;

    if (from === 'blocked') {
      throw conflictError(`Task ${task.key} is blocked.`, 'Use "novaflow task unblock <ID> --start" to resume blocked work.');
    }
    if (from === 'done' || from === 'cancelled') {
      throw conflictError(`Task ${task.key} is ${from}.`, 'Reopen it first with "novaflow task reopen <ID>".');
    }

    const decision = checkClaim(task, by, force, now);
    if (from === 'in_progress' && decision.takeover === null && !force) {
      throw conflictError(`Task ${task.key} is already in_progress.`, 'Pass --force to restart it.');
    }

    assertDependenciesMet(tx, task, force);

    const claim = claimFields(task, { by, session_ref: input.session_ref, lease_sec: input.lease_sec, now, takeover: decision.takeover });
    const timestamp = now.toISOString();
    tx.prepare(
      `UPDATE tasks
          SET status = 'in_progress', claimed_by = ?, session_ref = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(claim.claimed_by, claim.session_ref, claim.lease_expires_at, timestamp, timestamp, task.id);

    const eventSeqs: number[] = [];
    const payload: Record<string, unknown> = {};
    if (decision.takeover !== null) payload.take_over = decision.takeover;
    if (force) payload.force = true;
    eventSeqs.push(
      appendEventWithSeq(tx, {
        entity_type: 'task',
        entity_id: task.id,
        entity_key: task.key,
        event_type: 'task.started',
        actor: by,
        from_state: from,
        to_state: 'in_progress',
        payload,
        now,
      }).seq,
    );

    const note = nonEmpty(input.note);
    if (note !== null) {
      tx.prepare('INSERT INTO task_notes (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
        ulid(now.getTime()),
        task.id,
        by,
        note,
        timestamp,
      );
      eventSeqs.push(
        appendEventWithSeq(tx, {
          entity_type: 'task',
          entity_id: task.id,
          entity_key: task.key,
          event_type: 'task.noted',
          actor: by,
          payload: { body: note },
          now,
        }).seq,
      );
    }

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: 'in_progress',
      changed: true,
      event_seqs: eventSeqs,
      dry_run: input.dry_run === true,
    };
  });
}

export interface ArtifactInput {
  uri: string;
  label?: string | null | undefined;
  kind?: ArtifactKind | string | null | undefined;
}

export interface CompleteTaskInput extends TaskRefInput {
  summary?: string | null | undefined;
  by?: string | null | undefined;
  artifacts?: readonly (string | ArtifactInput)[] | null | undefined;
  force?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/**
 * `task complete`: `todo`/`in_progress`/`blocked` -> `done`. Completing straight
 * from `todo` leaves `started_at = NULL` (`novaflow-v100/data` §3.3).
 */
export function completeTask(db: DatabaseSync, input: CompleteTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const force = input.force === true;

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;

    if (from === 'done' || from === 'cancelled') {
      if (!force) {
        throw conflictError(`Task ${task.key} is already ${from}.`, 'Pass --force to complete it again, or reopen it first.');
      }
    }
    checkClaim(task, by, force, now);

    const timestamp = now.toISOString();
    const summary = input.summary === undefined ? task.summary : nonEmpty(input.summary);
    tx.prepare(
      `UPDATE tasks
          SET status = 'done', completed_at = ?, summary = ?, lease_expires_at = NULL,
              block_reason = NULL, blocked_by_ref = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(timestamp, summary, timestamp, task.id);

    const attached: TaskArtifact[] = [];
    for (const artifact of input.artifacts ?? []) {
      const normalized: ArtifactInput = typeof artifact === 'string' ? { uri: artifact } : artifact;
      const uri = nonEmpty(normalized.uri);
      if (uri === null) throw validationError('An artifact URI is required.', 'Pass --artifact <uri>.');
      const kind = artifactKind(normalized.kind);
      const id = ulid(now.getTime());
      tx.prepare('INSERT INTO task_artifacts (id, task_id, uri, label, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        task.id,
        uri,
        nonEmpty(normalized.label),
        kind,
        timestamp,
      );
      attached.push({ id, uri, label: nonEmpty(normalized.label), kind, created_at: timestamp });
    }

    const eventSeqs = [
      appendEventWithSeq(tx, {
        entity_type: 'task',
        entity_id: task.id,
        entity_key: task.key,
        event_type: 'task.completed',
        actor: by,
        from_state: from,
        to_state: 'done',
        payload: {
          ...(summary === null ? {} : { summary }),
          ...(attached.length === 0 ? {} : { artifacts: attached.map((artifact) => artifact.uri) }),
          ...(force ? { force: true } : {}),
        },
        now,
      }).seq,
    ];

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: 'done',
      changed: true,
      event_seqs: eventSeqs,
      dry_run: input.dry_run === true,
    };
  });
}

export interface BlockTaskInput extends TaskRefInput {
  reason?: string | null | undefined;
  waiting_on?: string | null | undefined;
  /** Another task to depend on; adding it is cycle-checked. */
  on?: string | null | undefined;
  by?: string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task block`: `todo`/`in_progress`/`blocked` -> `blocked`. */
export function blockTask(db: DatabaseSync, input: BlockTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const reason = nonEmpty(input.reason);
  const on = nonEmpty(input.on);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;

    if (from === 'done' || from === 'cancelled') {
      throw conflictError(`Task ${task.key} is ${from}.`, 'Reopen it first with "novaflow task reopen <ID>".');
    }
    if (reason === null && on === null) {
      throw validationError('A block reason is required.', 'Pass --reason <text>, or --on <OTHER_ID> to wait on another task.');
    }

    const timestamp = now.toISOString();
    const eventSeqs: number[] = [];
    let blockedByRef = nonEmpty(input.waiting_on);
    let blockReason = reason;

    if (on !== null) {
      const dependency = resolveTaskRow(tx, { id: on, project: project.slug, config: null });
      assertNoCycle(tx, { id: task.id, key: task.key }, { id: dependency.task.id, key: dependency.task.key });
      const exists = tx.prepare('SELECT 1 AS present FROM task_deps WHERE task_id = ? AND depends_on = ?').get(task.id, dependency.task.id);
      if (exists === undefined) {
        tx.prepare('INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)').run(task.id, dependency.task.id, timestamp);
        eventSeqs.push(
          appendEventWithSeq(tx, {
            entity_type: 'task',
            entity_id: task.id,
            entity_key: task.key,
            event_type: 'task.dep_added',
            actor: by,
            payload: { depends_on: dependency.task.key },
            now,
          }).seq,
        );
      }
      blockedByRef = blockedByRef ?? dependency.task.key;
      blockReason = blockReason ?? `Waiting on ${dependency.task.key}`;
    }

    tx.prepare(
      `UPDATE tasks
          SET status = 'blocked', block_reason = ?, blocked_by_ref = ?, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(blockReason, blockedByRef, timestamp, task.id);

    eventSeqs.push(
      appendEventWithSeq(tx, {
        entity_type: 'task',
        entity_id: task.id,
        entity_key: task.key,
        event_type: 'task.blocked',
        actor: by,
        from_state: from,
        to_state: 'blocked',
        payload: { reason: blockReason, waiting_on: blockedByRef },
        now,
      }).seq,
    );

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: 'blocked',
      changed: true,
      event_seqs: eventSeqs.sort((left, right) => left - right),
      dry_run: input.dry_run === true,
    };
  });
}

export interface UnblockTaskInput extends TaskRefInput {
  note?: string | null | undefined;
  /** Resume directly into `in_progress`; the only path out of `blocked`. */
  start?: boolean | undefined;
  by?: string | null | undefined;
  session_ref?: string | null | undefined;
  lease_sec?: number | null | undefined;
  force?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task unblock`: `blocked` -> `todo`, or `in_progress` with `--start`. */
export function unblockTask(db: DatabaseSync, input: UnblockTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const force = input.force === true;
  const start = input.start === true;

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    if (task.status !== 'blocked') {
      throw conflictError(`Task ${task.key} is ${task.status}, not blocked.`, 'Only blocked tasks can be unblocked.');
    }

    let claim: ClaimFields = {
      claimed_by: task.claimed_by,
      session_ref: task.session_ref,
      lease_expires_at: null,
    };
    let toState: TaskStatus = 'todo';
    if (start) {
      const decision = checkClaim(task, by, force, now);
      assertDependenciesMet(tx, task, force);
      claim = claimFields(task, { by, session_ref: input.session_ref, lease_sec: input.lease_sec, now, takeover: decision.takeover });
      toState = 'in_progress';
    }

    const timestamp = now.toISOString();
    tx.prepare(
      `UPDATE tasks
          SET status = ?, block_reason = NULL, blocked_by_ref = NULL, claimed_by = ?, session_ref = ?,
              lease_expires_at = ?, started_at = CASE WHEN ? = 'in_progress' THEN COALESCE(started_at, ?) ELSE started_at END,
              updated_at = ?
        WHERE id = ?`,
    ).run(toState, claim.claimed_by, claim.session_ref, claim.lease_expires_at, toState, timestamp, timestamp, task.id);

    const eventSeqs = [
      appendEventWithSeq(tx, {
        entity_type: 'task',
        entity_id: task.id,
        entity_key: task.key,
        event_type: 'task.unblocked',
        actor: by,
        from_state: 'blocked',
        to_state: toState,
        payload: { started: start },
        now,
      }).seq,
    ];

    const note = nonEmpty(input.note);
    if (note !== null) {
      tx.prepare('INSERT INTO task_notes (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
        ulid(now.getTime()),
        task.id,
        by,
        note,
        timestamp,
      );
      eventSeqs.push(
        appendEventWithSeq(tx, {
          entity_type: 'task',
          entity_id: task.id,
          entity_key: task.key,
          event_type: 'task.noted',
          actor: by,
          payload: { body: note },
          now,
        }).seq,
      );
    }

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: 'blocked',
      to_state: toState,
      changed: true,
      event_seqs: eventSeqs,
      dry_run: input.dry_run === true,
    };
  });
}

export interface CancelTaskInput extends TaskRefInput {
  reason?: string | null | undefined;
  by?: string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task cancel`: `todo`/`in_progress`/`blocked` -> `cancelled`. Keys are never reused. */
export function cancelTask(db: DatabaseSync, input: CancelTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const reason = nonEmpty(input.reason);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;

    if (from === 'done' || from === 'cancelled') {
      throw conflictError(`Task ${task.key} is ${from}.`, 'Terminal tasks cannot be cancelled; reopen it first.');
    }

    const timestamp = now.toISOString();
    tx.prepare('UPDATE tasks SET status = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(
      'cancelled',
      timestamp,
      task.id,
    );

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.cancelled',
      actor: by,
      from_state: from,
      to_state: 'cancelled',
      payload: reason === null ? {} : { reason },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: 'cancelled',
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface ReopenTaskInput extends TaskRefInput {
  reason?: string | null | undefined;
  by?: string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task reopen`: terminal reset only (`done`/`cancelled` -> `todo`). */
export function reopenTask(db: DatabaseSync, input: ReopenTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const reason = nonEmpty(input.reason);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;
    if (from !== 'done' && from !== 'cancelled') {
      throw conflictError(`Task ${task.key} is ${from}, not terminal.`, 'Use "novaflow task unblock <ID>" to resume a blocked task.');
    }

    const timestamp = now.toISOString();
    tx.prepare(
      `UPDATE tasks
          SET status = 'todo', completed_at = NULL, started_at = NULL, summary = NULL,
              claimed_by = NULL, session_ref = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(timestamp, task.id);

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.reopened',
      actor: by,
      from_state: from,
      to_state: 'todo',
      payload: reason === null ? {} : { reason },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: 'todo',
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface ClaimTaskInput extends TaskRefInput {
  by: string;
  session_ref?: string | null | undefined;
  lease_sec?: number | null | undefined;
  force?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task claim`: acquires or renews a claim without changing state. */
export function claimTask(db: DatabaseSync, input: ClaimTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);
  const force = input.force === true;
  if (by === null) {
    throw validationError('--by is required to claim a task.', 'Pass --by <actor>.');
  }

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    if (task.status !== 'todo' && task.status !== 'in_progress') {
      throw conflictError(`Task ${task.key} is ${task.status}.`, 'Only todo or in_progress tasks can be claimed.');
    }

    const decision = checkClaim(task, by, force, now);
    const claim = claimFields(task, { by, session_ref: input.session_ref, lease_sec: input.lease_sec, now, takeover: decision.takeover });
    const timestamp = now.toISOString();
    tx.prepare('UPDATE tasks SET claimed_by = ?, session_ref = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?').run(
      claim.claimed_by,
      claim.session_ref,
      claim.lease_expires_at,
      timestamp,
      task.id,
    );

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.claimed',
      actor: by,
      from_state: task.status,
      to_state: task.status,
      payload: {
        lease_expires_at: claim.lease_expires_at,
        ...(decision.takeover === null ? {} : { take_over: decision.takeover }),
      },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: task.status,
      to_state: task.status,
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface ReleaseTaskInput extends TaskRefInput {
  by?: string | null | undefined;
  /** Return an `in_progress` task to `todo`. */
  to_todo?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task release`: clears claim, session, and lease; `--to-todo` also un-starts. */
export function releaseTask(db: DatabaseSync, input: ReleaseTaskInput): TaskMutationResult {
  const now = input.now ?? new Date();
  const by = nonEmpty(input.by);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const from = task.status;
    if (from === 'done' || from === 'cancelled') {
      throw conflictError(`Task ${task.key} is ${from}.`, 'Terminal tasks hold no claim to release.');
    }

    const toState: TaskStatus = input.to_todo === true && from === 'in_progress' ? 'todo' : from;
    const timestamp = now.toISOString();
    tx.prepare(
      `UPDATE tasks SET status = ?, claimed_by = NULL, session_ref = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(toState, timestamp, task.id);

    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.released',
      actor: by,
      from_state: from,
      to_state: toState,
      payload: by === null ? {} : { released_by: by },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: from,
      to_state: toState,
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface TaskDepInput extends TaskRefInput {
  on: string;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `task depend`: adds `id depends_on on` after a breadth-first cycle check. */
export function addTaskDep(db: DatabaseSync, input: TaskDepInput): TaskMutationResult {
  const now = input.now ?? new Date();

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const dependency = resolveTaskRow(tx, { id: input.on, project: project.slug, config: null });
    assertNoCycle(tx, { id: task.id, key: task.key }, { id: dependency.task.id, key: dependency.task.key });

    const existing = tx
      .prepare('SELECT 1 AS present FROM task_deps WHERE task_id = ? AND depends_on = ?')
      .get(task.id, dependency.task.id);
    if (existing !== undefined) {
      return {
        task: taskView(tx, task, now, project),
        from_state: task.status,
        to_state: task.status,
        changed: false,
        event_seqs: [],
        dry_run: input.dry_run === true,
      };
    }

    tx.prepare('INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)').run(
      task.id,
      dependency.task.id,
      now.toISOString(),
    );
    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.dep_added',
      payload: { depends_on: dependency.task.key },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: task.status,
      to_state: task.status,
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

/** `task undepend`: removes a dependency edge; a missing edge is exit 4. */
export function removeTaskDep(db: DatabaseSync, input: TaskDepInput): TaskMutationResult {
  const now = input.now ?? new Date();

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task, project } = resolveTaskRow(tx, input);
    const dependency = resolveTaskRow(tx, { id: input.on, project: project.slug, config: null });
    const existing = tx
      .prepare('SELECT 1 AS present FROM task_deps WHERE task_id = ? AND depends_on = ?')
      .get(task.id, dependency.task.id);
    if (existing === undefined) {
      throw notFoundError(
        `Task ${task.key} does not depend on ${dependency.task.key}.`,
        'List dependencies with "novaflow task context <ID>".',
      );
    }

    tx.prepare('DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?').run(task.id, dependency.task.id);
    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.dep_removed',
      payload: { depends_on: dependency.task.key },
      now,
    });

    return {
      task: taskView(tx, readTaskRow(tx, task.id), now, project),
      from_state: task.status,
      to_state: task.status,
      changed: true,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface AddTaskNoteInput extends TaskRefInput {
  message: string;
  by?: string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

export interface AddTaskNoteResult {
  task: TaskNote;
  event_seqs: number[];
  dry_run: boolean;
}

/** `task note`: appends a timestamped note without changing status. */
export function addTaskNote(db: DatabaseSync, input: AddTaskNoteInput): AddTaskNoteResult {
  const now = input.now ?? new Date();
  const body = nonEmpty(input.message);
  if (body === null) {
    throw validationError('A note body is required.', 'Pass the note text as the second argument.');
  }
  const by = nonEmpty(input.by);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task } = resolveTaskRow(tx, input);
    const id = ulid(now.getTime());
    const timestamp = now.toISOString();
    tx.prepare('INSERT INTO task_notes (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      task.id,
      by,
      body,
      timestamp,
    );
    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.noted',
      actor: by,
      payload: { body },
      now,
    });

    return {
      task: { id, author: by, body, created_at: timestamp },
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface AttachArtifactInput extends TaskRefInput {
  uri: string;
  label?: string | null | undefined;
  kind?: ArtifactKind | string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

export interface AttachArtifactResult {
  artifact: TaskArtifact;
  event_seqs: number[];
  dry_run: boolean;
}

/** `task attach`: links a file, PR, log, or URL to the task for handoff. */
export function attachTaskArtifact(db: DatabaseSync, input: AttachArtifactInput): AttachArtifactResult {
  const now = input.now ?? new Date();
  const uri = nonEmpty(input.uri);
  if (uri === null) {
    throw validationError('An artifact URI is required.', 'Pass --artifact <uri> or a URI argument.');
  }
  const kind = artifactKind(input.kind);
  const label = nonEmpty(input.label);

  return runMutation(db, input.dry_run === true, (tx) => {
    const { task } = resolveTaskRow(tx, input);
    const id = ulid(now.getTime());
    const timestamp = now.toISOString();
    tx.prepare('INSERT INTO task_artifacts (id, task_id, uri, label, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      task.id,
      uri,
      label,
      kind,
      timestamp,
    );
    const event = appendEventWithSeq(tx, {
      entity_type: 'task',
      entity_id: task.id,
      entity_key: task.key,
      event_type: 'task.attached',
      payload: { uri, label, kind },
      now,
    });

    return {
      artifact: { id, uri, label, kind, created_at: timestamp },
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}
