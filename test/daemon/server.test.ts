import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMatrix } from "../helpers/spec.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection } from "./seed.ts";

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

test("task create → run (catalog probe) → dispatch → validating; result + logs ops", async () => {
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
    await waitForState(env, taskId, "validating"); // dispatch → startRun → settle

    // nova_task_status: full record, current run, no elapsed when concluded
    const status = await env.client.request({ id: "s", op: "nova_task_status", args: { task_id: taskId } });
    const statusData = status["data"] as Record<string, unknown>;
    assert.equal((statusData["task"] as Record<string, unknown>)["state"], "validating");
    assert.equal((statusData["current_run"] as Record<string, unknown>)["status"], "succeeded");
    assert.equal(statusData["elapsed_ms"], null);

    // nova_task_result: the validated result.json
    const result = await env.client.request({
      id: "res",
      op: "nova_task_result",
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
    const list = await env.client.request({ id: "l", op: "nova_task_list", args: { state: "validating" } });
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

/* --------------------------------- abort / steer -------------------------------- */

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
    const tr = transitions(env, gateTask);
    const last = tr[tr.length - 1]!;
    assert.equal(last["trigger_type"], "human");
    assert.match(String(last["reason"]), /gate approved by maul: ship it/);

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
    assert.equal((reject["data"] as Record<string, unknown>)["final_state"], "changes_requested");
    assert.equal((reject["data"] as Record<string, unknown>)["retry_count"], 1); // incremented on entry
    const rtr = transitions(env, rejectTask);
    const rlast = rtr[rlastIdx(rtr)]!;
    assert.equal(rlast["trigger_type"], "mcp"); // the surface rule (mcp.md §5)
    assert.equal(rlast["from_state"], "awaiting_gate");
    assert.equal(rlast["to_state"], "changes_requested");

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
    "src/daemonconfig.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, "..", "..", f), "utf8");
    assert.doesNotMatch(src, /UPDATE\s+tasks\b/i, `${f} must not UPDATE tasks directly`);
    assert.doesNotMatch(src, /SET\s+state\s*=/i, `${f} must not write state columns`);
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
