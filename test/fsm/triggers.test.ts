import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatrix } from "../helpers/spec.ts";
import {
  VERIFY_PASSED_TRIGGER,
  VERIFY_FAILED_TRIGGER,
  RETRIES_EXHAUSTED_TRIGGER,
  GATE_APPROVE_TRIGGER,
  GATE_REJECT_TRIGGER,
  GATE_FAIL_TRIGGER,
  REQUEUE_TRIGGER,
  ESCALATE_CHANGES_TRIGGER,
  ESCALATE_FAILED_TRIGGER,
  REVIEW_REENTRY_TRIGGER,
} from "../../src/fsm/triggers.ts";

/**
 * Golden pins: every trigger the validating/gate/retry paths use is the
 * VERBATIM 8.1 matrix string, extracted from src/fsm/matrix.ts ROWS
 * with a uniqueness guard on the (state, target) pair — never retyped,
 * never paraphrased (same pattern as test/runs/triggers.test.ts).
 */
function pin(name: string, state: string, target: string, constant: string): void {
  const rows = extractMatrix().filter((r) => r.state === state && r.target === target);
  assert.equal(rows.length, 1, `expected exactly one ${state}→${target} row`);
  assert.equal(constant, rows[0]?.trigger, `${name} must be the live spec trigger`);
}

test("golden: REVIEW_REENTRY_TRIGGER is the verbatim completed→changes_requested row (the review-path re-entry)", () => {
  pin("REVIEW_REENTRY_TRIGGER", "completed", "changes_requested", REVIEW_REENTRY_TRIGGER);
  assert.equal(
    REVIEW_REENTRY_TRIGGER,
    "named as the target of an emitter's `on_changes_requested` edge (review path, feedback routing rule below)",
  );
});

test("golden: VERIFY_PASSED_TRIGGER is the verbatim validating→completed row", () => {
  pin("VERIFY_PASSED_TRIGGER", "validating", "completed", VERIFY_PASSED_TRIGGER);
  assert.equal(VERIFY_PASSED_TRIGGER, "output schema valid AND engine verification passed");
});

test("golden: VERIFY_FAILED_TRIGGER is the verbatim validating→changes_requested row", () => {
  pin("VERIFY_FAILED_TRIGGER", "validating", "changes_requested", VERIFY_FAILED_TRIGGER);
  assert.equal(VERIFY_FAILED_TRIGGER, "engine verification failed, retry budget remains");
});

test("golden: RETRIES_EXHAUSTED_TRIGGER is the verbatim validating→failed row", () => {
  pin("RETRIES_EXHAUSTED_TRIGGER", "validating", "failed", RETRIES_EXHAUSTED_TRIGGER);
  assert.equal(RETRIES_EXHAUSTED_TRIGGER, "retries exhausted or hard schema failure");
});

test("golden: GATE_APPROVE_TRIGGER is the verbatim awaiting_gate→validating row", () => {
  pin("GATE_APPROVE_TRIGGER", "awaiting_gate", "validating", GATE_APPROVE_TRIGGER);
  assert.equal(GATE_APPROVE_TRIGGER, "operator approves gate");
});

test("golden: GATE_REJECT_TRIGGER is the verbatim awaiting_gate→changes_requested row", () => {
  pin("GATE_REJECT_TRIGGER", "awaiting_gate", "changes_requested", GATE_REJECT_TRIGGER);
  assert.equal(GATE_REJECT_TRIGGER, "operator rejects with feedback");
});

test("golden: GATE_FAIL_TRIGGER is the verbatim awaiting_gate→failed terminal row", () => {
  pin("GATE_FAIL_TRIGGER", "awaiting_gate", "failed", GATE_FAIL_TRIGGER);
  assert.equal(
    GATE_FAIL_TRIGGER,
    "operator confirms failure (terminal gate outcome)",
  );
});

test("golden: REQUEUE_TRIGGER is the verbatim changes_requested→queued row", () => {
  pin("REQUEUE_TRIGGER", "changes_requested", "queued", REQUEUE_TRIGGER);
  assert.equal(REQUEUE_TRIGGER, "feedback artifact delivered to next attempt");
});

test("golden: ESCALATE_CHANGES_TRIGGER is the verbatim changes_requested→awaiting_gate row", () => {
  pin("ESCALATE_CHANGES_TRIGGER", "changes_requested", "awaiting_gate", ESCALATE_CHANGES_TRIGGER);
  assert.equal(ESCALATE_CHANGES_TRIGGER, "retry_count >= max_retries");
});

test("golden: ESCALATE_FAILED_TRIGGER is the verbatim failed→awaiting_gate row", () => {
  pin("ESCALATE_FAILED_TRIGGER", "failed", "awaiting_gate", ESCALATE_FAILED_TRIGGER);
  assert.equal(ESCALATE_FAILED_TRIGGER, "retry_count >= max_retries");
});
