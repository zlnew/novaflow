import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl, extractMatrix } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER, createTask } from "../../src/tasks.ts";
import { START_TRIGGER } from "../../src/runs/triggers.ts";
import { startRun, type TaskRunRecord } from "../../src/runs/loop.ts";
import { recoverOrphanedRuns } from "../../src/daemon/recovery.ts";
import type { HaltAlert, HaltNotifier, NotifyResult } from "../../src/notify.ts";

/**
 * Boot crash recovery per architecture 8.4: on init, reconcile every
 * task_runs row still marked running. agent_settled in events.raw.jsonl
 * → REPLAY the settlement through the same intake the live loop uses;
 * otherwise mark the run crashed (status failed + crash detail, task
 * state UNCHANGED) and notify the operator.
 */

const MODEL = "claude-3-5-sonnet-20241022";
const PRICES = { [MODEL]: { input: 3, output: 15 } };

/** The pre-crash stream the stub would have emitted (api.md §4 shapes). */
function streamLines(taskId: string, runId: string, settled: boolean): string[] {
  return [
    JSON.stringify({ type: "message_update", usage: { input: 0, output: 0 } }),
    JSON.stringify({ type: "tool_execution_start", tool: "bash" }),
    JSON.stringify({ type: "tool_execution_end", tool: "bash", exit_code: 0 }),
    JSON.stringify({ type: "message_end", usage: { input: 4500, output: 620 } }),
    ...(settled ? [JSON.stringify({ type: "agent_settled" })] : []),
  ].map((l) => l.replace("__TASK__", taskId).replace("__RUN__", runId));
}

function validArtifact(taskId: string, runId: string): string {
  return JSON.stringify(
    {
      schema_version: "1.0.0",
      task_id: taskId,
      run_id: runId,
      status: "completed",
      summary: "Implemented the requested change end to end.",
      assumptions_made: [],
      open_questions: [],
      artifacts_modified: [],
      feedback_items: [],
      next_recommended_action: "proceed_to_next",
    },
    null,
    2,
  );
}

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  pricesPath: string;
  /** The temp dir holding pricesPath — cleanup() removes it (leak pin). */
  pricesDir: string;
};

/**
 * The temp-root prefix carries THIS process's token: the leak assertion below
 * compares the suite's own footprint, and a bare `novaflow-rec` prefix made
 * two concurrent suite copies see each other's live directories (the same
 * shared-namespace interference DEBT-004 was: not timing inside the subject).
 */
const TMP_TOKEN = `novaflow-rec-${process.pid}-`;

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), TMP_TOKEN));
  mkdirSync(join(wsRoot, "prompts"), { recursive: true });
  writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");

  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 1.5)`,
  ).run(ulid(), MODEL);
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;

  const task = createTask(db, {
    projectId,
    key: "TASK-101",
    title: "Implement PKCE",
    objective: "Implement PKCE code challenge verification.",
    profileId,
  });
  // simulate the pre-crash daemon: draft→queued already applied; the
  // queued→running move belongs to whichever path owns the spawn
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });

  const dir = mkdtempSync(join(tmpdir(), TMP_TOKEN));
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify(PRICES));
  return { db, wsRoot, taskId: task.id, pricesPath, pricesDir: dir };
}

type Orphan = { runId: string; runDir: string };

/** Insert an orphaned 'running' run row + a half-written run dir. */
function orphan(s: Seed, opts: { settled: boolean; artifact: boolean }): Orphan {
  // the crash happened mid-run: the queued→running move is already applied
  applyTransition(s.db, s.taskId, START_TRIGGER, { triggerType: "engine", actor: "test" });
  const runId = ulid();
  const runDir = join(s.wsRoot, ".novaflow", "runs", s.taskId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.raw.jsonl"),
    streamLines(s.taskId, runId, opts.settled).join("\n") + "\n",
    { mode: 0o600 },
  );
  if (opts.artifact) {
    writeFileSync(join(runDir, "result.json"), validArtifact(s.taskId, runId));
  }
  s.db
    .prepare(
      `INSERT INTO task_runs
         (id, task_id, profile_id, attempt_number, attempt_kind, pi_session_id,
          pi_session_dir, status, preflight_status, model_used, events_log_path)
       VALUES (?, ?, (SELECT id FROM agent_profiles), 1, 'execution', ?, ?,
          'running', 'passed', ?, ?)`,
    )
    .run(runId, s.taskId, runId, runDir, MODEL, join(runDir, "events.jsonl"));
  return { runId, runDir };
}

function runRow(s: Seed, runId: string): TaskRunRecord {
  return s.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as TaskRunRecord;
}

function taskState(s: Seed): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(s.taskId) as { state: string }).state;
}

function lastTransition(s: Seed): Record<string, unknown> {
  return s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(s.taskId) as Record<string, unknown>;
}

function cleanup(s: Seed): void {
  s.db.close();
  rmSync(s.wsRoot, { recursive: true, force: true });
  rmSync(s.pricesDir, { recursive: true, force: true });
}

/** This suite's own temp-dir footprint (token-scoped, see TMP_TOKEN). */
function recTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith(TMP_TOKEN));
}
const recTempDirsBefore = recTempDirs();

/* ----------------------------- replayed settlement ------------------------------ */

test("settled orphan → the replayed settlement matches the live path's outcome", async (t) => {
  const live = seed();
  const rec = seed();
  try {
    // ---- the LIVE path: the same task through startRun (stub run-ok) ----
    const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
    const liveOutcome = await startRun(live.db, live.taskId, "engine-worker", {
      piBin: "node",
      args: [STUB, "run-ok", join(live.wsRoot, "..", "noop.pid")],
      pricesPath: live.pricesPath,
      extensionPath: "/ext/novaflow.ts",
    });
    assert.equal(liveOutcome.finalState, "validating");
    const liveRow = liveOutcome.runs[0]!;

    // ---- the RECOVERY path: an orphan with the same stream + artifact ----
    const o = orphan(rec, { settled: true, artifact: true });
    const report = recoverOrphanedRuns(rec.db, { pricesPath: rec.pricesPath });
    assert.equal(taskState(rec), "validating");
    assert.deepEqual(
      report.replayed.map((r) => [r.taskId, r.runId, r.target]),
      [[rec.taskId, o.runId, "validating"]],
    );
    assert.deepEqual(report.crashed, []);

    // the recovered run row matches the live one on every engine-owned field
    const row = runRow(rec, o.runId);
    for (const field of [
      "status", // succeeded
      "preflight_status", // passed
      "model_used",
      "input_tokens", // 4500
      "output_tokens", // 620
      "cost_usd", // 4500/1M × $3 + 620/1M × $15 = 0.0228
      "error_summary", // null (prices file present)
      "attempt_kind",
      "attempt_number",
    ] as const) {
      assert.equal(
        row[field],
        liveRow[field],
        `field ${String(field)}: recovered ${JSON.stringify(row[field])} vs live ${JSON.stringify(liveRow[field])}`,
      );
    }
    assert.ok(Math.abs(row.cost_usd - 0.0228) < 1e-9);
    // artifact paths point at each run's own dir (temp roots differ)
    assert.equal(row.artifact_path, join(o.runDir, "result.json"));
    assert.equal(liveRow.artifact_path, join(liveRow.pi_session_dir, "result.json"));
    // documented recovery difference: the daemon never observed the exit,
    // so exit_code is null (the unobserved convention, like spawn-error)
    assert.equal(row.exit_code, null);
    assert.ok(existsSync(row.artifact_path!));

    // the settle transition: the verbatim agent_settled row, engine, run-pinned
    const tr = lastTransition(rec);
    const settleRow = extractMatrix().find(
      (r) => r.state === "running" && r.target === "validating",
    )!;
    assert.equal(tr["from_state"], "running");
    assert.equal(tr["to_state"], "validating");
    assert.equal(tr["trigger"], undefined); // the log schema has no trigger column
    assert.equal(tr["run_id"], o.runId);
    assert.equal(tr["trigger_type"], "engine");
    assert.equal(tr["reason"], "artifact status: completed");
    // the row used WAS the matrix's verbatim settle row: proven by the
    // live path logging the identical reason from the same intake
    assert.equal(lastTransition(live)["reason"], "artifact status: completed");
    assert.equal(
      settleRow.trigger,
      "agent_settled with artifact present (no gate required)",
    );
  } finally {
    cleanup(live);
    cleanup(rec);
  }
});

test("settled orphan with a missing result.json → replay produces failed-with-reason (the live loop's invalid-artifact row)", () => {
  const s = seed();
  try {
    const o = orphan(s, { settled: true, artifact: false });
    const report = recoverOrphanedRuns(s.db, { pricesPath: s.pricesPath });
    assert.equal(taskState(s), "failed");
    const row = runRow(s, o.runId);
    assert.equal(row.status, "failed");
    assert.equal(row.error_summary, "result.json missing after agent_settled");
    assert.equal(row.input_tokens, 4500); // the tally was still replayed
    const tr = lastTransition(s);
    assert.equal(tr["from_state"], "running");
    assert.equal(tr["to_state"], "failed");
    // the crash aborted the repair loop mid-flight — recovery cannot
    // resume a repair, so the intake failure lands on the running→failed row
    assert.equal(report.replayed.length, 0);
    assert.equal(report.failedIntake.length, 1);
  } finally {
    cleanup(s);
  }
});

/* --------------------------------- crashed orphan -------------------------------- */

test("orphan without agent_settled → run failed with crash detail, task UNCHANGED, halt notify fired", () => {
  const s = seed();
  try {
    const o = orphan(s, { settled: false, artifact: false });
    const transitionsBefore = (
      s.db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }
    ).n;
    const alerts: HaltAlert[] = [];
    const notify: HaltNotifier = (alert) => {
      alerts.push(alert);
      return Promise.resolve({ ok: true, topic: "ops" } as NotifyResult);
    };
    const report = recoverOrphanedRuns(s.db, {
      pricesPath: s.pricesPath,
      notify,
    });
    assert.deepEqual(report.crashed.map((c) => c.runId), [o.runId]);
    assert.equal(report.replayed.length, 0);

    // §8.4 + the fallback table's INTERRUPTED row: task state UNCHANGED
    assert.equal(taskState(s), "running");
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }).n,
      transitionsBefore,
    );

    // the run record: failed + crash detail + the tallied pre-crash stream
    const row = runRow(s, o.runId);
    assert.equal(row.status, "failed");
    assert.equal(row.exit_code, null); // unobserved: the process died with the daemon
    assert.match(row.error_summary ?? "", /crashed/);
    assert.match(row.error_summary ?? "", /agent_settled/);
    assert.equal(row.input_tokens, 4500);
    assert.equal(row.output_tokens, 620);
    assert.ok(Math.abs(row.cost_usd - 0.0228) < 1e-9);

    // the operator was notified (halt trigger, RSK-07)
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, new RegExp(o.runId));
    assert.match(alerts[0]!.message, /task state unchanged/);
  } finally {
    cleanup(s);
  }
});

test("an orphan with no events.raw.jsonl at all → crashed (nothing was ever streamed)", () => {
  const s = seed();
  try {
    const o = orphan(s, { settled: false, artifact: false });
    rmSync(join(o.runDir, "events.raw.jsonl"));
    const report = recoverOrphanedRuns(s.db, { pricesPath: s.pricesPath });
    assert.deepEqual(report.crashed.map((c) => c.runId), [o.runId]);
    const row = runRow(s, o.runId);
    assert.equal(row.status, "failed");
    assert.equal(row.input_tokens, 0);
    assert.equal(taskState(s), "running");
  } finally {
    cleanup(s);
  }
});

test("guard-refusal finalize preserves the orphan's preflight_status (a 'pending' row is finalized 'failed')", () => {
  const s = seed();
  try {
    // the first orphan settles cleanly; a stale second 'running' row for
    // the SAME task (a crash left two live rows) cannot be reconciled
    // once the first replay moved the task — the guard refuses it
    const first = orphan(s, { settled: true, artifact: true });

    const runId2 = ulid();
    const runDir2 = join(s.wsRoot, ".novaflow", "runs", s.taskId, runId2);
    mkdirSync(runDir2, { recursive: true });
    writeFileSync(
      join(runDir2, "events.raw.jsonl"),
      streamLines(s.taskId, runId2, true).join("\n") + "\n",
    );
    writeFileSync(join(runDir2, "result.json"), validArtifact(s.taskId, runId2));
    s.db
      .prepare(
        `INSERT INTO task_runs
           (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
            status, preflight_status, model_used, events_log_path)
         VALUES (?, ?, (SELECT id FROM agent_profiles), 2, ?, ?, 'running', 'pending', ?, ?)`,
      )
      .run(runId2, s.taskId, runId2, runDir2, MODEL, join(runDir2, "events.jsonl"));

    const report = recoverOrphanedRuns(s.db, { pricesPath: s.pricesPath });
    assert.deepEqual(report.crashed.map((c) => c.runId), [runId2]);
    const row = runRow(s, runId2);
    // the preserve rule mirrors the main crashed path: preflight never
    // completed, so the finalized row says 'failed' — not 'passed'
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /could not reconcile/);
    // the first orphan's replay is untouched by the guard refusal
    assert.equal((s.db.prepare("SELECT status FROM task_runs WHERE id = ?").get(first.runId) as { status: string }).status, "succeeded");
  } finally {
    cleanup(s);
  }
});


test("recovery is idempotent: a second pass finds no orphans", () => {
  const s = seed();
  try {
    const o = orphan(s, { settled: true, artifact: true });
    recoverOrphanedRuns(s.db, { pricesPath: s.pricesPath });
    const second = recoverOrphanedRuns(s.db, { pricesPath: s.pricesPath });
    assert.deepEqual(second, { replayed: [], failedIntake: [], crashed: [] });
    assert.equal(taskState(s), "validating");
    assert.equal((s.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(o.runId) as TaskRunRecord).status, "succeeded");
  } finally {
    cleanup(s);
  }
});

test("suite cleanup: zero temp dirs leaked (before/after delta 0)", () => {
  // every seed() in this suite cleans its wsRoot AND its prices dir —
  // the leak this pins was ~6 workspace+prices roots per run
  assert.deepEqual(recTempDirs().filter((d) => !recTempDirsBefore.includes(d)), []);
});
