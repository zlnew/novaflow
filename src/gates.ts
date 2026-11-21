import type { Db } from "./store/db.ts";
import { applyTransition } from "./fsm/engine.ts";
import { GATE_APPROVE_TRIGGER, GATE_REJECT_TRIGGER, GATE_FAIL_TRIGGER } from "./fsm/triggers.ts";
import {
  enterChangesRequested,
  escalateIfBudgetSpent,
} from "./validating.ts";
import {
  fireHalt,
  taskHaltNotifier,
  type HaltNotifier,
  type NotifyOptions,
  type NotifyResult,
} from "./notify.ts";

/**
 * The gate service per the 8.1 gate approval contract:
 *   payload = {task_id, run_id, approved_by, note}
 * Verification is operator-identity based (single local operator, no
 * crypto): the engine REQUIRES the fields (non-empty), records them in
 * `state_transition_logs` (`trigger_type` `human` or `mcp`), and
 * rejects the operation when the task is not in `awaiting_gate` or the
 * `run_id` does not match the LIVE run. The same contract backs the
 * CLI (`nova task gate-approve`), the MCP tool `nova_gate_approve`, and
 * the `/nova gate approve` slash command.
 *
 * Spec-silent choice (documented): the LIVE run is the task's highest
 * `attempt_number` task_runs row — the attempt that produced the
 * artifact under review. Older attempts are stale by definition; a
 * payload naming any other run id (including a nonexistent one) is a
 * `stale_run` refusal, so approvals can never replay old runs.
 *
 * Contract violations are typed (GateError) and leave BOTH the task
 * and the log untouched — every field is validated before any write.
 */

export type GatePayload = {
  task_id: string;
  run_id: string;
  approved_by: string;
  note: string;
};

export type GateSurface = "human" | "mcp";

export type GateErrorCode = "not_found" | "missing_field" | "wrong_state" | "stale_run";

/** A typed gate-contract violation; `code` names the violated clause. */
export class GateError extends Error {
  constructor(readonly code: GateErrorCode, message: string) {
    super(message);
    this.name = "GateError";
  }
}

export type GateOptions = {
  /** Injected halt notifier (tests); default: workspace-config topic. */
  notify?: HaltNotifier;
  /** Transport injection for the DEFAULT (config-wired) notifier. */
  notifyOptions?: NotifyOptions;
};

export type GateOutcome = {
  taskId: string;
  finalState: string;
  retryCount: number;
  /** Fire-and-forget halt dispatches (already sent; awaitable in tests). */
  notifications: Promise<NotifyResult>[];
};

type TaskRow = {
  id: string;
  state: string;
  retry_count: number;
  max_retries: number;
};

function liveRunId(db: Db, taskId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1",
    )
    .get(taskId) as { id: string } | undefined;
  return row?.id ?? null;
}

function requireContract(
  db: Db,
  payload: GatePayload,
): { task: TaskRow; liveRun: string | null } {
  for (const field of ["task_id", "run_id", "approved_by", "note"] as const) {
    const value: unknown = payload[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new GateError(
        "missing_field",
        `gate payload requires a non-empty "${field}" (gate approval contract, architecture 8.1)`,
      );
    }
  }
  const task = db
    .prepare("SELECT id, state, retry_count, max_retries FROM tasks WHERE id = ?")
    .get(payload.task_id) as TaskRow | undefined;
  if (!task) throw new GateError("not_found", `no such task: ${payload.task_id}`);
  if (task.state !== "awaiting_gate") {
    throw new GateError(
      "wrong_state",
      `gate operations require awaiting_gate, task ${payload.task_id} is in ${task.state}`,
    );
  }
  const live = liveRunId(db, payload.task_id);
  if (live !== payload.run_id) {
    throw new GateError(
      "stale_run",
      `run_id does not match the live run${live === null ? " (task has no runs)" : ` (live run is ${live})`} — refusing to replay a stale gate operation`,
    );
  }
  return { task, liveRun: live };
}

function defaultNotifier(db: Db, taskId: string, opts: GateOptions): HaltNotifier | null {
  if (opts.notify !== undefined) return opts.notify;
  return taskHaltNotifier(db, taskId, opts.notifyOptions ?? {});
}

/**
 * Approve the gate: awaiting_gate→validating via the verbatim
 * "operator approves gate" row, with the approval record
 * ({approved_by}, {note}) in the log's reason and the surface's
 * trigger_type (human | mcp).
 */
export function approveGate(
  db: Db,
  payload: GatePayload,
  surface: GateSurface,
  opts: GateOptions = {},
): GateOutcome {
  const { liveRun } = requireContract(db, payload);
  applyTransition(db, payload.task_id, GATE_APPROVE_TRIGGER, {
    triggerType: surface,
    actor: payload.approved_by,
    runId: liveRun,
    reason: `gate approved by ${payload.approved_by}: ${payload.note}`,
  });
  const task = db
    .prepare("SELECT retry_count FROM tasks WHERE id = ?")
    .get(payload.task_id) as { retry_count: number };
  return {
    taskId: payload.task_id,
    finalState: "validating",
    retryCount: task.retry_count,
    notifications: [],
  };
}

/**
 * Reject the gate with feedback: awaiting_gate→changes_requested via
 * the verbatim "operator rejects with feedback" row, retry_count
 * incremented EXACTLY on entry (the timing rule), the feedback recorded
 * in the log's reason. If the increment exhausts the budget, the same
 * escalation check as the validating path applies
 * (changes_requested→awaiting_gate + halt alert) — one deterministic
 * rule wherever a task enters changes_requested.
 */
export function rejectGate(
  db: Db,
  payload: GatePayload,
  feedback: string,
  surface: GateSurface = "human",
  opts: GateOptions = {},
): GateOutcome {
  if (typeof feedback !== "string" || feedback.trim() === "") {
    throw new GateError(
      "missing_field",
      "a gate rejection requires non-empty feedback (the 8.1 row is 'operator rejects with feedback')",
    );
  }
  const { task } = requireContract(db, payload);
  const notifications: Promise<NotifyResult>[] = [];
  const notify = defaultNotifier(db, payload.task_id, opts);
  const retryCount = enterChangesRequested(db, payload.task_id, GATE_REJECT_TRIGGER, {
    triggerType: surface,
    actor: payload.approved_by,
    runId: payload.run_id,
    reason: `gate rejected by ${payload.approved_by}: ${feedback}`,
  });
  const finalState = escalateIfBudgetSpent(
    db,
    payload.task_id,
    retryCount,
    task.max_retries,
    { triggerType: surface, actor: payload.approved_by },
    notify,
    notifications,
  );
  return { taskId: payload.task_id, finalState, retryCount, notifications };
}

/**
 * Confirm the failure gate: awaiting_gate→failed via the verbatim
 * "operator confirms failure (terminal gate outcome)" row, with the
 * matrix row's validation gate honored: "retry budget treated as
 * exhausted" — the engine floors retry_count at max_retries (never
 * lowering it), so no retry row's `retry_count < max_retries` gate can
 * ever authorize a requeue afterwards. Failed runs are halt triggers
 * (RSK-07), so an alert fires when a topic is configured.
 */
export function confirmFailureGate(
  db: Db,
  payload: GatePayload,
  surface: GateSurface = "human",
  opts: GateOptions = {},
): GateOutcome {
  const { task } = requireContract(db, payload);
  const notifications: Promise<NotifyResult>[] = [];
  const notify = defaultNotifier(db, payload.task_id, opts);

  applyTransition(db, payload.task_id, GATE_FAIL_TRIGGER, {
    triggerType: surface,
    actor: payload.approved_by,
    runId: payload.run_id,
    reason: `gate failure confirmed by ${payload.approved_by} (terminal gate outcome): ${payload.note}`,
  });

  let retryCount = task.retry_count;
  if (retryCount < task.max_retries) {
    db.prepare("UPDATE tasks SET retry_count = ?, updated_at = ? WHERE id = ?").run(
      task.max_retries,
      new Date().toISOString(),
      payload.task_id,
    );
    retryCount = task.max_retries;
  }

  if (notify !== null) {
    notifications.push(
      fireHalt(notify, {
        title: "NovaFlow task failed",
        message: `task ${payload.task_id} confirmed failed via the gate (terminal outcome): ${payload.note}`,
      }),
    );
  }
  return { taskId: payload.task_id, finalState: "failed", retryCount, notifications };
}
