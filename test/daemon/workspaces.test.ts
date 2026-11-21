import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isUlid } from "../../src/store/ids.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { readConnection } from "./seed.ts";

/**
 * Workspace ops over the real control server: FR-WS-01 (create, unique
 * name, valid+writable path, reports the bare ULID), FR-WS-02 (the
 * EXACT canonical layout), FR-WS-03 (archive disables dispatch — the
 * skip lives in candidate selection — unregister removes the DB entry
 * and NEVER files).
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  handle: DaemonHandle;
  client: TestClient;
};

/** Fresh empty store + real daemon with the stub pi (workspace ops seed themselves). */
async function boot(over: { runMode?: string } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-ws-"));
  const dbPath = join(dir, "state.db");
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  const handle = await startDaemon({
    dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: join(dir, "cfg.yaml"), // missing file = defaults
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, over.runMode ?? "run-ok"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return { dir, dbPath, handle, client };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

/** File-tree fingerprint: relative path → "dir/" marker or content sha256. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) {
        out.set(childRel + "/", "");
        walk(childRel);
      } else {
        out.set(
          childRel,
          createHash("sha256").update(readFileSync(join(root, childRel))).digest("hex"),
        );
      }
    }
  };
  walk("");
  return out;
}

function taskState(env: Env, taskId: string): string {
  const ro = readConnection(env.dbPath);
  const state = (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
  ro.close();
  return state;
}

async function createWorkspaceVia(env: Env, name: string, root: string): Promise<string> {
  const res = await env.client.request({
    id: `ws-${name}`,
    op: "nova_workspace_create",
    args: { name, root_path: root },
  });
  assert.equal(res["ok"], true, JSON.stringify(res));
  return (res["data"] as { id: string }).id;
}

/* ------------------------------ FR-WS-01 / FR-WS-02 ------------------------------ */

test("nova_workspace_create: exact FR-WS-02 layout + workspace.json + docs/, bare ULID id", async () => {
  const env = await boot();
  try {
    const root = join(env.dir, "wsroot-a");
    mkdirSync(root);
    writeFileSync(join(root, "readme.txt"), "operator file, never touched\n");

    const res = await env.client.request({
      id: "w1",
      op: "nova_workspace_create",
      args: { name: "alpha", root_path: root, default_branch: "develop" },
    });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const data = res["data"] as { id: string; workspace: Record<string, unknown> };
    assert.ok(isUlid(data["id"]), "FR-WS-01 AC3: the reported UUID is a bare ULID (data 5.1)");
    assert.equal(data["workspace"]["slug"], "alpha");
    assert.equal(data["workspace"]["status"], "active");
    assert.equal(data["workspace"]["default_branch"], "develop");

    // FR-WS-02 AC1: exactly the canonical layout, nothing more
    assert.deepEqual(
      [...snapshot(root).keys()].sort(),
      [
        ".novaflow/",
        ".novaflow/profiles/",
        ".novaflow/prompts/",
        ".novaflow/projects/",
        ".novaflow/runs/",
        ".novaflow/schemas/",
        ".novaflow/worktrees/",
        ".novaflow/workspace.json",
        "docs/",
        "readme.txt",
      ].sort(),
    );

    // AC2: initial workspace.json metadata in .novaflow/ (id, name, created_at)
    const meta = JSON.parse(readFileSync(join(root, ".novaflow", "workspace.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta["id"], data["id"]);
    assert.equal(meta["name"], "alpha");
    assert.match(String(meta["created_at"]), /^\d{4}-\d{2}-\d{2}T/);

    // the registry row carries the resolved absolute root
    const ro = readConnection(env.dbPath);
    const row = ro.prepare("SELECT * FROM workspaces WHERE slug = 'alpha'").get() as Record<string, unknown>;
    ro.close();
    assert.equal(row["root_path"], resolve(root));
    assert.equal(row["id"], data["id"]);
  } finally {
    await shutdown(env);
  }
});

test("nova_workspace_create refusals: duplicate name, duplicate root, bad name, missing/unwritable path", async () => {
  const env = await boot();
  try {
    const rootA = join(env.dir, "root-a");
    mkdirSync(rootA);
    await createWorkspaceVia(env, "alpha", rootA);

    // FR-WS-01 AC2: unique name constraint in the global store
    mkdirSync(join(env.dir, "root-b")); // a valid alternative path — only the NAME collides
    const dupName = await env.client.request({
      id: "d1",
      op: "nova_workspace_create",
      args: { name: "alpha", root_path: join(env.dir, "root-b") },
    });
    assert.equal(dupName["ok"], false);
    assert.equal(dupName["error"]["code"], "duplicate");

    // root_path is UNIQUE in the DDL — the same directory twice is a duplicate
    const dupRoot = await env.client.request({
      id: "d2",
      op: "nova_workspace_create",
      args: { name: "beta", root_path: rootA },
    });
    assert.equal(dupRoot["ok"], false);
    assert.equal(dupRoot["error"]["code"], "duplicate");

    // FR-WS-01 AC1: invalid name (not lowercase kebab-case) and invalid path
    for (const name of ["Alpha", "with space", "under_score"]) {
      const bad = await env.client.request({
        id: `n-${name}`,
        op: "nova_workspace_create",
        args: { name, root_path: join(env.dir, "root-b") },
      });
      assert.equal(bad["ok"], false, name);
      assert.equal(bad["error"]["code"], "schema_invalid", name);
    }

    const missing = await env.client.request({
      id: "p1",
      op: "nova_workspace_create",
      args: { name: "gamma", root_path: join(env.dir, "does-not-exist") },
    });
    assert.equal(missing["ok"], false);
    assert.equal(missing["error"]["code"], "schema_invalid");
    assert.match(String(missing["error"]["message"]), /root_path/);

    const locked = join(env.dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555); // read-only directory
    try {
      const unwritable = await env.client.request({
        id: "p2",
        op: "nova_workspace_create",
        args: { name: "gamma", root_path: locked },
      });
      assert.equal(unwritable["ok"], false);
      assert.equal(unwritable["error"]["code"], "schema_invalid");
      assert.match(String(unwritable["error"]["message"]), /writab/);
    } finally {
      chmodSync(locked, 0o755);
    }

    // nothing but the one valid workspace was persisted
    const ro = readConnection(env.dbPath);
    const n = (ro.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;
    ro.close();
    assert.equal(n, 1);
  } finally {
    await shutdown(env);
  }
});

test("nova_workspace_list: id, slug, name, root_path, status, created_at rows", async () => {
  const env = await boot();
  try {
    const rootA = join(env.dir, "root-a");
    const rootB = join(env.dir, "root-b");
    mkdirSync(rootA);
    mkdirSync(rootB);
    await createWorkspaceVia(env, "alpha", rootA);
    await createWorkspaceVia(env, "beta", rootB);

    const res = await env.client.request({ id: "l", op: "nova_workspace_list", args: {} });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const rows = (res["data"] as { workspaces: Array<Record<string, unknown>> }).workspaces;
    assert.equal(rows.length, 2);
    for (const key of ["id", "slug", "name", "root_path", "status", "created_at"]) {
      assert.ok(rows.every((r) => key in r), `every row carries ${key}`);
    }
    assert.deepEqual(
      rows.map((r) => r["slug"]).sort(),
      ["alpha", "beta"],
    );
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ FR-WS-03: archive ------------------------------ */

test("nova_workspace_archive: status archived; dispatch SKIPS non-active workspaces (FR-WS-03 AC2)", async () => {
  const env = await boot();
  try {
    // two fully-provisioned workspaces through the single-writer ops
    const rootA = join(env.dir, "ws-a");
    const rootB = join(env.dir, "ws-b");
    mkdirSync(rootA);
    mkdirSync(rootB);
    const idA = await createWorkspaceVia(env, "ws-a", rootA);
    const idB = await createWorkspaceVia(env, "ws-b", rootB);

    const profileSrc = join(env.dir, "profile-src.json");
    writeFileSync(
      profileSrc,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        system_prompt_path: "prompts/dev_system.md",
        tools_allowlist: ["bash", "read"],
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    const projectIds: Record<string, string> = {};
    for (const [wsId, root] of [[idA, rootA], [idB, rootB]] as Array<[string, string]>) {
      const p = await env.client.request({
        id: `p-${wsId}`,
        op: "nova_profile_create",
        args: { workspace_id: wsId, file_path: profileSrc },
      });
      assert.equal(p["ok"], true, JSON.stringify(p));
      // the run loop's preflight requires the system prompt file to exist
      // (data 4.2: system_prompt_path is relative to the workspace root,
      // convention prompts/<name>_system.md — pinned by p3a's loop)
      mkdirSync(join(root, "prompts"), { recursive: true });
      writeFileSync(join(root, "prompts", "dev_system.md"), "You are a worker agent.\n");
      const pr = await env.client.request({
        id: `pr-${wsId}`,
        op: "nova_project_create",
        args: { workspace_id: wsId, name: "prj", objective: "Ship it." },
      });
      assert.equal(pr["ok"], true, JSON.stringify(pr));
      projectIds[wsId] = (pr["data"] as { project: { id: string } }).project["id"];
    }

    const taskIds: string[] = [];
    for (const [i, projectId] of [projectIds[idA]!, projectIds[idB]!].entries()) {
      const t = await env.client.request({
        id: `t${i}`,
        op: "nova_task_create",
        args: { project_id: projectId, key: `T${i}`, title: "t", objective: "Do the work.", profile_name: "dev" },
      });
      assert.equal(t["ok"], true, JSON.stringify(t));
      taskIds.push((t["data"] as { task: { id: string } }).task["id"]);
    }
    // pause the scheduler so both enqueues are deterministically still
    // QUEUED when the archive lands (otherwise live dispatch races the test)
    const pause = await env.client.request({ id: "pause", op: "nova_daemon_pause", args: {} });
    assert.equal(pause["ok"], true, JSON.stringify(pause));
    for (const [i, taskId] of taskIds.entries()) {
      const r = await env.client.request({ id: `r${i}`, op: "nova_task_run", args: { task_id: taskId } });
      assert.equal(r["ok"], true, JSON.stringify(r));
      assert.equal(taskState(env, taskId), "queued");
    }

    // NOW archive ws-b — its already-queued task stays queued (dispatch gate)
    const arch = await env.client.request({ id: "arch", op: "nova_workspace_archive", args: { slug: "ws-b" } });
    assert.equal(arch["ok"], true, JSON.stringify(arch));
    assert.equal((arch["data"] as Record<string, unknown>)["status"], "archived");

    // a THIRD task created in the archived workspace refuses at enqueue:
    // execution is disabled there, so queueing would be a silent dead-end
    // (review round finding — the CLI --watch hang class)
    const t2 = await env.client.request({
      id: "t2",
      op: "nova_task_create",
      args: { project_id: projectIds[idB]!, key: "T2", title: "t", objective: "Do the work.", profile_name: "dev" },
    });
    assert.equal(t2["ok"], true, JSON.stringify(t2));
    const t2id = (t2["data"] as { task: { id: string } }).task["id"];
    const refused = await env.client.request({ id: "r2", op: "nova_task_run", args: { task_id: t2id } });
    assert.equal(refused["ok"], false, JSON.stringify(refused));
    assert.equal(refused["error"]["code"], "aborted");
    assert.match(String(refused["error"]["message"]), /ws-b.*archived/);
    assert.equal(taskState(env, t2id), "draft"); // untouched — no log row either

    // resume: the ACTIVE workspace's task runs to completion…
    const resume = await env.client.request({ id: "resume", op: "nova_daemon_resume", args: {} });
    assert.equal(resume["ok"], true, JSON.stringify(resume));
    await waitFor(() => taskState(env, taskIds[0]!) === "completed", 8000);
    // …while the ARCHIVED workspace's PRE-EXISTING queued task stays QUEUED
    // (dispatch skips non-active workspaces — the candidate-SQL gate)
    await new Promise((r2) => setTimeout(r2, 300)); // let a dispatch pass fire
    assert.equal(taskState(env, taskIds[1]!), "queued");

    // unarchiving is not an op in v1 — the skip is pinned as-is
    const ro2 = readConnection(env.dbPath);
    const st = (ro2.prepare("SELECT status FROM workspaces WHERE slug = 'ws-b'").get() as { status: string }).status;
    ro2.close();
    assert.equal(st, "archived");
  } finally {
    await shutdown(env);
  }
});

/* ----------------------------- FR-WS-03: unregister ----------------------------- */

test("nova_workspace_unregister: DB entry removed (cascade), files byte-identical, never deleted", async () => {
  const env = await boot();
  try {
    const root = join(env.dir, "ws-c");
    mkdirSync(root);
    writeFileSync(join(root, "operator.txt"), "user source code\n");
    const wsId = await createWorkspaceVia(env, "ws-c", root);

    // a project (no tasks) also disappears with the cascade; the
    // snapshot baseline starts AFTER registration (its scaffolding is
    // a create-side effect, not an unregister-side one)
    const pr = await env.client.request({
      id: "pr",
      op: "nova_project_create",
      args: { workspace_id: wsId, name: "prj-c", objective: "o" },
    });
    assert.equal(pr["ok"], true, JSON.stringify(pr));
    const before = snapshot(root);

    const res = await env.client.request({ id: "u", op: "nova_workspace_unregister", args: { slug: "ws-c" } });
    assert.equal(res["ok"], true, JSON.stringify(res));

    const ro = readConnection(env.dbPath);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?").get(wsId) as { n: number }).n, 0);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?").get(wsId) as { n: number }).n, 0);
    ro.close();

    // FR-WS-03 AC1: the underlying files are untouched (hash-identical)
    assert.deepEqual([...snapshot(root).entries()].sort(), [...before.entries()].sort());
  } finally {
    await shutdown(env);
  }
});

test("unregister a workspace with tasks: the store's FK RESTRICT refuses (honest v1 guard)", async () => {
  const env = await boot();
  try {
    const root = join(env.dir, "ws-d");
    mkdirSync(root);
    const wsId = await createWorkspaceVia(env, "ws-d", root);
    const profileSrc = join(env.dir, "profile-src.json");
    writeFileSync(
      profileSrc,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        system_prompt_path: "prompts/dev_system.md",
        tools_allowlist: [],
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    const p = await env.client.request({
      id: "p",
      op: "nova_profile_create",
      args: { workspace_id: wsId, file_path: profileSrc },
    });
    assert.equal(p["ok"], true, JSON.stringify(p));
    const pr = await env.client.request({
      id: "pr",
      op: "nova_project_create",
      args: { workspace_id: wsId, name: "prj-d", objective: "o" },
    });
    const projectId = (pr["data"] as { project: { id: string } }).project["id"];
    const t = await env.client.request({
      id: "t",
      op: "nova_task_create",
      args: { project_id: projectId, key: "T1", title: "t", objective: "o", profile_name: "dev" },
    });
    assert.equal(t["ok"], true, JSON.stringify(t));

    // tasks.profile_id is ON DELETE RESTRICT — the cascade cannot delete the
    // profile while the task references it, so the unregister is refused
    const res = await env.client.request({ id: "u", op: "nova_workspace_unregister", args: { workspace_id: wsId } });
    assert.equal(res["ok"], false);
    assert.equal(res["error"]["code"], "aborted");
    assert.match(String(res["error"]["message"]), /FOREIGN KEY|constraint/i);

    // the row and the files are both intact after the refusal
    const ro = readConnection(env.dbPath);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?").get(wsId) as { n: number }).n, 1);
    ro.close();
    assert.ok(existsSync(join(root, ".novaflow", "workspace.json")));
  } finally {
    await shutdown(env);
  }
});

/* --------------------------- the switch ruling (documented) --------------------------- */

test("the daemon has NO nova_workspace_switch op — the active-workspace marker is CLI-local state", async () => {
  const env = await boot();
  try {
    const res = await env.client.request({ id: "sw", op: "nova_workspace_switch", args: { slug: "x" } });
    assert.equal(res["ok"], false);
    assert.equal(res["error"]["code"], "not_found");
    assert.match(String(res["error"]["message"]), /unknown op/);
  } finally {
    await shutdown(env);
  }
});
