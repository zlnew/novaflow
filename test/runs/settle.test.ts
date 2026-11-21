import { test } from "node:test";
import assert from "node:assert/strict";
import { planSettleTransition } from "../../src/runs/settle.ts";
import {
  GATE_TRIGGER,
  VALIDATING_TRIGGER,
} from "../../src/runs/triggers.ts";

/**
 * Status → 8.1 row mapping for a settled run with a structurally valid
 * artifact. The reading is documented in src/runs/settle.ts.
 */
test("completed without a gate → the agent_settled-with-artifact row → validating", () => {
  assert.deepEqual(planSettleTransition("completed", false), {
    target: "validating",
    trigger: VALIDATING_TRIGGER,
  });
});

test("requires_human_gate → the gate row → awaiting_gate, whatever the artifact status", () => {
  for (const status of ["completed", "changes_requested", "blocked"] as const) {
    assert.deepEqual(planSettleTransition(status, true), {
      target: "awaiting_gate",
      trigger: GATE_TRIGGER,
    });
  }
});

test("agent status: blocked → the gate row → awaiting_gate", () => {
  assert.deepEqual(planSettleTransition("blocked", false), {
    target: "awaiting_gate",
    trigger: GATE_TRIGGER,
  });
});

test("changes_requested → the matrix admits only the validating row from running (documented reading)", () => {
  // From `running`, an agent_settled-with-artifact settle admits exactly two
  // legal rows (gate / validating). `changes_requested` as a STATE is reached
  // later per the feedback routing rule — validating→changes_requested on the
  // task's own engine verification failure, or the review-path edge routing —
  // never directly from running. So a changes_requested artifact takes the
  // same validating row as completed at settle time.
  assert.deepEqual(planSettleTransition("changes_requested", false), {
    target: "validating",
    trigger: VALIDATING_TRIGGER,
  });
});
