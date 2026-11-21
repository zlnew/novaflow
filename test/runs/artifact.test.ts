import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResultSchema } from "../helpers/spec.ts";
import {
  validateArtifact,
  readArtifactFile,
  ARTIFACT_REQUIRED_KEYS,
  ARTIFACT_STATUS_ENUM,
  ARTIFACT_NEXT_ACTION_ENUM,
  ARTIFACT_ACTION_ENUM,
  ARTIFACT_FEEDBACK_SEVERITY_ENUM,
  ARTIFACT_TOP_LEVEL_KEYS,
  type TaskHandoffArtifact,
} from "../../src/runs/artifact.ts";

/**
 * Golden pins: the structural validator is pinned live to the
 * TaskHandoffArtifact block in novaflow-v1/data 4.1, exactly like the
 * p2a profile-schema pins.
 */
test("golden: the artifact validator is pinned to the live data.md §4.1 block", () => {
  const schema = extractResultSchema();
  const props = schema["properties"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(ARTIFACT_REQUIRED_KEYS, schema["required"]);
  assert.deepEqual(ARTIFACT_STATUS_ENUM, props["status"]?.["enum"]);
  assert.deepEqual(ARTIFACT_NEXT_ACTION_ENUM, props["next_recommended_action"]?.["enum"]);
  assert.deepEqual(ARTIFACT_ACTION_ENUM, props["artifacts_modified"]?.["items"]?.["properties"]?.["action"]?.["enum"]);
  assert.deepEqual(
    ARTIFACT_FEEDBACK_SEVERITY_ENUM,
    props["feedback_items"]?.["items"]?.["properties"]?.["severity"]?.["enum"],
  );
  // additionalProperties:false — the top-level allow-list is the block's
  // own property set (required + optional engine-owned annotations).
  assert.deepEqual(
    [...ARTIFACT_TOP_LEVEL_KEYS].sort(),
    Object.keys(props).sort(),
  );
  // the summary minLength the block states
  assert.equal(props["summary"]?.["minLength"], 10);
  // the role minLength the block states (engine-owned annotation)
  assert.equal(props["role"]?.["minLength"], 1);
  // feedback_items[].file_location is a closed {path, line} object with
  // line >= 1 — the validator must enforce exactly this shape
  const fileLocation = props["feedback_items"]?.["items"]?.["properties"]?.["file_location"] as Record<string, unknown>;
  assert.deepEqual(fileLocation["required"], ["path", "line"]);
  assert.equal((fileLocation["properties"] as Record<string, Record<string, unknown>>)["line"]?.["minimum"], 1);
  assert.equal(fileLocation["additionalProperties"], false);
});

const TASK_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function validArtifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    task_id: TASK_ID,
    run_id: RUN_ID,
    status: "completed",
    summary: "Implemented the requested objective end to end.",
    assumptions_made: ["none worth noting"],
    open_questions: [],
    artifacts_modified: [
      { target_alias: "app", path: "src/auth.rs", action: "modified", diff_summary: "rewrote handler" },
    ],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
    ...over,
  };
}

// real 26-char ULID-alphabet ids for the pattern checks

test("validateArtifact accepts the §4.1 shape (with the optional engine-owned fields present)", () => {
  const art = validArtifact({
    task_id: TASK_ID,
    role: "worker",
    engine_verified: true, // agent-authored values pass structure; the engine never TRUSTS them (overwritten post-VALIDATING, p2c scope)
    protected_files_untouched: false,
    verification_results: [{ command: "npm test", exit_code: 0, passed: true }],
  });
  const res = validateArtifact(art);
  assert.equal(res.ok, true, JSON.stringify(res.ok ? null : res.errors));
});

test("validateArtifact rejects each missing required key by name", () => {
  for (const key of ARTIFACT_REQUIRED_KEYS) {
    const art = validArtifact({ task_id: TASK_ID });
    delete art[key];
    const res = validateArtifact(art);
    assert.equal(res.ok, false, `removing ${key} must fail`);
    if (!res.ok) {
      assert.ok(
        res.errors.some((e) => e.includes(`"${key}"`)),
        `error for ${key}: ${JSON.stringify(res.errors)}`,
      );
    }
  }
});

test("validateArtifact rejects a bad status enum value", () => {
  const res = validateArtifact(validArtifact({ task_id: TASK_ID, status: "done" }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.includes("status")));
});

test("validateArtifact rejects wrong types and constraint violations", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["summary too short", { summary: "short" }, /summary/],
    ["non-ulid task_id", { task_id: "not-a-ulid!" }, /task_id/],
    ["bad schema_version", { schema_version: "1.0" }, /schema_version/],
    ["assumptions not array", { assumptions_made: "none" }, /assumptions_made/],
    ["open_questions items not strings", { open_questions: [1] }, /open_questions/],
    ["bad action enum", { artifacts_modified: [{ target_alias: "a", path: "p", action: "touched" }] }, /action/],
    ["artifact item missing path", { artifacts_modified: [{ target_alias: "a", action: "created" }] }, /path/],
    ["bad severity enum", { feedback_items: [{ severity: "fatal", category: "c", message: "m" }] }, /severity/],
    ["bad next action enum", { next_recommended_action: "do_more" }, /next_recommended_action/],
    ["unknown top-level key", { invented_field: 1 }, /invented_field/],
    ["not an object", { } as Record<string, unknown>, /object/],
  ];
  for (const [name, over, re] of cases) {
    const res = validateArtifact(name === "not an object" ? "nope" : validArtifact({ task_id: TASK_ID, ...over }));
    assert.equal(res.ok, false, `case ${name} must fail`);
    if (!res.ok) assert.ok(res.errors.some((e) => re.test(e)), `${name}: ${JSON.stringify(res.errors)}`);
  }
});

test("validateArtifact rejects a non-object file_location", () => {
  const res = validateArtifact(
    validArtifact({
      task_id: TASK_ID,
      feedback_items: [{ severity: "error", category: "c", message: "m", file_location: "garbage" }],
    }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => /file_location/.test(e)), JSON.stringify(res.errors));
});

test("validateArtifact rejects file_location constraint violations (line >= 1, closed keys, path string)", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["line 0", { path: "p", line: 0 }, /line/],
    ["line not integer", { path: "p", line: 1.5 }, /line/],
    ["missing line", { path: "p" }, /line/],
    ["path not string", { path: 7, line: 1 }, /path/],
    ["unknown key", { path: "p", line: 1, extra: true }, /extra/],
  ];
  for (const [name, fileLocation, re] of cases) {
    const res = validateArtifact(
      validArtifact({
        task_id: TASK_ID,
        feedback_items: [{ severity: "error", category: "c", message: "m", file_location: fileLocation }],
      }),
    );
    assert.equal(res.ok, false, `case ${name} must fail`);
    if (!res.ok) assert.ok(res.errors.some((e) => re.test(e)), `${name}: ${JSON.stringify(res.errors)}`);
  }
});

test("validateArtifact accepts a well-formed file_location", () => {
  const res = validateArtifact(
    validArtifact({
      task_id: TASK_ID,
      feedback_items: [{ severity: "error", category: "c", message: "m", file_location: { path: "src/auth.rs", line: 12 } }],
    }),
  );
  assert.equal(res.ok, true);
});

test("validateArtifact rejects an empty role (minLength 1)", () => {
  const res = validateArtifact(validArtifact({ task_id: TASK_ID, role: "" }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => /role/.test(e)), JSON.stringify(res.errors));
});

test("readArtifactFile: missing file is a typed miss, never a crash", () => {
  const res = readArtifactFile("/no/such/dir/result.json");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "missing");
});

test("readArtifactFile: unparseable JSON is invalid, with the parse error recorded", () => {
  const res = readArtifactFile(process.cwd() + "/test/fixtures/bad-artifact.json.tmp");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "invalid");
});
