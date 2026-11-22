import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import novaflowFactory, { runNovaCommand } from "../../extensions/novaflow.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { seedFileStore } from "../daemon/seed.ts";
import { daemonRequest } from "../../src/cli/client.ts";
import { waitFor } from "../daemon/client.ts";
import { withBound } from "../helpers/bound.ts";

/**
 * Operator-mode coverage over a LIVE daemon (the p5 MCP harness
 * pattern: seeded file store, stub-pi runs driven to awaiting_gate,
 * NOVAFLOW_SOCK/NOVAFLOW_HOME pointed at the temp home). The /nova
 * command family is driven directly through the real
 * ExtensionCommandContext shape (a notify-capturing double), and the
 * daemon-side effects are asserted through the store the daemon owns.
 *
 * Attribution pin (§5 of the client's contract): every op the
 * extension issues rides surface "human" — the gate transitions it
 * triggers must record trigger_type 'human' exactly like the CLI's.
 */

const REPO = join(import.meta.dirname, "..", "..");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");
const BOUND_MS = 30_000;

type Note = { message: string; severity: string };

function fakeCmdCtx(cwd: string): { ctx: ExtensionCommandContext; notes: Note[] } {
  const notes: Note[] = [];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, severity: "info" | "warning" | "error") => {
        notes.push({ message, severity });
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notes };
}

function transitions(dbPath: string, taskId: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT from_state, to_state, trigger_type, actor FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, rowid",
      )
      .all(taskId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

test("operator mode over a live daemon: status, queue, plan, gate approve, gate reject", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-ext-op-"));
  const seeded = seedFileStore(dir, "op");
  const sockPath = join(dir, "novaflow.sock");
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 2\n");
  process.env["NOVAFLOW_SOCK"] = sockPath;
  process.env["NOVAFLOW_HOME"] = join(dir, "novahome");
  process.env["NOVAFLOW_DB"] = seeded.dbPath;
  mkdirSync(process.env["NOVAFLOW_HOME"]!);
  // the active-workspace marker (the CLI's own local state): the /nova
  // key-form identifiers resolve within it, exactly like nova task …
  writeFileSync(join(process.env["NOVAFLOW_HOME"]!, "active-workspace"), "op\n");
  delete process.env["NOVAFLOW_RUN_CONTEXT"];
  let handle: DaemonHandle | undefined;
  try {
    handle = await withBound(
      t.signal,
      BOUND_MS,
      startDaemon({
        dbPath: seeded.dbPath,
        socketPath: sockPath,
        daemonConfigPath: cfgPath,
        probePiBin: "node",
        probeArgs: [STUB, "ok"],
        runPiBin: "node",
        runArgs: [STUB, "run-blocked"],
        extensionPath: join(REPO, "extensions", "novaflow.ts"),
        pricesPath: join(dir, "no-prices.json"),
        killGraceMs: 300,
        tickMs: 30,
      }),
    );

    // ---- /nova status: daemon + active workspace ----
    const st = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("status", st.ctx));
    const stMsg = st.notes.map((n) => n.message).join("\n");
    assert.ok(/novaflow daemon/.test(stMsg), `daemon line rendered: ${JSON.stringify(st.notes)}`);
    assert.ok(/runner: \d+ running/.test(stMsg), `runner status rendered: ${JSON.stringify(st.notes)}`);
    assert.ok(/op \(active\)/.test(stMsg), `the active workspace is named: ${JSON.stringify(st.notes)}`);

    // ---- /nova plan: graceful empty answer ----
    const plan = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("plan", plan.ctx));
    assert.ok(plan.notes.length > 0, "plan renders something even with no chains");
    assert.ok(/chain/i.test(plan.notes.map((n) => n.message).join("\n")));

    // ---- /nova queue: empty, then a task waiting at the gate ----
    const emptyQ = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("queue", emptyQ.ctx));
    assert.ok(/queued/i.test(emptyQ.notes.map((n) => n.message).join("\n")));

    // drive a gated task to awaiting_gate through the daemon ops (the
    // operator's own creation path), then read it back through /nova queue
    const created = (await withBound(
      t.signal,
      BOUND_MS,
      daemonRequest("nova_task_create", {
        project_id: seeded.projectId,
        key: "OPG-1",
        title: "Operator gate task",
        objective: "Prove the /nova gate surface drives the engine.",
        profile_name: "dev",
        requires_human_gate: true,
      }),
    )) as { task: { id: string; key: string; state: string } };
    const taskId = created.task.id;
    await withBound(t.signal, BOUND_MS, daemonRequest("nova_task_run", { task_id: taskId, actor: "operator" }));
    await withBound(
      t.signal,
      20_000,
      waitFor(async () => {
        const stt = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
          task: { state: string };
        };
        return stt.task.state === "awaiting_gate";
      }, 20_000),
    );

    const q = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("queue", q.ctx));
    const qMsg = q.notes.map((n) => n.message).join("\n");
    assert.ok(/OPG-1/.test(qMsg), `the queued gate task is listed: ${JSON.stringify(q.notes)}`);
    assert.ok(/awaiting_gate/i.test(qMsg));

    // ---- /nova gate approve <key> → the engine validates and completes ----
    const approve = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("gate approve OPG-1 ship it from chat", approve.ctx));
    const apMsg = approve.notes.map((n) => n.message).join("\n");
    assert.ok(/\(gate approved\)/.test(apMsg), `the approval is rendered: ${JSON.stringify(approve.notes)}`);
    await withBound(
      t.signal,
      20_000,
      waitFor(async () => {
        const stt = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
          task: { state: string };
        };
        return stt.task.state === "completed";
      }, 20_000),
    );

    // the attribution pin: the chat-triggered gate transition is human-surfaced
    const gateRow = transitions(seeded.dbPath, taskId).find((r) => r["to_state"] === "validating");
    assert.ok(gateRow !== undefined, "the awaiting_gate→validating row exists");
    assert.equal(gateRow["trigger_type"], "human", "the extension's ops ride surface 'human'");

    // ---- /nova gate reject <key> <feedback> → the failure path with feedback ----
    const created2 = (await withBound(
      t.signal,
      BOUND_MS,
      daemonRequest("nova_task_create", {
        project_id: seeded.projectId,
        key: "OPG-2",
        title: "Operator reject task",
        objective: "Prove the /nova gate reject path.",
        profile_name: "dev",
        requires_human_gate: true,
      }),
    )) as { task: { id: string } };
    const taskId2 = created2.task.id;
    await withBound(t.signal, BOUND_MS, daemonRequest("nova_task_run", { task_id: taskId2, actor: "operator" }));
    await withBound(
      t.signal,
      20_000,
      waitFor(async () => {
        const stt = (await daemonRequest("nova_task_status", { task_id: taskId2 })) as {
          task: { state: string };
        };
        return stt.task.state === "awaiting_gate";
      }, 20_000),
    );
    const reject = fakeCmdCtx(dir);
    await withBound(
      t.signal,
      BOUND_MS,
      runNovaCommand("gate reject OPG-2 the feedback from chat", reject.ctx),
    );
    const rjMsg = reject.notes.map((n) => n.message).join("\n");
    assert.ok(/\(retry 1\)/.test(rjMsg), `the rejection with feedback is rendered: ${JSON.stringify(reject.notes)}`);

    // ---- /nova status with a project argument shows the project's state ----
    const stp = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("status prj", stp.ctx));
    const stpMsg = stp.notes.map((n) => n.message).join("\n");
    assert.ok(/project prj/.test(stpMsg), `the project status renders: ${JSON.stringify(stp.notes)}`);

    // ---- an unknown project surfaces the daemon's not_found as a chat error ----
    const stBad = fakeCmdCtx(dir);
    await withBound(t.signal, BOUND_MS, runNovaCommand("status no-such-project", stBad.ctx));
    assert.ok(
      stBad.notes.some((n) => n.severity === "error" && /not_found/.test(n.message)),
      `op failures render as structured errors: ${JSON.stringify(stBad.notes)}`,
    );
  } finally {
    delete process.env["NOVAFLOW_SOCK"];
    delete process.env["NOVAFLOW_HOME"];
    delete process.env["NOVAFLOW_DB"];
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator mode: the factory registers exactly one command, /nova, and no tools", () => {
  delete process.env["NOVAFLOW_RUN_CONTEXT"];
  const tools: Array<{ name: string }> = [];
  const commands: Array<{ name: string }> = [];
  const api = {
    on: () => () => undefined,
    registerTool: (def: { name: string }) => tools.push(def),
    registerCommand: (name: string) => commands.push({ name }),
  } as unknown as Parameters<typeof novaflowFactory>[0];
  novaflowFactory(api);
  assert.deepEqual(commands.map((c) => c.name), ["nova"]);
  assert.deepEqual(tools, []);
  assert.ok(typeof api === "object");
});

test("operator mode: the run-mode env var set to an empty string is still operator mode", () => {
  process.env["NOVAFLOW_RUN_CONTEXT"] = "";
  try {
    const commands: Array<{ name: string }> = [];
    const api = {
      on: () => () => undefined,
      registerTool: () => undefined,
      registerCommand: (name: string) => commands.push({ name }),
    } as unknown as Parameters<typeof novaflowFactory>[0];
    novaflowFactory(api);
    assert.deepEqual(commands.map((c) => c.name), ["nova"]);
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
  }
});

test("operator mode: the registered handler dispatches the same surface as runNovaCommand", async () => {
  // the handler registered with pi must be the tested one — capture it
  let captured: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const api = {
    on: () => () => undefined,
    registerTool: () => undefined,
    registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      captured = options.handler;
    },
  } as unknown as Parameters<typeof novaflowFactory>[0];
  novaflowFactory(api);
  assert.ok(captured !== undefined);
  const { ctx, notes } = fakeCmdCtx(process.cwd());
  process.env["NOVAFLOW_SOCK"] = join(tmpdir(), "novaflow-definitely-missing.sock");
  try {
    await captured!("status", ctx);
    assert.ok(notes.some((n) => n.severity === "error" && /daemon unreachable/.test(n.message)));
  } finally {
    delete process.env["NOVAFLOW_SOCK"];
  }
});
