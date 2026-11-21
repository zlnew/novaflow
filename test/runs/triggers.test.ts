import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatrix } from "../helpers/spec.ts";
import {
  START_TRIGGER,
  GATE_TRIGGER,
  VALIDATING_TRIGGER,
  REPAIR_TRIGGER,
  RUN_FAILED_TRIGGER,
} from "../../src/runs/triggers.ts";

/**
 * Golden pins: every trigger the run loop uses is the VERBATIM 8.1
 * matrix string, extracted from src/fsm/matrix.ts ROWS with a
 * uniqueness guard (never retyped, never paraphrased).
 */
function pin(name: string, state: string, target: string, constant: string): void {
  const rows = extractMatrix().filter((r) => r.state === state && r.target === target);
  assert.equal(rows.length, 1, `expected exactly one ${state}→${target} row`);
  assert.equal(constant, rows[0]?.trigger, `${name} must be the live spec trigger`);
}

test("golden: START_TRIGGER is the verbatim queued→running 'scheduler slot allocated' row", () => {
  pin("START_TRIGGER", "queued", "running", START_TRIGGER);
  assert.equal(START_TRIGGER, "scheduler slot allocated");
});

test("golden: GATE_TRIGGER is the verbatim running→awaiting_gate row", () => {
  pin("GATE_TRIGGER", "running", "awaiting_gate", GATE_TRIGGER);
});

test("golden: VALIDATING_TRIGGER is the verbatim running→validating agent_settled row", () => {
  pin("VALIDATING_TRIGGER", "running", "validating", VALIDATING_TRIGGER);
  assert.equal(VALIDATING_TRIGGER, "agent_settled with artifact present (no gate required)");
});

test("golden: REPAIR_TRIGGER is the verbatim running→running repair row", () => {
  pin("REPAIR_TRIGGER", "running", "running", REPAIR_TRIGGER);
});

test("golden: RUN_FAILED_TRIGGER is the verbatim running→failed subprocess/budget row", () => {
  pin("RUN_FAILED_TRIGGER", "running", "failed", RUN_FAILED_TRIGGER);
  assert.equal(
    RUN_FAILED_TRIGGER,
    "subprocess error, invalid JSON, budget or timeout kill",
  );
});
