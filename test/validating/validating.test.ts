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
import { START_TRIGGER, VALIDATING_TRIGGER } from "../../src/runs/triggers.ts";
import {
  completeValidation,
  requeueFromChangesRequested,
  RetryBudgetExhaustedError,
  type HaltNotifier,
} from "../../src/validating.ts";

/**
 * architecture 8.1, validating phase: the completed / changes_requested /
 * failed rows, the retry-count timing rule (increments EXACTLY on
 * entering changes_requested), the escalation rows, and the self-path
 * requeue the p3 scheduler will call.
 */

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  maxRetries: number;
};

function seed(opts: { maxRetries?: number; retryCount?: number } = {}): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-val-"));
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
  const maxRetries = opts.maxRetries ?? 3;
  db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, objective, profile_id, max_retries, retry_count)
     VALUES (?, ?, 'T-1', 't', 'o', ?, ?, ?)`,
  ).run(taskId, projectId, profileId, maxRetries, opts.retryCount ?? 0);

  // draft → queued → running → validating (the p2b run loop's own rows)
  applyTransition(db, taskId, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(db, taskId, START_TRIGGER, { triggerType: "engine", actor: "test" });
  applyTransition(db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "test" });
  return { db, wsRoot, taskId, maxRetries };
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

/** A recording halt notifier — every dispatched alert lands in `sent`. */
function recorder(sent: Array<Record<string, unknown>>): HaltNotifier {
  return async (alert) => {
    sent.push(alert as Record<string, unknown>);
    return { ok: true, topic: "test" };
  };
}

/* --------------------------------- the completed row ------------------------------ */

test("verdict passed → validating→completed, retry_count untouched, no notify", async () => {
  const s = seed();
  const sent: Array<Record<string, unknown>> = [];
  try {
    const out = completeValidation(s.db, s.taskId, { passed: true }, "engine-worker", {
      notify: recorder(sent),
    });
    assert.equal(out.finalState, "completed");
    assert.equal(state(s), "completed");
    assert.equal(out.retryCount, 0);
    assert.equal(retryCount(s), 0);
    assert.deepEqual(sent, [], "no halt alert on success");
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "validating");
    assert.equal(last["to_state"], "completed");
    assert.equal(last["trigger_type"], "engine");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ----------------------------- the changes_requested row -------------------------- */

test("verdict failed with budget remaining → validating→changes_requested, retry_count incremented EXACTLY on entry", async () => {
  const s = seed({ maxRetries: 3, retryCount: 0 });
  const sent: Array<Record<string, unknown>> = [];
  try {
    const out = completeValidation(s.db, s.taskId, { passed: false }, "engine-worker", {
      notify: recorder(sent),
    });
    assert.equal(out.finalState, "changes_requested");
    assert.equal(state(s), "changes_requested");
    assert.equal(out.retryCount, 1, "incremented on entering changes_requested");
    assert.equal(retryCount(s), 1);
    assert.deepEqual(sent, [], "budget remains — no escalation, no notify");
    // exactly ONE new transition row (validating → changes_requested)
    const tr = transitions(s);
    assert.equal(tr.length, 4); // enqueue, start, validating + the verdict move
    assert.equal(tr[3]?.["from_state"], "validating");
    assert.equal(tr[3]?.["to_state"], "changes_requested");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("requeue does NOT increment again — the timing rule is enter-only", async () => {
  const s = seed({ maxRetries: 3, retryCount: 0 });
  try {
    completeValidation(s.db, s.taskId, { passed: false }, "engine-worker");
    assert.equal(retryCount(s), 1);
    requeueFromChangesRequested(s.db, s.taskId, "scheduler", {
      feedbackPath: "/runs/x/review.json",
    });
    assert.equal(state(s), "queued");
    assert.equal(retryCount(s), 1, "no second increment on requeue");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ------------------------------- the escalation row ------------------------------- */

test("failure that exhausts the budget on entry → changes_requested→awaiting_gate escalation + halt notify", async () => {
  // retry_count 2, max 3: entering changes_requested makes it 3 → escalate
  const s = seed({ maxRetries: 3, retryCount: 2 });
  const sent: Array<Record<string, unknown>> = [];
  try {
    const out = completeValidation(s.db, s.taskId, { passed: false }, "engine-worker", {
      notify: recorder(sent),
    });
    assert.equal(out.finalState, "awaiting_gate");
    assert.equal(state(s), "awaiting_gate");
    assert.equal(out.retryCount, 3);
    const tr = transitions(s);
    assert.equal(tr[3]?.["to_state"], "changes_requested");
    assert.equal(tr[4]?.["from_state"], "changes_requested");
    assert.equal(tr[4]?.["to_state"], "awaiting_gate");
    // the escalation is a halt trigger (RSK-07 / architecture ~137)
    assert.equal(sent.length, 1);
    assert.equal(await Promise.all(out.notifications).then((r) => r[0]?.ok), true);
    assert.match(String(sent[0]?.["message"]), /awaiting_gate|human/i);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* --------------------------------- the failed row -------------------------------- */

test("verdict failed with the budget already spent → validating→failed + halt notify", async () => {
  const s = seed({ maxRetries: 3, retryCount: 3 });
  const sent: Array<Record<string, unknown>> = [];
  try {
    const out = completeValidation(s.db, s.taskId, { passed: false }, "engine-worker", {
      notify: recorder(sent),
    });
    assert.equal(out.finalState, "failed");
    assert.equal(state(s), "failed");
    assert.equal(out.retryCount, 3, "no increment — changes_requested was never entered");
    assert.equal(retryCount(s), 3);
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["to_state"], "failed");
    assert.equal(tr[tr.length - 1]?.["from_state"], "validating");
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]?.["message"]), /failed/i);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("a task with no configured ntfy topic dispatches no notification (best-effort alerts)", async () => {
  const s = seed({ maxRetries: 0 });
  try {
    // max_retries 0 → any failure is budget-exhausted → validating→failed
    const out = completeValidation(s.db, s.taskId, { passed: false }, "engine-worker");
    assert.equal(out.finalState, "failed");
    assert.equal(out.notifications.length, 0, "no topic → no notify attempt");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* --------------------------------- state guards ---------------------------------- */

test("completeValidation refuses a non-validating task (matrix guard), task and log untouched", () => {
  const s = seed();
  // move the task on to completed first
  completeValidation(s.db, s.taskId, { passed: true }, "engine-worker");
  const before = transitions(s).length;
  assert.throws(
    () => completeValidation(s.db, s.taskId, { passed: true }, "engine-worker"),
    /illegal transition/,
  );
  assert.equal(state(s), "completed");
  assert.equal(transitions(s).length, before);
  s.db.close();
  rmSync(s.wsRoot, { recursive: true, force: true });
});

test("completeValidation on a nonexistent task throws", () => {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  try {
    assert.throws(() => completeValidation(db, ulid(), { passed: true }, "x"), /no such task/);
  } finally {
    db.close();
  }
});

/* -------------------------------- the requeue function --------------------------- */

test("requeueFromChangesRequested: changes_requested→queued, feedback path recorded in the reason", () => {
  const s = seed({ maxRetries: 3, retryCount: 0 });
  try {
    completeValidation(s.db, s.taskId, { passed: false }, "engine-worker");
    requeueFromChangesRequested(s.db, s.taskId, "scheduler", {
      feedbackPath: "/ws/.novaflow/runs/t/r-1/result.json",
    });
    assert.equal(state(s), "queued");
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "changes_requested");
    assert.equal(last["to_state"], "queued");
    assert.match(String(last["reason"]), /result\.json/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("requeue refuses a spent budget with a typed error (the row's validation gate)", () => {
  const s = seed({ maxRetries: 3, retryCount: 2 });
  try {
    // entering changes_requested pushes retry_count to max → the escalation
    // fires; the task is in awaiting_gate, but even forced back the
    // requeue gate must refuse a spent budget.
    completeValidation(s.db, s.taskId, { passed: false }, "engine-worker");
    assert.equal(state(s), "awaiting_gate");
    assert.throws(
      () => requeueFromChangesRequested(s.db, s.taskId, "scheduler"),
      RetryBudgetExhaustedError,
    );
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("requeue refuses a task not in changes_requested (matrix guard)", () => {
  const s = seed();
  try {
    assert.throws(
      () => requeueFromChangesRequested(s.db, s.taskId, "scheduler"),
      /illegal transition/,
    );
    assert.equal(state(s), "validating");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ------------------------------ notify default wiring --------------------------- */

test("a workspace config with alerts.ntfy_topic wires the default halt notifier", async () => {
  const s = seed({ maxRetries: 0 });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(s.wsRoot, ".novaflow"), { recursive: true });
  writeFileSync(join(s.wsRoot, ".novaflow", "config.yaml"), "alerts:\n  ntfy_topic: ops-halts\n");
  const posts: Array<{ url: string; body: string }> = [];
  try {
    const out = completeValidation(s.db, s.taskId, { passed: false }, "engine-worker", {
      // the default notifier is config-wired; only the transport is injected
      notifyOptions: {
        post: async (url, body) => {
          posts.push({ url, body });
        },
      },
    });
    assert.equal(out.finalState, "failed");
    assert.equal(out.notifications.length, 1);
    const results = await Promise.all(out.notifications);
    assert.equal(results[0]?.ok, true);
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.url ?? "", /ops-halts$/);
    assert.match(posts[0]?.body ?? "", /failed/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});
