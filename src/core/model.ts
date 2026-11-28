/**
 * Row types, JSON column helpers, and derived read models
 * (`novaflow-v100/data` §1, §2, §3.2).
 *
 * The mapping layer keeps persisted rows (`snake_case`, `*_json` columns) apart
 * from the JSON views the CLI and MCP surface emit.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isReady, unmetDependencies, unmetDependencyMap } from './dag.js';
import type { DependencyRef } from './dag.js';
import { notFoundError } from './errors.js';

export type ProjectStatus = 'active' | 'paused' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'paused', 'archived'];
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const ARTIFACT_KINDS = ['file', 'pr', 'log', 'url'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** A `projects` row exactly as stored. */
export interface ProjectRow {
  id: string;
  slug: string;
  prefix: string;
  title: string;
  objective: string;
  repo_path: string | null;
  verify_cmd: string | null;
  status: ProjectStatus;
  next_seq: number;
  tags_json: string;
  meta_json: string;
  created_at: string;
  updated_at: string;
}

/** A `tasks` row exactly as stored. */
export interface TaskRow {
  id: string;
  project_id: string;
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
  tags_json: string;
  meta_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Task counts used by `project list`, `project show`, and `status`. */
export interface StatusCounts {
  todo: number;
  ready: number;
  waiting: number;
  in_progress: number;
  blocked: number;
  done: number;
  cancelled: number;
  total: number;
}

/** Computed readiness of one task (`novaflow-v100/data` §3.2). */
export interface Readiness {
  is_ready: boolean;
  unmet_deps: DependencyRef[];
}

export interface TaskNote {
  id: string;
  author: string | null;
  body: string;
  created_at: string;
}

export interface TaskArtifact {
  id: string;
  uri: string;
  label: string | null;
  kind: ArtifactKind;
  created_at: string;
}

/** Parses a JSON array column, tolerating hand-edited databases. */
export function parseJsonArray(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** Parses a JSON object column, tolerating hand-edited databases. */
export function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Serializes a string list for a `*_json` column. */
export function serializeTags(tags: readonly string[]): string {
  return JSON.stringify([...tags]);
}

/** Serializes an object for a `*_json` column. */
export function serializeMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(meta);
}

/** Normalizes a tag list: trimmed, non-empty, de-duplicated, order preserved. */
export function normalizeTags(tags: readonly string[] | null | undefined): string[] {
  if (tags === null || tags === undefined) return [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (value !== '') seen.add(value);
  }
  return [...seen];
}

export function readProjectRow(db: DatabaseSync, projectId: string): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as ProjectRow | undefined;
  if (row === undefined) throw notFoundError(`Project ${projectId} does not exist.`, 'List projects with "novaflow project list".');
  return row;
}

export function findProjectBySlug(db: DatabaseSync, slug: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as unknown as ProjectRow | undefined;
}

export function findProjectByPrefix(db: DatabaseSync, prefix: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE prefix = ?').get(prefix) as unknown as ProjectRow | undefined;
}

export function listProjectRows(db: DatabaseSync): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY slug').all() as unknown as ProjectRow[];
}

export function readTaskRow(db: DatabaseSync, taskId: string): TaskRow {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as TaskRow | undefined;
  if (row === undefined) throw notFoundError(`Task ${taskId} does not exist.`, 'List tasks with "novaflow task list".');
  return row;
}

export function findTaskById(db: DatabaseSync, id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
}

export function findTaskByKey(db: DatabaseSync, key: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE key = ?').get(key.toUpperCase()) as unknown as TaskRow | undefined;
}

export function findTaskBySlug(db: DatabaseSync, projectId: string, slug: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slug = ?').get(projectId, slug) as unknown as
    | TaskRow
    | undefined;
}

/** Every task slug in a project, for auto-slug collision checks. */
export function taskSlugs(db: DatabaseSync, projectId: string): Set<string> {
  const rows = db.prepare('SELECT slug FROM tasks WHERE project_id = ?').all(projectId) as unknown as Array<{
    slug: string;
  }>;
  return new Set(rows.map((row) => row.slug));
}

/** Every project slug in the workspace. */
export function projectSlugs(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT slug FROM projects').all() as unknown as Array<{ slug: string }>;
  return new Set(rows.map((row) => row.slug));
}

/** Every project prefix in the workspace. */
export function projectPrefixes(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT prefix FROM projects').all() as unknown as Array<{ prefix: string }>;
  return new Set(rows.map((row) => row.prefix));
}

/** Computed readiness for one task row. */
export function readinessFor(db: DatabaseSync, task: TaskRow, now: Date): Readiness {
  const unmet = unmetDependencies(db, task.id);
  return { is_ready: isReady(task, unmet, now), unmet_deps: unmet };
}

/**
 * Task counts by persisted status, plus derived `ready` / `waiting` splits of
 * `todo` (`novaflow-v100/data` §3.2, `novaflow-v100/cli` §3.5).
 */
export function statusCounts(db: DatabaseSync, options: { project_id?: string | null; now: Date }): StatusCounts {
  const projectId = options.project_id ?? null;
  const rows = (
    projectId === null
      ? db.prepare('SELECT id, status, claimed_by, lease_expires_at FROM tasks').all()
      : db.prepare('SELECT id, status, claimed_by, lease_expires_at FROM tasks WHERE project_id = ?').all(projectId)
  ) as unknown as Array<Pick<TaskRow, 'id' | 'status' | 'claimed_by' | 'lease_expires_at'>>;

  const unmetByTask = unmetDependencyMap(db);
  const counts: StatusCounts = {
    todo: 0,
    ready: 0,
    waiting: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    total: rows.length,
  };

  for (const row of rows) {
    switch (row.status) {
      case 'todo': {
        counts.todo += 1;
        const ready = isReady(row, unmetByTask.get(row.id) ?? [], options.now);
        if (ready) counts.ready += 1;
        else counts.waiting += 1;
        break;
      }
      case 'in_progress':
        counts.in_progress += 1;
        break;
      case 'blocked':
        counts.blocked += 1;
        break;
      case 'done':
        counts.done += 1;
        break;
      case 'cancelled':
        counts.cancelled += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

/** Notes for a task, oldest first. */
export function taskNotes(db: DatabaseSync, taskId: string, limit?: number): TaskNote[] {
  const sql = `SELECT id, author, body, created_at FROM task_notes WHERE task_id = ? ORDER BY created_at, id`;
  const rows = (
    limit === undefined ? db.prepare(sql).all(taskId) : db.prepare(`${sql} LIMIT ?`).all(taskId, limit)
  ) as unknown as TaskNote[];
  return rows;
}

/** Artifacts for a task, oldest first. */
export function taskArtifacts(db: DatabaseSync, taskId: string, limit?: number): TaskArtifact[] {
  const sql = `SELECT id, uri, label, kind, created_at FROM task_artifacts WHERE task_id = ? ORDER BY created_at, id`;
  const rows = (
    limit === undefined ? db.prepare(sql).all(taskId) : db.prepare(`${sql} LIMIT ?`).all(taskId, limit)
  ) as unknown as TaskArtifact[];
  return rows;
}

/** Counts of one task's notes, artifacts, dependencies, and dependents. */
export function taskRelationCounts(
  db: DatabaseSync,
  taskId: string,
): { notes: number; artifacts: number; dependencies: number; dependents: number } {
  const scalar = (sql: string): number => Number((db.prepare(sql).get(taskId) as { count: number | bigint }).count);
  return {
    notes: scalar('SELECT COUNT(*) AS count FROM task_notes WHERE task_id = ?'),
    artifacts: scalar('SELECT COUNT(*) AS count FROM task_artifacts WHERE task_id = ?'),
    dependencies: scalar('SELECT COUNT(*) AS count FROM task_deps WHERE task_id = ?'),
    dependents: scalar('SELECT COUNT(*) AS count FROM task_deps WHERE depends_on = ?'),
  };
}
