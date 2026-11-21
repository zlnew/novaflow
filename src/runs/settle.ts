import { GATE_TRIGGER, VALIDATING_TRIGGER } from "./triggers.ts";

/**
 * Map a structurally valid result.json to the legal 8.1 settle
 * transition (architecture 8.1, the ONE legal matrix).
 *
 * Matrix reading (documented per the card): from `running`, an
 * agent-settled-with-artifact admits exactly two legal rows —
 *   1. the gate row — "`requires_human_gate: true`, OR agent emitted
 *      `status: blocked`, AND agent settled with artifact present" →
 *      awaiting_gate;
 *   2. the agent_settled-with-artifact row (no gate required) →
 *      validating.
 * `status: "changes_requested"` is NOT a running-state transition. Per
 * the feedback routing rule, the changes_requested STATE is reached
 * later — either `validating → changes_requested` when the task's OWN
 * engine verification fails (p2c scope) or via the review-path edge
 * routing (an emitter's on_changes_requested edges re-entering its
 * targets). No matrix row goes running → changes_requested, so the
 * matrix admits only one path at settle time: the validating row, the
 * same as `completed`. The artifact's status is recorded on the run
 * row for the VALIDATING phase to consume.
 */

export type SettleTarget = "awaiting_gate" | "validating";

export type SettlePlan = {
  target: SettleTarget;
  /** The verbatim 8.1 trigger string for applyTransition. */
  trigger: string;
};

export function planSettleTransition(
  artifactStatus: string,
  requiresHumanGate: boolean,
): SettlePlan {
  if (requiresHumanGate || artifactStatus === "blocked") {
    return { target: "awaiting_gate", trigger: GATE_TRIGGER };
  }
  return { target: "validating", trigger: VALIDATING_TRIGGER };
}
