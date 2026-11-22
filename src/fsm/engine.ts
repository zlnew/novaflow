import type { Db } from "../store/db.ts";
import { ulid } from "../store/ids.ts";
import { ROWS, type CanonicalState, type MatrixRow } from "./matrix.ts";

export class InvalidTransitionError extends Error {
  constructor(
    readonly fromState: string,
    readonly trigger: string,
  ) {
    super(`illegal transition: ${fromState} + "${trigger}" is not in the 8.1 matrix`);
  }
}

/**
 * Look up a matrix row by exact trigger string. Returns the row when the
 * move is legal, undefined otherwise. Triggers are the spec's verbatim
 * trigger conditions (novaflow-v1/architecture 8.1).
 */
export function canTransition(
  state: CanonicalState | string,
  trigger: string,
): MatrixRow | undefined {
  return ROWS.find((r) => r.state === state && r.trigger === trigger);
}

export type TransitionActor = {
  triggerType: "engine" | "human" | "mcp" | "schedule" | "timeout";
  actor: string;
  reason?: string;
  runId?: string | null;
};

/**
 * Perform a guarded state move: validate against the matrix, update the
 * task row, and append the audit log row. Illegal moves throw
 * InvalidTransitionError and leave both the task and the log untouched.
 */
export function applyTransition(
  db: Db,
  taskId: string,
  trigger: string,
  who: TransitionActor,
): MatrixRow {
  const task = db
    .prepare("SELECT state FROM tasks WHERE id = ?")
    .get(taskId) as { state: CanonicalState } | undefined;
  if (!task) throw new Error(`no such task: ${taskId}`);
  const row = canTransition(task.state, trigger);
  if (!row) throw new InvalidTransitionError(task.state, trigger);

  db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(
    row.target,
    new Date().toISOString(),
    taskId,
  );
  logTransition(db, {
    taskId,
    runId: who.runId ?? null,
    fromState: task.state,
    toState: row.target,
    triggerType: who.triggerType,
    actor: who.actor,
    ...(who.reason !== undefined ? { reason: who.reason } : {}),
  });
  return row;
}

export type TransitionLogEntry = {
  taskId: string;
  runId: string | null;
  fromState: CanonicalState | string;
  toState: CanonicalState | string;
  triggerType: "engine" | "human" | "mcp" | "schedule" | "timeout";
  actor: string;
  reason?: string | undefined;
};

/** Append to state_transition_logs without changing task state (audit surface). */
export function logTransition(db: Db, entry: TransitionLogEntry): void {
  db.prepare(
    `INSERT INTO state_transition_logs
       (id, task_id, run_id, from_state, to_state, trigger_type, actor, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    entry.taskId,
    entry.runId,
    entry.fromState,
    entry.toState,
    entry.triggerType,
    entry.actor,
    entry.reason ?? null,
  );
}
