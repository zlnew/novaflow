import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { logTransition } from "../../src/fsm/engine.ts";

/**
 * `nova_events_since` on the MCP surface — the SAME op
 * (`nova_transitions_since`) with the SAME args, one frame per call,
 * `surface: "mcp"` attribution, and NO SQLite fallback: events.md rule 6
 * makes the daemon's absence part of this op's answer, so the tool the
 * catalog classifies "read" still refuses daemon_unreachable instead of
 * serving a frozen store snapshot.
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

type Harness = {
  client: Client;
  close: () => Promise<void>;
};

async function harness(socketPath: string, dbPath: string): Promise<Harness> {
  const server = createNovaMcpServer({ socketPath, dbPath });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "p2-events-test-client", version: "0.0.0" });
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

/** A migrated store with one workspace/project/task and one transition row. */
function seededStore(dir: string): { dbPath: string; taskId: string } {
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
  logTransition(db, {
    taskId,
    runId: null,
    fromState: "draft",
    toState: "queued",
    triggerType: "human",
    actor: "operator",
  });
  db.close();
  return { dbPath, taskId };
}

/* ------------------------------- the catalog ------------------------------- */

test("nova_events_since is the read-only catalog row mapping 1:1 to nova_transitions_since", () => {
  const tool = toolByName("nova_events_since");
  assert.ok(tool !== undefined, "the catalog must carry nova_events_since");
  assert.equal(tool!.op, "nova_transitions_since", "the tool translates to the socket op, same name family");
  assert.equal(tool!.kind, "read", "events.md: read-only table entry");
  assert.equal(tool!.argRenames, undefined, "no rename: the tool's args ARE the op's args");
  assert.notEqual(tool!.description.trim(), "");

  // catalog order: after nova_daemon_status in the read-only table (events.md)
  const names = MCP_TOOLS.map((t) => t.name);
  assert.equal(
    names.indexOf("nova_events_since"),
    names.indexOf("nova_daemon_status") + 1,
    "events.md pins the catalog position: after nova_daemon_status",
  );
  assert.ok(READ_ONLY_TOOL_NAMES.includes("nova_events_since"));

  // the input schema is the spec's four args, open (engine is the arbiter)
  assert.deepEqual(
    Object.keys(tool!.inputSchema.properties).sort(),
    ["cursor", "limit", "project_id", "workspace_id"],
    "events.md's MCP row: {cursor?, workspace_id?, project_id?, limit?}",
  );
  const schema = tool!.inputSchema as Record<string, unknown>;
  assert.equal(schema["required"], undefined, "no required[]: the engine validates, never the SDK");
  assert.notEqual(schema["additionalProperties"], false, "inputs stay open");

  // translation is identity — same args reach the same op
  assert.deepEqual(
    toOpArgs(tool!, { cursor: 42, workspace_id: "W", project_id: "P", limit: 5 }),
    { cursor: 42, workspace_id: "W", project_id: "P", limit: 5 },
  );
});

test("tools/list advertises nova_events_since with the cursor contract's schema", async () => {
  const dir = tmp("novaflow-mcp-events-list-");
  const h = await harness(join(dir, "absent.sock"), join(dir, "state.db"));
  try {
    const listed = (await h.client.listTools()) as {
      tools: Array<{ name: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }>;
    };
    const row = listed.tools.find((t) => t.name === "nova_events_since");
    assert.ok(row !== undefined, "the tool is advertised");
    const props = (row!.inputSchema?.["properties"] ?? {}) as Record<string, { type: string }>;
    assert.deepEqual(Object.keys(props).sort(), ["cursor", "limit", "project_id", "workspace_id"]);
    assert.equal(props["cursor"]!.type, "integer", "cursor is the last rowid seen");
    assert.equal(props["limit"]!.type, "integer");
    assert.equal(props["workspace_id"]!.type, "string");
    assert.equal(props["project_id"]!.type, "string");
    assert.equal(row!.annotations?.["readOnlyHint"], true, "advertised as read-only (nothing mutates)");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------- the frame -------------------------------- */

test("a call sends exactly one frame: {op: \"nova_transitions_since\", args, surface: \"mcp\"}", async () => {
  const dir = tmp("novaflow-mcp-events-frame-");
  const daemon = await fakeDaemon(dir, () => ({
    id: null,
    ok: true,
    data: { transitions: [], next_cursor: 0, has_more: false },
  }));
  const h = await harness(daemon.socketPath, join(dir, "state.db"));
  try {
    const args = { cursor: 42, workspace_id: "WS", project_id: "PRJ", limit: 5 };
    const res = (await h.client.callTool({ name: "nova_events_since", arguments: args })) as ToolResult;
    assert.equal(res.isError, undefined, `unexpected error: ${JSON.stringify(res)}`);
    assert.equal(daemon.frames.length, 1, "one tool call is one socket frame");
    const frame = daemon.frames[0]!;
    assert.equal(frame.op, "nova_transitions_since", "the MCP tool name maps to the engine op");
    assert.equal(frame.surface, "mcp", "surface attribution (mcp.md §5)");
    assert.deepEqual(frame.args, args, "args pass through untouched");
    assert.deepEqual(res.structuredContent, { transitions: [], next_cursor: 0, has_more: false });
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("args the schema does not model reach the engine untouched (no early rejection)", async () => {
  const dir = tmp("novaflow-mcp-events-passthru-");
  const daemon = await fakeDaemon(dir, () => ({
    id: null,
    ok: true,
    data: { transitions: [], next_cursor: 0, has_more: false },
  }));
  const h = await harness(daemon.socketPath, join(dir, "state.db"));
  try {
    // the op also accepts task_id/chain_run_id (the --watch and chain
    // surfaces); the MCP schema advertises the spec's four fields only,
    // and the daemon — not the SDK — decides what is acceptable
    const args = { task_id: "T", chain_run_id: "C", an_unmodelled_key: 1 };
    const res = (await h.client.callTool({ name: "nova_events_since", arguments: args })) as ToolResult;
    assert.equal(res.isError, undefined, `unexpected error: ${JSON.stringify(res)}`);
    assert.deepEqual(daemon.frames[0]!.args, args, "nothing is stripped before the engine sees it");
  } finally {
    await h.close();
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ daemon-down rule ------------------------------ */

test("a dead socket is daemon_unreachable, never a store read (events.md rule 6)", async () => {
  const dir = tmp("novaflow-mcp-events-dead-");
  const s = seededStore(dir);
  const h = await harness(join(dir, "absent.sock"), s.dbPath);
  try {
    // the sister read tools still serve from this very store…
    const readable = (await h.client.callTool({
      name: "nova_task_list",
      arguments: {},
    })) as ToolResult;
    assert.equal(readable.isError, undefined, "store-backed reads still answer with the daemon down");

    // …but the transitions feed refuses: a liveness feed served from a
    // store whose writer just died reports a frozen world as current
    const res = (await h.client.callTool({
      name: "nova_events_since",
      arguments: { limit: 10 },
    })) as ToolResult;
    assert.equal(res.isError, true, "no fallback answer");
    assert.equal(res.structuredContent?.["code"], "daemon_unreachable");
    assert.equal(res.structuredContent?.["transitions"], undefined, "no store-served payload");

    // and the shared read path has no body for it either: the fallback
    // could not serve it even if someone routed it there
    const db = openReadOnlyDb(s.dbPath);
    try {
      assert.throws(
        () => serveReadOnly("nova_events_since", db, {}),
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
