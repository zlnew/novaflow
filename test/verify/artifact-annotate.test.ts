import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl, extractResultSchema } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import {
  annotateRunArtifact,
  annotateRunVerification,
} from "../../src/verify/artifact-annotate.ts";
import type { VerifyOutcome } from "../../src/verify/runner.ts";
import type { ProtectedCheckResult } from "../../src/verify/protected.ts";

/**
 * data.md 4.1 (TaskHandoffArtifact): the engine OVERWRITES the
 * engine-owned annotations (engine_verified, protected_files_untouched,
 * verification_results, role) after VALIDATING — agent-authored values
 * are never trusted.
 */

type Seed = { db: Database.Database; taskId: string; runId: string; artifactPath: string };

function seed(artifact: Record<string, unknown>, opts: { profileRole?: string | null } = {}): Seed {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/ws')").run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  const profileId = ulid();
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path, role)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md', ?)`,
  ).run(profileId, opts.profileRole === undefined ? null : opts.profileRole);
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run(taskId, projectId, profileId);
  const runId = ulid();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-art-"));
  const artifactPath = join(dir, "result.json");
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
        model_used, events_log_path, artifact_path)
     VALUES (?, ?, ?, 1, ?, ?, 'm', ?, ?)`,
  ).run(runId, taskId, profileId, runId, dir, join(dir, "events.jsonl"), artifactPath);
  return { db, taskId, runId, artifactPath };
}

function readArtifact(s: Seed): Record<string, unknown> {
  return JSON.parse(readFileSync(s.artifactPath, "utf8")) as Record<string, unknown>;
}

function runColumn(s: Seed, col: string): unknown {
  return (
    s.db.prepare(`SELECT ${col} AS v FROM task_runs WHERE id = ?`).get(s.runId) as { v: unknown }
  ).v;
}

/* ------------------------- the schema block's ownership rule ----------------------- */

test("golden: the 4.1 block names the engine-owned fields it overwrites after VALIDATING", () => {
  const block = extractResultSchema();
  const description = String(block["description"]);
  for (const field of ["engine_verified", "protected_files_untouched", "verification_results"]) {
    assert.ok(description.includes(field), `block description must name ${field}`);
  }
  assert.match(description, /engine overwrites/i);
  // …and `role` is defined as an engine-owned annotation too
  const props = block["properties"] as Record<string, { description?: string }>;
  assert.match(String(props["role"]?.description), /[Ee]ngine-owned/);
});

/* ---------------------------------- the liar test -------------------------------- */

test("a LYING agent (engine_verified=true) with failing verification → engine_verified is overwritten to false", () => {
  const s = seed({
    schema_version: "1.0.0",
    task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "completed",
    summary: "Everything definitely works, trust me completely.",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
    role: "trusted-reviewer",
    engine_verified: true,
    protected_files_untouched: true,
    verification_results: [
      { command: "npm test", exit_code: 0, passed: true },
    ],
  });
  try {
    annotateRunArtifact(s.db, s.runId, {
      engineVerified: false,
      protectedFilesUntouched: false,
      verificationResults: [
        { command: "npm test", exit_code: 1, passed: false, output_tail: "1 failing" },
      ],
      role: "worker",
    });
    const art = readArtifact(s);
    // the engine's findings REPLACE the agent's claims, field for field
    assert.equal(art["engine_verified"], false);
    assert.equal(art["protected_files_untouched"], false);
    assert.deepEqual(art["verification_results"], [
      { command: "npm test", exit_code: 1, passed: false, output_tail: "1 failing" },
    ]);
    assert.equal(art["role"], "worker");
    // …and the run row's column says so too
    assert.equal(runColumn(s, "engine_verification_passed"), 0);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("passing verification → engine_verified=true and the run row's engine_verification_passed=1", () => {
  const s = seed({
    schema_version: "1.0.0",
    task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "completed",
    summary: "Implemented the objective per the task spec.",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
  });
  try {
    const res = annotateRunArtifact(s.db, s.runId, {
      engineVerified: true,
      protectedFilesUntouched: true,
      verificationResults: [{ command: "npm test", exit_code: 0, passed: true }],
      role: "worker",
    });
    assert.deepEqual(res, { engineVerificationPassed: true });
    assert.equal(readArtifact(s)["engine_verified"], true);
    assert.equal(runColumn(s, "engine_verification_passed"), 1);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("the annotated verification_results shape mirrors the 4.1 block exactly", () => {
  const block = extractResultSchema();
  const props = block["properties"] as Record<string, Record<string, unknown>>;
  const vr = props["verification_results"] as { items: Record<string, unknown> };
  const items = vr["items"] as {
    required: string[];
    properties: Record<string, unknown>;
  };
  const itemProps = items["properties"] as Record<string, unknown>;
  assert.deepEqual(items["required"], ["command", "exit_code", "passed"]);
  assert.deepEqual([...Object.keys(itemProps)].sort(), ["command", "exit_code", "output_tail", "passed"]);

  // our entries carry exactly those keys (plus output_tail only when non-empty)
  const s = seed({
    schema_version: "1.0.0",
    task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "completed",
    summary: "Implemented the objective per the task spec.",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
  });
  try {
    annotateRunArtifact(s.db, s.runId, {
      engineVerified: true,
      protectedFilesUntouched: true,
      verificationResults: [
        { command: "npm test", exit_code: 0, passed: true, output_tail: "ok" },
        { command: "tsc --noEmit", exit_code: 0, passed: true },
      ],
      role: null,
    });
    const results = readArtifact(s)["verification_results"] as Array<Record<string, unknown>>;
    assert.deepEqual([...Object.keys(results[0]!).sort()], ["command", "exit_code", "output_tail", "passed"].sort());
    assert.deepEqual([...Object.keys(results[1]!)], ["command", "exit_code", "passed"]);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("profile role NULL → the agent-authored role key is REMOVED (never trusted)", () => {
  const s = seed(
    {
      schema_version: "1.0.0",
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      status: "completed",
      summary: "Implemented the objective per the task spec.",
      assumptions_made: [],
      open_questions: [],
      artifacts_modified: [],
      feedback_items: [],
      next_recommended_action: "proceed_to_next",
      role: "i-am-the-role-king",
    },
    { profileRole: null },
  );
  try {
    annotateRunArtifact(s.db, s.runId, {
      engineVerified: true,
      protectedFilesUntouched: true,
      verificationResults: [],
      role: null,
    });
    const art = readArtifact(s);
    assert.equal("role" in art, false);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("annotateRunArtifact refuses a run with no artifact (nothing to annotate)", () => {
  const s = seed({
    schema_version: "1.0.0",
    task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "completed",
    summary: "Implemented the objective per the task spec.",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
  });
  s.db.prepare("UPDATE task_runs SET artifact_path = NULL WHERE id = ?").run(s.runId);
  try {
    assert.throws(
      () =>
        annotateRunArtifact(s.db, s.runId, {
          engineVerified: true,
          protectedFilesUntouched: true,
          verificationResults: [],
          role: null,
        }),
      /no artifact_path/,
    );
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

/* ------------------- the composed convenience (verify + protected) ---------------- */

test("annotateRunVerification derives the annotations and pulls role from the run's profile snapshot", () => {
  const s = seed(
    {
      schema_version: "1.0.0",
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      status: "completed",
      summary: "Implemented the objective per the task spec.",
      assumptions_made: [],
      open_questions: [],
      artifacts_modified: [],
      feedback_items: [],
      next_recommended_action: "proceed_to_next",
      engine_verified: true,
    },
    { profileRole: "qa-worker" },
  );
  try {
    const verify: VerifyOutcome = {
      passed: false,
      results: [
        {
          command: "npm test",
          cwd: "/repo",
          exitCode: 1,
          exitCodeForArtifact: 1,
          timedOut: false,
          spawnError: null,
          marker: null,
          passed: false,
          stdoutTail: "1 failing",
          stderrTail: "",
        },
      ],
    };
    const protectedCheck: ProtectedCheckResult = {
      protectedFilesUntouched: true,
      scopeCreepPaths: ["app/rogue.txt"],
      notes: [],
    };
    annotateRunVerification(s.db, s.runId, verify, protectedCheck);
    const art = readArtifact(s);
    // scope creep is a verification failure even when every command… failed
    // on its own anyway here; engine_verified must be false either way
    assert.equal(art["engine_verified"], false);
    assert.equal(art["protected_files_untouched"], true);
    assert.equal(art["role"], "qa-worker"); // the STORED profile's role, not the agent's
    assert.deepEqual(art["verification_results"], [
      { command: "npm test", exit_code: 1, passed: false, output_tail: "1 failing" },
    ]);
    assert.equal(runColumn(s, "engine_verification_passed"), 0);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("annotateRunVerification: passing commands + untouched protected files → engine_verification_passed=1", () => {
  const s = seed(
    {
      schema_version: "1.0.0",
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      status: "completed",
      summary: "Implemented the objective per the task spec.",
      assumptions_made: [],
      open_questions: [],
      artifacts_modified: [],
      feedback_items: [],
      next_recommended_action: "proceed_to_next",
    },
    { profileRole: "worker" },
  );
  try {
    const verify: VerifyOutcome = {
      passed: true,
      results: [
        {
          command: "npm test",
          cwd: "/repo",
          exitCode: 0,
          exitCodeForArtifact: 0,
          timedOut: false,
          spawnError: null,
          marker: { tests: 3, pass: 3, fail: 0 },
          passed: true,
          stdoutTail: "",
          stderrTail: "",
        },
      ],
    };
    const protectedCheck: ProtectedCheckResult = {
      protectedFilesUntouched: true,
      scopeCreepPaths: [],
      notes: [],
    };
    const res = annotateRunVerification(s.db, s.runId, verify, protectedCheck);
    assert.deepEqual(res, { engineVerificationPassed: true });
    assert.equal(runColumn(s, "engine_verification_passed"), 1);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});

test("an inconclusive scope check fails closed: engine_verification_passed stays 0 even with passing commands (re-judge finding 1)", () => {
  const s = seed({
    schema_version: "1.0.0",
    task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    status: "completed",
    summary: "Implemented the objective per the task spec.",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
    engine_verified: true,
  });
  try {
    const verify: VerifyOutcome = {
      passed: true,
      results: [
        {
          command: "npm test",
          cwd: "/repo",
          exitCode: 0,
          exitCodeForArtifact: 0,
          timedOut: false,
          spawnError: null,
          marker: { tests: 3, pass: 3, fail: 0 },
          passed: true,
          stdoutTail: "[novaflow-verify] tests=3 pass=3 fail=0",
          stderrTail: "",
        },
      ],
    };
    const protectedCheck: ProtectedCheckResult = {
      protectedFilesUntouched: true,
      scopeCreepPaths: [],
      scopeCheckInconclusive: true, // git status failed — fail closed
      notes: ["git status failed — scope check inconclusive, failing closed"],
    };
    const res = annotateRunVerification(s.db, s.runId, verify, protectedCheck);
    assert.deepEqual(res, { engineVerificationPassed: false });
    assert.equal(runColumn(s, "engine_verification_passed"), 0);
  } finally {
    s.db.close();
    rmSync(join(s.artifactPath, ".."), { recursive: true, force: true });
  }
});
