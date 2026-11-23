import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { seedFileStore } from "./seed.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * `nova chain clean <chain_id>` (srs 4.1.1 "Chain clean", amendments row 2) —
 * the operator confirmation `data` 3.x presupposes. It refuses a
 * non-terminal chain, refuses a member run whose worktree has uncommitted
 * changes unless `--force` (naming the run), removes the worktrees and
 * prunes, reports every removed tree, and NEVER deletes a run row or its
 * artifacts (`task_runs.worktree_root` is history).
 */

const MODEL = "claude-3-5-sonnet-20241022";

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function gitOk(cwd: string, ...args: string[]): string {
  const res = git(cwd, ...args);
  assert.equal(res.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  projectId: string;
  profileId: string;
  /** The workspace's git_repo read_write target every member is scoped to. */
  targetId: string;
  repo: string;
  handle: DaemonHandle;
  client: TestClient;
};

type ChainFixture = {
  chainId: string;
  taskId: string;
  runId: string;
  worktreeRoot: string;
  subdir: string;
  eventsPath: string;
};

/** One chain run + one member task + (for a terminal chain) one run with a real worktree. */
function seedChain(
  env: Env,
  opts: { state: "active" | "completed" | "failed" | "aborted"; dirty?: boolean; corruptGit?: boolean },
): ChainFixture {
  const db = new Database(env.dbPath);
  try {
    const chainId = ulid();
    db.prepare("INSERT INTO chain_runs (id, project_id, state) VALUES (?, ?, ?)").run(
      chainId,
      env.projectId,
      opts.state,
    );
    // a non-terminal chain's member must stay non-terminal too: an active
    // chain whose members are all completed is moved to completed by the
    // daemon's boot sweep (FR-TSK-07), which would falsify the fixture.
    const memberState = opts.state === "active" ? "draft" : "completed";
    const taskId = ulid();
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id, state, chain_run_id)
       VALUES (?, ?, ?, 'T', 'o', ?, ?, ?)`,
    ).run(taskId, env.projectId, `CLEAN-${chainId.slice(-6)}`, env.profileId, memberState, chainId);

    const runId = ulid();
    const worktreeRoot = join(env.wsRoot, ".novaflow", "worktrees", runId);
    const subdir = join(worktreeRoot, "app");
    mkdirSync(worktreeRoot, { recursive: true });
    gitOk(env.repo, "worktree", "add", "-q", "-b", `novaflow/run-${runId}`, subdir, "HEAD");
    if (opts.dirty === true) writeFileSync(join(subdir, "uncommitted.txt"), "work in progress\n");
    // an UNASSESSABLE tree (must-fix 2): a broken .git file means `git status`
    // cannot say whether the tree holds work
    if (opts.corruptGit === true) writeFileSync(join(subdir, ".git"), "gitdir: /nowhere/no-such-gitdir\n");

    const sessionDir = join(env.wsRoot, ".novaflow", "runs", taskId, runId);
    mkdirSync(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    writeFileSync(eventsPath, '{"type":"agent_settled"}\n');
    writeFileSync(join(sessionDir, "result.json"), '{"status":"completed"}\n');

    db.prepare(
      "INSERT INTO task_target_scopes (id, task_id, target_id, access_mode) VALUES (?, ?, ?, 'read_write')",
    ).run(ulid(), taskId, env.targetId);

    if (memberState === "completed") {
      db.prepare(
        `INSERT INTO task_runs
           (id, task_id, attempt_number, pi_session_id, pi_session_dir, status, preflight_status,
            model_used, events_log_path, worktree_root)
         VALUES (?, ?, 1, ?, ?, 'succeeded', 'passed', ?, ?, ?)`,
      ).run(runId, taskId, runId, sessionDir, MODEL, eventsPath, worktreeRoot);
    }

    return { chainId, taskId, runId, worktreeRoot, subdir, eventsPath };
  } finally {
    db.close();
  }
}

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-clean-"));
  const seeded = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");

  // the workspace's git_repo read_write target the run's scopes point at
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  gitOk(repo, "init", "-q");
  gitOk(repo, "config", "user.email", "t@example.com");
  gitOk(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "# base\n");
  gitOk(repo, "add", "-A");
  gitOk(repo, "commit", "-q", "-m", "base");

  const db = new Database(seeded.dbPath);
  let targetId = "";
  try {
    db.prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path, default_access) VALUES (?, ?, 'app', 'git_repo', ?, 'read_write')",
    ).run(ulid(), seeded.projectId, repo);
    targetId = (
      db.prepare("SELECT id FROM project_targets WHERE alias = 'app' AND project_id = ?").get(seeded.projectId) as {
        id: string;
      }
    ).id;
  } finally {
    db.close();
  }

  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    pricesPath: join(dir, "no-prices.json"),
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return {
    dir,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    targetId,
    repo,
    handle,
    client,
  };
}

async function close(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

function errorCode(res: Record<string, unknown>): string {
  return String((res["error"] as { code?: string } | undefined)?.code);
}

function errorMessage(res: Record<string, unknown>): string {
  return String((res["error"] as { message?: string } | undefined)?.message);
}

test("nova chain clean refuses a NON-TERMINAL chain, naming the state", async () => {
  const env = await boot();
  try {
    const fx = seedChain(env, { state: "active" });
    const res = await env.client.request({
      id: "c1",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId },
    });
    assert.equal(res["ok"], false);
    assert.equal(errorCode(res), "invalid_transition");
    assert.match(errorMessage(res), new RegExp(`chain run ${fx.chainId} is active`));
    assert.ok(existsSync(fx.subdir), "nothing was removed");
  } finally {
    await close(env);
  }
});

test("nova chain clean refuses a DIRTY worktree without --force, naming the run; --force removes it", async () => {
  const env = await boot();
  try {
    const fx = seedChain(env, { state: "completed", dirty: true });

    const refused = await env.client.request({
      id: "c2",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId },
    });
    assert.equal(refused["ok"], false);
    assert.equal(errorCode(refused), "invalid_transition");
    assert.match(errorMessage(refused), new RegExp(`run ${fx.runId}`));
    assert.match(errorMessage(refused), /uncommitted changes/);
    assert.match(errorMessage(refused), /--force/);
    assert.ok(existsSync(fx.subdir), "the dirty tree is preserved");
    assert.ok(existsSync(join(fx.subdir, "uncommitted.txt")));

    const forced = await env.client.request({
      id: "c3",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId, force: true },
    });
    assert.equal(forced["ok"], true, JSON.stringify(forced["error"]));
    const data = forced["data"] as {
      removed: Array<{ run_id: string; path: string; forced: boolean }>;
      runs_kept: number;
    };
    assert.equal(data.removed.length, 1);
    assert.equal(data.removed[0]!.run_id, fx.runId);
    assert.equal(data.removed[0]!.path, fx.subdir);
    assert.equal(data.removed[0]!.forced, true);
    assert.equal(existsSync(fx.subdir), false, "the forced removal deleted the tree");

    // history survives: the run row keeps its worktree_root, artifacts intact
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT worktree_root, status FROM task_runs WHERE id = ?").get(fx.runId) as
        | { worktree_root: string; status: string }
        | undefined;
      assert.ok(row !== undefined, "the run row is never deleted");
      assert.equal(row.worktree_root, fx.worktreeRoot, "worktree_root is history, not nulled");
      assert.ok(existsSync(fx.eventsPath), "run artifacts are never deleted");
      assert.ok(existsSync(join(env.wsRoot, ".novaflow", "runs", fx.taskId, fx.runId, "result.json")));
    } finally {
      db.close();
    }
  } finally {
    await close(env);
  }
});

test("nova chain clean removes a CLEAN worktree and prunes the repo's worktree list", async () => {
  const env = await boot();
  try {
    const fx = seedChain(env, { state: "completed" });
    assert.ok(gitOk(env.repo, "worktree", "list").includes(fx.subdir));

    const res = await env.client.request({
      id: "c4",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId },
    });
    assert.equal(res["ok"], true, JSON.stringify(res["error"]));
    const data = res["data"] as {
      removed: Array<{ run_id: string; path: string; forced: boolean }>;
      pruned: string[];
      state: string;
    };
    assert.equal(data.state, "completed");
    assert.deepEqual(data.removed, [{ run_id: fx.runId, task_id: fx.taskId, key: `CLEAN-${fx.chainId.slice(-6)}`, path: fx.subdir, forced: false }]);
    assert.deepEqual(data.pruned, [env.repo]);
    assert.equal(existsSync(fx.subdir), false);
    assert.equal(existsSync(fx.worktreeRoot), false);
    assert.equal(gitOk(env.repo, "worktree", "list").includes(fx.subdir), false);

    // the repo itself is untouched and still on its base commit
    assert.equal(gitOk(env.repo, "status", "--porcelain"), "");
    assert.equal(gitOk(env.repo, "log", "--format=%s").trim(), "base");
  } finally {
    await close(env);
  }
});

test("nova chain clean prunes a worktree whose directory was already deleted by hand", async () => {
  const env = await boot();
  try {
    const fx = seedChain(env, { state: "aborted" });
    rmSync(fx.subdir, { recursive: true, force: true });
    assert.ok(gitOk(env.repo, "worktree", "list").includes(fx.subdir), "stale metadata is still listed");

    const res = await env.client.request({
      id: "c5",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId },
    });
    assert.equal(res["ok"], true, JSON.stringify(res["error"]));
    const data = res["data"] as { removed: unknown[]; pruned: string[]; missing: string[] };
    assert.deepEqual(data.removed, [], "nothing to remove — the tree is gone");
    assert.deepEqual(data.missing, [fx.subdir]);
    assert.deepEqual(data.pruned, [env.repo]);
    assert.equal(gitOk(env.repo, "worktree", "list").includes(fx.subdir), false);
  } finally {
    await close(env);
  }
});

test("nova chain clean on an unknown chain is not_found (never a silent success)", async () => {
  const env = await boot();
  try {
    const res = await env.client.request({
      id: "c6",
      op: "nova_chain_clean",
      args: { chain_run_id: ulid() },
    });
    assert.equal(res["ok"], false);
    assert.equal(errorCode(res), "not_found");
  } finally {
    await close(env);
  }
});

/* ------------------------- P9 re-judge: fail-closed dirtiness ---------------------- */

test("nova chain clean REFUSES an unassessable worktree (broken .git) without --force, naming the run and the error", async () => {
  const env = await boot();
  try {
    const fx = seedChain(env, { state: "completed", corruptGit: true });

    const refused = await env.client.request({
      id: "c7",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId },
    });
    assert.equal(refused["ok"], false);
    assert.equal(errorCode(refused), "invalid_transition");
    // the refusal names the RUN and carries the assessment error
    assert.match(errorMessage(refused), new RegExp(`run ${fx.runId}`));
    assert.match(errorMessage(refused), /could not be assessed/);
    assert.match(errorMessage(refused), /git status failed/);
    assert.match(errorMessage(refused), /--force/);
    // nothing was removed: the tree is preserved exactly as it was
    assert.ok(existsSync(fx.subdir), "the unassessable tree is preserved");

    // --force is the operator's confirmation: the refusal lifts
    const forced = await env.client.request({
      id: "c8",
      op: "nova_chain_clean",
      args: { chain_run_id: fx.chainId, force: true },
    });
    assert.equal(forced["ok"], true, JSON.stringify(forced["error"]));
  } finally {
    await close(env);
  }
});
