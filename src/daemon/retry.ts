import type { Db } from "../store/db.ts";
import { applyTransition, InvalidTransitionError } from "../fsm/engine.ts";
import {
  AUTO_RETRY_TRIGGER,
  OPERATOR_RETRY_TRIGGER,
  FAILED_ESCALATION_TRIGGER,
} from "./triggers.ts";
import {
  fireHalt,
  taskHaltNotifier,
  type HaltNotifier,
  type NotifyOptions,
  type NotifyResult,
} from "../notify.ts";

/**
 * The retry/escalation evaluator — the p2c contract that would
 * otherwise dead-end failed tasks with no operator surface
 * (architecture 8.1, the failed-state rows; srs FR-TSK-02 AC3):
 *
 *   - Whenever a task enters `failed` (dispatch's run-conclusion hook)
 *     or at boot (bootScan): if `retry_count >= max_retries`, apply the
 *     verbatim failed→awaiting_gate escalation row + halt notify
 *     (FAILED_NEEDS_HUMAN_REVIEW is served by the gate surface);
 *     otherwise arm the auto-retry timer.
 *   - The timer measures `retry.delay_sec` (daemon config, default 300)
 *     from the failed transition's state_transition_logs.created_at —
 *     data.md's authoritative transition time — so a delay already
 *     elapsed at boot requeues immediately.
 *   - On expiry: the verbatim failed→queued auto-retry row (the row's
 *     `retry_count < max_retries` gate is re-checked at fire time, so a
 *     task moved by another surface — operator retry, abort — never
 *     double-moves), then the dispatch hook picks it up.
 *
 * Spec-silent choices (documented, minimal-convention readings):
 *   - the auto-retry row's trigger_type is `timeout` (a timer expiry);
 *     the escalation is engine-evaluated, so `engine`.
 *   - a failed task with no failed-transition log row (impossible via
 *     the guarded paths; defensively) arms from now.
 *   - timers are unref'd and cleared on every exit path (state change,
 *     requeue, escalation, stop) — the suite leaves zero strays.
 */

export type RetryOptions = {
  /** `retry.delay_sec` from the daemon config (default 300). */
  delaySec: number;
  /** Injected halt notifier (tests); default: workspace-config topic. */
  notify?: HaltNotifier | undefined;
  /** Transport injection for the DEFAULT (config-wired) notifier. */
  notifyOptions?: NotifyOptions | undefined;
  /** Dispatch hook: a requeued task should get a scheduler pass. */
  onRequeue?: ((taskId: string) => void) | undefined;
  /** Audit-log actor (default "daemon-retry"). */
  actor?: string | undefined;
};

export type RetryDecision =
  | { kind: "escalated"; finalState: "awaiting_gate" }
  | { kind: "timer-armed"; delaySec: number; fromCreatedAt: string }
  | { kind: "requeued"; finalState: "queued" }
  | { kind: "not-failed"; state: string };

export type OperatorRetryMeta = {
  /** The socket surface: human (CLI) or mcp — recorded per the DDL CHECK. */
  triggerType: "human" | "mcp";
  actor: string;
};

type TaskCore = { state: string; retry_count: number; max_retries: number };

function warn(message: string): void {
  console.warn(`[novaflow-retry] ${message}`);
}

export function createRetryEvaluator(db: Db, opts: RetryOptions) {
  const actor = opts.actor ?? "daemon-retry";
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function notifierFor(taskId: string): HaltNotifier | null {
    if (opts.notify !== undefined) return opts.notify;
    return taskHaltNotifier(db, taskId, opts.notifyOptions ?? {});
  }

  /** The authoritative transition time of the LAST entry into failed. */
  function failedTransitionAt(taskId: string): { createdAt: string; atMs: number } | null {
    const row = db
      .prepare(
        "SELECT created_at FROM state_transition_logs WHERE task_id = ? AND to_state = 'failed' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(taskId) as { created_at: string } | undefined;
    if (!row) return null;
    const atMs = Date.parse(row.created_at);
    return Number.isFinite(atMs)
      ? { createdAt: row.created_at, atMs }
      : { createdAt: row.created_at, atMs: Date.now() };
  }

  function clearTimer(taskId: string): void {
    const t = timers.get(taskId);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(taskId);
    }
  }

  function escalate(task: TaskCore, taskId: string): RetryDecision {
    applyTransition(db, taskId, FAILED_ESCALATION_TRIGGER, {
      triggerType: "engine",
      actor,
      reason: `retry_count ${task.retry_count} >= max_retries ${task.max_retries} — escalated for human intervention (FR-TSK-02)`,
    });
    const notify = notifierFor(taskId);
    if (notify !== null) {
      void fireHalt(notify, {
        title: "NovaFlow gate escalation",
        message: `task ${taskId} entered awaiting_gate: retry budget exhausted (retry_count ${task.retry_count} >= max_retries ${task.max_retries})`,
      });
    }
    return { kind: "escalated", finalState: "awaiting_gate" };
  }

  /** Apply the auto-retry row (re-checking the task is still failed). */
  function requeueAuto(taskId: string): RetryDecision {
    const task = db
      .prepare("SELECT state, retry_count, max_retries FROM tasks WHERE id = ?")
      .get(taskId) as TaskCore | undefined;
    if (!task || task.state !== "failed") {
      return { kind: "not-failed", state: task?.state ?? "missing" };
    }
    clearTimer(taskId);
    applyTransition(db, taskId, AUTO_RETRY_TRIGGER, {
      triggerType: "timeout",
      actor,
      reason: `auto-retry timer expired (retry.delay_sec ${opts.delaySec}s)`,
    });
    opts.onRequeue?.(taskId);
    return { kind: "requeued", finalState: "queued" };
  }

  /**
   * The failed-state evaluation: escalate when the budget is spent,
   * otherwise arm (or fire) the auto-retry timer measured from the
   * failed transition's created_at.
   */
  function evaluate(taskId: string): RetryDecision {
    const task = db
      .prepare("SELECT state, retry_count, max_retries FROM tasks WHERE id = ?")
      .get(taskId) as TaskCore | undefined;
    if (!task) return { kind: "not-failed", state: "missing" };
    if (task.state !== "failed") return { kind: "not-failed", state: task.state };
    clearTimer(taskId);

    if (task.retry_count >= task.max_retries) {
      return escalate(task, taskId);
    }

    const failedAt = failedTransitionAt(taskId);
    const base = failedAt?.atMs ?? Date.now();
    const remaining = opts.delaySec * 1000 - (Date.now() - base);
    if (remaining <= 0) return requeueAuto(taskId);

    const timer = setTimeout(() => {
      timers.delete(taskId);
      // re-checked at fire time: a task moved by another surface never
      // double-moves (applyTransition's guard backs this up)
      const decision = requeueAuto(taskId);
      if (decision.kind === "not-failed") {
        warn(`auto-retry for task ${taskId} dropped: task is ${decision.state}`);
      }
    }, remaining);
    timer.unref?.();
    timers.set(taskId, timer);
    return {
      kind: "timer-armed",
      delaySec: opts.delaySec,
      fromCreatedAt: failedAt?.createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * Operator retry (CLI `task retry` / MCP twin): the verbatim
   * failed→queued operator-retry row. When the budget is spent the
   * matrix has no operator-retry row — the deterministic escalation
   * contract applies instead (the FSM is the arbiter; the operator
   * gets the gate surface, never a silent rejection).
   */
  function operatorRetry(taskId: string, meta: OperatorRetryMeta): RetryDecision {
    const task = db
      .prepare("SELECT state, retry_count, max_retries FROM tasks WHERE id = ?")
      .get(taskId) as TaskCore | undefined;
    if (!task) return { kind: "not-failed", state: "missing" };
    if (task.state !== "failed") {
      throw new InvalidTransitionError(task.state, OPERATOR_RETRY_TRIGGER);
    }
    if (task.retry_count >= task.max_retries) {
      return escalate(task, taskId);
    }
    clearTimer(taskId);
    applyTransition(db, taskId, OPERATOR_RETRY_TRIGGER, {
      triggerType: meta.triggerType,
      actor: meta.actor,
      reason: "operator retry",
    });
    opts.onRequeue?.(taskId);
    return { kind: "requeued", finalState: "queued" };
  }

  /** Clear an armed timer when another surface moved the task. */
  function clearFor(taskId: string): void {
    clearTimer(taskId);
  }

  /** Boot scan: evaluate every failed task (escalate or arm/requeue). */
  function bootScan(): RetryDecision[] {
    const rows = db.prepare("SELECT id FROM tasks WHERE state = 'failed'").all() as Array<{
      id: string;
    }>;
    return rows.map((r) => evaluate(r.id));
  }

  function stop(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { evaluate, operatorRetry, clearFor, bootScan, stop };
}

export type RetryEvaluator = ReturnType<typeof createRetryEvaluator>;
