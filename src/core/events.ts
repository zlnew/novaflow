/**
 * Immutable audit log (`novaflow-v100/data` §2, `novaflow-v100/cli` §3.5).
 *
 * Every state change appends exactly one row inside the caller's transaction, so
 * an event and the mutation it describes are never observable apart.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '../store/id.js';
import { validationError } from './errors.js';
import { parseJsonObject, serializeMeta } from './model.js';

export type EventEntityType = 'workspace' | 'project' | 'task';

/** Canonical workspace event types emitted in v1.0.0. */
export const WORKSPACE_EVENT_TYPES = ['workspace.created', 'workspace.updated'] as const;
/** Canonical project event types emitted in v1.0.0. */
export const PROJECT_EVENT_TYPES = ['project.created', 'project.updated', 'project.archived'] as const;
/** Canonical task event types emitted in v1.0.0. */
export const TASK_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.started',
  'task.completed',
  'task.blocked',
  'task.unblocked',
  'task.cancelled',
  'task.reopened',
  'task.claimed',
  'task.released',
  'task.dep_added',
  'task.dep_removed',
  'task.noted',
  'task.attached',
] as const;

export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
export type EventType = WorkspaceEventType | ProjectEventType | TaskEventType;

/** An `events` row exactly as stored. */
export interface EventRow {
  seq: number;
  id: string;
  entity_type: EventEntityType;
  entity_id: string;
  entity_key: string;
  event_type: string;
  actor: string | null;
  from_state: string | null;
  to_state: string | null;
  payload_json: string;
  created_at: string;
}

/** JSON view of one event. */
export interface EventView {
  seq: number;
  id: string;
  entity_type: EventEntityType;
  entity_id: string;
  entity_key: string;
  event_type: string;
  actor: string | null;
  from_state: string | null;
  to_state: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AppendEventInput {
  entity_type: EventEntityType;
  entity_id: string;
  entity_key: string;
  event_type: EventType | string;
  actor?: string | null;
  from_state?: string | null;
  to_state?: string | null;
  payload?: Record<string, unknown>;
  now?: Date;
}

export function toEventView(row: EventRow): EventView {
  return {
    seq: row.seq,
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_key: row.entity_key,
    event_type: row.event_type,
    actor: row.actor,
    from_state: row.from_state,
    to_state: row.to_state,
    payload: parseJsonObject(row.payload_json),
    created_at: row.created_at,
  };
}

/** Appends one immutable event. Must run inside the caller's transaction. */
export function appendEvent(db: DatabaseSync, input: AppendEventInput): EventView {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const id = ulid(now.getTime());
  const inserted = db.prepare(
    `INSERT INTO events
       (id, entity_type, entity_id, entity_key, event_type, actor, from_state, to_state, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.entity_type,
    input.entity_id,
    input.entity_key,
    input.event_type,
    input.actor ?? null,
    input.from_state ?? null,
    input.to_state ?? null,
    serializeMeta(input.payload ?? {}),
    createdAt,
  );

  return {
    seq: Number(inserted.lastInsertRowid),
    id,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    entity_key: input.entity_key,
    event_type: input.event_type,
    actor: input.actor ?? null,
    from_state: input.from_state ?? null,
    to_state: input.to_state ?? null,
    payload: input.payload ?? {},
    created_at: createdAt,
  };
}

/** Appends an event and returns it with the database-assigned `seq`. */
export function appendEventWithSeq(db: DatabaseSync, input: AppendEventInput): EventView {
  return appendEvent(db, input);
}

const RELATIVE_SINCE = /^([1-9][0-9]*)([smhdw])$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Normalizes `--since` into an ISO-8601 UTC timestamp
 * (`novaflow-v100/cli` §2.4): compact durations (`30m`, `2h`, `7d`) or an
 * ISO-8601/RFC3339 stamp with UTC assumed when the offset is omitted.
 */
export function parseSince(value: string, now: Date): string {
  const raw = value.trim();
  if (raw === '') throw validationError('--since cannot be empty.', 'Pass an ISO-8601 timestamp or a duration like 30m, 2h, 7d.');

  const relative = RELATIVE_SINCE.exec(raw);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2] as string] as number;
    return new Date(now.getTime() - amount * unit).toISOString();
  }

  const padded = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(padded);
  const parsed = new Date(hasZone ? padded : `${padded}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError(
      `Invalid --since value ${JSON.stringify(value)}.`,
      'Pass an ISO-8601 timestamp (2026-11-28T03:30:00Z) or a duration like 30m, 2h, 7d.',
    );
  }
  return parsed.toISOString();
}

export interface ListEventsInput {
  /** Restrict to one project's own events plus its tasks'. */
  project_id?: string | null;
  /** Restrict to one task. */
  task_id?: string | null;
  entity_type?: EventEntityType | null;
  event_types?: readonly string[] | null;
  /** Cursor: only events with `seq > after_seq`. */
  after_seq?: number | null;
  since?: string | null;
  limit?: number | null;
  now?: Date;
}

function asInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw validationError(`${name} must be an integer >= ${minimum}.`, `Pass a whole number for ${name}.`);
  }
  return value;
}

/** Queries the audit log in chronological (`seq`) order. */
export function listEvents(db: DatabaseSync, input: ListEventsInput = {}): EventView[] {
  const now = input.now ?? new Date();
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (typeof input.project_id === 'string') {
    where.push(`((entity_type = 'project' AND entity_id = ?) OR (entity_type = 'task' AND entity_id IN (SELECT id FROM tasks WHERE project_id = ?)))`);
    params.push(input.project_id, input.project_id);
  }
  if (typeof input.task_id === 'string') {
    where.push(`entity_type = 'task' AND entity_id = ?`);
    params.push(input.task_id);
  }
  if (typeof input.entity_type === 'string') {
    where.push('entity_type = ?');
    params.push(input.entity_type);
  }
  if (Array.isArray(input.event_types) && input.event_types.length > 0) {
    where.push(`event_type IN (${input.event_types.map(() => '?').join(', ')})`);
    params.push(...input.event_types);
  }
  if (input.after_seq !== null && input.after_seq !== undefined) {
    where.push('seq > ?');
    params.push(asInteger(input.after_seq, 'after_seq', 0));
  }
  if (typeof input.since === 'string') {
    where.push('created_at >= ?');
    params.push(parseSince(input.since, now));
  }

  const limit = input.limit === null || input.limit === undefined ? 100 : asInteger(input.limit, 'limit', 1);
  const sql = `SELECT * FROM events ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY seq ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as unknown as EventRow[];
  return rows.map(toEventView);
}

/** Most recent events for one entity, newest first. */
export function recentEventsFor(
  db: DatabaseSync,
  entity: { entity_type: EventEntityType; entity_id: string },
  limit = 10,
): EventView[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT ?')
    .all(entity.entity_type, entity.entity_id, limit) as unknown as EventRow[];
  return rows.map(toEventView);
}
