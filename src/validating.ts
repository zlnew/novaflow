import type { Db } from "./store/db.ts";
import { applyTransition, type TransitionActor } from "./fsm/engine.ts";
import {
  VERIFY_PASSED_TRIGGER,
  VERIFY_FAILED_TRIGGER,
  RETRIES_EXHAUSTED_TRIGGER,
  REQUEUE_TRIGGER,
  ESCALATE_CHANGES_TRIGGER,
} from "./fsm/triggers.ts";
import {
  fireHalt,
  taskHaltNotifier,
  type HaltNotifier,
  type NotifyOptions,
  type NotifyResult,
} from "./notify.ts";

/**
 * The VALIDATING phase's transitions (architecture 8.1, the verbatim
 * matrix rows) plus retry bookkeeping per the Retry-count timing rule:
 * `retry_count` increments EXACTLY when a task ENTERS
 * changes_requested — from validating (self verification failure),
 * from awaiting_gate (reject), or from completed (review-path
 * re-entry). Auto-retry, operator retry, and gate-approve-retry all
 * READ the same counter; `max_retries` is the hard ceiling.
 *
 * Escalation: after entering changes_requested, if
 * `retry_count >= max_retries` the task continues via the verbatim
 * changes_requested→awaiting_gate row (FR-TSK-02 AC3, human
 * intervention) and a halt alert fires (RSK-07: gate escalations are
 * ntfy halt triggers). The validating→failed row fires when the
 * budget was ALREADY spent before the verdict.
 *
 * completeValidation is called by the operator/scheduler after a run
 * settles into validating; the p2b run loop does NOT auto-verify.
 */

export type ValidationVerdict = {
  passed: boolean;
  /** Optional human-readable finding, recorded in the log's reason. */
  summary?: string;
};

export type ValidationOutcome = {
  taskId: string;
  finalState: string;
  retryCount: number;
  /** Fire-and-forget halt dispatches (already sent; awaitable in tests). */
  notifications: Promise<NotifyResult>[];
};

export type CompleteValidationOptions = {
  /** Injected halt notifier (tests); default: workspace-config topic. */
  notify?: HaltNotifier;
  /** Transport injection for the DEFAULT (config-wired) notifier. */
  notifyOptions?: NotifyOptions;
};

type TaskCoreRow = {
  id: string;
  state: string;
  retry_count: number;
  max_retries: number;
};

function getTaskCore(db: Db, taskId: string): TaskCoreRow | undefined {
  return db
    .prepare("SELECT id, state, retry_count, max_retries FROM tasks WHERE id = ?")
    .get(taskId) as TaskCoreRow | undefined;
}

/**
 * Enter changes_requested: the verbatim row's transition plus the
 * retry_count increment, in ONE transaction (FR-TSK-01 AC2: atomic
 * persistence). Returns the incremented retry_count. Throws
 * (InvalidTransitionError, transaction rolled back) when the move is
 * illegal — the task and the log stay untouched.
 */
export function enterChangesRequested(db: Db, taskId: string, trigger: string, who: TransitionActor): number {
  const tx = db.transaction((): number => {
    applyTransition(db, taskId, trigger, who);
    const row = db
      .prepare(
        "UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ? RETURNING retry_count",
      )
      .get(new Date().toISOString(), taskId) as { retry_count: number };
    return row.retry_count;
  });
  return tx();
}

/** Typed refusal when a retry row's `retry_count < max_retries` gate fails. */
export class RetryBudgetExhaustedError extends Error {
  constructor(readonly retryCount: number, readonly maxRetries: number) {
    super(`retry budget exhausted: retry_count ${retryCount} >= max_retries ${maxRetries}`);
    this.name = "RetryBudgetExhaustedError";
  }
}

/**
 * The shared post-entry escalation check: a task whose retry budget is
 * spent after entering changes_requested continues to awaiting_gate via
 * the verbatim row, with a halt alert. Returns the final state.
 * Exported for the gate paths (reject) — the same deterministic rule
 * applies wherever a task enters changes_requested.
 */
export function escalateIfBudgetSpent(
  db: Db,
  taskId: string,
  retryCount: number,
  maxRetries: number,
  who: TransitionActor,
  notify: HaltNotifier | null,
  notifications: Promise<NotifyResult>[],
): "changes_requested" | "awaiting_gate" {
  if (retryCount < maxRetries) return "changes_requested";
  applyTransition(db, taskId, ESCALATE_CHANGES_TRIGGER, {
    ...who,
    reason: `retry_count ${retryCount} >= max_retries ${maxRetries} — escalated for human intervention (FR-TSK-02)`,
  });
  if (notify !== null) {
    notifications.push(
      fireHalt(notify, {
        title: "NovaFlow gate escalation",
        message: `task ${taskId} entered awaiting_gate: retry budget exhausted (retry_count ${retryCount} >= max_retries ${maxRetries})`,
      }),
    );
  }
  return "awaiting_gate";
}

/**
 * Settle the VALIDATING verdict (architecture 8.1):
 *   - passed → validating→completed (verbatim row);
 *   - failed, budget remains → validating→changes_requested (verbatim
 *     row) with retry_count incremented EXACTLY on entry, then the
 *     escalation check (changes_requested→awaiting_gate when spent);
 *   - failed, budget spent → validating→failed (verbatim row) with a
 *     halt alert.
 */
export function completeValidation(
  db: Db,
  taskId: string,
  verdict: ValidationVerdict,
  actor: string,
  opts: CompleteValidationOptions = {},
): ValidationOutcome {
  const task = getTaskCore(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const notifications: Promise<NotifyResult>[] = [];
  const notify: HaltNotifier | null =
    opts.notify !== undefined ? opts.notify : taskHaltNotifier(db, taskId, opts.notifyOptions ?? {});
  const who = (reason: string): TransitionActor => ({
    triggerType: "engine",
    actor,
    reason,
  });

  if (verdict.passed) {
    applyTransition(db, taskId, VERIFY_PASSED_TRIGGER, who(verdict.summary ?? "engine verification passed"));
    return { taskId, finalState: "completed", retryCount: task.retry_count, notifications };
  }

  // Budget spent: validating→failed via the verbatim retries-exhausted
  // row, with a halt alert. The matrix's failed→awaiting_gate escalation
  // row (ESCALATE_FAILED_TRIGGER, exported + golden-pinned) fires from the
  // FAILED STATE — it is the p3 scheduler's evaluation of failed tasks
  // (FR-TSK-02), not a synchronous chain off this verdict; this card's
  // contract stops at failed + notify.
  if (task.retry_count >= task.max_retries) {
    applyTransition(db, taskId, RETRIES_EXHAUSTED_TRIGGER, who(verdict.summary ?? "engine verification failed; retry budget exhausted"));
    if (notify !== null) {
      notifications.push(
        fireHalt(notify, {
          title: "NovaFlow task failed",
          message: `task ${taskId} failed at validating: ${verdict.summary ?? "engine verification failed"} (retry budget exhausted)`,
        }),
      );
    }
    return { taskId, finalState: "failed", retryCount: task.retry_count, notifications };
  }

  const retryCount = enterChangesRequested(db, taskId, VERIFY_FAILED_TRIGGER, who(verdict.summary ?? "engine verification failed"));
  const finalState = escalateIfBudgetSpent(
    db,
    taskId,
    retryCount,
    task.max_retries,
    { triggerType: "engine", actor },
    notify,
    notifications,
  );
  return { taskId, finalState, retryCount, notifications };
}

export type RequeueOptions = {
  /** Path of the feedback artifact delivered to the next attempt. */
  feedbackPath?: string;
};

/**
 * The self-path requeue the p3 scheduler calls after the feedback
 * artifact is delivered: changes_requested→queued via the verbatim
 * row. The row's validation gate (`retry_count < max_retries`) is
 * enforced BEFORE the transition — a spent budget is a typed refusal
 * (the task should already be in awaiting_gate). The retry_count was
 * already incremented on ENTRY; requeue never increments again.
 */
export function requeueFromChangesRequested(
  db: Db,
  taskId: string,
  actor: string,
  opts: RequeueOptions = {},
): void {
  const task = getTaskCore(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  if (task.retry_count >= task.max_retries) {
    throw new RetryBudgetExhaustedError(task.retry_count, task.max_retries);
  }
  applyTransition(db, taskId, REQUEUE_TRIGGER, {
    triggerType: "engine",
    actor,
    reason:
      opts.feedbackPath !== undefined
        ? `feedback artifact delivered to next attempt: ${opts.feedbackPath}`
        : "feedback artifact delivered to next attempt",
  });
}
