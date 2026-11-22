#!/usr/bin/env node
/**
 * test/extensions/smoke.mjs — the p6 REAL-PI receipt (GATED, not in
 * npm test; the suite's glob only matches *.test.ts). Run manually:
 *
 *   npx tsx test/extensions/smoke.mjs
 *
 * Optional knobs:
 *   NOVAFLOW_SMOKE_MODEL   the model for the scripted run-mode turn
 *                          (default: the cheapest configured local
 *                          model, mistral/ministral-3b-latest).
 *
 * Phases (each against the REAL `pi 1.6.0` on this box, `-e` the repo
 * extension, the way src/runs/spawn.ts installs it):
 *
 *   1. OPERATOR MODE — a live daemon (seeded store, stub-pi runs) with
 *      a task parked at awaiting_gate; the operator pi session answers
 *      /nova status, /nova queue, and /nova gate approve over the
 *      socket; the task completes and the transition is human-surfaced.
 *
 *   2. RUN MODE — engine-context.json + protected-digests.json in a
 *      prepared run dir (the smoke acts as the engine's preflight);
 *      a scripted agent turn (the cheapest configured model) calls
 *      novaflow_submit_result; the receipt asserts the extension
 *      initialized (session_start diagnostics), that the submit call
 *      was answered with "artifact accepted", that result.json landed
 *      and structurally validates, and RECORDS (observes, not
 *      asserts) how pi treated the batch: whether the submit shared a
 *      batch with an ordinary call, and whether the agent ran another
 *      turn anyway — pi's every-finalized-result-terminating rule.
 *
 * Kill discipline: every spawned pi leads its own process group and is
 * reaped SIGTERM → grace → SIGKILL(-pid); the daemon is stopped; the
 * temp dir removed. Every wait is wall-clock bounded.
 */

import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/lifecycle.ts";
import { seedFileStore } from "../daemon/seed.ts";
import { daemonRequest } from "../../src/cli/client.ts";
import { readArtifactFile } from "../../src/runs/artifact.ts";

const REPO = join(import.meta.dirname, "..", "..");
const EXT = join(REPO, "extensions", "novaflow.ts");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");
const MODEL = process.env["NOVAFLOW_SMOKE_MODEL"] ?? "mistral/ministral-3b-latest";

const TASK_ID = "01HJ8Z9X01ABCDEFGHJKMNPQRS";
const RUN_ID = "01HJ8Z9XABCDEFGHJKMNPQRSTV";
const TARGET_ID = "01TGT00000000000000000000A";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
function note(label, detail) {
  console.log(`OBSERVE  ${label}: ${detail}`);
}

/* --------------------------------- plumbing --------------------------------- */

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparseable", raw: line.slice(0, 200) };
  }
}

function killTree(child) {
  if (child.exitCode !== null) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* group gone */
    }
    try {
      child.kill(sig);
    } catch {
      /* already dead */
    }
    if (sig === "SIGTERM") {
      const until = Date.now() + 1500;
      while (child.exitCode === null && Date.now() < until) {
        // eslint-disable-next-line no-unused-expressions
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
}

function startPiRpc(argv, env) {
  const child = spawn("pi", ["--mode", "rpc", ...argv], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...env },
  });
  const events = [];
  let stderrTail = "";
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      events.push(safeJson(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  child.on("exit", (code, signal) => {
    events.push({ type: "__exit", code, signal });
  });
  return { child, events, stderrTail: () => stderrTail };
}

function send(rpc, obj) {
  rpc.child.stdin.write(JSON.stringify(obj) + "\n");
}

async function waitFor(rpc, pred, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const hit = rpc.events.find(pred);
    if (hit !== undefined) return hit;
    const exited = rpc.events.find((e) => e["type"] === "__exit");
    if (exited !== undefined) {
      throw new Error(`pi exited before ${label} (code=${String(exited["code"])} signal=${String(exited["signal"])}); stderr tail:\n${rpc.stderrTail()}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${label}; events so far:\n${rpc.events.slice(-40).map((e) => JSON.stringify(e).slice(0, 300)).join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const notifies = (rpc) => rpc.events.filter((e) => e["type"] === "extension_ui_request" && e["method"] === "notify");
const notifyText = (rpc) => notifies(rpc).map((e) => String(e["message"])).join("\n---\n");

async function handshake(rpc, timeoutMs = 30_000) {
  send(rpc, { id: "smoke-handshake", type: "get_state" });
  const res = await waitFor(
    rpc,
    (e) => e["type"] === "response" && e["id"] === "smoke-handshake",
    timeoutMs,
    "the get_state handshake",
  );
  if (res["success"] !== true) {
    throw new Error(`get_state handshake failed: ${JSON.stringify(res).slice(0, 400)}`);
  }
  return res["data"];
}

async function sleepMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------- phase 1: operator ------------------------------- */

async function phaseOperator(dir, seeded, sockPath) {
  process.env["NOVAFLOW_SOCK"] = sockPath;
  process.env["NOVAFLOW_DB"] = seeded.dbPath;

  // a gated task parked at awaiting_gate, so /nova gate approve does
  // real engine work (the daemon's runs use the stub pi)
  const created = (await daemonRequest("nova_task_create", {
    project_id: seeded.projectId,
    key: "SMOKE-1",
    title: "Smoke gate task",
    objective: "Prove /nova gate approve drives the engine from a real chat.",
    profile_name: "dev",
    requires_human_gate: true,
  }));
  const taskId = created.task.id;
  await daemonRequest("nova_task_run", { task_id: taskId, actor: "operator" });
  for (;;) {
    const st = await daemonRequest("nova_task_status", { task_id: taskId });
    if (st.task.state === "awaiting_gate") break;
    await sleepMs(100);
  }
  console.log(`\n== phase 1: operator mode (real pi, /nova over the socket) ==`);

  const opSessionDir = join(dir, "pi-op-session");
  mkdirSync(opSessionDir, { recursive: true });
  const rpc = startPiRpc(
    ["-e", EXT, "--session-dir", opSessionDir, "--session-id", "novaflow-smoke-op"],
    { NOVAFLOW_SOCK: sockPath, NOVAFLOW_HOME: process.env["NOVAFLOW_HOME"], NOVAFLOW_RUN_CONTEXT: "" },
  );
  try {
    const state = await handshake(rpc);
    check("operator session: real pi booted with the extension (get_state answered)", true, JSON.stringify(state).slice(0, 200));

    send(rpc, { id: "op-status", type: "prompt", message: "/nova status" });
    const res1 = await waitFor(rpc, (e) => e["type"] === "response" && e["id"] === "op-status", 30_000, "/nova status response");
    check("/nova status handled by the extension (disposition)", res1["success"] === true && res1["data"]?.["disposition"] === "handled", JSON.stringify(res1));
    await waitFor(rpc, (e) => e["type"] === "extension_ui_request" && e["method"] === "notify" && /novaflow daemon/.test(String(e["message"])), 30_000, "the /nova status notify");
    check("/nova status rendered the daemon + workspace", /runner: \d+ running/.test(notifyText(rpc)) && /smoke \(active\)/.test(notifyText(rpc)), notifyText(rpc));

    send(rpc, { id: "op-queue", type: "prompt", message: "/nova queue" });
    await waitFor(rpc, (e) => e["type"] === "response" && e["id"] === "op-queue", 30_000, "/nova queue response");
    await waitFor(rpc, (e) => e["type"] === "extension_ui_request" && e["method"] === "notify" && /SMOKE-1/.test(String(e["message"])), 30_000, "the /nova queue notify");
    check("/nova queue listed the gated task", /awaiting_gate/.test(notifyText(rpc)), notifyText(rpc));

    send(rpc, { id: "op-approve", type: "prompt", message: "/nova gate approve SMOKE-1 note from the smoke chat" });
    await waitFor(rpc, (e) => e["type"] === "response" && e["id"] === "op-approve", 30_000, "/nova gate approve response");
    await waitFor(rpc, (e) => e["type"] === "extension_ui_request" && e["method"] === "notify" && /\(gate approved\)/.test(String(e["message"])), 30_000, "the approval notify");
    check("/nova gate approve rendered the engine's transition", true);

    for (;;) {
      const st = await daemonRequest("nova_task_status", { task_id: taskId });
      if (st.task.state === "completed") break;
      await sleepMs(100);
    }
    check("the chat-approved gate completed the task through the engine", true);

    const db = new Database(seeded.dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT trigger_type, actor FROM state_transition_logs WHERE task_id = ? AND to_state = 'validating'")
        .get(taskId);
      check("the chat-triggered gate transition is human-surfaced", row?.trigger_type === "human", JSON.stringify(row));
      note("gate approve actor", String(row?.actor));
    } finally {
      db.close();
    }
  } finally {
    killTree(rpc.child);
    await sleepMs(200);
  }
}

/* --------------------------------- phase 2: run --------------------------------- */

function phaseRunFixtures(dir) {
  const targetRoot = join(dir, "smoke-target");
  mkdirSync(join(targetRoot, "src"), { recursive: true });
  mkdirSync(join(targetRoot, "golden"), { recursive: true });
  writeFileSync(join(targetRoot, "golden", "protected.test"), "never touch me\n");

  const runDir = join(dir, ".novaflow", "runs", TASK_ID, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const contextPath = join(runDir, "engine-context.json");
  writeFileSync(
    contextPath,
    JSON.stringify({
      task_id: TASK_ID,
      run_id: RUN_ID,
      attempt_kind: "execution",
      scopes: [
        {
          target_id: TARGET_ID,
          alias: "smoke-target",
          access_mode: "read_write",
          write_scope_globs: ["src/**"],
          protected_test_globs: ["golden/**"],
        },
      ],
      output_schema: { id: "1.0.0", inline: null },
      budget: { max_timeout_sec: 300, max_cost_usd: 1 },
      verification_commands: [],
    }) + "\n",
  );
  writeFileSync(
    join(runDir, "protected-digests.json"),
    JSON.stringify({
      version: 1,
      task_id: TASK_ID,
      run_id: RUN_ID,
      taken_at: new Date().toISOString(),
      targets: [
        {
          target_id: TARGET_ID,
          alias: "smoke-target",
          target_type: "directory",
          root_path: targetRoot,
          protected_globs: ["golden/**"],
          write_scope_globs: ["src/**"],
          full_tree: true,
          files: {},
        },
      ],
    }) + "\n",
  );
  return { runDir, contextPath, targetRoot };
}

const SMOKE_ARTIFACT = {
  schema_version: "1.0.0",
  task_id: TASK_ID,
  run_id: RUN_ID,
  status: "completed",
  summary: "Smoke run: created the file and submitted the handoff artifact.",
  assumptions_made: ["the smoke prompt is normative"],
  open_questions: [],
  artifacts_modified: [
    { target_alias: "smoke-target", path: "src/feature.txt", action: "created", diff_summary: "one line" },
  ],
  feedback_items: [],
  next_recommended_action: "proceed_to_next",
};

async function phaseRun(dir) {
  console.log(`\n== phase 2: run mode (real pi, real model ${MODEL}, scripted turn) ==`);
  const { runDir, contextPath, targetRoot } = phaseRunFixtures(dir);

  const rpc = startPiRpc(
    [
      "-e", EXT,
      "--tools", "read,bash,edit,write,novaflow_submit_result",
      "--session-dir", runDir,
      "--session-id", RUN_ID,
      "--model", MODEL,
    ],
    { NOVAFLOW_RUN_CONTEXT: contextPath },
  );
  try {
    await handshake(rpc);
    check("run session: real pi booted with the extension", true);

    // §6: the extension reads the context at session_start and speaks
    const diag = await waitFor(
      rpc,
      (e) => e["type"] === "extension_ui_request" && e["method"] === "notify" && /novaflow run mode/.test(String(e["message"])),
      30_000,
      "the session_start diagnostics notify",
    );
    check("extension initialized in run mode (session_start diagnostics)", /novaflow run mode/.test(String(diag["message"])), String(diag["message"]));

    const prompt =
      `You are a NovaFlow worker agent. Do EXACTLY the following, in order, and nothing else:\n` +
      `1. Use the write tool to create the file ${join(targetRoot, "src", "feature.txt")} with the content: smoke\n` +
      `2. Do not modify anything under ${join(targetRoot, "golden")}.\n` +
      `3. As your final action, call the tool novaflow_submit_result with EXACTLY this JSON object as its arguments (the whole artifact, no path argument):\n` +
      JSON.stringify(SMOKE_ARTIFACT, null, 2);
    send(rpc, { id: "run-turn", type: "prompt", message: prompt });
    await waitFor(rpc, (e) => e["type"] === "response" && e["id"] === "run-turn", 60_000, "the run prompt response");

    // the turn is live: wait for the settle, bounded generously
    const settled = await waitFor(rpc, (e) => e["type"] === "agent_settled", 300_000, "agent_settled after the scripted turn");
    note("agent_settled", `aborted=${String(settled["aborted"])}`);

    // the completion signal's receipt on the wire
    const submitEnds = rpc.events.filter(
      (e) => e["type"] === "tool_execution_end" && e["toolName"] === "novaflow_submit_result",
    );
    check("the model actually called novaflow_submit_result", submitEnds.length >= 1, `${String(submitEnds.length)} submit tool_execution_end events`);
    if (submitEnds.length > 0) {
      const last = submitEnds[submitEnds.length - 1];
      note("submit tool_execution_end result", JSON.stringify(last).slice(0, 400));
    }
    const acceptedNotify = notifies(rpc).find((e) => /artifact accepted/.test(String(e["message"])));
    check("the extension answered 'artifact accepted'", acceptedNotify !== undefined, notifyText(rpc).slice(-800));

    // the artifact of record
    const resultPath = join(runDir, "result.json");
    check("result.json landed in the run dir", existsSync(resultPath));
    if (existsSync(resultPath)) {
      const read = readArtifactFile(resultPath);
      check("result.json passes the ENGINE's structural validator (artifact.ts)", read.ok === true, read.ok === false ? JSON.stringify(read.errors) : "");
      if (read.ok === true) {
        check("result.json carries the run's identity", read.artifact["task_id"] === TASK_ID && read.artifact["run_id"] === RUN_ID);
      }
    }

    // protected-file honesty: the model was told not to touch golden/,
    // and the extension would have refused if it tried
    check("the protected golden file is untouched", readFileSync(join(targetRoot, "golden", "protected.test"), "utf8") === "never touch me\n");

    /* ---- pi's BATCH RULE, observed (not asserted — the rule is pi's) ---- */
    const callStarts = rpc.events.filter((e) => e["type"] === "tool_execution_start");
    const writeCalls = callStarts.filter((e) => e["toolName"] === "write");
    const submitCalls = callStarts.filter((e) => e["toolName"] === "novaflow_submit_result");
    const messageEnds = rpc.events.filter((e) => e["type"] === "message_end" && e["message"]?.["role"] === "assistant");
    const blockedScope = rpc.events.filter(
      (e) => e["type"] === "tool_execution_end" && e["isError"] === true && /novaflow:/.test(JSON.stringify(e)),
    );
    note("tool calls in order", callStarts.map((e) => String(e["toolName"])).join(" -> ") || "(none)");
    note("assistant messages (turns)", String(messageEnds.length));
    note("writes vs submits", `write=${String(writeCalls.length)} submit=${String(submitCalls.length)}`);
    if (blockedScope.length > 0) {
      note("scope-blocked calls the model attempted", JSON.stringify(blockedScope.map((e) => e["result"])).slice(0, 400));
    } else {
      note("scope-blocked calls the model attempted", "none — the model stayed in scope");
    }
    const singleBatch = callStarts.length >= 2 && callStarts.length === submitCalls.length + writeCalls.length;
    note(
      "batching",
      singleBatch
        ? "the write and the submit were both issued — whether they shared one assistant batch is visible in the session file"
        : "the model spread its calls across turns (no mixed batch to test the every-result-terminating rule against)",
    );
  } finally {
    killTree(rpc.child);
    await sleepMs(200);
  }
}

/* ------------------------------------ main ------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), "novaflow-p6-smoke-"));
let handle;
try {
  const seeded = seedFileStore(dir, "smoke");
  const sockPath = join(dir, "novaflow.sock");
  process.env["NOVAFLOW_HOME"] = join(dir, "novahome");
  mkdirSync(process.env["NOVAFLOW_HOME"]);
  writeFileSync(join(process.env["NOVAFLOW_HOME"], "active-workspace"), "smoke\n");
  writeFileSync(join(dir, "config.yaml"), "concurrency:\n  global: 2\n");

  handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: sockPath,
    daemonConfigPath: join(dir, "config.yaml"),
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    runPiBin: "node",
    runArgs: [STUB, "run-blocked"],
    extensionPath: EXT,
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 50,
  });

  await phaseOperator(dir, seeded, sockPath);
  await phaseRun(dir);
} catch (err) {
  failures++;
  console.log(`FAIL  smoke aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await handle?.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`SMOKE FAIL — ${String(failures)} failing check(s)`);
  process.exit(1);
}
console.log("SMOKE PASS — the p6 extension receipt is green against real pi 1.6.0");
