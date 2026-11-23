import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore } from "./seed.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";

/**
 * novaflow-v030/readme W1 R1.4 — concurrency is real, and honest.
 *
 * The scheduler dispatches independent ready members in PARALLEL up to
 * `concurrency.workspace` (workspace config, default 2) and
 * `concurrency.global` (daemon config, default 4); `nova_daemon_status`
 * reports `inflight` and each running run's `worktree_root` (mcp §3.1
 * amendment row 6). With R1.3's isolation in place the overlapping runs
 * hold disjoint trees, which is what makes the parallelism safe.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const MODEL = "claude-3-5-sonnet-20241022";

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  repo: string;
  handle: DaemonHandle;
  client: TestClient;
  taskIds: string[];
};

function gitOk(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${String(res.stderr)}`);
}

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-conc-"));
  const seeded = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify({ [MODEL]: { input: 3, output: 15 } }));

  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  gitOk(repo, "init", "-q");
  gitOk(repo, "config", "user.email", "t@example.com");
  gitOk(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "# base\n");
  gitOk(repo, "add", "-A");
  gitOk(repo, "commit", "-q", "-m", "base");

  // three independent READY members: one git_repo read_write scope each
  const db = new Database(seeded.dbPath);
  const taskIds: string[] = [];
  try {
    const targetId = ulid();
    db.prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path, default_access) VALUES (?, ?, 'app', 'git_repo', ?, 'read_write')",
    ).run(targetId, seeded.projectId, repo);
    for (const key of ["TASK-C1", "TASK-C2", "TASK-C3"]) {
      const task = createTask(db, {
        projectId: seeded.projectId,
        key,
        title: key,
        objective: "Do the objective.",
        profileId: seeded.profileId,
      });
      db.prepare(
        "INSERT INTO task_target_scopes (id, task_id, target_id, access_mode) VALUES (?, ?, ?, 'read_write')",
      ).run(ulid(), task.id, targetId);
      applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
      taskIds.push(task.id);
    }
  } finally {
    db.close();
  }

  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    runPiBin: "node",
    runArgs: [STUB, "run-hang"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath,
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return { dir, dbPath: seeded.dbPath, wsRoot: seeded.wsRoot, repo, handle, client, taskIds };
}

async function close(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

function taskState(dbPath: string, taskId: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
  } finally {
    db.close();
  }
}

test("the scheduler runs two ready independent tasks OVERLAPPING, at disjoint worktree roots", async () => {
  const env = await boot();
  try {
    // bounded poll: BOTH rows reach running (never a fixed sleep)
    await waitFor(
      () => env.taskIds.slice(0, 2).every((id) => taskState(env.dbPath, id) === "running"),
      20_000,
    );
    const db = new Database(env.dbPath, { readonly: true });
    let rows: Array<{ id: string; task_id: string; worktree_root: string | null; pid: number | null }>;
    try {
      rows = db
        .prepare("SELECT id, task_id, worktree_root, pid FROM task_runs WHERE status = 'running' ORDER BY id")
        .all() as typeof rows;
    } finally {
      db.close();
    }
    assert.equal(rows.length, 2, "two runs are live at the same time");
    for (const row of rows) {
      assert.equal(row.worktree_root, join(env.wsRoot, ".novaflow", "worktrees", row.id));
      assert.ok(existsSync(join(row.worktree_root!, "app")), "each live run holds its own tree");
      assert.equal(typeof row.pid, "number");
    }
    assert.notEqual(rows[0]!.worktree_root, rows[1]!.worktree_root, "never a shared root");

    // the shared checkout is untouched while both agents are live
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: env.repo, encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.equal(String(status.stdout), "");

    // the third independent member is held in QUEUED by concurrency.workspace
    assert.equal(taskState(env.dbPath, env.taskIds[2]!), "queued");

    // R1.4 payload: inflight + each running run's worktree_root
    const res = await env.client.request({ id: "s1", op: "nova_daemon_status", args: {} });
    assert.equal(res["ok"], true);
    const data = res["data"] as {
      scheduler: {
        running: number;
        queued: number;
        inflight: number;
        runs: Array<{ task_id: string; worktree_root: string | null }>;
      };
    };
    assert.equal(data.scheduler.inflight, 2);
    assert.equal(data.scheduler.running, 2);
    assert.equal(data.scheduler.queued, 1);
    assert.deepEqual(
      data.scheduler.runs.map((r) => r.task_id).sort(),
      env.taskIds.slice(0, 2).sort(),
    );
    assert.deepEqual(
      data.scheduler.runs.map((r) => r.worktree_root).sort(),
      rows.map((r) => r.worktree_root).sort(),
    );
  } finally {
    await close(env);
  }
});
