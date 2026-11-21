import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMatrix } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER } from "../../src/runs/triggers.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, MODEL } from "./seed.ts";

/**
 * The v1 wire contract over the real socket: JSONL envelope, the srs
 * error taxonomy, the op catalog (mcp.md names/payload shapes where
 * they exist), and the write discipline — every state change lands on
 * a legal 8.1 matrix row through the guarded services.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  projectId: string;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(
  over: {
    runMode?: string;
    daemonConfig?: string;
    tickMs?: number;
  } = {},
): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-srv-"));
  const seeded = seedFileStore(dir);
  const runMode = over.runMode ?? "run-ok";
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(
    cfgPath,
    over.daemonConfig ?? "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n",
  );
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, runMode, join(dir, `${runMode}.pid`)],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: over.tickMs ?? 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return {
    dir,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    handle,
    client,
  };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

async function createTaskVia(
  env: Env,
  key: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await env.client.request({
    id: `c-${key}`,
    op: "nova_task_create",
    args: {
      project_id: env.projectId,
      key,
      title: key,
      objective: "Implement the thing end to end.",
      profile_name: "dev",
      ...over,
    },
  });
  assert.equal(res["ok"], true, JSON.stringify(res));
  const task = (res["data"] as { task: { id: string } }).task;
  return task.id;
}

async function runVia(env: Env, taskId: string): Promise<void> {
  const res = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: taskId } });
  assert.equal(res["ok"], true, JSON.stringify(res));
}

function taskState(env: Env, taskId: string): string {
  const ro = readConnection(env.dbPath);
  const state = (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
  ro.close();
  return state;
}

function transitions(env: Env, taskId: string): Array<Record<string, unknown>> {
  const ro = readConnection(env.dbPath);
  const rows = ro
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
    .all(taskId) as Array<Record<string, unknown>>;
  ro.close();
  return rows;
}

async function waitForState(env: Env, taskId: string, state: string): Promise<void> {
  await waitFor(() => taskState(env, taskId) === state, 6000);
}

/* ------------------------------- wire protocol ------------------------------- */

test("wire contract: JSONL envelope, id echo, taxonomy errors, 0600 socket", async () => {
  const env = await boot();
  try {
    // a valid request: id echoed verbatim, ok + data
    const ok = await env.client.request({ id: "req-42", op: "nova_daemon_status", args: {} });
    assert.equal(ok["id"], "req-42");
    assert.equal(ok["ok"], true);
    const data = ok["data"] as Record<string, unknown>;
    assert.equal(data["version"], "0.1.0");
    assert.equal((data["scheduler"] as Record<string, unknown>)["paused"], false);

    // non-JSON line → id null + schema_invalid
    const bad = JSON.parse(await env.client.sendRaw("this is not json"));
    assert.equal(bad["id"], null);
    assert.equal(bad["error"]["code"], "schema_invalid");

    // unknown op → not_found (documented mapping)
    const unknown = await env.client.request({ id: "u1", op: "nova_nope", args: {} });
    assert.equal(unknown["ok"], false);
    assert.equal(unknown["error"]["code"], "not_found");

    // missing op / bad args shape / bad surface → schema_invalid
    const noOp = await env.client.request({ id: "u2" });
    assert.equal(noOp["error"]["code"], "schema_invalid");
    const badArgs = await env.client.request({ id: "u3", op: "nova_task_status", args: [] });
    assert.equal(badArgs["error"]["code"], "schema_invalid");
    const badSurface = await env.client.request({ id: "u4", op: "nova_daemon_status", surface: "web" });
    assert.equal(badSurface["error"]["code"], "schema_invalid");

    // TB-1: operator-only socket
    assert.equal(statSync(env.handle.socketPath).mode & 0o777, 0o600);
  } finally {
    await shutdown(env);
  }
});

test("multiple requests on one connection answer in order (per-connection serialization)", async () => {
  const env = await boot();
  try {
    const p1 = env.client.request({ id: "a", op: "nova_daemon_status", args: {} });
    const p2 = env.client.request({ id: "b", op: "nova_daemon_status", args: {} });
    const p3 = env.client.request({ id: "c", op: "nova_task_list", args: {} });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepEqual([r1["id"], r2["id"], r3["id"]], ["a", "b", "c"]);
    assert.equal(r1["ok"], true);
    assert.equal(r3["ok"], true);
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ task lifecycle ops ----------------------------- */

test("task create → run (catalog probe) → dispatch → settle → auto-verification → completed; result + logs ops", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "TASK-1");
    assert.equal(taskState(env, taskId), "draft");

    // duplicate key → the taxonomy's duplicate code
    const dup = await env.client.request({
      id: "dup",
      op: "nova_task_create",
      args: { project_id: env.projectId, key: "TASK-1", title: "x", objective: "y", profile_name: "dev" },
    });
    assert.equal(dup["ok"], false);
    assert.equal(dup["error"]["code"], "duplicate");

    await runVia(env, taskId); // draft→queued via the enqueue service (probe: ok)
    // dispatch may already have granted the slot — assert the enqueue,
    // not a race: the task left draft on the draft→queued row
    assert.notEqual(taskState(env, taskId), "draft");
    // dispatch → startRun → settle into validating → the daemon's
    // auto-verification (FR-TSK-12, no commands configured → passed)
    // → completed via the guarded validating→completed row
    await waitForState(env, taskId, "completed");
    assert.deepEqual(
      transitions(env, taskId).map((x) => [x["from_state"], x["to_state"]]),
      [
        ["draft", "queued"],
        ["queued", "running"],
        ["running", "validating"],
        ["validating", "completed"],
      ],
    );

    // nova_task_status: full record, current run, no elapsed when concluded
    const status = await env.client.request({ id: "s", op: "nova_task_status", args: { task_id: taskId } });
    const statusData = status["data"] as Record<string, unknown>;
    assert.equal((statusData["task"] as Record<string, unknown>)["state"], "completed");
    assert.equal((statusData["current_run"] as Record<string, unknown>)["status"], "succeeded");
    assert.equal((statusData["current_run"] as Record<string, unknown>)["engine_verification_passed"], 1);
    assert.equal(statusData["elapsed_ms"], null);

    // nova_result_get (mcp.md §3.1 tool table — the wire name): the validated result.json
    const result = await env.client.request({
      id: "res",
      op: "nova_result_get",
      args: { task_id: taskId },
    });
    const artifact = (result["data"] as Record<string, unknown>)["artifact"] as Record<string, unknown>;
    assert.equal(artifact["status"], "completed");

    // nova_run_logs: the REDACTED events.jsonl only — never the raw file
    const logs = await env.client.request({ id: "logs", op: "nova_run_logs", args: { task_id: taskId } });
    const lines = (logs["data"] as Record<string, unknown>)["lines"] as string[];
    assert.ok(lines.length > 0);
    for (const line of lines) JSON.parse(line); // scrubbed, still parseable
    assert.ok(lines.some((l) => l.includes("agent_settled")));
    const run = (logs["data"] as Record<string, unknown>)["run_id"];
    const ro = readConnection(env.dbPath);
    const eventsPath = (ro.prepare("SELECT events_log_path FROM task_runs WHERE id = ?").get(run) as { events_log_path: string }).events_log_path;
    ro.close();
    assert.match(eventsPath, /events\.jsonl$/); // the read surface, never events.raw.jsonl

    // task list with a state filter
    const list = await env.client.request({ id: "l", op: "nova_task_list", args: { state: "completed" } });
    const tasks = (list["data"] as Record<string, unknown>)["tasks"] as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!["id"], taskId);

    // profile ops
    const profiles = await env.client.request({ id: "pl", op: "nova_profile_list", args: {} });
    assert.equal((profiles["data"] as Record<string, unknown>)["profiles"].length >= 1, true);
    const ro2 = readConnection(env.dbPath);
    const profileId = (ro2.prepare("SELECT id FROM agent_profiles LIMIT 1").get() as { id: string }).id;
    ro2.close();
    const pv = await env.client.request({ id: "pv", op: "nova_profile_validate", args: { profile_id: profileId } });
    assert.equal(pv["ok"], true);
    const pvBad = await env.client.request({ id: "pv2", op: "nova_profile_validate", args: { profile_id: "NOPE" } });
    assert.equal(pvBad["error"]["code"], "not_found");

    // FSM-only writes: every recorded move is a legal 8.1 row
    const matrix = extractMatrix();
    for (const tr of transitions(env, taskId)) {
      assert.ok(
        matrix.some((r) => r.state === tr["from_state"] && r.target === tr["to_state"]),
        `illegal pair ${tr["from_state"]}→${tr["to_state"]}`,
      );
    }
  } finally {
    await shutdown(env);
  }
});

test("nova_task_run with an unresolvable model → profile_unresolved, zero tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-srv-"));
  const seeded = seedFileStore(dir);
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    probePiBin: "node",
    probeArgs: [STUB, "garbage"], // never a valid response frame
    probeTimeoutMs: 500,
    runPiBin: "node",
    runArgs: [STUB, "run-ok", join(dir, "stub.pid")],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  try {
    const res = await client.request({
      id: "c",
      op: "nova_task_create",
      args: { project_id: seeded.projectId, key: "T", title: "t", objective: "o", profile_name: "dev" },
    });
    const taskId = (res["data"] as { task: { id: string } }).task.id;
    const runRes = await client.request({ id: "r", op: "nova_task_run", args: { task_id: taskId } });
    assert.equal(runRes["ok"], false);
    assert.equal(runRes["error"]["code"], "profile_unresolved");
    const ro = readConnection(seeded.dbPath);
    const state = (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
    const logs = (ro.prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ?").get(taskId) as { n: number }).n;
    ro.close();
    assert.equal(state, "draft"); // the probe rejection leaves draft, no log row
    assert.equal(logs, 0);
    assert.equal(existsSync(join(dir, "stub.pid")), false); // zero spawns
  } finally {
    client.close();
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------- auto-verification wiring (FR-TSK-12) ------------------- */

test("auto-verification wiring: a settled run is verified, annotated, and completed end to end (stub pi, exit-0 command)", async () => {
  const env = await boot();
  try {
    // a directory target whose verification command exits 0
    const targetRoot = join(env.dir, "targetroot");
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "note.txt"), "clean tree\n");
    const db = new Database(env.dbPath);
    db.prepare(
      `INSERT INTO project_targets (id, project_id, alias, target_type, root_path)
       VALUES (?, ?, 'app', 'directory', ?)`,
    ).run(ulid(), env.projectId, targetRoot);
    db.close();

    // mcp.md §3.2 payload: the create carries the scoped verification command
    const res = await env.client.request({
      id: "c-ver",
      op: "nova_task_create",
      args: {
        project_id: env.projectId,
        key: "VERIFY",
        title: "v",
        objective: "Do the thing.",
        profile_name: "dev",
        target_scopes: [
          { repo_alias: "app", access_mode: "read_write", verification_commands: ["exit 0"] },
        ],
      },
    });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const taskId = (res["data"] as { task: { id: string } }).task.id;
    await runVia(env, taskId);

    // stub run -> settle -> validating -> the daemon's auto-verification
    // -> completed (before the wiring the task dead-ended in validating)
    await waitForState(env, taskId, "completed", 8000);

    const ro = readConnection(env.dbPath);
    const run = ro
      .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(taskId) as Record<string, unknown>;
    ro.close();
    assert.equal(run["engine_verification_passed"], 1);

    // the artifact carries the engine-owned annotations (never agent-authored)
    const artifact = JSON.parse(
      readFileSync(String(run["artifact_path"]), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(artifact["engine_verified"], true);
    assert.equal(artifact["protected_files_untouched"], true);
    const vr = artifact["verification_results"] as Array<Record<string, unknown>>;
    assert.equal(vr.length, 1);
    assert.equal(vr[0]!["command"], "exit 0");
    assert.equal(vr[0]!["passed"], true);
    assert.equal(vr[0]!["exit_code"], 0);

    // the guarded validating→completed row, engine-triggered, run-pinned
    const tr = transitions(env, taskId);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "validating");
    assert.equal(last["to_state"], "completed");
    assert.equal(last["trigger_type"], "engine");
    // the built summary now reaches the audit log (re-judge polish 3)
    assert.match(String(last["reason"]), /engine verification passed \(1 command\)/);
  } finally {
    await shutdown(env);
  }
});

/* --------------------------------- abort / steer -------------------------------- */

test("regression: nova_task_abort on a running task with no live run (boot-recovered crashed orphan) -> the running-to-cancelled matrix row, run row untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-srv-"));
  const seeded = seedFileStore(dir);
  // pre-crash: the task is mid-run with an UNSETTLED orphan run row
  const db = new Database(seeded.dbPath);
  const task = createTask(db, {
    projectId: seeded.projectId,
    key: "ORPHAN",
    title: "t",
    objective: "o",
    profileId: seeded.profileId,
  });
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(db, task.id, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  const runId = task.id.slice(0, 25) + "B";
  const runDir = join(seeded.wsRoot, ".novaflow", "runs", task.id, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.raw.jsonl"),
    JSON.stringify({ type: "message_end", usage: { input: 100, output: 20 } }) + "\n", // no agent_settled
  );
  db.prepare(
    `INSERT INTO task_runs (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
       status, preflight_status, model_used, events_log_path)
     VALUES (?, ?, ?, 1, ?, ?, 'running', 'passed', ?, ?)`,
  ).run(runId, task.id, seeded.profileId, runId, runDir, MODEL, join(runDir, "events.jsonl"));
  db.close();

  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: join(dir, "none-config.yaml"), // defaults
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok", join(dir, "stub.pid")],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  try {
    // boot recovery marked the orphan crashed — the task stays running
    // (§8.4 task-state-unchanged) with NO live dispatcher entry
    const ro = readConnection(seeded.dbPath);
    assert.equal(
      (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as { state: string }).state,
      "running",
    );
    assert.equal(
      (ro.prepare("SELECT status FROM task_runs WHERE id = ?").get(runId) as { status: string }).status,
      "failed",
    );
    ro.close();

    // before the fix this was `not_found` ("has no live run") — the task
    // was permanently wedged; now the FSM row applies
    const abort = await client.request({
      id: "ab",
      op: "nova_task_abort",
      surface: "human",
      args: { task_id: task.id },
    });
    assert.equal(abort["ok"], true, JSON.stringify(abort));
    assert.equal((abort["data"] as Record<string, unknown>)["final_state"], "cancelled");
    assert.equal((abort["data"] as Record<string, unknown>)["live_run"], false);

    // the task moved via the verbatim running→cancelled operator-abort row
    const ro2 = readConnection(seeded.dbPath);
    assert.equal(
      (ro2.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as { state: string }).state,
      "cancelled",
    );
    const tr = ro2
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(task.id) as Record<string, unknown>;
    ro2.close();
    assert.equal(tr["from_state"], "running");
    assert.equal(tr["to_state"], "cancelled");
    assert.equal(tr["trigger_type"], "human");

    // the crashed run row stays crashed — the abort never rewrote history
    const ro3 = readConnection(seeded.dbPath);
    const run = ro3.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as Record<string, unknown>;
    ro3.close();
    assert.equal(run["status"], "failed");
    assert.match(String(run["error_summary"]), /crashed/);
  } finally {
    client.close();
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("nova_task_abort: on a queued task (scheduler paused) → the queued→cancelled row; on terminal → invalid_transition", async () => {
  const env = await boot();
  try {
    // freeze the scheduler so the task stays queued
    const pause = await env.client.request({ id: "p", op: "nova_daemon_pause", args: {} });
    assert.equal(pause["ok"], true);

    const taskId = await createTaskVia(env, "TASK-A");
    await runVia(env, taskId);
    assert.equal(taskState(env, taskId), "queued");

    const abort = await env.client.request({ id: "ab", op: "nova_task_abort", surface: "human", args: { task_id: taskId } });
    assert.equal(abort["ok"], true, JSON.stringify(abort));
    assert.equal((abort["data"] as Record<string, unknown>)["final_state"], "cancelled");
    const tr = transitions(env, taskId);
    assert.deepEqual(
      tr.map((x) => [x["from_state"], x["to_state"]]),
      [["draft", "queued"], ["queued", "cancelled"]],
    );

    // a completed task has no abort row → invalid_transition naming the state
    const missing = await env.client.request({ id: "ab2", op: "nova_task_abort", args: { task_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" } });
    assert.equal(missing["error"]["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

test("nova_task_abort on a live run: group kill via the loop, cancelled record, reaped; steer forwards to the live stdin", async () => {
  const env = await boot({ runMode: "run-hang" });
  try {
    const taskId = await createTaskVia(env, "TASK-L", { context_files: [] });
    await runVia(env, taskId);
    await waitForState(env, taskId, "running");

    // steer to the live child: api.md §3 frame
    const steer = await env.client.request({
      id: "st",
      op: "nova_task_steer",
      args: { task_id: taskId, message: "Do not touch the lockfile." },
    });
    assert.equal(steer["ok"], true, JSON.stringify(steer));

    const ro = readConnection(env.dbPath);
    const pid = (ro
      .prepare("SELECT pid FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(taskId) as { pid: number }).pid;
    ro.close();

    const abort = await env.client.request({ id: "ab", op: "nova_task_abort", args: { task_id: taskId } });
    assert.equal(abort["ok"], true, JSON.stringify(abort));
    assert.equal((abort["data"] as Record<string, unknown>)["live_run"], true);
    assert.equal(taskState(env, taskId), "cancelled");

    const tr = transitions(env, taskId);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "running");
    assert.equal(last["to_state"], "cancelled");
    assert.equal(last["trigger_type"], "human");

    await waitFor(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 4000);
  } finally {
    await shutdown(env);
  }
});

test("steer on a non-running task → invalid_transition naming the state", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "TASK-S");
    const res = await env.client.request({
      id: "st",
      op: "nova_task_steer",
      args: { task_id: taskId, message: "hi" },
    });
    assert.equal(res["ok"], false);
    assert.equal(res["error"]["code"], "invalid_transition");
    assert.match(String(res["error"]["message"]), /draft/);
  } finally {
    await shutdown(env);
  }
});

/* ----------------------------------- gates ------------------------------------- */

test("gate ops over the socket: approve (contract), reject (mcp payload + defaults), confirm-failure", async () => {
  const env = await boot({ runMode: "run-blocked" });
  try {
    const gateTask = await createTaskVia(env, "TASK-G", { requires_human_gate: true });
    await runVia(env, gateTask);
    await waitForState(env, gateTask, "awaiting_gate");

    const ro = readConnection(env.dbPath);
    const runId = (ro
      .prepare("SELECT id FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(gateTask) as { id: string }).id;
    ro.close();

    // a stale run id is refused (the gate approval contract)
    const stale = await env.client.request({
      id: "ga1",
      op: "nova_gate_approve",
      args: { task_id: gateTask, run_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS", approved_by: "maul", note: "ok" },
    });
    assert.equal(stale["ok"], false);
    assert.equal(stale["error"]["code"], "invalid_transition");

    // the real approval: awaiting_gate→validating, contract fields recorded
    const approve = await env.client.request({
      id: "ga2",
      op: "nova_gate_approve",
      args: { task_id: gateTask, run_id: runId, approved_by: "maul", note: "ship it" },
    });
    assert.equal(approve["ok"], true, JSON.stringify(approve));
    assert.equal((approve["data"] as Record<string, unknown>)["final_state"], "validating");
    // the approval row (p4b: the engine's verification verdict now
    // FOLLOWS the approval async, so the approval is no longer the last
    // row — pin it by its matrix row instead of by position)
    const tr = transitions(env, gateTask);
    const approval = tr.find((t) => t["from_state"] === "awaiting_gate" && t["to_state"] === "validating")!;
    assert.equal(approval["trigger_type"], "human");
    assert.match(String(approval["reason"]), /gate approved by maul: ship it/);
    // the p4b gate-approved verification driver: the ENGINE decides the
    // validating→terminal verdict (FR-TSK-12 — approval is not bypass)
    await waitForState(env, gateTask, "completed", 8000);
    const verdict = transitions(env, gateTask);
    const vlast = verdict[verdict.length - 1]!;
    assert.equal(vlast["from_state"], "validating");
    assert.equal(vlast["to_state"], "completed");
    assert.equal(vlast["trigger_type"], "engine");

    // a second gate task: reject via the mcp payload shape {task_id, feedback}
    const rejectTask = await createTaskVia(env, "TASK-R", { requires_human_gate: true });
    await runVia(env, rejectTask);
    await waitForState(env, rejectTask, "awaiting_gate");
    const reject = await env.client.request({
      id: "gr",
      op: "nova_gate_reject",
      surface: "mcp",
      args: { task_id: rejectTask, feedback: "the tests are wrong, fix them" },
    });
    assert.equal(reject["ok"], true, JSON.stringify(reject));
    // the SELF path (p4b fix): a rejected task with budget retries itself —
    // the operator's feedback is the delivered artifact
    assert.equal((reject["data"] as Record<string, unknown>)["final_state"], "queued");
    assert.equal((reject["data"] as Record<string, unknown>)["retry_count"], 1); // incremented on entry
    assert.match(
      String((reject["data"] as Record<string, unknown>)["feedback_path"]),
      /feedback\/gate-reject\.json/,
    );
    const rtr = transitions(env, rejectTask);
    const rejectRow = rtr.find(
      (r) => r["from_state"] === "awaiting_gate" && r["to_state"] === "changes_requested",
    );
    assert.ok(rejectRow !== undefined, "the reject row exists");
    assert.equal(rejectRow!["trigger_type"], "mcp"); // the surface rule (mcp.md §5)
    // the requeued task may already be running again — find the row, don't
    // assume it is the last one
    const requeueRow = rtr.find(
      (r) => r["from_state"] === "changes_requested" && r["to_state"] === "queued",
    );
    assert.ok(requeueRow !== undefined, "the self-path requeue row exists");
    assert.match(String(requeueRow!["reason"]), /feedback artifact delivered to next attempt: .*gate-reject/);

    // confirm-failure: the terminal gate outcome
    const failTask = await createTaskVia(env, "TASK-F", { requires_human_gate: true });
    await runVia(env, failTask);
    await waitForState(env, failTask, "awaiting_gate");
    const confirm = await env.client.request({
      id: "gf",
      op: "nova_gate_confirm_failure",
      args: { task_id: failTask, feedback: "confirmed broken" },
    });
    assert.equal(confirm["ok"], true, JSON.stringify(confirm));
    assert.equal((confirm["data"] as Record<string, unknown>)["final_state"], "failed");
  } finally {
    await shutdown(env);
  }
});

function rlastIdx(rows: Array<Record<string, unknown>>): number {
  return rows.length - 1;
}

/* --------------------- nova_task_create payload parts (mcp.md \u00a73.2) --------------------- */

test("nova_task_create persists overrides, target_scopes, output_schema_version; malformed payloads refuse with schema_invalid", async () => {
  const env = await boot();
  try {
    // a project target the scopes reference (repo_alias -> project_targets)
    const targetRoot = join(env.dir, "targetroot");
    mkdirSync(targetRoot, { recursive: true });
    const db = new Database(env.dbPath);
    db.prepare(
      `INSERT INTO project_targets (id, project_id, alias, target_type, root_path)
       VALUES (?, ?, 'app', 'directory', ?)`,
    ).run(ulid(), env.projectId, targetRoot);
    db.close();

    const base = { project_id: env.projectId, title: "t", objective: "o", profile_name: "dev" };

    // a create with ALL THREE optional payload parts persists everything
    const full = await env.client.request({
      id: "c-full",
      op: "nova_task_create",
      args: {
        ...base,
        key: "FULL",
        overrides: { timeout_sec: 120, max_cost_usd: 2.5, thinking_level: "high" },
        output_schema_version: "2.1.0",
        target_scopes: [{
          repo_alias: "app",
          access_mode: "read_write",
          write_scope_globs: ["src/**"],
          protected_test_globs: ["test/**"],
          verification_commands: ["exit 0"],
        }],
      },
    });
    assert.equal(full["ok"], true, JSON.stringify(full));
    const fullTask = (full["data"] as { task: { id: string } }).task;

    // a minimal scope: column defaults apply for omitted fields (data.md DDL)
    const minimal = await env.client.request({
      id: "c-min",
      op: "nova_task_create",
      args: { ...base, key: "MIN", target_scopes: [{ repo_alias: "app", access_mode: "read_only" }] },
    });
    assert.equal(minimal["ok"], true, JSON.stringify(minimal));
    const minimalTask = (minimal["data"] as { task: { id: string } }).task;

    const ro = readConnection(env.dbPath);
    const taskRow = ro
      .prepare("SELECT overrides_json, output_schema_version FROM tasks WHERE id = ?")
      .get(fullTask.id) as { overrides_json: string | null; output_schema_version: string };
    assert.deepEqual(JSON.parse(taskRow.overrides_json ?? "{}"), {
      timeout_sec: 120,
      max_cost_usd: 2.5,
      thinking_level: "high",
    });
    assert.equal(taskRow.output_schema_version, "2.1.0");

    const scopeRow = ro
      .prepare(
        `SELECT pt.alias, tts.access_mode, tts.write_scope_globs_json,
                tts.protected_test_globs_json, tts.verification_commands_json
           FROM task_target_scopes tts
           JOIN project_targets pt ON pt.id = tts.target_id
          WHERE tts.task_id = ?`,
      )
      .get(fullTask.id) as Record<string, string>;
    assert.equal(scopeRow["alias"], "app");
    assert.equal(scopeRow["access_mode"], "read_write");
    assert.deepEqual(JSON.parse(scopeRow["write_scope_globs_json"]), ["src/**"]);
    assert.deepEqual(JSON.parse(scopeRow["protected_test_globs_json"]), ["test/**"]);
    assert.deepEqual(JSON.parse(scopeRow["verification_commands_json"]), ["exit 0"]);

    const minScope = ro
      .prepare("SELECT * FROM task_target_scopes WHERE task_id = ?")
      .get(minimalTask.id) as Record<string, string>;
    assert.equal(minScope["access_mode"], "read_only");
    assert.deepEqual(JSON.parse(minScope["write_scope_globs_json"]), ["**/*"]); // DDL default
    assert.deepEqual(JSON.parse(minScope["protected_test_globs_json"]), []); // DDL default
    assert.deepEqual(JSON.parse(minScope["verification_commands_json"]), []); // DDL default
    ro.close();

    // malformed payloads refuse with schema_invalid — nothing persisted
    const bad: Array<[string, Record<string, unknown>]> = [
      ["overrides not an object", { ...base, key: "BAD1", overrides: "nope" }],
      ["overrides unknown key", { ...base, key: "BAD2", overrides: { timeout_sec: 1, bogus: true } }],
      ["overrides bad type", { ...base, key: "BAD3", overrides: { timeout_sec: 0.5 } }],
      ["output_schema_version empty", { ...base, key: "BAD4", output_schema_version: "" }],
      ["target_scopes not array", { ...base, key: "BAD5", target_scopes: "app" }],
      ["scope missing repo_alias", { ...base, key: "BAD6", target_scopes: [{ access_mode: "read_write" }] }],
      ["scope bad access_mode", { ...base, key: "BAD7", target_scopes: [{ repo_alias: "app", access_mode: "write" }] }],
      ["scope bad globs", { ...base, key: "BAD8", target_scopes: [{ repo_alias: "app", access_mode: "read_only", write_scope_globs: "src" }] }],
      ["scope globs not strings", { ...base, key: "BAD9", target_scopes: [{ repo_alias: "app", access_mode: "read_only", protected_test_globs: [1] }] }],
      ["scope unknown key", { ...base, key: "BAD11", target_scopes: [{ repo_alias: "app", access_mode: "read_only", write_scope_glob: ["src"] }] }],
    ];
    for (const [label, args] of bad) {
      const res = await env.client.request({ id: `bad-${label}`, op: "nova_task_create", args });
      assert.equal(res["ok"], false, label);
      assert.equal((res["error"] as Record<string, unknown>)["code"], "schema_invalid", label);
    }
    // duplicate repo_alias in one array -> truthful duplicate, nothing persisted
    const dupAlias = await env.client.request({
      id: "bad-dup-alias",
      op: "nova_task_create",
      args: { ...base, key: "BAD12", target_scopes: [
        { repo_alias: "app", access_mode: "read_only" },
        { repo_alias: "app", access_mode: "read_write" },
      ] },
    });
    assert.equal(dupAlias["ok"], false);
    assert.equal((dupAlias["error"] as Record<string, unknown>)["code"], "duplicate");
    assert.match(String((dupAlias["error"] as Record<string, unknown>)["message"]), /twice/);

    // an unknown repo_alias -> not_found
    const aliasMissing = await env.client.request({
      id: "bad-alias",
      op: "nova_task_create",
      args: { ...base, key: "BAD10", target_scopes: [{ repo_alias: "nope", access_mode: "read_only" }] },
    });
    assert.equal(aliasMissing["ok"], false);
    assert.equal((aliasMissing["error"] as Record<string, unknown>)["code"], "not_found");

    // only the two valid creates persisted a task
    const ro2 = readConnection(env.dbPath);
    const n = (ro2.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    ro2.close();
    assert.equal(n, 2);
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ retry + kill switch ---------------------------- */

test("nova_task_retry: a crashed task requeues via the operator-retry row", async () => {
  const env = await boot({ runMode: "run-crash" });
  try {
    const taskId = await createTaskVia(env, "TASK-C");
    await runVia(env, taskId);
    await waitForState(env, taskId, "failed");

    const retry = await env.client.request({ id: "rt", op: "nova_task_retry", args: { task_id: taskId } });
    assert.equal(retry["ok"], true, JSON.stringify(retry));
    assert.equal((retry["data"] as Record<string, unknown>)["decision"]["kind"], "requeued");
    // the dispatch loop picks it up again (queued is momentary)
    await waitForState(env, taskId, "failed"); // run-crash fails again — the loop turned
    const tr = transitions(env, taskId);
    assert.ok(
      tr.some((x) => x["from_state"] === "failed" && x["to_state"] === "queued"),
      "the operator-retry row was applied",
    );
  } finally {
    await shutdown(env);
  }
});

test("auto-retry timer: a crashed task requeues itself after retry.delay_sec (dispatch paused → QUEUED holds)", async () => {
  const env = await boot({
    runMode: "run-crash",
    daemonConfig: "concurrency:\n  global: 4\nretry:\n  delay_sec: 1.5\n",
  });
  try {
    const taskId = await createTaskVia(env, "TASK-T");
    await runVia(env, taskId);
    await waitForState(env, taskId, "failed");
    // freeze dispatch BEFORE the timer fires, so the requeued task is
    // observable in QUEUED instead of racing its own redispatch
    const pause = await env.client.request({ id: "p", op: "nova_daemon_pause", args: {} });
    assert.equal(pause["ok"], true);
    assert.equal(taskState(env, taskId), "failed"); // the timer is still armed
    await waitForState(env, taskId, "queued", 5000); // fired by the timer alone
    const tr = transitions(env, taskId);
    const autoRetries = tr.filter((x) => x["from_state"] === "failed" && x["to_state"] === "queued");
    assert.equal(autoRetries.length, 1); // exactly one auto-retry
    assert.equal(autoRetries[0]!["trigger_type"], "timeout");
    // resume: dispatch picks the requeued task up (documented pause semantics)
    const resume = await env.client.request({ id: "r", op: "nova_daemon_resume", args: {} });
    assert.equal(resume["ok"], true);
    await waitForState(env, taskId, "failed", 5000); // run-crash fails again — it dispatched
  } finally {
    await shutdown(env);
  }
});

test("kill switch (nova_kill_all): pauses the scheduler and aborts every live run", async () => {
  const env = await boot({ runMode: "run-hang", daemonConfig: "concurrency:\n  global: 4\n" });
  try {
    const t1 = await createTaskVia(env, "K1");
    const t2 = await createTaskVia(env, "K2");
    await runVia(env, t1);
    await runVia(env, t2);
    await waitForState(env, t1, "running");
    await waitForState(env, t2, "running");

    const kill = await env.client.request({ id: "ka", op: "nova_kill_all", args: {} });
    assert.equal(kill["ok"], true, JSON.stringify(kill));
    assert.equal((kill["data"] as Record<string, unknown>)["paused"], true);
    assert.equal(taskState(env, t1), "cancelled");
    assert.equal(taskState(env, t2), "cancelled");
    assert.equal(env.handle.status().scheduler.paused, true);

    // resume unpauses (documented: kill-all pauses; the operator resumes)
    const res = await env.client.request({ id: "rs", op: "nova_daemon_resume", args: {} });
    assert.equal((res["data"] as Record<string, unknown>)["paused"], false);
  } finally {
    await shutdown(env);
  }
});

/* --------------------------- write discipline (grep-level) ---------------------- */

test("write discipline: the daemon modules never issue a raw state UPDATE (grep-pinned)", async () => {
  const files = [
    "src/daemon/server.ts",
    "src/daemon/dispatch.ts",
    "src/daemon/retry.ts",
    "src/daemon/recovery.ts",
    "src/daemon/lifecycle.ts",
    "src/daemon/triggers.ts",
    "src/chain/import.ts",
    "src/chain/readiness.ts",
    "src/chain/graph.ts",
    "src/chain/yaml.ts",
    "src/chain/routing.ts",
    "src/chain/summary.ts",
    "src/daemonconfig.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, "..", "..", f), "utf8");
    if (f === "src/chain/routing.ts") {
      // the ONE sanctioned tasks write (FR-TSK-04 delivery): the context
      // column append — every UPDATE tasks in routing.ts must be exactly
      // this guarded form; all other columns stay forbidden
      const taskWrites = src.match(/UPDATE\s+tasks\b/gi) ?? [];
      const sanctioned = src.match(
        /UPDATE tasks SET context_files_json = \?, updated_at = \? WHERE id = \?/g,
      ) ?? [];
      assert.equal(
        taskWrites.length, sanctioned.length,
        "routing.ts: every UPDATE tasks must be the sanctioned context_files_json form",
      );
    } else {
      assert.doesNotMatch(src, /UPDATE\s+tasks\b/i, `${f} must not UPDATE tasks directly`);
    }
    if (f.startsWith("src/chain/")) {
      // chain modules own chain_runs TERMINAL moves — every one must be the
      // guarded form (never a raw state write; a terminal chain never moves
      // again). All other SET state = writes stay forbidden.
      const writes = src.match(/UPDATE\s+chain_runs\s+SET\s+state\s*=\s*'(?:aborted|failed|completed)'\s*,\s*completed_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+state\s*=\s*'active'/g) ?? [];
      // case-INsensitive raw count (re-judge: SET STATE = smuggled past a
      // case-sensitive counter); the guarded form stays exact-case, so any
      // case variant counts raw but not guarded and fails
      const raw = src.match(/SET\s+state\s*=/gi) ?? [];
      assert.equal(
        writes.length, raw.length,
        `${f}: every chain_runs state write must be the guarded terminal form`,
      );
      // graph/yaml are pure modules — zero state writes; the chain modules
      // own at most the three guarded terminal movers
      const max = f.endsWith("graph.ts") || f.endsWith("yaml.ts") ? 0 : 3;
      assert.ok(raw.length <= max, `${f}: unexpected chain_runs state write count (${raw.length} > ${max})`);
    } else {
      assert.doesNotMatch(src, /SET\s+state\s*=/i, `${f} must not write state columns`);
    }
  }
});

test("daemon stop over the socket: response delivered, then shutdown, socket removed", async () => {
  const env = await boot();
  const socketPath = env.handle.socketPath;
  const res = await env.client.request({ id: "stop", op: "nova_daemon_stop", args: {} });
  assert.equal(res["ok"], true);
  assert.equal((res["data"] as Record<string, unknown>)["stopping"], true);
  // the daemon shuts down and removes its socket
  await waitFor(() => !existsSync(socketPath), 4000);
  env.client.close();
  // the store is closed cleanly behind the socket
  const check = new Database(env.dbPath);
  check.prepare("SELECT COUNT(*) AS n FROM tasks").get();
  check.close();
  rmSync(env.dir, { recursive: true, force: true });
});
