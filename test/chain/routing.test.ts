import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import {
  START_TRIGGER,
  GATE_TRIGGER,
  VALIDATING_TRIGGER,
  RUN_FAILED_TRIGGER,
} from "../../src/runs/triggers.ts";
import { VERIFY_PASSED_TRIGGER, GATE_FAIL_TRIGGER, REVIEW_REENTRY_TRIGGER } from "../../src/fsm/triggers.ts";
import { enterChangesRequested } from "../../src/validating.ts";
import { importChain, setChainRunAborted } from "../../src/chain/import.ts";
import { createChainEvaluator, CHAIN_ENGINE_ACTOR } from "../../src/chain/readiness.ts";
import {
  createRoutingEvaluator,
  feedbackRelPath,
  deliveredFeedbackPaths,
  type ReviewRouted,
} from "../../src/chain/routing.ts";
import type { HaltAlert } from "../../src/notify.ts";

/**
 * The FEEDBACK ROUTING evaluator (architecture 8.1 feedback routing rule
 * + failure routing rule, ruled 2026-11-21):
 *
 *   REVIEW PATH — a chain member that reaches `completed` with a
 *   result.json carrying `status: "changes_requested"` routes EVERY
 *   `on_changes_requested` target: the verbatim completed→
 *   changes_requested re-entry row (retry_count incremented EXACTLY on
 *   entry via the ONE enterChangesRequested), then the self-path
 *   requeue (changes_requested→queued) with the emitter's validated
 *   result.json delivered as the target's one sanctioned feedback
 *   context file (FR-TSK-04). A spent post-entry budget escalates via
 *   the ONE escalation check instead. Idempotence: the entry log row's
 *   run_id (the emitter's run) is the durable occurrence marker.
 *
 *   FAILURE PATH — a CONFIRMED failed member (the awaiting_gate→failed
 *   terminal gate outcome) enqueues every `on_failure` target in draft
 *   via the guarded draft→queued row (engine/chain-engine), delivering a
 *   synthesized failure context file (latest run error_summary +
 *   result.json content when present). Non-draft targets are consumed
 *   (matrix is the arbiter). The chain-failed rule is unordered with
 *   the fallback: the chain records failed while routing continues.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const PROBE = { piBin: "node", args: [STUB, "ok"], timeoutMs: 5000 };

type Seed = {
  db: Database.Database;
  dir: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
};

function seed(): Seed {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-routing-"));
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot, { recursive: true });
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  // the FK every enqueued member's target_scopes reference (DEBT-010
  // fixtures: the guarded draft→queued row refuses zero-scope tasks)
  db.prepare(
    "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'app', 'directory', ?)",
  ).run(ulid(), projectId, join(wsRoot, "target"));
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'm1', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  return { db, dir, wsRoot, workspaceId, projectId, profileId };
}

type TaskSpec = { key: string; title?: string };
type EdgeSpec = { source_key: string; target_key: string; edge_type: string };

function importGraph(
  s: Seed,
  tasks: TaskSpec[],
  edges: EdgeSpec[],
): { chainId: string; ids: Record<string, string> } {
  const { chainRun, tasks: created } = importChain(
    s.db,
    { id: s.workspaceId },
    { id: s.projectId, slug: "prj" },
    {
      version: "1.0.0",
      project_slug: "prj",
      tasks: tasks.map((t) => ({
        key: t.key,
        title: t.title ?? `Task ${t.key}`,
        objective: `The objective of task ${t.key}.`,
        profile_name: "dev",
        target_scopes: [{ repo_alias: "app", access_mode: "read_write" }],
      })),
      edges,
    },
  );
  const ids: Record<string, string> = {};
  for (const [key, row] of Object.entries(created)) ids[key] = row.id;
  return { chainId: chainRun.id, ids };
}

function artifactJson(taskId: string, runId: string, status: string): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    task_id: taskId,
    run_id: runId,
    status,
    summary: "A summary that is long enough to pass validation.",
    assumptions_made: ["one assumption"],
    open_questions: ["a question"],
    artifacts_modified: [{ target_alias: "app", path: "src/x.rs", action: "modified" }],
    feedback_items: [
      { severity: "error", category: "correctness", message: "The handler does not refresh tokens." },
    ],
    next_recommended_action: "proceed_to_next",
  };
}

function nextAttempt(s: Seed, taskId: string): number {
  return (
    (s.db.prepare("SELECT COALESCE(MAX(attempt_number), 0) AS n FROM task_runs WHERE task_id = ?").get(taskId) as { n: number }).n + 1
  );
}

/** Add a run row + on-disk result.json; returns the run id. */
function addRunRow(
  s: Seed,
  taskId: string,
  status: string,
  opts: { errorSummary?: string | null } = {},
): string {
  const runId = ulid();
  const runDir = join(s.wsRoot, ".novaflow", "runs", taskId, runId);
  mkdirSync(runDir, { recursive: true });
  const artifactPath = join(runDir, "result.json");
  writeFileSync(artifactPath, JSON.stringify(artifactJson(taskId, runId, status), null, 2) + "\n");
  s.db
    .prepare(
      `INSERT INTO task_runs (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
          status, preflight_status, model_used, events_log_path)
       VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 'passed', 'm1', ?)`,
    )
    .run(runId, taskId, s.profileId, nextAttempt(s, taskId), runId, runDir, join(runDir, "events.jsonl"));
  s.db
    .prepare("UPDATE task_runs SET artifact_path = ?, error_summary = ? WHERE id = ?")
    .run(artifactPath, opts.errorSummary ?? null, runId);
  return runId;
}

/** Drive a task to completed via the legal matrix rows (seed actor). */
function complete(s: Seed, taskId: string): void {
  applyTransition(s.db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(s.db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
}

/** A completed member whose latest run carries the given artifact status. */
function completeWithArtifact(s: Seed, taskId: string, status: string): string {
  complete(s, taskId);
  return addRunRow(s, taskId, status);
}

/** A confirmed-failed member (awaiting_gate→failed) with a latest run row. */
function confirmFailedWithRun(
  s: Seed,
  taskId: string,
  opts: { errorSummary: string | null; artifactStatus: string },
): string {
  applyTransition(s.db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(s.db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, GATE_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, GATE_FAIL_TRIGGER, { triggerType: "human", actor: "operator" });
  return addRunRow(s, taskId, opts.artifactStatus, { errorSummary: opts.errorSummary });
}

function state(s: Seed, taskId: string): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
}

function retryCount(s: Seed, taskId: string): number {
  return (s.db.prepare("SELECT retry_count FROM tasks WHERE id = ?").get(taskId) as { retry_count: number }).retry_count;
}

function transitions(s: Seed, taskId: string): Array<Record<string, unknown>> {
  return s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
    .all(taskId) as Array<Record<string, unknown>>;
}

function contextFiles(s: Seed, taskId: string): string[] {
  return JSON.parse(
    (s.db.prepare("SELECT context_files_json FROM tasks WHERE id = ?").get(taskId) as { context_files_json: string }).context_files_json,
  ) as string[];
}

function artifactPathOf(s: Seed, taskId: string): string {
  return (
    s.db
      .prepare("SELECT artifact_path FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(taskId) as { artifact_path: string }
  ).artifact_path;
}

/** The reviewer chain: R --on_changes_requested--> W. */
function importReviewChain(s: Seed): { chainId: string; r: string; w: string } {
  const { chainId, ids } = importGraph(
    s,
    [{ key: "R", title: "Reviewer" }, { key: "W", title: "Worker" }],
    [{ source_key: "R", target_key: "W", edge_type: "on_changes_requested" }],
  );
  return { chainId, r: ids["R"]!, w: ids["W"]! };
}

/** The fallback chain: F --on_failure--> T. */
function importFailureChain(s: Seed): { chainId: string; f: string; t: string } {
  const { chainId, ids } = importGraph(
    s,
    [{ key: "F", title: "Flaky" }, { key: "T", title: "Fallback" }],
    [{ source_key: "F", target_key: "T", edge_type: "on_failure" }],
  );
  return { chainId, f: ids["F"]!, t: ids["T"]! };
}

/* ------------------------------- review path ------------------------------- */

test("review path: a completed emitter with a changes_requested artifact re-enters its completed target and requeues with the artifact delivered", async () => {
  const s = seed();
  try {
    const { chainId, r, w } = importReviewChain(s);
    const requeued: string[] = [];
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE, onEnqueued: (id) => requeued.push(id) });
    // the target is completed (DAG ordering: it finished before the review)
    complete(s, w);
    const emitterRun = completeWithArtifact(s, r, "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.equal(out?.chainRunId, chainId);
    assert.equal(out?.emitterRunId, emitterRun);
    const expected: ReviewRouted[] = [
      { target: w, finalState: "queued", feedbackPath: feedbackRelPath(w, r) },
    ];
    assert.deepEqual(out?.routed, expected);
    assert.deepEqual(requeued, [w], "the dispatch hook fired for the requeued target");

    // the target: completed → changes_requested → queued, retry_count +1 EXACTLY
    assert.equal(state(s, w), "queued");
    assert.equal(retryCount(s, w), 1);
    const logs = transitions(s, w);
    const entry = logs.find((t) => t["to_state"] === "changes_requested")!;
    assert.equal(entry["from_state"], "completed");
    assert.equal(entry["trigger_type"], "engine");
    assert.equal(entry["actor"], CHAIN_ENGINE_ACTOR);
    assert.equal(entry["run_id"], emitterRun, "the durable occurrence marker is the emitter's run");
    assert.match(String(entry["reason"]), /review-path re-entry/);
    const requeue = logs.find((t) => t["from_state"] === "changes_requested" && t["to_state"] === "queued")!;
    assert.match(String(requeue["reason"]), new RegExp(feedbackRelPath(w, r).replace(/\./g, "\\.")));

    // the feedback artifact: a verbatim copy of the emitter's validated result.json
    const delivered = join(s.wsRoot, feedbackRelPath(w, r));
    assert.ok(existsSync(delivered), "the feedback file is written under the target's runs dir");
    assert.equal(readFileSync(delivered, "utf8"), readFileSync(artifactPathOf(s, r), "utf8"));

    // FR-TSK-04 recording: the delivered path rides the target's context
    // (task_runs has no context column — the repair-feedback precedent)
    assert.deepEqual(deliveredFeedbackPaths(s.db, w), [feedbackRelPath(w, r)]);
    assert.deepEqual(contextFiles(s, w), [feedbackRelPath(w, r)]);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path idempotence: re-observing the same completion never double-fires (the durable marker)", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    completeWithArtifact(s, r, "changes_requested");

    await routing.routeReviewPath(r);
    await routing.routeReviewPath(r); // the same completion observed again
    await routing.routeReviewPath(r); // and again

    assert.equal(state(s, w), "queued");
    assert.equal(retryCount(s, w), 1, "retry_count incremented EXACTLY once");
    const entries = transitions(s, w).filter((t) => t["to_state"] === "changes_requested");
    assert.equal(entries.length, 1, "exactly one re-entry row");
    const requeues = transitions(s, w).filter((t) => t["from_state"] === "changes_requested" && t["to_state"] === "queued");
    assert.equal(requeues.length, 1, "exactly one requeue row");
    assert.deepEqual(contextFiles(s, w), [feedbackRelPath(w, r)], "the context append is idempotent too");
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path + budget: a post-entry spent budget escalates changes_requested→awaiting_gate instead of requeueing (the ONE escalation rule)", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    s.db.prepare("UPDATE tasks SET max_retries = 1 WHERE id = ?").run(w);
    const alerts: HaltAlert[] = [];
    const routing = createRoutingEvaluator(s.db, {
      enqueueOptions: PROBE,
      notify: (alert) => {
        alerts.push(alert);
        return Promise.resolve({ ok: true, topic: "test" });
      },
    });
    complete(s, w);
    completeWithArtifact(s, r, "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.deepEqual(out?.routed, [{ target: w, finalState: "awaiting_gate", feedbackPath: feedbackRelPath(w, r) }]);
    assert.equal(state(s, w), "awaiting_gate");
    assert.equal(retryCount(s, w), 1, "the entry still increments EXACTLY once");
    const logs = transitions(s, w);
    assert.equal(
      logs.some((t) => t["from_state"] === "changes_requested" && t["to_state"] === "queued"),
      false,
      "no requeue on a spent budget",
    );
    const escalation = logs.find((t) => t["from_state"] === "changes_requested" && t["to_state"] === "awaiting_gate")!;
    assert.match(String(escalation["reason"]), /retry_count 1 >= max_retries 1 — escalated for human intervention/);
    assert.equal(alerts.length, 1, "the gate escalation is a halt trigger (RSK-07)");
    assert.match(alerts[0]!.message, new RegExp(w));
    // the artifact is still delivered — the review occurrence is real
    assert.ok(existsSync(join(s.wsRoot, feedbackRelPath(w, r))));
    assert.deepEqual(contextFiles(s, w), [feedbackRelPath(w, r)]);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path: a target whose budget was ALREADY spent is consumed (the row's own gate text refuses the re-entry)", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    s.db.prepare("UPDATE tasks SET retry_count = max_retries WHERE id = ?").run(w);
    completeWithArtifact(s, r, "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.deepEqual(out?.routed, [], "the occurrence exists but is consumed");
    assert.equal(state(s, w), "completed", "the matrix row's gate (retry_count < max_retries) refuses");
    assert.equal(retryCount(s, w), 3, "no increment — nothing was entered");
    assert.equal(transitions(s, w).some((t) => t["to_state"] === "changes_requested"), false);
    assert.equal(existsSync(join(s.wsRoot, feedbackRelPath(w, r))), false, "nothing is delivered for a refused entry");
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path: a target in any other state is consumed with a warn (matrix is the arbiter)", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    // W never completed — it is still draft
    completeWithArtifact(s, r, "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.deepEqual(out?.routed, []);
    assert.equal(state(s, w), "draft");
    assert.equal(retryCount(s, w), 0);
    assert.equal(existsSync(join(s.wsRoot, feedbackRelPath(w, r))), false);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path non-occurrences: completed-status artifact, no edges, non-chain task, non-completed emitter", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    // a completed-status artifact routes nothing
    complete(s, w);
    completeWithArtifact(s, r, "completed");
    assert.equal(await routing.routeReviewPath(r), null);
    // an emitter with no on_changes_requested edges is a no-op
    const { ids } = importGraph(s, [{ key: "SOLO" }], []);
    completeWithArtifact(s, ids["SOLO"]!, "changes_requested");
    assert.equal(await routing.routeReviewPath(ids["SOLO"]!), null);
    // a non-chain task is a no-op
    assert.equal(await routing.routeReviewPath(ulid()), null);
    // an emitter not in completed is a no-op
    assert.equal(await routing.routeReviewPath(w), null);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path: a LATER review occurrence (new emitter run) routes again — the marker is per-occurrence", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    completeWithArtifact(s, r, "changes_requested");
    await routing.routeReviewPath(r);
    assert.equal(retryCount(s, w), 1);

    // the target re-runs and completes again; the reviewer reviews AGAIN
    applyTransition(s.db, w, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, w, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, w, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    const secondRun = addRunRow(s, r, "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.equal(out?.emitterRunId, secondRun);
    assert.deepEqual(out?.routed, [{ target: w, finalState: "queued", feedbackPath: feedbackRelPath(w, r) }]);
    assert.equal(state(s, w), "queued");
    assert.equal(retryCount(s, w), 2, "a new occurrence burns one more retry");
    const entries = transitions(s, w).filter((t) => t["to_state"] === "changes_requested");
    assert.deepEqual(entries.map((t) => t["run_id"]), [entries[0]!["run_id"], secondRun]);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("review path crash-window recovery: a marker left without the requeue is finished, never re-entered", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    const emitterRun = completeWithArtifact(s, r, "changes_requested");
    // simulate a crash BETWEEN the entry and the delivery/requeue: the
    // marker (the entry log row) exists, the requeue never happened
    enterChangesRequested(s.db, w, REVIEW_REENTRY_TRIGGER, {
      triggerType: "engine",
      actor: CHAIN_ENGINE_ACTOR,
      runId: emitterRun,
      reason: "review-path re-entry (simulated crash window)",
    });
    assert.equal(state(s, w), "changes_requested");

    const out = await routing.routeReviewPath(r);
    assert.deepEqual(out?.routed, [{ target: w, finalState: "queued", feedbackPath: feedbackRelPath(w, r) }]);
    assert.equal(state(s, w), "queued");
    assert.equal(retryCount(s, w), 1, "the entry is NEVER applied twice");
    assert.equal(
      transitions(s, w).filter((t) => t["to_state"] === "changes_requested").length,
      1,
    );
    assert.deepEqual(contextFiles(s, w), [feedbackRelPath(w, r)], "the interrupted delivery completes");
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

/* ------------------------------- failure path ------------------------------- */

test("failure path: a confirmed-failed member enqueues its draft on_failure target with a synthesized failure context file", async () => {
  const s = seed();
  try {
    const { chainId, f, t } = importFailureChain(s);
    const enqueued: string[] = [];
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE, onEnqueued: (id) => enqueued.push(id) });
    const failedRun = confirmFailedWithRun(s, f, {
      errorSummary: "boom: tests failed",
      artifactStatus: "completed",
    });

    const out = await routing.routeFailurePath(f);
    assert.equal(out?.chainRunId, chainId);
    assert.deepEqual(out?.enqueued, [t]);
    assert.deepEqual(enqueued, [t]);
    assert.equal(state(s, t), "queued");

    // the guarded draft→queued row, engine / chain-engine
    const entry = transitions(s, t).find((tr) => tr["to_state"] === "queued")!;
    assert.equal(entry["from_state"], "draft");
    assert.equal(entry["trigger_type"], "engine");
    assert.equal(entry["actor"], CHAIN_ENGINE_ACTOR);

    // the synthesized failure feedback: latest run error_summary + result.json content
    const delivered = join(s.wsRoot, feedbackRelPath(t, f));
    assert.ok(existsSync(delivered));
    const fb = JSON.parse(readFileSync(delivered, "utf8")) as Record<string, unknown>;
    assert.equal(fb["kind"], "novaflow-failure-feedback");
    assert.equal(fb["failed_task_id"], f);
    assert.equal(fb["failed_run_id"], failedRun);
    assert.equal(fb["error_summary"], "boom: tests failed");
    assert.equal((fb["result"] as Record<string, unknown>)["status"], "completed");
    // FR-TSK-04 recording, same convention as the review path
    assert.deepEqual(deliveredFeedbackPaths(s.db, t), [feedbackRelPath(t, f)]);
    assert.deepEqual(contextFiles(s, t), [feedbackRelPath(t, f)]);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("failure path: non-draft targets are consumed; the chain-failed rule is unordered — routing continues on a FAILED chain", async () => {
  const s = seed();
  try {
    const { chainId, ids } = importGraph(
      s,
      [{ key: "F", title: "Flaky" }, { key: "T1", title: "Fallback one" }, { key: "T2", title: "Fallback two" }],
      [
        { source_key: "F", target_key: "T1", edge_type: "on_failure" },
        { source_key: "F", target_key: "T2", edge_type: "on_failure" },
      ],
    );
    const f = ids["F"]!;
    const t1 = ids["T1"]!;
    const t2 = (s.db.prepare("SELECT id FROM tasks WHERE key = 'T2'").get() as { id: string }).id;
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });

    // T2 is mid-flight (queued), not draft — consumed, never force-moved
    applyTransition(s.db, t2, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    confirmFailedWithRun(s, f, { errorSummary: "irrecoverable", artifactStatus: "completed" });

    // the chain-failed rule fires FIRST (the natural gate-confirm order):
    // the chain records failed while member-level routing continues
    assert.equal(evaluator.applyTerminalRules(chainId), "failed");

    const out = await routing.routeFailurePath(f);
    assert.deepEqual(out?.enqueued, [t1], "only the draft target enqueued");
    assert.equal(state(s, t1), "queued");
    assert.equal(state(s, t2), "queued", "the queued target is untouched");
    assert.equal(transitions(s, t2).filter((tr) => tr["to_state"] === "queued").length, 1);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("failure path: a member failed WITHOUT the terminal gate outcome does not route fallbacks", async () => {
  const s = seed();
  try {
    const { f, t } = importFailureChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    // running→failed: the retry path is still ahead — NOT a confirmed failure
    applyTransition(s.db, f, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(s.db, f, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, f, RUN_FAILED_TRIGGER, { triggerType: "engine", actor: "seed" });

    assert.equal(await routing.routeFailurePath(f), null);
    assert.equal(state(s, t), "draft");
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("failure path idempotence: re-observing the same confirmed failure enqueues exactly once", async () => {
  const s = seed();
  try {
    const { f, t } = importFailureChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    confirmFailedWithRun(s, f, { errorSummary: "irrecoverable", artifactStatus: "completed" });

    await routing.routeFailurePath(f);
    await routing.routeFailurePath(f); // the same failure observed again
    assert.equal(state(s, t), "queued");
    assert.equal(transitions(s, t).filter((tr) => tr["to_state"] === "queued").length, 1);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

/* -------------------------------- boot sweep -------------------------------- */

test("boot sweep: a review occurrence missed while the daemon was down routes exactly once", async () => {
  const s = seed();
  try {
    const { r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    completeWithArtifact(s, r, "changes_requested");

    const report = await routing.bootScan();
    assert.equal(report.chains, 1);
    assert.equal(report.reviewRouted, 1);
    assert.equal(state(s, w), "queued");

    // a second sweep (another restart) never double-fires
    const again = await routing.bootScan();
    assert.equal(again.reviewRouted, 0);
    assert.equal(retryCount(s, w), 1);
    assert.equal(transitions(s, w).filter((t) => t["to_state"] === "changes_requested").length, 1);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("boot sweep: a confirmed failure missed while down enqueues its fallback; a FAILED chain still sweeps", async () => {
  const s = seed();
  try {
    const { chainId, f, t } = importFailureChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    confirmFailedWithRun(s, f, { errorSummary: "irrecoverable", artifactStatus: "completed" });
    assert.equal(evaluator.applyTerminalRules(chainId), "failed");

    const report = await routing.bootScan();
    assert.equal(report.fallbackEnqueued, 1);
    assert.equal(state(s, t), "queued", "the sweep covers failed chains — member routing continues");
    const again = await routing.bootScan();
    assert.equal(again.fallbackEnqueued, 0);
    assert.equal(transitions(s, t).filter((tr) => tr["to_state"] === "queued").length, 1);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("boot sweep: an ABORTED chain is never swept — the operator's terminal decision stands", async () => {
  const s = seed();
  try {
    const { chainId, r, w } = importReviewChain(s);
    const routing = createRoutingEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, w);
    completeWithArtifact(s, r, "changes_requested");
    assert.equal(setChainRunAborted(s.db, chainId), true);

    const report = await routing.bootScan();
    assert.equal(report.chains, 0);
    assert.equal(state(s, w), "completed", "no routing fires for an aborted chain");
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
