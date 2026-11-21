import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER, GATE_TRIGGER } from "../../src/runs/triggers.ts";
import {
  approveGate,
  confirmFailureGate,
  rejectGate,
  GateError,
  type GatePayload,
} from "../../src/gates.ts";

/**
 * architecture 8.1, gate approval contract: the payload is
 * {task_id, run_id, approved_by, note}; verification is identity-based;
 * the engine requires the fields, records them in
 * state_transition_logs (trigger_type human|mcp), and rejects when the
 * task is not awaiting_gate or the run_id does not match the live run.
 */

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
};

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-gate-"));
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run(taskId, projectId, profileId);
  return { db, wsRoot, taskId };
}

/** Walk the task into awaiting_gate and give it N run rows (attempt order). */
function toGate(s: Seed, runCount: number, opts: { maxRetries?: number; retryCount?: number } = {}): string[] {
  if (opts.maxRetries !== undefined || opts.retryCount !== undefined) {
    s.db
      .prepare("UPDATE tasks SET max_retries = ?, retry_count = ? WHERE id = ?")
      .run(opts.maxRetries ?? 3, opts.retryCount ?? 0, s.taskId);
  }
  applyTransition(s.db, s.taskId, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(s.db, s.taskId, START_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(s.db, s.taskId, GATE_TRIGGER, { triggerType: "engine", actor: "test" });
  const ids: string[] = [];
  for (let i = 1; i <= runCount; i++) {
    const runId = ulid();
    s.db
      .prepare(
        `INSERT INTO task_runs
           (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
            model_used, events_log_path)
         VALUES (?, ?, ?, ?, ?, ?, 'm', ?)`,
      )
      .run(runId, s.taskId, null, i, runId, "/tmp", "/tmp/events.jsonl");
    ids.push(runId);
  }
  return ids;
}

function payload(s: Seed, runId: string, over: Partial<GatePayload> = {}): GatePayload {
  return {
    task_id: s.taskId,
    run_id: runId,
    approved_by: "maul",
    note: "LGTM — ship it",
    ...over,
  };
}

function state(s: Seed): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(s.taskId) as { state: string }).state;
}

function retryCount(s: Seed): number {
  return (s.db.prepare("SELECT retry_count FROM tasks WHERE id = ?").get(s.taskId) as { retry_count: number }).retry_count;
}

function transitions(s: Seed): Array<Record<string, unknown>> {
  return s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
    .all(s.taskId) as Array<Record<string, unknown>>;
}

/* ------------------------------------ approve ------------------------------------- */

test("approve: awaiting_gate→validating, the record lands in the log's reason, run_id logged", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    approveGate(s.db, payload(s, run!), "human");
    assert.equal(state(s), "validating");
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "awaiting_gate");
    assert.equal(last["to_state"], "validating");
    assert.equal(last["trigger_type"], "human");
    assert.equal(last["actor"], "maul");
    assert.equal(last["run_id"], run);
    assert.match(String(last["reason"]), /maul/);
    assert.match(String(last["reason"]), /LGTM — ship it/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("approve via the mcp surface records trigger_type mcp", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    approveGate(s.db, payload(s, run!), "mcp");
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["trigger_type"], "mcp");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ------------------------------ contract violations ------------------------------ */

test("a missing required field is a typed error; task and log untouched", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    const before = transitions(s).length;
    const cases: Array<Partial<GatePayload>> = [
      { task_id: undefined as never },
      { run_id: undefined as never },
      { approved_by: undefined as never },
      { note: undefined as never },
      { approved_by: "" },
      { note: "   " },
    ];
    for (const over of cases) {
      assert.throws(
        () => approveGate(s.db, payload(s, run!, over), "human"),
        (err: unknown) => err instanceof GateError && err.code === "missing_field",
        `expected missing_field for ${JSON.stringify(over)}`,
      );
    }
    assert.equal(state(s), "awaiting_gate");
    assert.equal(transitions(s).length, before);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("an approval for a task not in awaiting_gate is a typed wrong_state error", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    approveGate(s.db, payload(s, run!), "human"); // → validating
    const before = transitions(s).length;
    assert.throws(
      () => approveGate(s.db, payload(s, run!), "human"),
      (err: unknown) => err instanceof GateError && err.code === "wrong_state",
    );
    assert.equal(state(s), "validating");
    assert.equal(transitions(s).length, before);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("a stale run_id (an older attempt) is refused — approvals cannot replay old runs", () => {
  const s = seed();
  try {
    const [first, live] = toGate(s, 2);
    assert.throws(
      () => approveGate(s.db, payload(s, first!), "human"),
      (err: unknown) => err instanceof GateError && err.code === "stale_run",
    );
    assert.equal(state(s), "awaiting_gate");
    // the LIVE run (highest attempt_number) is accepted
    approveGate(s.db, payload(s, live!), "human");
    assert.equal(state(s), "validating");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("an unknown run_id is a stale_run refusal", () => {
  const s = seed();
  try {
    toGate(s, 1);
    assert.throws(
      () => approveGate(s.db, payload(s, ulid()), "human"),
      (err: unknown) => err instanceof GateError && err.code === "stale_run",
    );
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("an unknown task is a typed not_found error", () => {
  const s = seed();
  try {
    assert.throws(
      () => approveGate(s.db, { task_id: ulid(), run_id: ulid(), approved_by: "m", note: "n" }, "human"),
      (err: unknown) => err instanceof GateError && err.code === "not_found",
    );
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------ reject ------------------------------------- */

test("reject: awaiting_gate→changes_requested, retry_count increments (timing rule), feedback recorded", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1, { maxRetries: 3, retryCount: 0 });
    rejectGate(s.db, payload(s, run!), "SQL injection on line 42");
    assert.equal(state(s), "changes_requested");
    assert.equal(retryCount(s), 1);
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["to_state"], "changes_requested");
    assert.match(String(last["reason"]), /SQL injection on line 42/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("reject that exhausts the budget escalates to awaiting_gate + halt notify", async () => {
  const s = seed();
  const sent: Array<Record<string, unknown>> = [];
  try {
    const [run] = toGate(s, 1, { maxRetries: 3, retryCount: 2 });
    const out = rejectGate(s.db, payload(s, run!), "still broken", "human", {
      notify: async (alert) => {
        sent.push(alert as Record<string, unknown>);
        return { ok: true, topic: "test" };
      },
    });
    assert.equal(out.finalState, "awaiting_gate");
    assert.equal(retryCount(s), 3);
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["to_state"], "awaiting_gate");
    assert.equal(sent.length, 1);
    await Promise.all(out.notifications);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("reject requires feedback — a missing feedback string is a typed error", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    assert.throws(
      () => rejectGate(s.db, payload(s, run!), ""),
      (err: unknown) => err instanceof GateError && err.code === "missing_field",
    );
    assert.equal(state(s), "awaiting_gate");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* -------------------------------- confirm failure -------------------------------- */

test("confirmFailure: awaiting_gate→failed (terminal gate outcome), retry budget treated as exhausted", async () => {
  const s = seed();
  const sent: Array<Record<string, unknown>> = [];
  try {
    const [run] = toGate(s, 1, { maxRetries: 3, retryCount: 0 });
    const out = confirmFailureGate(s.db, payload(s, run!), "human", {
      notify: async (alert) => {
        sent.push(alert as Record<string, unknown>);
        return { ok: true, topic: "test" };
      },
    });
    assert.equal(out.finalState, "failed");
    assert.equal(state(s), "failed");
    // the matrix gate: "retry budget treated as exhausted" — the counter is
    // floored at max so no retry row's `retry_count < max_retries` gate
    // can ever pass again
    assert.equal(retryCount(s), 3);
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "awaiting_gate");
    assert.equal(last["to_state"], "failed");
    assert.match(String(last["reason"]), /LGTM — ship it|terminal/);
    assert.equal(sent.length, 1, "failed runs are halt triggers");
    await Promise.all(out.notifications);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("confirmFailure on a task not in awaiting_gate → wrong_state, untouched", () => {
  const s = seed();
  try {
    const [run] = toGate(s, 1);
    approveGate(s.db, payload(s, run!), "human");
    const before = transitions(s).length;
    assert.throws(
      () => confirmFailureGate(s.db, payload(s, run!), "human"),
      (err: unknown) => err instanceof GateError && err.code === "wrong_state",
    );
    assert.equal(state(s), "validating");
    assert.equal(transitions(s).length, before);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});
