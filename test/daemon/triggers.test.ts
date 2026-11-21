import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatrix } from "../helpers/spec.ts";
import {
  AUTO_RETRY_TRIGGER,
  FAILED_ESCALATION_TRIGGER,
  OPERATOR_RETRY_TRIGGER,
  RUNNING_ABORT_TRIGGER,
  abortTriggerFor,
} from "../../src/daemon/triggers.ts";
import { ESCALATE_FAILED_TRIGGER } from "../../src/fsm/triggers.ts";

/**
 * The daemon's verbatim 8.1 trigger constants, golden-pinned against
 * the live spec matrix (the src/runs/triggers.ts pattern: extract from
 * ROWS with uniqueness guards, never retype).
 */

test("golden pin: the auto-retry trigger is the matrix's failed→queued timer row, verbatim", () => {
  const rows = extractMatrix().filter(
    (r) =>
      r.state === "failed" &&
      r.target === "queued" &&
      r.trigger.startsWith("auto-retry timer expires"),
  );
  assert.equal(rows.length, 1);
  assert.equal(AUTO_RETRY_TRIGGER, rows[0]!.trigger);
  assert.match(AUTO_RETRY_TRIGGER, /retry\.delay_sec`?, default 300 s/);
});

test("golden pin: the operator-retry trigger is the matrix's failed→queued CLI row, verbatim", () => {
  const rows = extractMatrix().filter(
    (r) =>
      r.state === "failed" &&
      r.target === "queued" &&
      r.trigger.startsWith("operator retry"),
  );
  assert.equal(rows.length, 1);
  assert.equal(OPERATOR_RETRY_TRIGGER, rows[0]!.trigger);
});

test("golden pin: the failed-state escalation is the SAME constant the FSM exports (one source)", () => {
  assert.equal(FAILED_ESCALATION_TRIGGER, ESCALATE_FAILED_TRIGGER);
  const rows = extractMatrix().filter(
    (r) => r.state === "failed" && r.target === "awaiting_gate",
  );
  assert.equal(rows.length, 1);
  assert.equal(FAILED_ESCALATION_TRIGGER, rows[0]!.trigger);
});

test("golden pin: the running abort trigger is the matrix's running→cancelled row, verbatim", () => {
  const rows = extractMatrix().filter(
    (r) => r.state === "running" && r.target === "cancelled",
  );
  assert.equal(rows.length, 1);
  assert.equal(RUNNING_ABORT_TRIGGER, rows[0]!.trigger);
  assert.match(RUNNING_ABORT_TRIGGER, /abort_bash/);
});

test("golden pin: every abortable state resolves to its verbatim operator-abort row", () => {
  const matrix = extractMatrix();
  for (const state of [
    "queued",
    "running",
    "awaiting_gate",
    "validating",
    "changes_requested",
    "failed",
  ]) {
    const rows = matrix.filter((r) => r.state === state && r.target === "cancelled");
    assert.equal(rows.length, 1, `${state} must have exactly one abort row`);
    assert.equal(abortTriggerFor(state), rows[0]!.trigger);
  }
  // non-abortable states resolve to null (the op refuses them)
  for (const state of ["draft", "completed", "cancelled"]) {
    assert.equal(abortTriggerFor(state), null);
  }
});
