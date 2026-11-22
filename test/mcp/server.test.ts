import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNovaMcpServer, type McpServerOptions } from "../../src/mcp/server.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { seedFileStore } from "../daemon/seed.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";
import { redactLine } from "../../src/runs/redact.ts";
import { runLogs } from "../../src/daemon/readops.ts";
import { waitFor } from "../daemon/client.ts";

/**
 * The translation layer under test: an MCP client speaks to the real
 * server object over the SDK's in-memory transport, and we observe the
 * EXACT frames the server sends on the loopback control socket.
 *
 * `surface: "mcp"` on every request is the audit rule (mcp.md §5) — the
 * fake socket below records the raw request line so the test can assert
 * it, not a refactored equivalent.
 */

type Frame = { id: unknown; surface?: string; op: string; args: Record<string, unknown> };

type FakeDaemon = {
  socketPath: string;
  frames: Frame[];
  close: () => Promise<void>;
};

/**
 * A stand-in for src/daemon/server.ts: same JSONL wire contract, one
 * scripted answer per op. The MCP server cannot tell it from the daemon
 * — which is the point (it is a thin client).
 */
async function fakeDaemon(
  dir: string,
  answer: (frame: Frame) => Record<string, unknown>,
): Promise<FakeDaemon> {
  const socketPath = join(dir, "fake-d.sock");
  const frames: Frame[] = [];
  const sockets = new Set<Socket>();
  const held: string[] = [];
  const server: TcpServer = createTcpServer();
  server.on("connection", (sock: Socket) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        held.push(line);
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        sock.write(JSON.stringify(answer(frame)) + "\n");
      }
    });
    sock.on("error", () => sock.destroy());
  });
  // net.createServer().listen(path) binds a Unix domain socket on POSIX
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    frames,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

type Harness = {
  client: Client;
  server: ReturnType<typeof createNovaMcpServer>;
  close: () => Promise<void>;
};

async function harness(opts: McpServerOptions): Promise<Harness> {
  const server = createNovaMcpServer(opts);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "p5-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A migrated read-only store with one workspace/project/task/run. */
type Seeded = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string;
};

function seed(dir: string): Seeded {
  const dbPath = join(dir, "state.db");
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot, { recursive: true });
  const db: Database.Database = openDb(dbPath);
  migrate(db);
  const workspaceId = ulid();
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(
    workspaceId,
    wsRoot,
  );
  const projectId = ulid();
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(projectId, workspaceId);
  const profileId = ulid();
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, ?, 'dev', 'anthropic', 'm', 'medium', 'p.md', 3600, 5)`,
  ).run(profileId, workspaceId);
  const taskId = ulid();
  db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
     VALUES (?, ?, 'T1', 'title', 'objective', ?)`,
  ).run(taskId, projectId, profileId);
  const runId = ulid();
  const runDir = join(wsRoot, ".novaflow", "runs", taskId, runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = join(runDir, "events.jsonl");
  // The redacted read surface, written the way src/runs/pump.ts writes it:
  // every stdout line goes VERBATIM to events.raw.jsonl and through
  // redactLine() to events.jsonl. Seeding both files is what lets the test
  // prove the read surface is the scrubbed one and not the raw one.
  const rawLines = [
    JSON.stringify({ type: "message_update", text: "hello" }),
    JSON.stringify({ type: "tool", message: "token sk-abcdefgh12345678 here" }),
  ];
  writeFileSync(join(runDir, "events.raw.jsonl"), rawLines.join("\n") + "\n", { mode: 0o600 });
  writeFileSync(eventsPath, rawLines.map((l) => redactLine(l)).join("\n") + "\n");
  const artifact = {
    schema_version: "1.0.0",
    task_id: taskId,
    run_id: runId,
    status: "completed",
    summary: "did the thing well",
    assumptions_made: [],
    open_questions: [],
    artifacts_modified: [],
    feedback_items: [],
    next_recommended_action: "proceed_to_next",
  };
  const artifactPath = join(runDir, "result.json");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, attempt_number, pi_session_id, pi_session_dir, status,
        preflight_status, model_used, events_log_path, artifact_path, ended_at)
     VALUES (?, ?, 1, ?, ?, 'succeeded', 'passed', 'm', ?, ?, '2026-11-22T00:00:01.000Z')`,
  ).run(runId, taskId, runId, runDir, eventsPath, artifactPath);
  db.close();
  return { dir, dbPath, wsRoot, workspaceId, projectId, taskId, runId };
}

/* ------------------------------ translation ------------------------------ */

test("each read-only tool sends exactly one frame: {op, args, surface: \"mcp\"}", async () => {
  const dir = tmp("novaflow-mcp-xlate-");
  const daemon = await fakeDaemon(dir, () => ({ id: null, ok: true, data: { ok: true } }));
  const h = await harness({ socketPath: daemon.socketPath, dbPath: join(dir, "state.db") });
  try {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["nova_workspace_list", {}],
      ["nova_project_list", { workspace_id: "WS" }],
      ["nova_task_list", { project_id: "PRJ", state: "draft" }],
      ["nova_task_status", { task_id: "T" }],
      ["nova_run_logs", { task_id: "T", run_id: "R", tail_lines: 5 }],
      ["nova_result_get", { task_id: "T", run_id: "R" }],
      ["nova_daemon_status", {}],
    ];
    for (const [name, args] of calls) {
      daemon.frames.length = 0;
      const res = (await h.client.callTool({ name, arguments: args })) as ToolResult;
      assert.equal(res.isError, undefined, `${name} unexpectedly errored: ${JSON.stringify(res)}`);
      assert.equal(daemon.frames.length, 1, `${name} must send exactly one socket frame`);
      const frame = daemon.frames[0]!;
      assert.equal(frame.surface, "mcp", `${name}: surface must be "mcp" (mcp.md §5 audit rule)`);
      assert.equal(frame.op, name, `${name}: the op is the tool name (mcp.md §3 catalog)`);
      assert.deepEqual(frame.args, args, `${name}: args pass through untouched`);
    }
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each mutating tool sends exactly one frame with surface: \"mcp\" and the op's arg shape", async () => {
  const dir = tmp("novaflow-mcp-xlate-mut-");
  const daemon = await fakeDaemon(dir, () => ({ id: null, ok: true, data: { ok: true } }));
  const h = await harness({ socketPath: daemon.socketPath, dbPath: join(dir, "state.db") });
  try {
    const calls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      // [tool, arguments, expected op args]
      ["nova_workspace_create", { name: "ws", path: "/tmp/ws" }, { name: "ws", root_path: "/tmp/ws" }],
      [
        "nova_task_create",
        {
          project_id: "PRJ",
          key: "K",
          title: "T",
          objective: "O",
          profile_name: "dev",
          requires_human_gate: true,
          context_files: ["a.md"],
          overrides: { timeout_sec: 60 },
          target_scopes: [{ repo_alias: "r", access_mode: "read_write" }],
          output_schema_version: "1.0.0",
        },
        {
          project_id: "PRJ",
          key: "K",
          title: "T",
          objective: "O",
          profile_name: "dev",
          requires_human_gate: true,
          context_files: ["a.md"],
          overrides: { timeout_sec: 60 },
          target_scopes: [{ repo_alias: "r", access_mode: "read_write" }],
          output_schema_version: "1.0.0",
        },
      ],
      ["nova_task_run", { task_id: "T" }, { task_id: "T" }],
      ["nova_task_steer", { task_id: "T", message: "hi" }, { task_id: "T", message: "hi" }],
      ["nova_task_abort", { task_id: "T" }, { task_id: "T" }],
      [
        "nova_gate_approve",
        { task_id: "T", run_id: "R", approved_by: "maul", note: "ok" },
        { task_id: "T", run_id: "R", approved_by: "maul", note: "ok" },
      ],
      ["nova_gate_reject", { task_id: "T", feedback: "no" }, { task_id: "T", feedback: "no" }],
      ["nova_chain_abort", { chain_run_id: "C" }, { chain_run_id: "C" }],
      ["nova_kill_all", {}, {}],
    ];
    for (const [name, args, expected] of calls) {
      daemon.frames.length = 0;
      const res = (await h.client.callTool({ name, arguments: args })) as ToolResult;
      assert.equal(res.isError, undefined, `${name} unexpectedly errored: ${JSON.stringify(res)}`);
      assert.equal(daemon.frames.length, 1, `${name} must send exactly one socket frame`);
      const frame = daemon.frames[0]!;
      assert.equal(frame.surface, "mcp", `${name}: mutating calls are attributed to mcp`);
      assert.equal(frame.op, name);
      assert.deepEqual(frame.args, expected, `${name}: args translation`);
    }
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server never mutates on read and never cold-starts the daemon", async () => {
  const dir = tmp("novaflow-mcp-nostart-");
  // no fake daemon at all: every tool call sees a dead socket
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: join(dir, "state.db") });
  try {
    const res = (await h.client.callTool({
      name: "nova_task_run",
      arguments: { task_id: "T" },
    })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.["code"], "daemon_unreachable");
    // no socket file was created by the attempt (no cold start, mcp.md §4)
    assert.equal(existsSync(join(dir, "absent.sock")), false);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------- error taxonomy ---------------------------- */

test("engine error codes pass through verbatim as structured tool errors (mcp.md §4)", async () => {
  const dir = tmp("novaflow-mcp-taxonomy-");
  const engineErrors = [
    "invalid_transition",
    "schema_invalid",
    "not_found",
    "duplicate",
    "aborted",
    "profile_unresolved",
    "preflight_failed",
    "budget_exceeded",
  ];
  let i = 0;
  const daemon = await fakeDaemon(dir, () => {
    const code = engineErrors[i++ % engineErrors.length]!;
    return { id: null, ok: false, error: { code, message: `engine said ${code}` } };
  });
  const h = await harness({ socketPath: daemon.socketPath, dbPath: join(dir, "state.db") });
  try {
    for (const [n, code] of engineErrors.entries()) {
      const res = (await h.client.callTool({
        name: "nova_task_run",
        arguments: { task_id: "T" },
      })) as ToolResult;
      assert.equal(res.isError, true, `${code}: must be a tool error`);
      assert.equal(res.structuredContent?.["code"], code, `code ${n} must survive verbatim`);
      assert.equal(res.structuredContent?.["message"], `engine said ${code}`);
      const text = res.content.map((c) => c.text ?? "").join("\n");
      assert.match(text, new RegExp(code), "the human-readable block names the code too");
    }
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutating tools on a dead socket return daemon_unreachable", async () => {
  const dir = tmp("novaflow-mcp-unreachable-");
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: join(dir, "state.db") });
  try {
    for (const [name, args] of [
      ["nova_workspace_create", { name: "w", path: "/tmp/w" }],
      ["nova_task_create", { project_id: "P", key: "K", title: "t", objective: "o", profile_name: "dev" }],
      ["nova_task_run", { task_id: "T" }],
      ["nova_task_steer", { task_id: "T", message: "m" }],
      ["nova_task_abort", { task_id: "T" }],
      ["nova_gate_approve", { task_id: "T", run_id: "R", approved_by: "a", note: "n" }],
      ["nova_gate_reject", { task_id: "T", feedback: "f" }],
      ["nova_chain_abort", { chain_run_id: "C" }],
      ["nova_kill_all", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = (await h.client.callTool({ name, arguments: args })) as ToolResult;
      assert.equal(res.isError, true, `${name}: isError on a dead socket`);
      assert.equal(res.structuredContent?.["code"], "daemon_unreachable", `${name}: daemon_unreachable`);
      assert.equal(typeof res.structuredContent?.["message"], "string");
    }
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- kill surface parity --------------------------- */

test("kill surface parity: nova_task_abort and nova_kill_all kill the same process trees over MCP", async () => {
  // The card's judge-B concern, "kill-surface parity": the MCP tools must
  // reach the SAME dispatcher kill paths the CLI does — SIGTERM to the run's
  // process group, the loop-owned running→cancelled row, and kill-all's
  // scheduler pause. Observed through the ENGINE's own records (transition
  // rows, task state, the stub's pidfile), never through MCP's wording.
  const dir = tmp("novaflow-mcp-kill-");
  const seeded = seedFileStore(dir);
  const pidfile = join(dir, "stub.pid");
  const sockPath = join(dir, "d.sock");
  const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
  let handle: DaemonHandle | undefined;
  let h: Harness | undefined;
  try {
    handle = await startDaemon({
      dbPath: seeded.dbPath,
      socketPath: sockPath,
      probePiBin: "node",
      probeArgs: [STUB, "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      // ignores SIGTERM: the abort must escalate to the SIGKILL backstop
      runArgs: [STUB, "run-hang-ignore-term", pidfile],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    h = await harness({ socketPath: sockPath, dbPath: seeded.dbPath });
    const mcp = h;

    const createTask = async (key: string): Promise<string> => {
      const res = (await mcp.client.callTool({
        name: "nova_task_create",
        arguments: {
          project_id: seeded.projectId,
          key,
          title: key,
          objective: `objective for ${key}`,
          profile_name: "dev",
        },
      })) as ToolResult;
      assert.equal(res.isError, undefined, JSON.stringify(res));
      return String((res.structuredContent?.["task"] as Record<string, unknown>)["id"]);
    };
    const runTask = async (taskId: string): Promise<void> => {
      const res = (await mcp.client.callTool({
        name: "nova_task_run",
        arguments: { task_id: taskId },
      })) as ToolResult;
      assert.equal(res.isError, undefined, JSON.stringify(res));
    };
    const stateOf = (taskId: string): string => {
      const db = new Database(seeded.dbPath, { readonly: true });
      try {
        return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string })
          .state;
      } finally {
        db.close();
      }
    };

    // ---- nova_task_abort over MCP, against a run that ignores SIGTERM ----
    const aborted = await createTask("ABORT-ME");
    await runTask(aborted);
    await waitFor(() => stateOf(aborted) === "running", 15_000);
    // queued→running is applied BEFORE the child spawns, so the stub's
    // pidfile (its first action) lands a moment later — wait for the twin
    // evidence rather than assuming the order.
    await waitFor(() => existsSync(pidfile), 15_000);
    await waitFor(() => readFileSync(pidfile, "utf8").trim() !== "", 15_000);
    const stubPid = Number(readFileSync(pidfile, "utf8").split("\n")[0]);
    // DEBT-004: the pid arrives at spawn, but the child only INSTALLS its
    // SIGTERM handler once it is booted and reading stdin. Under full-suite
    // load a boot measures 231-284 ms, so a group kill landing before the
    // handler exists is a default-signal death and the IGNORED marker never
    // appears (the observed failure). The stub's receipt is written exactly
    // when it reaches its prompt handler — poll that, never a sleep.
    const runDir = ((): string => {
      const db = new Database(seeded.dbPath, { readonly: true });
      try {
        return (
          db.prepare("SELECT pi_session_dir FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1").get(
            aborted,
          ) as { pi_session_dir: string }
        ).pi_session_dir;
      } finally {
        db.close();
      }
    })();
    await waitFor(() => existsSync(join(runDir, "stub-receipt.json")), 15_000);

    const abortRes = (await mcp.client.callTool({
      name: "nova_task_abort",
      arguments: { task_id: aborted },
    })) as ToolResult;
    assert.equal(abortRes.isError, undefined, JSON.stringify(abortRes));
    assert.equal(abortRes.structuredContent?.["live_run"], true);
    await waitFor(() => stateOf(aborted) === "cancelled", 15_000);

    // the spec's named kill path really ran: SIGTERM reached the child…
    await waitFor(() => /SIGTERM-IGNORED/.test(readFileSync(pidfile, "utf8")), 15_000);
    assert.match(readFileSync(pidfile, "utf8"), /SIGTERM-IGNORED/);
    // …and the SIGKILL backstop reaped it
    await waitFor(() => {
      try {
        process.kill(stubPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);

    const dbAbort = new Database(seeded.dbPath, { readonly: true });
    try {
      const row = dbAbort
        .prepare(
          "SELECT trigger_type FROM state_transition_logs WHERE task_id = ? AND from_state = 'running' AND to_state = 'cancelled'",
        )
        .get(aborted) as { trigger_type: string } | undefined;
      assert.ok(row !== undefined, "the running→cancelled row exists");
      assert.equal(row!["trigger_type"], "mcp", "an MCP abort is attributed to mcp (§5)");
    } finally {
      dbAbort.close();
    }

    // ---- nova_kill_all over MCP: the live tree dies, scheduler pauses ----
    const second = await createTask("KILL-ME");
    await runTask(second);
    await waitFor(() => stateOf(second) === "running", 15_000);
    const killRes = (await mcp.client.callTool({ name: "nova_kill_all", arguments: {} })) as ToolResult;
    assert.equal(killRes.isError, undefined, JSON.stringify(killRes));
    assert.equal(killRes.structuredContent?.["paused"], true, "kill-all pauses the scheduler");
    assert.deepEqual(killRes.structuredContent?.["aborted"], [second]);
    await waitFor(() => stateOf(second) === "cancelled", 15_000);

    // the scheduler really is paused: a fresh enqueue stays queued
    const third = await createTask("AFTER-KILL");
    await runTask(third);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(stateOf(third), "queued", "nothing dispatches while the scheduler is paused");
  } finally {
    try {
      await h?.close();
    } catch {
      /* bounded */
    }
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nova_task_abort over MCP group-kills a forked grandchild (judge B finding 1)", async () => {
  // run-fork-grandchild's fork takes SIGTERM only if the kill reaches the
  // whole process GROUP; a degraded bare-pid kill leaves it alive and
  // unmarked. This case makes the MCP parity test discriminate on the
  // group-kill itself, not just the leader — the engine-level discipline
  // is pinned in test/runs/run-loop.test.ts; this pins that the MCP op
  // reaches the same path. runArgs are fixed per daemon, hence a dedicated
  // harness with the grandchild fixture.
  const dir = tmp("novaflow-mcp-killgc-");
  const seeded = seedFileStore(dir);
  const pidfile = join(dir, "stub.pid");
  const sockPath = join(dir, "d.sock");
  const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
  let handle: DaemonHandle | undefined;
  let h: Harness | undefined;
  try {
    handle = await startDaemon({
      dbPath: seeded.dbPath,
      socketPath: sockPath,
      probePiBin: "node",
      probeArgs: [STUB, "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      // the run forks a sleeping grandchild in the stub's process group
      runArgs: [STUB, "run-fork-grandchild", pidfile],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    h = await harness({ socketPath: sockPath, dbPath: seeded.dbPath });
    const mcp = h;

    const stateOf = (taskId: string): string => {
      const db = new Database(seeded.dbPath, { readonly: true });
      try {
        return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string })
          .state;
      } finally {
        db.close();
      }
    };

    const createRes = (await mcp.client.callTool({
      name: "nova_task_create",
      arguments: {
        project_id: seeded.projectId,
        key: "ABORT-GC",
        title: "ABORT-GC",
        objective: "objective for ABORT-GC",
        profile_name: "dev",
      },
    })) as ToolResult;
    assert.equal(createRes.isError, undefined, JSON.stringify(createRes));
    const taskId = String((createRes.structuredContent?.["task"] as Record<string, unknown>)["id"]);
    const runRes = (await mcp.client.callTool({ name: "nova_task_run", arguments: { task_id: taskId } })) as ToolResult;
    assert.equal(runRes.isError, undefined, JSON.stringify(runRes));

    await waitFor(() => stateOf(taskId) === "running", 15_000);
    await waitFor(
      // GRANDCHILD-READY, not just the pid line: the pid is written at
      // spawn(), the SIGTERM handler only exists after node boots
      () => existsSync(pidfile) && readFileSync(pidfile, "utf8").match(/GRANDCHILD-READY/),
      15_000,
    );

    const abortRes = (await mcp.client.callTool({
      name: "nova_task_abort",
      arguments: { task_id: taskId },
    })) as ToolResult;
    assert.equal(abortRes.isError, undefined, JSON.stringify(abortRes));
    await waitFor(() => stateOf(taskId) === "cancelled", 15_000);

    const gcPidfile = readFileSync(pidfile, "utf8");
    assert.match(
      gcPidfile, /GRANDCHILD-SIGTERM/,
      "the abort's SIGTERM reached the forked grandchild — group kill, not bare-pid",
    );
    const gcMatch = gcPidfile.match(/GRANDCHILD (\d+)/);
    assert.ok(gcMatch, gcPidfile);
    await waitFor(() => {
      try {
        process.kill(Number(gcMatch![1]), 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
  } finally {
    try {
      await h?.close();
    } catch {
      /* bounded */
    }
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------- read-only service from SQLite --------------------- */

test("read-only tools serve from SQLite when the socket is down (mcp.md §4)", async () => {
  const dir = tmp("novaflow-mcp-ro-");
  const s = seed(dir);
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: s.dbPath });
  try {
    const workspaces = (await h.client.callTool({ name: "nova_workspace_list", arguments: {} })) as ToolResult;
    assert.equal(workspaces.isError, undefined, JSON.stringify(workspaces));
    const ws = workspaces.structuredContent?.["workspaces"] as Array<Record<string, unknown>>;
    assert.equal(ws.length, 1);
    assert.equal(ws[0]!["slug"], "ws");

    const projects = (await h.client.callTool({
      name: "nova_project_list",
      arguments: { workspace_id: s.workspaceId },
    })) as ToolResult;
    assert.equal(projects.isError, undefined, JSON.stringify(projects));
    const prj = projects.structuredContent?.["projects"] as Array<Record<string, unknown>>;
    assert.equal(prj.length, 1);
    assert.equal(prj[0]!["slug"], "prj");

    const tasks = (await h.client.callTool({ name: "nova_task_list", arguments: { project_id: s.projectId } })) as ToolResult;
    assert.equal(tasks.isError, undefined, JSON.stringify(tasks));
    const taskRows = tasks.structuredContent?.["tasks"] as Array<Record<string, unknown>>;
    assert.equal(taskRows.length, 1);
    assert.equal(taskRows[0]!["key"], "T1");

    const filtered = (await h.client.callTool({
      name: "nova_task_list",
      arguments: { project_id: s.projectId, state: "running" },
    })) as ToolResult;
    assert.deepEqual(filtered.structuredContent?.["tasks"], []);

    const status = (await h.client.callTool({
      name: "nova_task_status",
      arguments: { task_id: s.taskId },
    })) as ToolResult;
    assert.equal(status.isError, undefined, JSON.stringify(status));
    const currentRun = status.structuredContent?.["current_run"] as Record<string, unknown>;
    assert.equal(currentRun["id"], s.runId);
    const workspaceField = status.structuredContent?.["workspace"] as Record<string, unknown>;
    assert.equal(workspaceField["status"], "active");
    assert.equal(workspaceField["slug"], "ws");
    assert.equal(status.structuredContent?.["elapsed_ms"], null);

    const result = (await h.client.callTool({
      name: "nova_result_get",
      arguments: { task_id: s.taskId, run_id: s.runId },
    })) as ToolResult;
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal((result.structuredContent?.["artifact"] as Record<string, unknown>)["status"], "completed");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nova_run_logs serves the redacted file the pump writes, never events.raw.jsonl", async () => {
  const dir = tmp("novaflow-mcp-logs-");
  const s = seed(dir);
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: s.dbPath });
  try {
    const res = (await h.client.callTool({
      name: "nova_run_logs",
      arguments: { task_id: s.taskId, run_id: s.runId, tail_lines: 10 },
    })) as ToolResult;
    assert.equal(res.isError, undefined, JSON.stringify(res));
    const lines = res.structuredContent?.["lines"] as string[];
    assert.equal(lines.length, 2);
    const joined = lines.join("\n");
    // NFR-SE-04: the token exists in events.raw.jsonl only; the served
    // lines are the scrubbed stream the run pump wrote
    assert.doesNotMatch(joined, /sk-abcdefgh12345678/, "the raw token must never leave the process");
    assert.match(joined, /\[REDACTED\]/);
    assert.equal(lines[0], JSON.stringify({ type: "message_update", text: "hello" }));

    // THE REUSE PROOF: byte-for-byte identity with the daemon's own read op
    // over the same store. A re-derived "tail the JSONL" here could drift
    // (different tail default, different file, different trimming) — this
    // pins that the MCP path IS the op, not a lookalike.
    const db = new Database(s.dbPath, { readonly: true });
    try {
      const direct = runLogs(db, { task_id: s.taskId, run_id: s.runId, tail_lines: 10 });
      assert.deepEqual(res.structuredContent, direct);
      // and the file it read is the redacted surface, never the raw one
      const pointer = db
        .prepare("SELECT events_log_path FROM task_runs WHERE id = ?")
        .get(s.runId) as { events_log_path: string };
      assert.match(pointer.events_log_path, /events\.jsonl$/);
      assert.doesNotMatch(pointer.events_log_path, /events\.raw\.jsonl$/);
    } finally {
      db.close();
    }
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only fallback honours tail_lines bounds and reports not_found like the op does", async () => {
  const dir = tmp("novaflow-mcp-logs-bounds-");
  const s = seed(dir);
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: s.dbPath });
  try {
    for (const tail of [0, -1, 1.5, 1001]) {
      const res = (await h.client.callTool({
        name: "nova_run_logs",
        arguments: { task_id: s.taskId, tail_lines: tail },
      })) as ToolResult;
      assert.equal(res.isError, true, `tail_lines ${tail} must be refused`);
      assert.equal(res.structuredContent?.["code"], "schema_invalid");
    }
    const okTail = (await h.client.callTool({
      name: "nova_run_logs",
      arguments: { task_id: s.taskId, tail_lines: 1 },
    })) as ToolResult;
    assert.equal((okTail.structuredContent?.["lines"] as string[]).length, 1);

    const missing = (await h.client.callTool({
      name: "nova_task_status",
      arguments: { task_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" },
    })) as ToolResult;
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent?.["code"], "not_found");

    const noFile = (await h.client.callTool({
      name: "nova_workspace_list",
      arguments: {},
    })) as ToolResult;
    assert.equal(noFile.isError, undefined);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-only tool with no store file answers not_found, never invents a store", async () => {
  const dir = tmp("novaflow-mcp-nostore-");
  const dbPath = join(dir, "state.db");
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath });
  try {
    const res = (await h.client.callTool({ name: "nova_workspace_list", arguments: {} })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.["code"], "not_found");
    assert.equal(existsSync(dbPath), false, "a read must never create the store");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CORRUPT store answers the catch-all code, never crashes (judge B finding 3)", async () => {
  // better-sqlite3 opens a corrupt file lazily — the throw surfaces at
  // first query and falls into errors.ts classify's catch-all, the SAME
  // rule the daemon's toErrorPayload applies (mcp.md §4: MCP adds no
  // second error model). Pinned deliberately: an orchestrator branching
  // on codes sees {code: "aborted", message: "file is not a database"}
  // for a broken installation — no crash, no hang, no side files.
  const dir = tmp("novaflow-mcp-corrupt-");
  const dbPath = join(dir, "state.db");
  writeFileSync(dbPath, "this is not a sqlite database at all\n");
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath });
  try {
    const res = (await h.client.callTool({ name: "nova_workspace_list", arguments: {} })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.["code"], "aborted", "the documented catch-all, mirroring the daemon taxonomy");
    assert.match(String(res.structuredContent?.["message"]), /file is not a database/);
    // the server survives and keeps serving
    const again = (await h.client.callTool({ name: "nova_workspace_list", arguments: {} })) as ToolResult;
    assert.equal(again.isError, true);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nova_daemon_status on a dead socket is daemon_unreachable (no SQLite substitute)", async () => {
  const dir = tmp("novaflow-mcp-daemonstatus-");
  const s = seed(dir);
  const h = await harness({ socketPath: join(dir, "absent.sock"), dbPath: s.dbPath });
  try {
    // scheduler state, active runs and budget counters are LIVE daemon
    // state — no store table holds them, so there is nothing to serve
    const res = (await h.client.callTool({ name: "nova_daemon_status", arguments: {} })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.["code"], "daemon_unreachable");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
