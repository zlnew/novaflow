/**
 * Dependency-graph rules (`novaflow-v100/data` §3.2, §4).
 *
 * Pure graph helpers over `task_deps`: computed readiness, unmet-dependency
 * lookups, and breadth-first cycle detection. Nothing here mutates rows or emits
 * events; the task service wraps these in a transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cycleDetectedError } from './errors.js';

/** Minimal identity of a dependency edge target. */
export interface DependencyRef {
  id: string;
  key: string;
  slug: string;
  title: string;
  status: string;
}

/** Fields readiness depends on; satisfied by a task row. */
export interface ReadinessSubject {
  id: string;
  status: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
}

interface DependencySqlRow {
  task_id: string;
  id: string;
  key: string;
  slug: string;
  title: string;
  status: string;
}

/**
 * A claim is expired iff a lease timestamp exists and is strictly in the past
 * (`novaflow-v100/data` §3.2). `null` means a permanent manual claim.
 */
export function isLeaseExpired(leaseExpiresAt: string | null, now: Date): boolean {
  if (leaseExpiresAt === null) return false;
  const parsed = Date.parse(leaseExpiresAt);
  return Number.isFinite(parsed) && parsed < now.getTime();
}

/** True while `claimed_by` names an actor whose lease has not expired. */
export function hasActiveClaim(subject: ReadinessSubject, now: Date): boolean {
  return subject.claimed_by !== null && !isLeaseExpired(subject.lease_expires_at, now);
}

/**
 * `ready` is derived: `todo`, every dependency `done`, and no live claim
 * (`novaflow-v100/data` §3.2). A `cancelled` dependency leaves the task waiting.
 */
export function isReady(subject: ReadinessSubject, unmet: readonly DependencyRef[], now: Date): boolean {
  return subject.status === 'todo' && unmet.length === 0 && !hasActiveClaim(subject, now);
}

function toRef(row: DependencySqlRow): DependencyRef {
  return { id: row.id, key: row.key, slug: row.slug, title: row.title, status: row.status };
}

/** Every `depends_on` task of `taskId`, whether or not it is finished. */
export function dependencyRefs(db: DatabaseSync, taskId: string): DependencyRef[] {
  const rows = db
    .prepare(
      `SELECT d.task_id AS task_id, t.id AS id, t.key AS key, t.slug AS slug, t.title AS title, t.status AS status
         FROM task_deps d
         JOIN tasks t ON t.id = d.depends_on
        WHERE d.task_id = ?
        ORDER BY t.key`,
    )
    .all(taskId) as unknown as DependencySqlRow[];
  return rows.map(toRef);
}

/** Every task that depends on `taskId` (downstream), ordered by key. */
export function dependentRefs(db: DatabaseSync, taskId: string): DependencyRef[] {
  const rows = db
    .prepare(
      `SELECT d.depends_on AS task_id, t.id AS id, t.key AS key, t.slug AS slug, t.title AS title, t.status AS status
         FROM task_deps d
         JOIN tasks t ON t.id = d.task_id
        WHERE d.depends_on = ?
        ORDER BY t.key`,
    )
    .all(taskId) as unknown as DependencySqlRow[];
  return rows.map(toRef);
}

/** Dependencies that are not `done`, in key order (`novaflow-v100/data` §3.3). */
export function unmetDependencies(db: DatabaseSync, taskId: string): DependencyRef[] {
  return dependencyRefs(db, taskId).filter((dependency) => dependency.status !== 'done');
}

/**
 * Unmet dependencies for every task in one query, keyed by `task_id`.
 *
 * Bulk reads (list, next, counts, status board) use this instead of one query
 * per task.
 */
export function unmetDependencyMap(db: DatabaseSync): Map<string, DependencyRef[]> {
  const rows = db
    .prepare(
      `SELECT d.task_id AS task_id, t.id AS id, t.key AS key, t.slug AS slug, t.title AS title, t.status AS status
         FROM task_deps d
         JOIN tasks t ON t.id = d.depends_on
        WHERE t.status != 'done'
        ORDER BY t.key`,
    )
    .all() as unknown as DependencySqlRow[];

  const map = new Map<string, DependencyRef[]>();
  for (const row of rows) {
    const refs = map.get(row.task_id);
    if (refs === undefined) map.set(row.task_id, [toRef(row)]);
    else refs.push(toRef(row));
  }
  return map;
}

/** Every task reachable from `startId` along `depends_on` edges, excluding `startId`. */
export function reachableFrom(db: DatabaseSync, startId: string): Set<string> {
  const statement = db.prepare('SELECT depends_on AS depends_on FROM task_deps WHERE task_id = ?');
  const seen = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const row of statement.all(current) as unknown as Array<{ depends_on: string }>) {
      if (seen.has(row.depends_on)) continue;
      seen.add(row.depends_on);
      queue.push(row.depends_on);
    }
  }
  return seen;
}

/**
 * Rejects `task depends_on dependency` when it would close a cycle
 * (`novaflow-v100/data` §4): self-edges and any path back to `task` re-enter
 * through `dependency`. Exit 3 (`CYCLE_DETECTED`).
 */
export function assertNoCycle(
  db: DatabaseSync,
  task: { id: string; key: string },
  dependency: { id: string; key: string },
): void {
  if (task.id === dependency.id) {
    throw cycleDetectedError(`Task ${task.key} cannot depend on itself.`, 'Pass a different task to --on.');
  }
  if (reachableFrom(db, dependency.id).has(task.id)) {
    throw cycleDetectedError(
      `Dependency ${task.key} -> ${dependency.key} would create a cycle.`,
      'Remove the conflicting edge first with "novaflow task undepend".',
    );
  }
}

/** Human sentence for `UNMET_DEPENDENCIES`, matching the documented error text. */
export function formatUnmetDependencies(taskKey: string, unmet: readonly DependencyRef[]): string {
  const listed = unmet.map((dependency) => `${dependency.key} (${dependency.status})`).join(', ');
  return `Task ${taskKey} depends on unfinished tasks: ${listed}.`;
}
