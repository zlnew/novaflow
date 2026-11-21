import { ROWS, type CanonicalState } from "./matrix.ts";

/**
 * The verbatim 8.1 trigger strings for the VALIDATING phase, the gate
 * rows, and the retry/escalation bookkeeping (novaflow-v1/architecture
 * 8.1). Each is extracted from src/fsm/matrix.ts ROWS with a uniqueness
 * guard on the (state, target) pair — never retyped, never paraphrased
 * (the same pattern as src/runs/triggers.ts). Golden tests re-parse the
 * live spec matrix and pin every constant here.
 */
function soleTrigger(state: CanonicalState, target: CanonicalState): string {
  const rows = ROWS.filter((r) => r.state === state && r.target === target);
  if (rows.length !== 1) {
    throw new Error(
      `the 8.1 matrix must have exactly one ${state}→${target} row, found ${rows.length}`,
    );
  }
  return rows[0]!.trigger;
}

/** validating → completed: the passed-verification row. */
export const VERIFY_PASSED_TRIGGER: string = soleTrigger("validating", "completed");

/** validating → changes_requested: engine verification failed, budget remains. */
export const VERIFY_FAILED_TRIGGER: string = soleTrigger("validating", "changes_requested");

/** validating → failed: retries exhausted or hard schema failure. */
export const RETRIES_EXHAUSTED_TRIGGER: string = soleTrigger("validating", "failed");

/** awaiting_gate → validating: operator approves gate. */
export const GATE_APPROVE_TRIGGER: string = soleTrigger("awaiting_gate", "validating");

/** awaiting_gate → changes_requested: operator rejects with feedback. */
export const GATE_REJECT_TRIGGER: string = soleTrigger("awaiting_gate", "changes_requested");

/** awaiting_gate → failed: the terminal gate outcome. */
export const GATE_FAIL_TRIGGER: string = soleTrigger("awaiting_gate", "failed");

/** changes_requested → queued: feedback artifact delivered to the next attempt. */
export const REQUEUE_TRIGGER: string = soleTrigger("changes_requested", "queued");

/** changes_requested → awaiting_gate: escalation for human intervention. */
export const ESCALATE_CHANGES_TRIGGER: string = soleTrigger("changes_requested", "awaiting_gate");

/** failed → awaiting_gate: escalation for human intervention. */
export const ESCALATE_FAILED_TRIGGER: string = soleTrigger("failed", "awaiting_gate");
