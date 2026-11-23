import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNovaMcpServer } from "../../src/mcp/server.ts";
import { MCP_TOOLS, READ_ONLY_TOOL_NAMES, toOpArgs, toolByName } from "../../src/mcp/catalog.ts";
import { serveReadOnly } from "../../src/mcp/read.ts";
import { OpError } from "../../src/opcodes.ts";
import { openDb } from "../../src/store/db.ts";
import { openReadOnlyDb } from "../../src/store/readonly.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";
import { createPump } from "../../src/runs/pump.ts";

/**
 * `nova_run_logs_since` on the MCP surface — the SAME op with the SAME args,
 * one frame per call, `surface: "mcp"` attribution, and NO SQLite fallback
 * (amendments.md row 3: the two new read ops are daemon-owned because their
 * value is liveness, events.md rule 6). A follower served from a store whose
 * writer just died would report a frozen run as live forever.
 */

type Frame = { id: unknown; surface?: string; op: string; args: Record<string, unknown> };

type FakeDaemon = {
  socketPath: string;
  frames: Frame[];
  close: () => Promise<void>;
};

/** A stand-in for src/daemon/server.ts: same JSONL wire contract, one scripted answer. */
async function fakeDaemon(
  dir: string,
  answer: (frame: Frame) => Record<string, unknown>,
): Promise<FakeDaemon> {
  const socketPath = join(dir, "fake-d.sock");
  const frames: Frame[] = [];
  const sockets = new Set<Socket>();
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
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        sock.write(JSON.stringify(answer(frame)) + "\n");
      }
    });
    sock.on("error", () => sock.destroy());
  });
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

type Harness = { client: Client; close: () => Promise<void> };

async function harness(socketPath: string, dbPath: string): Promise<Harness> {
  const server = createNovaMcpServer({ socketPath, dbPath });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "p3-follow-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A migrated store with one workspace/project/task and one run's log files. */
function seededStore(dir: string): { dbPath: string; taskId: string; runId: string } {
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
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T1', 'title', 'objective', ?)",
  ).run(taskId, projectId, profileId);
  const runId = ulid();
  const runDir = join(dir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = join(runDir, "events.jsonl");
  const pump = createPump(join(runDir, "events.raw.jsonl"), eventsPath);
  pump.onLine(JSON.stringify({ type: "message_update", text: "hello" }));
  pump.onLine(JSON.stringify({ type: "agent_settled" }));
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, attempt_number, pi_session_id, pi_session_dir, status,
        preflight_status, model_used, events_log_path, ended_at)
     VALUES (?, ?, 1, ?, ?, 'succeeded', 'passed', 'm', ?, '2026-11-22T00:00:01.000Z')`,
  ).run(runId, taskId, runId, runDir, eventsPath);
  db.close();
  return { dbPath, taskId, runId };
}

/* --------------------------------- the catalog --------------------------------- */

test("nova_run_logs_since is the read-only catalog row mapping 1:1 to the socket op", () => {
  const tool = toolByName("nova_run_logs_since");
  assert.ok(tool !== undefined, "the catalog must carry nova_run_logs_since");
  assert.equal(tool!.op, "nova_run_logs_since", "the tool translates to the op of the same name");
  assert.equal(tool!.kind, "read", "amendments.md row 2: the READ-ONLY catalog gains it");
  assert.equal(tool!.argRenames, undefined, "no rename: the tool's args ARE the op's args");
  assert.notEqual(tool!.description.trim(), "");

  // catalog order: the follow twin sits with its v1 sibling (mcp.md §3.1 gets
  // re-pinned with this row; the position is reported to the parent)
  const names = MCP_TOOLS.map((t) => t.name);
  assert.equal(
    names.indexOf("nova_run_logs_since"),
    names.indexOf("nova_run_logs") + 1,
    "the follow op is advertised beside the tail op it extends",
  );
  assert.ok(READ_ONLY_TOOL_NAMES.includes("nova_run_logs_since"));

  // the input schema is the contract's five args, open (engine is the arbiter)
  assert.deepEqual(
    Object.keys(tool!.inputSchema.properties).sort(),
    ["limit", "offset", "run_id", "tail_lines", "task_id"],
    "watch.md: {task_id, run_id?, offset, limit, tail_lines?}",
  );
  const schema = tool!.inputSchema as Record<string, unknown>;
  assert.equal(schema["required"], undefined, "no required[]: the engine validates, never the SDK");
  assert.notEqual(schema["additionalProperties"], false, "inputs stay open");

  assert.deepEqual(
    toOpArgs(tool!, { task_id: "T", run_id: "R", offset: 7, limit: 20, tail_lines: 5 }),
    { task_id: "T", run_id: "R", offset: 7, limit: 20, tail_lines: 5 },
    "translation is identity",
  );
});

test("tools/list advertises nova_run_logs_since with the offset/limit/tail schema", async () => {
  const dir = tmp("novaflow-mcp-logs-since-list-");
  const h = await harness(join(dir, "absent.sock"), join(dir, "state.db"));
  try {
    const listed = (await h.client.listTools()) as {
      tools: Array<{
        name: string;
        inputSchema?: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      }>;
    };
    const row = listed.tools.find((t) => t.name === "nova_run_logs_since");
    assert.ok(row !== undefined, "the tool is advertised");
    const props = (row!.inputSchema?.["properties"] ?? {}) as Record<string, { type: string }>;
    assert.deepEqual(Object.keys(props).sort(), ["limit", "offset", "run_id", "tail_lines", "task_id"]);
    assert.equal(props["task_id"]!.type, "string");
    assert.equal(props["run_id"]!.type, "string");
    assert.equal(props["offset"]!.type, "integer", "offset is a LINE COUNT, not a byte position");
    assert.equal(props["limit"]!.type, "integer");
    assert.equal(props["tail_lines"]!.type, "integer");
    assert.equal(row!.annotations?.["readOnlyHint"], true, "advertised as read-only (nothing mutates)");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------- the frame ---------------------------------- */

test("a call sends exactly one frame: {op: \"nova_run_logs_since\", args, surface: \"mcp\"}", async () => {
  const dir = tmp("novaflow-mcp-logs-since-frame-");
  const data = { run_id: "R", lines: ["a"], offset: 0, has_more: false, done: false };
  const daemon = await fakeDaemon(dir, () => ({ id: null, ok: true, data }));
  const h = await harness(daemon.socketPath, join(dir, "state.db"));
  try {
    const args = { task_id: "T", run_id: "R", offset: 4, limit: 10 };
    const res = (await h.client.callTool({ name: "nova_run_logs_since", arguments: args })) as ToolResult;
    assert.equal(res.isError, undefined, `unexpected error: ${JSON.stringify(res)}`);
    assert.equal(daemon.frames.length, 1, "one tool call is one socket frame");
    const frame = daemon.frames[0]!;
    assert.equal(frame.op, "nova_run_logs_since", "the tool name IS the op name");
    assert.equal(frame.surface, "mcp", "surface attribution (mcp.md §5)");
    assert.deepEqual(frame.args, args, "args pass through untouched");
    assert.deepEqual(res.structuredContent, data, "the op's envelope reaches the client unedited");
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args the schema does not model reach the engine untouched (no early rejection)", async () => {
  const dir = tmp("novaflow-mcp-logs-since-passthru-");
  const daemon = await fakeDaemon(dir, () => ({
    id: null,
    ok: true,
    data: { lines: [], offset: 0, has_more: false, done: true },
  }));
  const h = await harness(daemon.socketPath, join(dir, "state.db"));
  try {
    const args = { task_id: "T", an_unmodelled_key: 1 };
    const res = (await h.client.callTool({ name: "nova_run_logs_since", arguments: args })) as ToolResult;
    assert.equal(res.isError, undefined, `unexpected error: ${JSON.stringify(res)}`);
    assert.deepEqual(daemon.frames[0]!.args, args, "nothing is stripped before the engine sees it");
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------- daemon-down rule -------------------------------- */

test("a dead socket is daemon_unreachable, never a store read (amendments.md row 3)", async () => {
  const dir = tmp("novaflow-mcp-logs-since-dead-");
  const s = seededStore(dir);
  const h = await harness(join(dir, "absent.sock"), s.dbPath);
  try {
    // the v1 TAIL tool still answers from this very store: the refusal below
    // is a deliberate ruling about liveness, not a missing store
    const tail = (await h.client.callTool({
      name: "nova_run_logs",
      arguments: { task_id: s.taskId, run_id: s.runId },
    })) as ToolResult;
    assert.equal(tail.isError, undefined, `the store is readable: ${JSON.stringify(tail)}`);
    assert.equal((tail.structuredContent?.["lines"] as string[]).length, 2);

    // …but the FOLLOW op refuses: a live feed served by a dead writer would
    // report a frozen run as current
    const res = (await h.client.callTool({
      name: "nova_run_logs_since",
      arguments: { task_id: s.taskId },
    })) as ToolResult;
    assert.equal(res.isError, true, "no fallback answer");
    assert.equal(res.structuredContent?.["code"], "daemon_unreachable");
    assert.equal(res.structuredContent?.["lines"], undefined, "no store-served payload");

    // and the shared read path has no body for it either
    const db = openReadOnlyDb(s.dbPath);
    try {
      assert.throws(
        () => serveReadOnly("nova_run_logs_since", db, { task_id: s.taskId }),
        (err: unknown) => err instanceof OpError && err.code === "not_found",
      );
    } finally {
      db.close();
    }
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
