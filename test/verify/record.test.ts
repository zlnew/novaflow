import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationRecord,
  parseVerificationRecord,
  VERIFICATION_FRAME_TYPE,
} from "../../src/verify/record.ts";
import type { VerifyOutcome } from "../../src/verify/runner.ts";

/**
 * The run's verification record (DEBT-006): the executed side with cwd plus
 * the configured set, written as one engine frame into the run's REDACTED
 * events.jsonl, and read back by `nova chain verify`. The frame's item
 * schema is deliberately closed here: it is a record, not a place to grow
 * new fields without a reader that consumes them.
 */

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function outcome(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    passed: true,
    collectionError: null,
    configured: [
      { command: "npm test", rootPath: "/ws/.novaflow/worktrees/r1/app", targetId: "t1", alias: "app" },
      { command: "npm run lint", rootPath: "/ws/repo", targetId: "t2", alias: "docs" },
    ],
    results: [
      {
        command: "npm test",
        cwd: "/ws/.novaflow/worktrees/r1/app",
        exitCode: 0,
        exitCodeForArtifact: 0,
        timedOut: false,
        spawnError: null,
        marker: null,
        passed: true,
        stdoutTail: "ok",
        stderrTail: "",
      },
      {
        command: "npm run lint",
        cwd: "/ws/repo",
        exitCode: null,
        exitCodeForArtifact: 124,
        timedOut: true,
        spawnError: null,
        marker: null,
        passed: false,
        stdoutTail: "",
        stderrTail: "",
      },
    ],
    ...over,
  };
}

test("buildVerificationRecord: each executed command carries its exit status and the cwd it ran in", () => {
  const record = buildVerificationRecord(RUN_ID, outcome());
  assert.deepEqual(record, {
    type: VERIFICATION_FRAME_TYPE,
    run_id: RUN_ID,
    configured: [
      { command: "npm test", cwd: "/ws/.novaflow/worktrees/r1/app" },
      { command: "npm run lint", cwd: "/ws/repo" },
    ],
    // the ARTIFACT exit code (GNU conventions for a timed-out command), the
    // same integer the §4.1 block records — one number, both surfaces
    executed: [
      { command: "npm test", exit: 0, cwd: "/ws/.novaflow/worktrees/r1/app" },
      { command: "npm run lint", exit: 124, cwd: "/ws/repo" },
    ],
    collection_error: null,
  });
});

test("buildVerificationRecord: a failed collection records the error and an empty configured set", () => {
  const record = buildVerificationRecord(
    RUN_ID,
    outcome({ passed: false, collectionError: "verification_commands_json is not a JSON array of strings", configured: [], results: [] }),
  );
  assert.deepEqual(record.configured, []);
  assert.deepEqual(record.executed, []);
  assert.match(record.collection_error ?? "", /not a JSON array of strings/);
});

test("parseVerificationRecord: finds the frame among mixed telemetry lines and the LAST pass wins", () => {
  const lines = [
    '{"type":"agent_settled"}',
    "framing noise, not JSON",
    JSON.stringify({ type: VERIFICATION_FRAME_TYPE, run_id: RUN_ID, configured: [{ command: "a", cwd: "/1" }], executed: [{ command: "a", exit: 1, cwd: "/1" }], collection_error: null }),
    '{"type":"novaflow_worktree_warning","message":"later unrelated frame"}',
    JSON.stringify({ type: VERIFICATION_FRAME_TYPE, run_id: RUN_ID, configured: [{ command: "a", cwd: "/1" }], executed: [{ command: "a", exit: 0, cwd: "/1" }], collection_error: null }),
    "",
  ];
  const record = parseVerificationRecord(lines);
  assert.ok(record !== null);
  assert.equal(record.run_id, RUN_ID);
  assert.deepEqual(record.executed, [{ command: "a", exit: 0, cwd: "/1" }]);
});

test("parseVerificationRecord: a run with no verification frame reads as null (the caller falls back to the §4.1 block)", () => {
  assert.equal(parseVerificationRecord([]), null);
  assert.equal(parseVerificationRecord(['{"type":"agent_settled"}', "not json"]), null);
  // a malformed frame (no configured/executed arrays) is not a record
  assert.equal(parseVerificationRecord([JSON.stringify({ type: VERIFICATION_FRAME_TYPE, run_id: RUN_ID })]), null);
});
