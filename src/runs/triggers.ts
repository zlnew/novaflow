import { ROWS, type CanonicalState } from "../fsm/matrix.ts";

/**
 * The verbatim 8.1 trigger strings the run loop transitions on. Each is
 * extracted from src/fsm/matrix.ts ROWS with a uniqueness guard on the
 * (state, target) pair — never retyped, never paraphrased. Golden tests
 * re-parse the live spec matrix and pin every constant here.
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

/** queued → running: the scheduler-slot row (the slot check itself is the caller's duty). */
export const START_TRIGGER: string = soleTrigger("queued", "running");

/** running → awaiting_gate: the gate row (requires_human_gate OR agent `status: blocked`). */
export const GATE_TRIGGER: string = soleTrigger("running", "awaiting_gate");

/** running → validating: agent_settled with artifact present, no gate required. */
export const VALIDATING_TRIGGER: string = soleTrigger("running", "validating");

/** running → running: the FR-TSK-06 repair row (max 1 repair per run). */
export const REPAIR_TRIGGER: string = soleTrigger("running", "running");

/** running → failed: subprocess error, invalid JSON, budget or timeout kill. */
export const RUN_FAILED_TRIGGER: string = soleTrigger("running", "failed");

/** running → cancelled: the operator-abort row (abort_bash -> SIGTERM -> SIGKILL). */
export const ABORT_TRIGGER: string = soleTrigger("running", "cancelled");
