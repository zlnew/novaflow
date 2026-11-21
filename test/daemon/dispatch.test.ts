import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl, extractMatrix } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { createDispatcher } from "../../src/daemon/dispatch.ts";
import { START_TRIGGER } from "../../src/runs/triggers.ts";
import type { TaskRunRecord } from "../../src/runs/loop.ts";

/**
 * FR-SCH-02: global + per-workspace concurrency semaphores, FIFO order,
 * surplus held in QUEUED; pause freezes new spawns (running continue);
 * the loop never wedges on a failing startRun; operator abort is the
 * group kill (SIGTERM → grace → SIGKILL) + the running→cancelled row,
 * applied by the run loop — never by the op.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const MODEL = "claude-3-5-sonnet-20241022";

type Ws = { id: string; root: string; projectId: string; profileId: string };
type Seed = { db: Database.Database; workspaces: Ws[]; dir: string };

function seed(workspaceCount = 1): Seed {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-disp-"));
  const db = new Database(":memory:");
  db.exec(extractDdl());
  const workspaces: Ws[] = [];
  for (let i = 0; i < workspaceCount; i++) {
    const root = join(dir, `ws${i}`);
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "dev_system.md"), "You are a worker agent.\n");
    db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, 'ws', ?)").run(
      ulid(),
      `ws${i}`,
      root,
    );
    const wsId = (
      db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(`ws${i}`) as { id: string }
    ).id;
    db.prepare(
      "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, ?, 'prj', 'o')",
    ).run(ulid(), wsId, `prj${i}`);
    const projectId = (
      db.prepare("SELECT id FROM projects WHERE workspace_id = ?").get(wsId) as { id: string }
    ).id;
    db.prepare(
      `INSERT INTO agent_profiles
         (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
          max_timeout_sec, max_cost_usd)
       VALUES (?, ?, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 5)`,
    ).run(ulid(), wsId, MODEL);
    const profileId = (
      db.prepare("SELECT id FROM agent_profiles WHERE workspace_id = ?").get(wsId) as { id: string }
    ).id;
    workspaces.push({ id: wsId, root, projectId, profileId });
  }
  return { db, workspaces, dir };
}

/** An enqueued task that runs the stub in run-hang mode (stays live). */
function hangTask(s: Seed, wsIdx = 0, key = "TASK-101"): string {
  const ws = s.workspaces[wsIdx]!;
  const task = createTask(s.db, {
    projectId: ws.projectId,
    key,
    title: key,
    objective: "Do the thing that hangs.",
    profileId: ws.profileId,
  });
  s.db.prepare("UPDATE tasks SET overrides_json = ? WHERE id = ?").run(
    JSON.stringify({ timeout_sec: 3600 }),
    task.id,
  );
  applyTransition(s.db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  return task.id;
}

function runOpts(s: Seed, mode = "run-hang", graceMs = 300) {
  return {
    piBin: "node",
    args: [STUB, mode, join(s.dir, `${mode}.pid`)],
    pricesPath: join(s.dir, "no-prices.json"),
    extensionPath: "/ext/novaflow.ts",
    killGraceMs: graceMs,
  };
}

function state(s: Seed, taskId: string): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
}

function lastRun(s: Seed, taskId: string): TaskRunRecord {
  return s.db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as TaskRunRecord;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function assertReaped(pid: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await wait(50);
  }
  assert.fail(`stub process ${pid} is still alive`);
}

function cleanup(s: Seed): void {
  s.db.close();
  rmSync(s.dir, { recursive: true, force: true });
}

/* ------------------------------ global semaphore + FIFO ----------------------------- */

test("FR-SCH-02: global 1 — first task runs, surplus stays QUEUED (FIFO); freed slot dispatches the next", async () => {
  const s = seed();
  const first = hangTask(s, 0, "A");
  const second = hangTask(s, 0, "B");
  const conclusions: Array<[string, unknown]> = [];
  const d = createDispatcher(s.db, {
    globalConcurrency: 1,
    runOptions: runOpts(s),
    tickMs: 40,
    onRunConcluded: (taskId, outcome) => conclusions.push([taskId, outcome]),
  });
  try {
    await wait(150);
    assert.equal(state(s, first), "running");
    assert.equal(state(s, second), "queued"); // AC2: surplus held in QUEUED
    assert.equal(d.status().running, 1);
    assert.equal(d.status().queued, 1);

    // freeing the slot (operator abort) dispatches the FIFO successor
    const res = await d.abortTask(first, { triggerType: "human", actor: "op" });
    assert.ok(res.aborted);
    assert.equal(state(s, first), "cancelled");
    await wait(150);
    assert.equal(state(s, second), "running");
    assert.equal(conclusions.length, 1);
    assert.equal(conclusions[0]![0], first);
    await assertReaped(lastRun(s, first).pid!);
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* ------------------------------ per-workspace semaphore ----------------------------- */

test("FR-SCH-02: per-workspace limit — workspace config 1 caps ws A, default 2 caps ws B", async () => {
  const s = seed(2);
  // ws A pins concurrency.workspace: 1; ws B has no config (default 2)
  mkdirSync(join(s.workspaces[0]!.root, ".novaflow"), { recursive: true });
  writeFileSync(
    join(s.workspaces[0]!.root, ".novaflow", "config.yaml"),
    "concurrency:\n  workspace: 1\n",
  );
  const a1 = hangTask(s, 0, "A1");
  const a2 = hangTask(s, 0, "A2");
  const b1 = hangTask(s, 1, "B1");
  const b2 = hangTask(s, 1, "B2");
  const d = createDispatcher(s.db, { globalConcurrency: 4, runOptions: runOpts(s), tickMs: 40 });
  try {
    await wait(200);
    assert.equal(state(s, a1), "running");
    assert.equal(state(s, b1), "running");
    assert.equal(state(s, b2), "running");
    // ws A is full at its configured 1 — the surplus task stays QUEUED
    assert.equal(state(s, a2), "queued");
    assert.equal(d.status().running, 3);
    assert.equal(d.status().paused, false);
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* ------------------------------------ pause / resume -------------------------------- */

test("paused scheduler: no NEW spawns; running runs continue; resume dispatches again", async () => {
  const s = seed();
  const first = hangTask(s, 0, "A");
  const d = createDispatcher(s.db, { globalConcurrency: 4, runOptions: runOpts(s), tickMs: 40 });
  try {
    await wait(150);
    assert.equal(state(s, first), "running");
    d.pause();
    assert.equal(d.status().paused, true);

    const second = hangTask(s, 0, "B");
    await wait(200);
    assert.equal(state(s, second), "queued"); // frozen: no new spawn
    assert.equal(state(s, first), "running"); // the live run continues

    d.resume();
    await wait(200);
    assert.equal(state(s, second), "running");
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* --------------------------------- never-wedge discipline --------------------------- */

test("a failing startRun never wedges the loop: the failure is logged, the task stays queued, the next candidate runs", async () => {
  const s = seed();
  // a dedicated profile for the poison task so deleting it breaks only
  // that task's start (the profile FK blocks a bogus profile_id outright)
  const ws = s.workspaces[0]!;
  s.db
    .prepare(
      `INSERT INTO agent_profiles
         (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
          max_timeout_sec, max_cost_usd)
       VALUES (?, ?, 'poisoned', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 5)`,
    )
    .run(ulid(), ws.id, MODEL);
  const poisonProfile = (
    s.db.prepare("SELECT id FROM agent_profiles WHERE name = 'poisoned'").get() as { id: string }
  ).id;
  const poisonTask = createTask(s.db, {
    projectId: ws.projectId,
    key: "POISON",
    title: "POISON",
    objective: "Never starts.",
    profileId: poisonProfile,
  });
  s.db.prepare("UPDATE tasks SET overrides_json = ? WHERE id = ?").run(
    JSON.stringify({ timeout_sec: 3600 }),
    poisonTask.id,
  );
  applyTransition(s.db, poisonTask.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  s.db.pragma("foreign_keys = OFF");
  s.db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(poisonProfile);
  s.db.pragma("foreign_keys = ON");
  const poison = poisonTask.id;
  const healthy = hangTask(s, 0, "OK");
  const failures: string[] = [];
  const d = createDispatcher(s.db, {
    globalConcurrency: 4,
    runOptions: runOpts(s),
    tickMs: 40,
    onRunConcluded: (taskId, outcome) => {
      if ("error" in outcome) failures.push(taskId);
    },
  });
  try {
    await wait(250);
    // the healthy candidate ran to the stub; the poison task was skipped
    assert.equal(state(s, healthy), "running");
    assert.equal(state(s, poison), "queued"); // left for operator abort / retry paths
    assert.ok(failures.includes(poison));
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* ----------------------- start-failure cooldown (never a hot loop) -------------------- */

test("regression: a poison task's start failures are cooldown-bounded, never a hot loop; other candidates unaffected", async () => {
  const s = seed();
  // a dedicated profile for the poison task so deleting it breaks only
  // that task's start (the profile FK blocks a bogus profile_id outright)
  const ws = s.workspaces[0]!;
  s.db
    .prepare(
      `INSERT INTO agent_profiles
         (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
          max_timeout_sec, max_cost_usd)
       VALUES (?, ?, 'poisoned', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 5)`,
    )
    .run(ulid(), ws.id, MODEL);
  const poisonProfile = (
    s.db.prepare("SELECT id FROM agent_profiles WHERE name = 'poisoned'").get() as { id: string }
  ).id;
  const poisonTask = createTask(s.db, {
    projectId: ws.projectId,
    key: "POISON-LOOP",
    title: "POISON-LOOP",
    objective: "Never starts, ever.",
    profileId: poisonProfile,
  });
  applyTransition(s.db, poisonTask.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  s.db.pragma("foreign_keys = OFF");
  s.db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(poisonProfile);
  s.db.pragma("foreign_keys = ON");
  const poison = poisonTask.id;
  const healthy = hangTask(s, 0, "OK");

  let poisonAttempts = 0;
  const d = createDispatcher(s.db, {
    globalConcurrency: 4,
    runOptions: runOpts(s),
    tickMs: 1000, // the PRODUCTION tick
    startFailureCooldownMs: 1200, // injected short window (default 5 s)
    onRunConcluded: (taskId, outcome) => {
      if ("error" in outcome && taskId === poison) poisonAttempts++;
    },
  });
  try {
    await wait(3500);
    // cooldown-bounded re-eligibility: ~1 attempt per (cooldown + tick)
    // window — NOT the pre-fix hot loop (~10,500 attempts/s). Bound has
    // slack for tick/cooldown interleave flake; floor pins non-starvation.
    assert.ok(
      poisonAttempts >= 1 && poisonAttempts <= 4,
      `poison attempts in 3.5 s window: ${poisonAttempts}`,
    );
    // the poison task neither wedges the pass nor starves other candidates
    assert.equal(state(s, healthy), "running");
    assert.equal(state(s, poison), "queued"); // left for operator abort / retry paths
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* ------------------------------- operator abort (live run) -------------------------- */

test("abortTask: SIGTERM group kill + the running→cancelled row (loop-owned), run row cancelled, reaped", async () => {
  const s = seed();
  const taskId = hangTask(s, 0, "A");
  const d = createDispatcher(s.db, { globalConcurrency: 4, runOptions: runOpts(s), tickMs: 40 });
  try {
    await wait(150);
    assert.equal(state(s, taskId), "running");
    const pid = lastRun(s, taskId).pid!;
    const res = await d.abortTask(taskId, { triggerType: "human", actor: "operator-x" });
    assert.ok(res.aborted);

    // task + run record
    assert.equal(state(s, taskId), "cancelled");
    const row = lastRun(s, taskId);
    assert.equal(row.status, "cancelled");
    assert.match(row.error_summary ?? "", /operator abort/);
    assert.equal(row.exit_code, 0); // the stub exits 0 on SIGTERM

    // the audit row: the VERBATIM running→cancelled trigger, human, actor-pinned
    const tr = s.db
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(taskId) as Record<string, unknown>;
    assert.equal(tr["from_state"], "running");
    assert.equal(tr["to_state"], "cancelled");
    assert.equal(tr["trigger_type"], "human");
    assert.equal(tr["actor"], "operator-x");
    assert.equal(tr["run_id"], row.id);

    // the group was reaped and the steer sink is closed
    await assertReaped(pid);
    const steer = d.steerFrame(taskId, "{}");
    assert.ok(!steer.ok);
  } finally {
    await d.stop();
    cleanup(s);
  }
});

test("abortTask escalates to SIGKILL when the child ignores SIGTERM (grace window honored)", async () => {
  const s = seed();
  const taskId = hangTask(s, 0, "A");
  const pidfile = join(s.dir, "run-hang-ignore-term.pid");
  const d = createDispatcher(s.db, {
    globalConcurrency: 4,
    runOptions: runOpts(s, "run-hang-ignore-term", 150),
    tickMs: 40,
  });
  try {
    await wait(150);
    assert.equal(state(s, taskId), "running");
    const pid = lastRun(s, taskId).pid!;
    const res = await d.abortTask(taskId, { triggerType: "mcp", actor: "orchestrator" });
    assert.ok(res.aborted);
    assert.equal(state(s, taskId), "cancelled");
    // the child took and IGNORED the SIGTERM — only the backstop ended it
    assert.match(readFileSync(pidfile, "utf8"), /SIGTERM-IGNORED/);
    const row = lastRun(s, taskId);
    assert.equal(row.status, "cancelled");
    assert.equal(row.exit_code, null); // SIGKILL: no exit code
    await assertReaped(pid);
  } finally {
    await d.stop();
    cleanup(s);
  }
});

/* ------------------------------------- steer sink ----------------------------------- */

test("steerFrame: forwards a frame while the child is live; refuses with a reason otherwise", async () => {
  const s = seed();
  const taskId = hangTask(s, 0, "A");
  const d = createDispatcher(s.db, { globalConcurrency: 4, runOptions: runOpts(s), tickMs: 40 });
  try {
    // no live run yet → refused
    const early = d.steerFrame(taskId, JSON.stringify({ id: "s1", type: "steer", message: "hi" }));
    assert.ok(!early.ok);
    await wait(150);
    // live: the write goes through the child's stdin
    const frame = JSON.stringify({ id: "s2", type: "steer", message: "Use SHA-256." });
    const liveRes = d.steerFrame(taskId, frame);
    assert.ok(liveRes.ok, liveRes.reason);
    // a task with no live run → refused with a reason
    const none = d.steerFrame(ulid(), frame);
    assert.ok(!none.ok);
    await d.stop();
    // after stop, the sink is gone
    const after = d.steerFrame(taskId, frame);
    assert.ok(!after.ok);
  } finally {
    cleanup(s);
  }
});

/* --------------------------------------- stop() ------------------------------------- */

test("stop() reaps every live run (operator-abort semantics) and leaves no strays", async () => {
  const s = seed();
  const t1 = hangTask(s, 0, "A");
  const t2 = hangTask(s, 0, "B");
  const d = createDispatcher(s.db, { globalConcurrency: 4, runOptions: runOpts(s), tickMs: 40 });
  await wait(150);
  const pids = [lastRun(s, t1).pid!, lastRun(s, t2).pid!];
  await d.stop();
  assert.equal(state(s, t1), "cancelled");
  assert.equal(state(s, t2), "cancelled");
  assert.equal(d.status().running, 0);
  for (const pid of pids) await assertReaped(pid);
  cleanup(s);
});

/* ------------------- PRESERVE: dispatch grants go through startRun's own row -------------------- */

test("PRESERVE: the dispatch slot still lands on the verbatim queued→running scheduler row (one source — startRun)", async () => {
  const s = seed();
  const taskId = hangTask(s, 0, "A");
  const d = createDispatcher(s.db, { globalConcurrency: 1, runOptions: runOpts(s), tickMs: 40 });
  try {
    await wait(150);
    const tr = s.db
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(taskId) as Record<string, unknown>;
    assert.equal(tr["from_state"], "queued");
    assert.equal(tr["to_state"], "running");
    // the trigger dispatch relies on is START_TRIGGER — the SAME constant
    // startRun applies (one source), pinned against the live matrix row
    const schedulerRow = extractMatrix().find(
      (r) => r.state === "queued" && r.target === "running",
    )!;
    assert.equal(START_TRIGGER, schedulerRow.trigger);
    // and startRun (not dispatch) applied it: the actor is the dispatcher's
    assert.equal(tr["actor"], "daemon-dispatch");
  } finally {
    await d.stop();
    cleanup(s);
  }
});
