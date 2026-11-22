import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { seedFileStore } from "../daemon/seed.ts";
import { withBound } from "../helpers/bound.ts";

/**
 * `nova mcp` as an OPERATOR-FACING command: the process lifecycle and the
 * exit-code reasoning (mcp.md §2 + §4), driven through the real binary.
 *
 * The rules under test, spelled out because each one is easy to get
 * backwards:
 *   1. It is a SERVER: it runs until its stdio client disconnects, then
 *      exits 0. `daemon_unreachable` does NOT terminate it (a tool error
 *      is not a process error) — so exit 5 has no meaning for this
 *      command, even though the CLI's one-shot commands map
 *      daemon_unreachable → 5.
 *   2. stdout is the protocol channel: with no client, stdout is empty.
 *   3. With no daemon, read-only tools still answer from the store, and a
 *      mutating tool returns `daemon_unreachable` — without spawning a
 *      daemon (no cold start).
 *   4. A stray argument is a usage error (exit 2), never a silent drop.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const BOUND_MS = 30_000;

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

type Rig = {
  dir: string;
  home: string;
  sock: string;
  dbPath: string;
  env: Record<string, string>;
  seeded: ReturnType<typeof seedFileStore>;
  handle?: DaemonHandle;
};

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-mcp-cli-"));
  const home = join(dir, "novahome");
  mkdirSync(home, { recursive: true });
  const seeded = seedFileStore(dir);
  const sock = join(home, "novaflow.sock");
  const dbPath = join(home, "state.db");
  return {
    dir,
    home,
    sock,
    dbPath,
    seeded,
    env: { NOVAFLOW_HOME: home, NOVAFLOW_SOCK: sock, NOVAFLOW_DB: dbPath },
  };
}

/** Copy the seeded store into the operator home the CLI will read. */
function installStore(r: Rig): void {
  writeFileSync(r.dbPath, readFileSync(r.seeded.dbPath));
}

async function connect(r: Rig, signal: AbortSignal): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: NOVA,
    args: ["mcp"],
    env: r.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "p5-cli-test", version: "0.0.0" });
  await withBound(signal, BOUND_MS, client.connect(transport));
  return { client, transport };
}

function reap(pid: number | null | undefined): void {
  if (pid === null || pid === undefined) return;
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {
      /* no group */
    }
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

test("nova mcp exits 0 when its stdio client disconnects (a server, not a one-shot)", async () => {
  const r = rig();
  const child: ChildProcess = spawn(NOVA, ["mcp"], {
    env: { ...process.env, ...r.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    // a live server keeps running: still here after a moment
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(child.exitCode, null, "the server must outlive a moment with a live client");
    assert.equal(out, "", "nothing may be written to stdout outside the protocol");
    // the client hangs up → normal end of service → exit 0
    child.stdin?.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("nova mcp did not exit after client EOF")), 15_000);
      child.once("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0, "client disconnect is a successful session end (mcp.md §2)");
  } finally {
    reap(child.pid);
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("nova mcp refuses a stray argument with usage exit 2", async () => {
  const r = rig();
  try {
    const child = spawn(NOVA, ["mcp", "stray"], {
      env: { ...process.env, ...r.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    reap(child.pid);
    assert.equal(code, 2);
    assert.match(err, /takes no arguments/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("with the daemon down: read-only serves from SQLite, mutating is daemon_unreachable, the process survives both", async (t) => {
  const r = rig();
  installStore(r);
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    ({ client, transport } = await connect(r, t.signal));

    const ws = (await withBound(
      t.signal,
      BOUND_MS,
      client.callTool({ name: "nova_workspace_list", arguments: {} }),
    )) as ToolResult;
    assert.equal(ws.isError, undefined, JSON.stringify(ws));
    assert.equal((ws.structuredContent?.["workspaces"] as unknown[]).length, 1);

    const run = (await withBound(
      t.signal,
      BOUND_MS,
      client.callTool({ name: "nova_task_run", arguments: { task_id: r.seeded.projectId } }),
    )) as ToolResult;
    assert.equal(run.isError, true);
    assert.equal(run.structuredContent?.["code"], "daemon_unreachable");

    // no cold start: no socket appeared, no daemon process was spawned
    assert.equal(existsSync(r.sock), false, "a tool call must never start the daemon (mcp.md §4)");

    // the server is still serving after a failed mutating call
    const again = (await withBound(
      t.signal,
      BOUND_MS,
      client.callTool({ name: "nova_workspace_list", arguments: {} }),
    )) as ToolResult;
    assert.equal(again.isError, undefined, "a tool error must not take the server down");
  } finally {
    try {
      await withBound(t.signal, BOUND_MS, (async () => void (await client?.close()))());
    } catch {
      /* bounded */
    }
    reap(transport?.pid ?? undefined);
    await r.handle?.stop();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("with a live daemon: mutating tools are recorded as trigger_type 'mcp'", async (t) => {
  const r = rig();
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    r.handle = await startDaemon({
      dbPath: r.seeded.dbPath,
      socketPath: r.sock,
      probePiBin: "node",
      probeArgs: [join(REPO, "test", "fixtures", "pi-stub.ts"), "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      runArgs: [join(REPO, "test", "fixtures", "pi-stub.ts"), "run-ok"],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(r.dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    ({ client, transport } = await connect(r, t.signal));

    const created = (await withBound(
      t.signal,
      BOUND_MS,
      client.callTool({
        name: "nova_task_create",
        arguments: {
          project_id: r.seeded.projectId,
          key: "CLI-1",
          title: "cli-created",
          objective: "Prove the CLI server attributes mutations to mcp.",
          profile_name: "dev",
          target_scopes: [{ repo_alias: "ws-app", access_mode: "read_write" }],
        },
      }),
    )) as ToolResult;
    assert.equal(created.isError, undefined, JSON.stringify(created));
    const taskId = String((created.structuredContent?.["task"] as Record<string, unknown>)["id"]);

    const ran = (await withBound(
      t.signal,
      BOUND_MS,
      client.callTool({ name: "nova_task_run", arguments: { task_id: taskId } }),
    )) as ToolResult;
    assert.equal(ran.isError, undefined, JSON.stringify(ran));

    const db = new Database(r.seeded.dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT from_state, to_state, trigger_type FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .all(taskId) as Array<{ from_state: string; to_state: string; trigger_type: string }>;
      assert.equal(rows.length >= 1, true);
      assert.equal(rows[0]!["from_state"], "draft");
      assert.equal(rows[0]!["to_state"], "queued");
      assert.equal(
        rows[0]!["trigger_type"],
        "mcp",
        "mcp.md §5: an MCP-initiated transition is recorded as mcp, not human",
      );
    } finally {
      db.close();
    }
  } finally {
    try {
      await withBound(t.signal, BOUND_MS, (async () => void (await client?.close()))());
    } catch {
      /* bounded */
    }
    reap(transport?.pid ?? undefined);
    await r.handle?.stop();
    rmSync(r.dir, { recursive: true, force: true });
  }
});
