import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER, GATE_TRIGGER, RUN_FAILED_TRIGGER, VALIDATING_TRIGGER } from "../../src/runs/triggers.ts";
import { VERIFY_PASSED_TRIGGER, GATE_FAIL_TRIGGER } from "../../src/fsm/triggers.ts";
import { abortTriggerFor } from "../../src/daemon/triggers.ts";
import { InvalidTransitionError } from "../../src/fsm/engine.ts";
import { importChain, getChainRun, type ChainRunRow } from "../../src/chain/import.ts";
import { createChainEvaluator, CHAIN_ENGINE_ACTOR } from "../../src/chain/readiness.ts";
import { enqueueTask } from "../../src/tasks.ts";

/**
 * The readiness evaluator (FR-TSK-07 downstream auto-enqueue; the
 * 8.1 chain run ownership terminal rules): a member is READY when
 * every depends_on source is completed and the member is draft.
 * Ready members enqueue through the ONE guarded draft→queued row
 * (enqueueTask) with trigger_type "engine", actor "chain-engine".
 * Terminal rules on every member terminal outcome: all completed →
 * chain completed; any member CONFIRMED failed (the awaiting_gate→failed
 * terminal gate outcome — the retry evaluator's discriminator, one
 * source) → chain failed; a member cancelled by single-task abort is
 * the non-rule. A paused chain withholds propagation.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

function seed(): {
  db: Database.Database;
  workspaceId: string;
  projectId: string;
  profileId: string;
} {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/ws')").run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'm1', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.db ? db : db).prepare("SELECT id FROM agent_profiles").get() as { id: string };
  return { db, workspaceId, projectId, profileId: profileId.id };
}

type Seed = ReturnType<typeof seed>;

const PROBE = { piBin: "node", args: [STUB, "ok"], timeoutMs: 5000 };

/** Import a linear chain A -> B (depends_on) into the seeded project. */
function importLinearChain(s: Seed): { chainId: string; a: string; b: string } {
  const { chainRun, tasks } = importChain(s.db, { id: s.workspaceId }, { id: s.projectId, slug: "prj" }, {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [
      { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev" },
      { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev" },
    ],
    edges: [{ source_key: "A", target_key: "B", edge_type: "depends_on" }],
  });
  return { chainId: chainRun.id, a: tasks["A"]!.id, b: tasks["B"]!.id };
}

/** Drive a task to completed via the legal matrix rows (seed actor). */
function complete(s: Seed, taskId: string): void {
  applyTransition(s.db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(s.db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
}

function state(s: Seed, taskId: string): string {
  return (s.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
}

function chainState(s: Seed, chainId: string): ChainRunRow | undefined {
  return getChainRun(s.db, chainId);
}

function lastTransition(s: Seed, taskId: string): Record<string, unknown> {
  const rows = s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at DESC, id DESC")
    .all(taskId) as Array<Record<string, unknown>>;
  return rows[0]!;
}

test("a completed member's downstream enqueues via the guarded row (engine / chain-engine)", async () => {
  const s = seed();
  try {
    const { chainId, a, b } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });

    // not ready yet: A is draft
    await evaluator.evaluateForTask(a);
    assert.equal(state(s, b), "draft");

    // A completes → B is ready → draft→queued via enqueueTask
    complete(s, a);
    const outcome = await evaluator.evaluateForTask(a);
    assert.deepEqual(outcome?.enqueued, [b]);
    assert.equal(state(s, b), "queued");
    const log = lastTransition(s, b);
    assert.equal(log["from_state"], "draft");
    assert.equal(log["to_state"], "queued");
    assert.equal(log["trigger_type"], "engine");
    assert.equal(log["actor"], CHAIN_ENGINE_ACTOR);
    // the chain itself stays active (B is not terminal yet)
    assert.equal(chainState(s, chainId)?.state, "active");
  } finally {
    s.db.close();
  }
});

test("idempotency: a member evaluated twice enqueues exactly once; the matrix guard refuses the second enqueue", async () => {
  const s = seed();
  try {
    const { a, b } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, a);
    await evaluator.evaluateForTask(a);
    await evaluator.evaluateForTask(a); // second evaluation: B is queued already
    await evaluator.evaluateForTask(a); // and a third, same pass
    const logs = s.db
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? AND to_state = 'queued'")
      .all(b) as Array<Record<string, unknown>>;
    assert.equal(logs.length, 1, "exactly one draft→queued row, however often the chain is evaluated");
    // the guard itself: enqueueTask on a non-draft member refuses
    await assert.rejects(enqueueTask(s.db, b, "chain-engine", { ...PROBE, triggerType: "engine" }), InvalidTransitionError);
  } finally {
    s.db.close();
  }
});

test("fan-in: a member waits for EVERY depends_on source to complete", async () => {
  const s = seed();
  try {
    const { chainRun, tasks } = importChain(s.db, { id: s.workspaceId }, { id: s.projectId, slug: "prj" }, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev" },
        { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev" },
        { key: "C", title: "Task C", objective: "The objective of task C.", profile_name: "dev" },
      ],
      edges: [
        { source_key: "A", target_key: "C", edge_type: "depends_on" },
        { source_key: "B", target_key: "C", edge_type: "depends_on" },
      ],
    });
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, tasks["A"]!.id);
    await evaluator.evaluateForTask(tasks["A"]!.id);
    assert.equal(state(s, tasks["C"]!.id), "draft"); // B is still draft
    // B is a ROOT (no depends_on in-edges): the engine never auto-enqueues
    // roots — the operator/orchestrator starts them via nova_task_run
    assert.equal(state(s, tasks["B"]!.id), "draft");
    complete(s, tasks["B"]!.id);
    await evaluator.evaluateForTask(tasks["B"]!.id);
    assert.equal(state(s, tasks["C"]!.id), "queued"); // now every source completed
    void chainRun;
  } finally {
    s.db.close();
  }
});

test("a paused chain withholds propagation; ready members stay draft until resume", async () => {
  const s = seed();
  try {
    const { chainId, a, b } = importLinearChain(s);
    const paused = new Set<string>([chainId]);
    const evaluator = createChainEvaluator(s.db, {
      enqueueOptions: PROBE,
      isPaused: (id) => paused.has(id),
    });
    complete(s, a);
    const outcome = await evaluator.evaluateForTask(a);
    assert.deepEqual(outcome?.enqueued, []);
    assert.equal(outcome?.withheld, true);
    assert.equal(state(s, b), "draft");
    // resume clears the flag → the same evaluation propagates
    paused.delete(chainId);
    await evaluator.evaluateForTask(a);
    assert.equal(state(s, b), "queued");
  } finally {
    s.db.close();
  }
});

test("terminal rule: all members completed → chain completed; a terminal chain never moves again", async () => {
  const s = seed();
  try {
    const { chainId, a, b } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, a);
    await evaluator.evaluateForTask(a); // B → queued
    // B runs to completion without the evaluator (operator surface)
    applyTransition(s.db, b, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, b, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, b, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    const outcome = await evaluator.evaluateForTask(b);
    assert.equal(outcome?.terminal, "completed");
    const chain = chainState(s, chainId);
    assert.equal(chain?.state, "completed");
    assert.ok(chain?.completed_at !== null, "completed_at is stamped at the terminal move");

    // guarded: re-evaluation never moves a terminal chain
    const again = await evaluator.evaluateForTask(b);
    assert.equal(again?.terminal, null);
    assert.equal(chainState(s, chainId)?.state, "completed");
  } finally {
    s.db.close();
  }
});

test("terminal rule: a CONFIRMED failed member (awaiting_gate→failed) fails the chain", async () => {
  const s = seed();
  try {
    const { chainId, a } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    // A enters awaiting_gate and the operator confirms failure (the terminal gate outcome)
    applyTransition(s.db, a, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(s.db, a, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, a, GATE_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, a, GATE_FAIL_TRIGGER, { triggerType: "human", actor: "operator" });
    const outcome = await evaluator.evaluateForTask(a);
    assert.equal(outcome?.terminal, "failed");
    assert.equal(chainState(s, chainId)?.state, "failed");
  } finally {
    s.db.close();
  }
});

test("the non-rule: a failed member that is NOT confirmed (running→failed) does not fail the chain", async () => {
  const s = seed();
  try {
    const { chainId, a } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    applyTransition(s.db, a, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(s.db, a, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, a, RUN_FAILED_TRIGGER, { triggerType: "engine", actor: "seed" });
    const outcome = await evaluator.evaluateForTask(a);
    assert.equal(outcome?.terminal, null);
    assert.equal(chainState(s, chainId)?.state, "active");
  } finally {
    s.db.close();
  }
});

test("the non-rule: a member cancelled by single-task abort does not change the chain state", async () => {
  const s = seed();
  try {
    const { chainId, a, b } = importLinearChain(s);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    complete(s, a);
    await evaluator.evaluateForTask(a); // B → queued
    // the operator aborts B alone (the queued operator-abort row)
    applyTransition(s.db, b, abortTriggerFor("queued")!, { triggerType: "human", actor: "operator" });
    const outcome = await evaluator.evaluateForTask(b);
    assert.equal(outcome?.terminal, null);
    assert.equal(chainState(s, chainId)?.state, "active");
  } finally {
    s.db.close();
  }
});

test("a non-chain task is a no-op for the evaluator", async () => {
  const s = seed();
  try {
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    const outcome = await evaluator.evaluateForTask(ulid()); // no such task at all
    assert.equal(outcome, null);
  } finally {
    s.db.close();
  }
});

test("boot sweep: a restart-shaped store (ready members implied by member states) evaluates once at boot", async () => {
  const s = seed();
  try {
    // chain 1: A completed while the daemon was down — B is ready at boot
    const one = importLinearChain(s);
    complete(s, one.a);
    // chain 2: all members completed pre-boot — the chain should complete at boot
    const two = importChain(s.db, { id: s.workspaceId }, { id: s.projectId, slug: "prj" }, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [{ key: "SOLO", title: "Solo task", objective: "The objective of the solo task.", profile_name: "dev" }],
      edges: [],
    });
    complete(s, two.tasks["SOLO"]!.id);

    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    const report = await evaluator.bootScan();
    assert.equal(state(s, one.b), "queued", "the missed propagation fires at boot");
    assert.equal(chainState(s, two.chainRun.id)?.state, "completed", "the missed terminal move applies at boot");
    // a second sweep is idempotent
    await evaluator.bootScan();
    const queuedLogs = s.db
      .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND to_state = 'queued'")
      .get(one.b) as { n: number };
    assert.equal(queuedLogs.n, 1);
    assert.ok(report.enqueued >= 1);
  } finally {
    s.db.close();
  }
});
