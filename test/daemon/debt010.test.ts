import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER, createTask, enqueueTask, type TaskRow } from "../../src/tasks.ts";
import { START_TRIGGER, VALIDATING_TRIGGER } from "../../src/runs/triggers.ts";
import { VERIFY_PASSED_TRIGGER } from "../../src/fsm/triggers.ts";
import { OpError } from "../../src/opcodes.ts";
import { importChain, ChainValidationError } from "../../src/chain/import.ts";
import { createChainEvaluator } from "../../src/chain/readiness.ts";
import { createScheduleEvaluator } from "../../src/daemon/schedules.ts";
import { canonicalTimestamp } from "../../src/sched/iso.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";

/**
 * DEBT-010 — the guarded draft→queued transition refuses a task with
 * ZERO target_scopes, fail-closed: an unscoped run executes unconfined
 * in the daemon process's cwd (real incident: an unscoped MCP task wrote
 * into this engine's own source repo). The guard rides the ONE row
 * (enqueueTask), so every enqueuing surface refuses the same way:
 *   1. the nova_task_run op — schema_invalid naming DEBT-010, the task
 *      stays draft (no log row, no spawn);
 *   2. the chain readiness evaluator — a scopeless member's propagation
 *      is refused and logged (the import itself refuses the shape since
 *      DEBT-011: this is the second line of defence);
 *   3. the schedule evaluator — a scopeless task's fire is refused,
 *      logged, and the occurrence advances (never wedged);
 *   4. a properly scoped task still enqueues and runs to completion.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const PROBE = { piBin: "node", args: [STUB, "ok"], timeoutMs: 5000 };

/** In-memory store: workspace, project, profile (mirrors the readiness seed). */
function seededDb() {
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
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  return { db, workspaceId, projectId, profileId };
}

/** A draft task with NO target_scopes rows (the DEBT-010 shape). */
function createScopelessDraft(
  db: Database.Database,
  projectId: string,
  profileId: string,
  key: string,
): TaskRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, key, key, `Objective for ${key}.`, profileId);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
}

/** Capture console.warn calls while fn runs (the evaluators log refusals). */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ out: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  try {
    const out = await fn();
    return { out, warns };
  } finally {
    console.warn = original;
  }
}

function taskState(db: Database.Database, taskId: string): string {
  return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
}

function logCount(db: Database.Database, taskId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ?")
    .get(taskId) as { n: number }).n;
}

function tableCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/* ------------------------- 1. the nova_task_run op ------------------------- */

test("DEBT-010: nova_task_run on a scopeless draft task refuses with schema_invalid naming DEBT-010; the task stays draft", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-debt010-"));
  const seeded: SeededStore = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  let handle: DaemonHandle | undefined;
  try {
    handle = await startDaemon({
      dbPath: seeded.dbPath,
      socketPath: join(dir, "novaflow.sock"),
      daemonConfigPath: cfgPath,
      probePiBin: "node",
      probeArgs: [STUB, "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      runArgs: [STUB, "run-ok"],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    const client = await TestClient.connect(handle.socketPath);
    try {
      // a draft task with NO target_scopes — creation stays legal (a
      // parked draft), only the run transition refuses
      const created = await client.request({
        id: "c",
        op: "nova_task_create",
        args: { project_id: seeded.projectId, key: "BARE", title: "t", objective: "o", profile_name: "dev" },
      });
      assert.equal(created["ok"], true, JSON.stringify(created));
      const taskId = (created["data"] as { task: { id: string } }).task.id;

      const run = await client.request({ id: "r", op: "nova_task_run", args: { task_id: taskId } });
      assert.equal(run["ok"], false, "the op must refuse an unscoped run");
      assert.equal(run["error"]["code"], "schema_invalid");
      assert.match(String(run["error"]["message"]), /DEBT-010/);
      assert.match(String(run["error"]["message"]), /no target_scopes/);

      const ro = readConnection(seeded.dbPath);
      try {
        assert.equal((ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state, "draft");
        assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ?").get(taskId) as { n: number }).n, 0);
      } finally {
        ro.close();
      }
    } finally {
      client.close();
    }
  } finally {
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------- 2. the chain import + readiness evaluator --------------------- */

test("DEBT-011: a chain member without target_scopes is refused at import — schema_invalid naming the member, NO chain row created", () => {
  const s = seededDb();
  try {
    const before = {
      chains: tableCount(s.db, "chain_runs"),
      tasks: tableCount(s.db, "tasks"),
      edges: tableCount(s.db, "task_edges"),
      scopes: tableCount(s.db, "task_target_scopes"),
    };
    let refusal: unknown;
    try {
      // the shape the import used to accept: both members scopeless
      importChain(s.db, { id: s.workspaceId }, { id: s.projectId, slug: "prj" }, {
        version: "1.0.0",
        project_slug: "prj",
        tasks: [
          { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev" },
          { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev" },
        ],
        edges: [{ source_key: "A", target_key: "B", edge_type: "depends_on" }],
      });
      assert.fail("the import must refuse a member without target_scopes");
    } catch (thrown) {
      refusal = thrown;
    }
    assert.ok(refusal instanceof ChainValidationError, `expected ChainValidationError, got ${String(refusal)}`);
    assert.equal(refusal.code, "schema_invalid");
    // the refusal names the member and the fix, before any row exists
    assert.match(refusal.message, /add target_scopes to member A/);
    assert.deepEqual(
      {
        chains: tableCount(s.db, "chain_runs"),
        tasks: tableCount(s.db, "tasks"),
        edges: tableCount(s.db, "task_edges"),
        scopes: tableCount(s.db, "task_target_scopes"),
      },
      before,
      "the import is all-or-nothing: not even the chain_runs row exists",
    );
    assert.deepEqual(before, { chains: 0, tasks: 0, edges: 0, scopes: 0 });
  } finally {
    s.db.close();
  }
});

test("DEBT-010: the readiness enqueue still refuses a scopeless member — the second line of defence", async () => {
  const s = seededDb();
  try {
    // the import refuses this shape now (DEBT-011), so the only way such a
    // member can still exist is a store written outside the import (a
    // pre-v0.3.0 row, a hand-written DB): construct exactly that
    const chainRunId = ulid();
    s.db
      .prepare("INSERT INTO chain_runs (id, project_id, state) VALUES (?, ?, 'active')")
      .run(chainRunId, s.projectId);
    const a = createTask(s.db, {
      projectId: s.projectId,
      key: "A",
      title: "Task A",
      objective: "The objective of task A.",
      profileId: s.profileId,
      chainRunId,
    });
    const b = createTask(s.db, {
      projectId: s.projectId,
      key: "B",
      title: "Task B",
      objective: "The objective of task B.",
      profileId: s.profileId,
      chainRunId, // no targetScopes: the DEBT-010 shape
    });
    s.db
      .prepare(
        `INSERT INTO task_edges (id, project_id, source_task_id, target_task_id, edge_type)
         VALUES (?, ?, ?, ?, 'depends_on')`,
      )
      .run(ulid(), s.projectId, a.id, b.id);

    // the guarded row itself refuses member B the same named way
    await assert.rejects(
      enqueueTask(s.db, b.id, "chain-engine", { ...PROBE, triggerType: "engine" }),
      (err: unknown) => {
        assert.ok(err instanceof OpError, String(err));
        assert.equal(err.code, "schema_invalid");
        assert.match(err.message, /DEBT-010/);
        return true;
      },
    );
    assert.equal(taskState(s.db, b.id), "draft");
    assert.equal(logCount(s.db, b.id), 0);

    // A completes (seed-side rows) → B is ready → the evaluator's enqueue
    // is refused and logged; B stays draft and the chain stays active
    applyTransition(s.db, a.id, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(s.db, a.id, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, a.id, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(s.db, a.id, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });

    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });
    const { out, warns } = await captureWarn(() => evaluator.evaluateForTask(a.id));
    assert.deepEqual(out?.enqueued, [], "the readiness enqueue refused the scopeless member");
    assert.equal(taskState(s.db, b.id), "draft");
    assert.equal(logCount(s.db, b.id), 0, "no transition row — the refusal left no trace on the task");
    assert.ok(
      warns.some((w) => /DEBT-010/.test(w) && new RegExp(b.id).test(w)),
      `the refusal is logged naming DEBT-010: ${JSON.stringify(warns)}`,
    );
    const chain = s.db.prepare("SELECT state FROM chain_runs WHERE id = ?").get(chainRunId) as { state: string };
    assert.equal(chain.state, "active", "the evaluator never wedges on the refusal");
  } finally {
    s.db.close();
  }
});

/* ---------------------- 3. the schedule evaluator's fire ---------------------- */

test("DEBT-010: a scheduled attach on a scopeless task refuses at fire — logged naming DEBT-010, occurrence consumed, task stays draft", async () => {
  const s = seededDb();
  try {
    const task = createScopelessDraft(s.db, s.projectId, s.profileId, "FIRED");
    const scheduleId = ulid();
    s.db.prepare(
      `INSERT INTO schedules
         (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
          missed_policy, enabled, last_run_at, next_run_at)
       VALUES (?, ?, 'task', ?, NULL, ?, 'UTC', 'skip', 1, NULL, ?)`,
    ).run(
      scheduleId,
      s.workspaceId,
      task.id,
      canonicalTimestamp(Date.now() + 3_600_000), // the one-shot's moment
      canonicalTimestamp(Date.now() - 1000), // already due
    );

    const evaluator = createScheduleEvaluator(s.db, { enqueueOptions: PROBE });
    const { warns } = await captureWarn(() => evaluator.evaluate(Date.now()));

    assert.equal(taskState(s.db, task.id), "draft", "the fire never moved the task");
    assert.equal(logCount(s.db, task.id), 0);
    assert.ok(
      warns.some((w) => /DEBT-010/.test(w) && new RegExp(task.id).test(w)),
      `the refusal is logged naming DEBT-010: ${JSON.stringify(warns)}`,
    );
    // never wedged, never a hot loop: the refused occurrence advanced
    // (last_run_at untouched — the run never happened)
    const row = s.db.prepare("SELECT last_run_at, next_run_at FROM schedules WHERE id = ?").get(scheduleId) as {
      last_run_at: string | null;
      next_run_at: string | null;
    };
    assert.equal(row.last_run_at, null);
    assert.ok(row.next_run_at !== null && Date.parse(row.next_run_at) > Date.now());
  } finally {
    s.db.close();
  }
});

/* ------------------- 4. a properly scoped task still runs ------------------- */

test("DEBT-010: a properly scoped task still enqueues and runs to completion end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-debt010-"));
  const seeded: SeededStore = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  let handle: DaemonHandle | undefined;
  try {
    handle = await startDaemon({
      dbPath: seeded.dbPath,
      socketPath: join(dir, "novaflow.sock"),
      daemonConfigPath: cfgPath,
      probePiBin: "node",
      probeArgs: [STUB, "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      runArgs: [STUB, "run-ok"],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    const client = await TestClient.connect(handle.socketPath);
    try {
      const created = await client.request({
        id: "c",
        op: "nova_task_create",
        args: {
          project_id: seeded.projectId,
          key: "SCOPED",
          title: "t",
          objective: "Do the scoped work.",
          profile_name: "dev",
          target_scopes: [{ repo_alias: "ws-app", access_mode: "read_write" }],
        },
      });
      assert.equal(created["ok"], true, JSON.stringify(created));
      const taskId = (created["data"] as { task: { id: string } }).task.id;

      const run = await client.request({ id: "r", op: "nova_task_run", args: { task_id: taskId } });
      assert.equal(run["ok"], true, JSON.stringify(run));
      assert.equal((run["data"] as { task: { state: string } }).task.state, "queued");

      await waitFor(() => {
        const ro = readConnection(seeded.dbPath);
        try {
          return (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state === "completed";
        } finally {
          ro.close();
        }
      }, 15_000);
    } finally {
      client.close();
    }
  } finally {
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
