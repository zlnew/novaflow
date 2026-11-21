import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition, InvalidTransitionError } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER, RUN_FAILED_TRIGGER } from "../../src/runs/triggers.ts";
import { ROWS } from "../../src/fsm/matrix.ts";
import { confirmFailureGate } from "../../src/gates.ts";
import {
  AUTO_RETRY_TRIGGER,
  OPERATOR_RETRY_TRIGGER,
  FAILED_ESCALATION_TRIGGER,
} from "../../src/daemon/triggers.ts";
import { createRetryEvaluator } from "../../src/daemon/retry.ts";
import type { HaltAlert, HaltNotifier, NotifyResult } from "../../src/notify.ts";

/**
 * The p2c contract: whenever a task enters `failed`, either arm the
 * auto-retry timer (failed→queued, `retry.delay_sec` measured from the
 * failed transition's state_transition_logs.created_at) or — when the
 * retry budget is spent — apply the verbatim failed→awaiting_gate
 * escalation row + halt notify. Without this, failed tasks dead-end
 * with no operator surface.
 */

type Seed = { db: Database.Database; taskId: string; alerts: HaltAlert[]; requeues: string[] };

function makeFailedTask(opts: { retryCount?: number; maxRetries?: number } = {}): Seed {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/nf-ws')").run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, thinking_level,
       system_prompt_path, max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', 'm', 'medium', 'p.md', 60, 5)`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  const task = createTask(db, {
    projectId,
    key: "TASK-101",
    title: "t",
    objective: "o",
    profileId,
  });
  db.prepare("UPDATE tasks SET max_retries = ?, retry_count = ? WHERE id = ?").run(
    opts.maxRetries ?? 3,
    opts.retryCount ?? 0,
    task.id,
  );
  // draft → queued → running → failed, exactly the legal chain
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(db, task.id, START_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(db, task.id, RUN_FAILED_TRIGGER, { triggerType: "engine", actor: "test" });

  const alerts: HaltAlert[] = [];
  const requeues: string[] = [];
  return { db, taskId: task.id, alerts, requeues };
}

function evaluator(s: Seed, delaySec: number) {
  const notify: HaltNotifier = (alert) => {
    s.alerts.push(alert);
    return Promise.resolve({ ok: true, topic: "ops" } as NotifyResult);
  };
  return createRetryEvaluator(s.db, {
    delaySec,
    notify,
    onRequeue: (taskId) => s.requeues.push(taskId),
  });
}

/**
 * An operator-CONFIRMED terminal gate failure: the task ran, settled
 * into awaiting_gate, and the operator confirmed the failure gate
 * (the verbatim awaiting_gate→failed terminal row, retry budget floored
 * at max_retries) — through the REAL gate service, never a hand-built
 * row.
 */
function makeConfirmedFailedTask(): Seed {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/nf-ws')").run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, thinking_level,
       system_prompt_path, max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', 'm', 'medium', 'p.md', 60, 5)`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  const task = createTask(db, {
    projectId,
    key: "TASK-CONFIRMED",
    title: "t",
    objective: "o",
    profileId,
  });
  db.prepare("UPDATE tasks SET max_retries = 3, retry_count = 0 WHERE id = ?").run(task.id);
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(db, task.id, START_TRIGGER, { triggerType: "engine", actor: "test" });
  const runId = ulid();
  db.prepare(
    `INSERT INTO task_runs (id, task_id, attempt_number, pi_session_id, pi_session_dir,
       status, preflight_status, model_used, events_log_path)
     VALUES (?, ?, 1, ?, ?, 'succeeded', 'passed', 'm', '/tmp/nf-events.jsonl')`,
  ).run(runId, task.id, runId, "/tmp/nf-run");
  // running → awaiting_gate: the requires_human_gate settle row (verbatim)
  const gateSettle = ROWS.find((r) => r.state === "running" && r.target === "awaiting_gate")!;
  applyTransition(db, task.id, gateSettle.trigger, {
    triggerType: "engine",
    actor: "test",
    runId,
  });
  // the operator confirms failure — the TERMINAL gate row
  confirmFailureGate(
    db,
    { task_id: task.id, run_id: runId, approved_by: "maul", note: "confirmed broken" },
    "human",
    {
      notify: () => Promise.resolve({ ok: true, topic: "ops" } as NotifyResult),
    },
  );
  const alerts: HaltAlert[] = [];
  const requeues: string[] = [];
  return { db, taskId: task.id, alerts, requeues };
}

function state(s: Seed): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(s.taskId) as { state: string }).state;
}

function transitions(s: Seed): Array<Record<string, unknown>> {
  return s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
    .all(s.taskId) as Array<Record<string, unknown>>;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------------- escalation path --------------------------------- */

test("regression: an operator-CONFIRMED terminal gate failure is never resurrected at boot — stays failed, no notify, no timer", async () => {
  const s = makeConfirmedFailedTask();
  try {
    const r = evaluator(s, 300);
    const decisions = r.bootScan();
    assert.deepEqual(decisions, [{ kind: "terminal-gate", finalState: "failed" }]);
    assert.equal(state(s), "failed");
    // no escalation notify fired — the evaluator's collector saw nothing
    assert.equal(s.alerts.length, 0);
    // no failed→awaiting_gate ESCALATION row was ever written (the seed's
    // running→awaiting_gate settle row is the task's legitimate gate entry)
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND from_state = 'failed' AND to_state = 'awaiting_gate'").get(s.taskId) as { n: number }).n,
      0,
    );
    // terminal means terminal: even a short-delay evaluator arms no
    // auto-retry timer for it
    const short = evaluator(s, 0.05);
    const d = short.evaluate(s.taskId);
    assert.deepEqual(d, { kind: "terminal-gate", finalState: "failed" });
    await wait(300);
    assert.equal(state(s), "failed"); // never requeued, never moved
    r.stop();
    short.stop();
  } finally {
    s.db.close();
  }
});

test("a run-failed task with a spent budget still escalates — the terminal-gate skip is source-row-based, not budget-based", () => {
  const s = makeFailedTask({ retryCount: 3, maxRetries: 3 });
  try {
    const r = evaluator(s, 300);
    const d = r.evaluate(s.taskId);
    assert.equal(d.kind, "escalated");
    assert.equal(state(s), "awaiting_gate");
    assert.equal(s.alerts.length, 1);
    r.stop();
  } finally {
    s.db.close();
  }
});

test("budget spent on entry to failed → the verbatim failed→awaiting_gate escalation + halt notify", () => {
  const s = makeFailedTask({ retryCount: 3, maxRetries: 3 });
  try {
    const r = evaluator(s, 300);
    const decision = r.evaluate(s.taskId);
    assert.equal(state(s), "awaiting_gate");
    assert.deepEqual(decision, { kind: "escalated", finalState: "awaiting_gate" });
    // the verbatim escalation row, engine-evaluated
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "failed");
    assert.equal(last["to_state"], "awaiting_gate");
    assert.equal(last["trigger_type"], "engine");
    assert.match(String(last["reason"]), /retry_count 3 >= max_retries 3/);
    // FAILED_NEEDS_HUMAN_REVIEW is served: the operator has a gate surface
    assert.equal(s.alerts.length, 1);
    assert.match(s.alerts[0]!.message, /awaiting_gate/);
    r.stop();
  } finally {
    s.db.close();
  }
});

/* ----------------------------------- timer path ------------------------------------ */

test("budget remains → the timer arms from the failed transition's created_at; expiry requeues and dispatch is hooked", async () => {
  const s = makeFailedTask({ retryCount: 1, maxRetries: 3 });
  try {
    const r = evaluator(s, 0.15); // 150 ms
    const decision = r.evaluate(s.taskId);
    assert.equal(decision.kind, "timer-armed");
    assert.equal(state(s), "failed");
    assert.equal(s.requeues.length, 0);
    await wait(50);
    assert.equal(state(s), "failed"); // not yet
    await wait(250);
    assert.equal(state(s), "queued");
    assert.deepEqual(s.requeues, [s.taskId]); // dispatch picks it up
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "failed");
    assert.equal(last["to_state"], "queued");
    assert.equal(last["trigger_type"], "timeout"); // a timer expiry
    assert.match(String(last["reason"]), /auto-retry timer expired/);
    r.stop();
  } finally {
    s.db.close();
  }
});

test("the timer measures from the transition's created_at, not from evaluate() — half-spent delays fire half-late", async () => {
  const s = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    // backdate the failed transition by ~120 ms of a 200 ms delay
    s.db
      .prepare("UPDATE state_transition_logs SET created_at = ? WHERE task_id = ? AND to_state = 'failed'")
      .run(new Date(Date.now() - 120).toISOString(), s.taskId);
    const r = evaluator(s, 0.2);
    r.evaluate(s.taskId);
    await wait(40);
    assert.equal(state(s), "failed"); // ~80 ms remain
    await wait(160);
    assert.equal(state(s), "queued");
    r.stop();
  } finally {
    s.db.close();
  }
});

test("a delay already elapsed at boot → requeue immediately (no timer wait)", () => {
  const s = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    s.db
      .prepare("UPDATE state_transition_logs SET created_at = ? WHERE task_id = ? AND to_state = 'failed'")
      .run(new Date(Date.now() - 400_000).toISOString(), s.taskId); // elapsed past the 300 s delay
    const r = evaluator(s, 300);
    const decision = r.bootScan();
    assert.equal(state(s), "queued");
    assert.deepEqual(decision.map((d) => d.kind), ["requeued"]);
    assert.deepEqual(s.requeues, [s.taskId]);
    r.stop();
  } finally {
    s.db.close();
  }
});

test("bootScan escalates spent tasks and requeues elapsed ones in one pass", () => {
  const spent = makeFailedTask({ retryCount: 2, maxRetries: 2 });
  const elapsed = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    elapsed.db
      .prepare("UPDATE state_transition_logs SET created_at = ? WHERE task_id = ? AND to_state = 'failed'")
      .run(new Date(Date.now() - 400_000).toISOString(), elapsed.taskId); // elapsed past the 300 s delay
    const r = evaluator(spent, 300);
    r.bootScan();
    const r2 = evaluator(elapsed, 300);
    r2.bootScan();
    assert.equal(state(spent), "awaiting_gate");
    assert.equal(state(elapsed), "queued");
    assert.equal(spent.alerts.length, 1);
    r.stop();
    r2.stop();
  } finally {
    spent.db.close();
    elapsed.db.close();
  }
});

/* ------------------------------ operator retry + clears ---------------------------- */

test("operatorRetry applies the verbatim operator-retry row, clears the armed timer, hooks dispatch", () => {
  const s = makeFailedTask({ retryCount: 1, maxRetries: 3 });
  try {
    const r = evaluator(s, 300);
    r.evaluate(s.taskId); // arms a 300 s timer
    const res = r.operatorRetry(s.taskId, { triggerType: "human", actor: "maul" });
    assert.deepEqual(res, { kind: "requeued", finalState: "queued" });
    assert.equal(state(s), "queued");
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["trigger_type"], "human");
    assert.equal(last["actor"], "maul");
    assert.match(String(last["reason"]), /operator retry/);
    assert.deepEqual(s.requeues, [s.taskId]);
    // the armed timer is cleared: no second failed→queued move ever fires
    r.stop();
    const count = (
      s.db
        .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND to_state = 'queued'")
        .get(s.taskId) as { n: number }
    ).n;
    assert.equal(count, 2); // the seed's draft→queued + the operator retry, nothing more
  } finally {
    s.db.close();
  }
});

test("operatorRetry on a budget-spent failed task escalates instead (the deterministic contract — the FSM is the arbiter)", () => {
  const s = makeFailedTask({ retryCount: 3, maxRetries: 3 });
  try {
    const r = evaluator(s, 300);
    const res = r.operatorRetry(s.taskId, { triggerType: "mcp", actor: "orchestrator" });
    assert.deepEqual(res, { kind: "escalated", finalState: "awaiting_gate" });
    assert.equal(state(s), "awaiting_gate");
    assert.equal(s.alerts.length, 1);
    r.stop();
  } finally {
    s.db.close();
  }
});

test("operatorRetry on a non-failed task → InvalidTransitionError, state untouched", () => {
  const s = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    const r = evaluator(s, 300);
    r.operatorRetry(s.taskId, { triggerType: "human", actor: "maul" }); // failed → queued
    assert.throws(
      () => r.operatorRetry(s.taskId, { triggerType: "human", actor: "maul" }),
      InvalidTransitionError,
    );
    assert.equal(state(s), "queued");
    r.stop();
  } finally {
    s.db.close();
  }
});

test("clearFor: a task moved out of failed by another surface never fires its armed timer", async () => {
  const s = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    const r = evaluator(s, 0.1);
    r.evaluate(s.taskId); // armed: 100 ms
    // the operator aborts the failed task inside the retry window
    applyTransition(s.db, s.taskId, "operator abort inside the retry window (task abort or chain abort)", {
      triggerType: "human",
      actor: "op",
    });
    r.clearFor(s.taskId);
    await wait(250);
    assert.equal(state(s), "cancelled"); // no timer-fired requeue happened
    const queuedCount = (
      s.db
        .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND to_state = 'queued'")
        .get(s.taskId) as { n: number }
    ).n;
    assert.equal(queuedCount, 1); // only the seed's draft→queued
    r.stop();
  } finally {
    s.db.close();
  }
});

test("trigger constants are the verbatim matrix rows (one source, golden-pinned in triggers.test)", () => {
  assert.match(AUTO_RETRY_TRIGGER, /^auto-retry timer expires/);
  assert.match(OPERATOR_RETRY_TRIGGER, /^operator retry/);
  assert.match(FAILED_ESCALATION_TRIGGER, /^retry_count >= max_retries/);
});

/* --------------------------- no strays: timers are cleared -------------------------- */

test("stop() clears every armed timer — nothing fires after", async () => {
  const s = makeFailedTask({ retryCount: 0, maxRetries: 3 });
  try {
    const r = evaluator(s, 0.05);
    r.evaluate(s.taskId);
    r.stop();
    await wait(200);
    assert.equal(state(s), "failed"); // the timer never fired
  } finally {
    s.db.close();
  }
});
