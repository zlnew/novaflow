import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { startRun, type RunOutcome, type TaskRunRecord } from "../../src/runs/loop.ts";
import { SNAPSHOT_FILENAME } from "../../src/verify/protected.ts";

/**
 * novaflow-v030/readme W1 R1.3 (amendments row 1) — DEBT-007 closure:
 * per-run worktree isolation per `architecture` 4.4 / 8.3
 * (`git worktree add -b novaflow/run-<run_id>
 * .novaflow/worktrees/<run_id>/<target_alias> HEAD`), the run row's
 * `worktree_root` (migration 0004), and the fail-closed refusal when a
 * worktree cannot be created.
 *
 * Classification is by target_type AND access mode (`data` 2.x keeps them
 * orthogonal): `git_repo` + `read_write` → isolated worktree; `git_repo` +
 * `read_only` and `directory` → in place, `worktree_root` NULL.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const MODEL = "claude-3-5-sonnet-20241022";
const BOUND_MS = 20000;

type Seed = {
  db: Database.Database;
  wsRoot: string;
  projectId: string;
  profileId: string;
  pricesPath: string;
  pidfile: string;
  repos: string[];
};

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function gitOk(cwd: string, ...args: string[]): string {
  const res = git(cwd, ...args);
  assert.equal(res.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

/** A real repo with one commit; `commit: false` leaves HEAD unborn. */
function gitRepo(opts: { commit?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "novaflow-wtg-"));
  gitOk(root, "init", "-q");
  gitOk(root, "config", "user.email", "t@example.com");
  gitOk(root, "config", "user.name", "t");
  if (opts.commit !== false) {
    writeFileSync(join(root, "README.md"), "# base\n");
    gitOk(root, "add", "-A");
    gitOk(root, "commit", "-q", "-m", "base");
  }
  return root;
}

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-wtws-"));
  mkdirSync(join(wsRoot, "prompts"), { recursive: true });
  writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");

  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 5)`,
  ).run(ulid(), MODEL);
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;

  const dir = mkdtempSync(join(tmpdir(), "novaflow-wtrun-"));
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify({ [MODEL]: { input: 3, output: 15 } }));
  return { db, wsRoot, projectId, profileId, pricesPath, pidfile: join(dir, "stub.pid"), repos: [] };
}

/** Attach a scoped target (`project_targets` + `task_target_scopes`). */
function addTarget(
  s: Seed,
  taskId: string,
  opts: {
    alias: string;
    type: "git_repo" | "directory";
    root: string;
    access?: "read_only" | "read_write";
    /** Omitted → the DDL default ('main'); null → recorded as NULL. */
    baseBranch?: string | null;
  },
): string {
  s.db
    .prepare(
      `INSERT INTO project_targets (id, project_id, alias, target_type, root_path, default_access, base_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ulid(),
      s.projectId,
      opts.alias,
      opts.type,
      opts.root,
      opts.access ?? "read_write",
      opts.baseBranch === undefined ? "main" : opts.baseBranch,
    );
  const targetId = (
    s.db
      .prepare("SELECT id FROM project_targets WHERE alias = ? AND project_id = ?")
      .get(opts.alias, s.projectId) as { id: string }
  ).id;
  s.db
    .prepare("INSERT INTO task_target_scopes (id, task_id, target_id, access_mode) VALUES (?, ?, ?, ?)")
    .run(ulid(), taskId, targetId, opts.access ?? "read_write");
  return targetId;
}

/** Attach an existing target to another task (one target, many scoped tasks). */
function addScope(s: Seed, taskId: string, targetId: string, access: "read_only" | "read_write"): void {
  s.db
    .prepare("INSERT INTO task_target_scopes (id, task_id, target_id, access_mode) VALUES (?, ?, ?, ?)")
    .run(ulid(), taskId, targetId, access);
}

function newTask(s: Seed, key: string): string {
  const task = createTask(s.db, {
    projectId: s.projectId,
    key,
    title: key,
    objective: "Do the objective.",
    profileId: s.profileId,
  });
  applyTransition(s.db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });
  return task.id;
}

function run(s: Seed, taskId: string, mode: string, over: Record<string, unknown> = {}): Promise<RunOutcome> {
  return startRun(s.db, taskId, "engine-worker", {
    piBin: "node",
    args: [STUB, mode, s.pidfile],
    pricesPath: s.pricesPath,
    extensionPath: "/ext/novaflow.ts",
    ...over,
  });
}

function runRows(s: Seed, taskId: string): TaskRunRecord[] {
  return s.db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number")
    .all(taskId) as TaskRunRecord[];
}

type Receipt = { cwd: string; prompt: unknown; emitted: string[] };

function receipt(sessionDir: string): Receipt {
  return JSON.parse(readFileSync(join(sessionDir, "stub-receipt.json"), "utf8")) as Receipt;
}

function cleanup(s: Seed): void {
  s.db.close();
  rmSync(s.wsRoot, { recursive: true, force: true });
  for (const repo of s.repos) rmSync(repo, { recursive: true, force: true });
}

/* ------------------------- R1.3: isolated trees, per run ------------------------- */

test("two concurrent runs on one git_repo target get DISJOINT worktree roots, one commit each, shared checkout untouched", async (t) => {
  const s = seed();
  const repo = gitRepo();
  s.repos.push(repo);
  const first = newTask(s, "TASK-1");
  const sharedTarget = addTarget(s, first, { alias: "app", type: "git_repo", root: repo, access: "read_write" });
  const second = newTask(s, "TASK-2");
  addScope(s, second, sharedTarget, "read_write");
  try {
    const [a, b] = await withBound(t.signal, BOUND_MS, Promise.all([run(s, first, "run-commit"), run(s, second, "run-commit")]));
    assert.equal(a!.finalState, "validating");
    assert.equal(b!.finalState, "validating");

    const rowA = runRows(s, first)[0]!;
    const rowB = runRows(s, second)[0]!;
    // migration 0004: the ROOT (one column describes a 1..N target run)
    assert.equal(rowA.worktree_root, join(s.wsRoot, ".novaflow", "worktrees", rowA.id));
    assert.equal(rowB.worktree_root, join(s.wsRoot, ".novaflow", "worktrees", rowB.id));
    assert.notEqual(rowA.worktree_root, rowB.worktree_root, "two runs must never share a root");

    // one per-target subdirectory beneath each root, on the spec's branch
    for (const row of [rowA, rowB]) {
      const sub = join(row.worktree_root!, "app");
      assert.ok(existsSync(sub), `missing worktree subdir ${sub}`);
      assert.equal(gitOk(sub, "rev-parse", "--abbrev-ref", "HEAD").trim(), `novaflow/run-${row.id}`);
      assert.equal(readdirSync(row.worktree_root!).sort().join(","), "app");
      // one commit landed in EACH tree
      assert.equal(gitOk(sub, "log", "--format=%s", "-1").trim(), "worktree commit");
      assert.ok(existsSync(join(sub, "WORKTREE.md")));

      // the pi process ran IN its own tree
      assert.equal(receipt(row.pi_session_dir).cwd, sub);

      // the persisted artifacts (data 3.x): the diff and the commit list
      const patch = readFileSync(join(row.pi_session_dir, "workspace_diff.patch"), "utf8");
      assert.match(patch, /SCRATCH\.md/, "the uncommitted edit is in workspace_diff.patch");
      const commits = JSON.parse(row.git_commits_json) as Record<string, string[]>;
      assert.equal(commits["app"]?.length, 1, "git_commits_json records the run's commit");
      assert.match(commits["app"]![0]!, /worktree commit/);
    }
    assert.notEqual(rowA.git_commits_json, rowB.git_commits_json);

    // the shared checkout is untouched: clean, no agent commit, no agent file
    assert.equal(gitOk(repo, "status", "--porcelain"), "");
    assert.equal(gitOk(repo, "log", "--format=%s").trim(), "base");
    assert.equal(existsSync(join(repo, "WORKTREE.md")), false);
    assert.equal(existsSync(join(repo, "SCRATCH.md")), false);
    // both worktrees persist after settle (NEVER auto-removed, data 3.x)
    assert.ok(existsSync(join(rowA.worktree_root!, "app")));
    assert.ok(existsSync(join(rowB.worktree_root!, "app")));
  } finally {
    cleanup(s);
  }
});

test("a git_repo read_only target and a directory target run IN PLACE with worktree_root NULL", async (t) => {
  const s = seed();
  const readonlyRepo = gitRepo();
  const directory = mkdtempSync(join(tmpdir(), "novaflow-wtdir-"));
  s.repos.push(readonlyRepo, directory);
  const roTask = newTask(s, "TASK-RO");
  addTarget(s, roTask, { alias: "ro", type: "git_repo", root: readonlyRepo, access: "read_only" });
  const dirTask = newTask(s, "TASK-DIR");
  addTarget(s, dirTask, { alias: "docs", type: "directory", root: directory, access: "read_write" });
  try {
    const [ro, dir] = await withBound(t.signal, BOUND_MS, Promise.all([run(s, roTask, "run-ok"), run(s, dirTask, "run-ok")]));
    assert.equal(ro!.finalState, "validating");
    assert.equal(dir!.finalState, "validating");

    const roRow = runRows(s, roTask)[0]!;
    const dirRow = runRows(s, dirTask)[0]!;
    for (const row of [roRow, dirRow]) {
      assert.equal(row.worktree_root, null, "in-place runs carry no worktree root");
      assert.equal(row.status, "succeeded");
      // no cwd override: the child inherits the engine's cwd
      assert.equal(receipt(row.pi_session_dir).cwd, process.cwd());
      assert.equal(existsSync(join(s.wsRoot, ".novaflow", "worktrees", row.id)), false);
    }
    // the read_only repo grew no worktree at all
    assert.equal(gitOk(readonlyRepo, "worktree", "list", "--porcelain").includes(".novaflow"), false);
  } finally {
    cleanup(s);
  }
});

test("multi-target: cwd is the FIRST read_write target's worktree subdir and every writable git target gets one", async (t) => {
  const s = seed();
  const api = gitRepo();
  const web = gitRepo();
  s.repos.push(api, web);
  const task = newTask(s, "TASK-MULTI");
  addTarget(s, task, { alias: "api", type: "git_repo", root: api, access: "read_write" });
  addTarget(s, task, { alias: "web", type: "git_repo", root: web, access: "read_write" });
  addTarget(s, task, { alias: "docs", type: "directory", root: api, access: "read_only" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-ok"));
    assert.equal(outcome.finalState, "validating");
    const row = runRows(s, task)[0]!;
    assert.ok(row.worktree_root !== null);
    // the layout of architecture 4.4: one subdir per target alias
    assert.deepEqual(readdirSync(row.worktree_root!).sort(), ["api", "web"]);
    // the FIRST (scope-row order) read_write git target is the cwd
    assert.equal(receipt(row.pi_session_dir).cwd, join(row.worktree_root!, "api"));
    assert.equal(gitOk(api, "status", "--porcelain"), "");
    assert.equal(gitOk(web, "status", "--porcelain"), "");
  } finally {
    cleanup(s);
  }
});

test("a worktree that cannot be created REFUSES the run with the reason (no fallback to the shared tree)", async (t) => {
  const s = seed();
  // valid git dir for preflight (git status succeeds) but an unborn HEAD,
  // so `git worktree add … HEAD` fails — the fake bad git dir
  const broken = gitRepo({ commit: false });
  s.repos.push(broken);
  const task = newTask(s, "TASK-FAIL");
  addTarget(s, task, { alias: "app", type: "git_repo", root: broken, access: "read_write" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-commit"));
    assert.equal(outcome.finalState, "failed");

    const row = runRows(s, task)[0]!;
    assert.equal(row.status, "failed");
    assert.equal(row.preflight_status, "failed"); // the existing refusal path
    assert.equal(row.worktree_root, null);
    assert.equal(row.pid, null, "no child was ever spawned");
    assert.equal(row.input_tokens + row.output_tokens, 0, "zero LLM tokens");
    assert.match(row.error_summary ?? "", /preflight failure:/);
    assert.match(row.error_summary ?? "", /worktree/);
    assert.match(row.error_summary ?? "", /"app"/); // names the target
    assert.match(row.error_summary ?? "", /invalid reference|HEAD/); // the git reason
    assert.match(row.error_summary ?? "", /no fallback to the shared tree/);

    // never fell back: nothing ran in the shared tree, no run dir artifacts
    assert.equal(existsSync(join(broken, "WORKTREE.md")), false);
    assert.equal(existsSync(join(broken, "stub-receipt.json")), false);
    assert.equal(existsSync(join(row.pi_session_dir, "stub-receipt.json")), false);
    assert.equal(existsSync(join(s.wsRoot, ".novaflow", "worktrees", row.id)), false);

    // the refusal is recorded on the transition log with the reason
    const log = s.db
      .prepare("SELECT reason FROM state_transition_logs WHERE task_id = ? AND to_state = 'failed'")
      .get(task) as { reason: string } | undefined;
    assert.ok(log !== undefined);
    assert.match(log.reason, /worktree/);
  } finally {
    cleanup(s);
  }
});

test("base branch: a recorded, resolvable base_branch is the branch point (HEAD only when nothing resolves)", async (t) => {
  const s = seed();
  const repo = gitRepo();
  s.repos.push(repo);
  const original = gitOk(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  gitOk(repo, "checkout", "-q", "-b", "release");
  writeFileSync(join(repo, "RELEASE.md"), "# release\n");
  gitOk(repo, "add", "-A");
  gitOk(repo, "commit", "-q", "-m", "release commit");
  gitOk(repo, "checkout", "-q", original); // HEAD moves away from release
  const task = newTask(s, "TASK-BASE");
  addTarget(s, task, { alias: "app", type: "git_repo", root: repo, access: "read_write", baseBranch: "release" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-ok"));
    assert.equal(outcome.finalState, "validating");
    const row = runRows(s, task)[0]!;
    const sub = join(row.worktree_root!, "app");
    // the recorded base is the start point, NOT the repo's current HEAD
    assert.ok(existsSync(join(sub, "RELEASE.md")), "the worktree branched from the recorded base");
    assert.equal(gitOk(sub, "log", "--format=%s", "-1").trim(), "release commit");
    // and the report names the class each target got (events.jsonl, the
    // REDACTED read surface)
    const events = readFileSync(join(row.pi_session_dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes("novaflow_worktree"));
    assert.equal(events.length, 1, "one worktree report frame");
    const frame = JSON.parse(events[0]!) as {
      type: string;
      worktree_root: string;
      cwd: string;
      targets: Array<{ alias: string; placement: string; path: string | null; base: string }>;
    };
    assert.equal(frame.type, "novaflow_worktree");
    assert.equal(frame.worktree_root, row.worktree_root);
    assert.equal(frame.cwd, sub);
    assert.deepEqual(
      frame.targets.map((x) => [x.alias, x.placement, x.base]),
      [["app", "worktree", "release"]],
    );
  } finally {
    cleanup(s);
  }
});

/* ------------- P9 re-judge round: re-rooting, rollback, alias backstop ------------- */

test("the preflight snapshot re-roots worktree-placed targets to the worktree path (in-place targets keep the shared root)", async (t) => {
  const s = seed();
  const repo = gitRepo();
  const roRepo = gitRepo();
  s.repos.push(repo, roRepo);
  const task = newTask(s, "TASK-SNAP");
  addTarget(s, task, { alias: "app", type: "git_repo", root: repo, access: "read_write" });
  addTarget(s, task, { alias: "ro", type: "git_repo", root: roRepo, access: "read_only" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-ok"));
    assert.equal(outcome.finalState, "validating");
    const row = runRows(s, task)[0]!;
    const sub = join(row.worktree_root!, "app");
    const snap = JSON.parse(readFileSync(join(row.pi_session_dir, SNAPSHOT_FILENAME), "utf8")) as {
      targets: Array<{ alias: string; root_path: string }>;
    };
    const byAlias = new Map(snap.targets.map((x) => [x.alias, x.root_path]));
    // the enforcement root of the worktree-placed target IS the worktree —
    // the extension's scope roots and the verifier both read this file
    assert.equal(byAlias.get("app"), sub);
    // the in-place read_only target keeps the shared root
    assert.equal(byAlias.get("ro"), roRepo);
  } finally {
    cleanup(s);
  }
});

test("partial provisioning ROLLS BACK: a failed second target leaves no worktree dirs and no branches", async (t) => {
  const s = seed();
  const good = gitRepo();
  const broken = gitRepo({ commit: false }); // `git worktree add ... HEAD` fails
  s.repos.push(good, broken);
  const task = newTask(s, "TASK-PARTIAL");
  addTarget(s, task, { alias: "app", type: "git_repo", root: good, access: "read_write" });
  addTarget(s, task, { alias: "web", type: "git_repo", root: broken, access: "read_write" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-ok"));
    assert.equal(outcome.finalState, "failed");
    const row = runRows(s, task)[0]!;
    assert.equal(row.preflight_status, "failed");
    assert.equal(row.worktree_root, null, "the refused run records no root");
    // the refusal names the FAILED target and the rollback
    assert.match(row.error_summary ?? "", /worktree creation failed for target "web"/);
    assert.match(row.error_summary ?? "", /rolled back the 1 tree/);
    // NO worktree dirs: the run's root does not exist at all
    assert.equal(existsSync(join(s.wsRoot, ".novaflow", "worktrees", row.id)), false);
    // NO leftover metadata or branch in the repo whose tree WAS created
    assert.equal(gitOk(good, "worktree", "list", "--porcelain").includes("worktrees"), false);
    assert.equal(gitOk(good, "branch", "--list", "novaflow/run-*"), "");
    assert.equal(gitOk(good, "status", "--porcelain"), "");
  } finally {
    cleanup(s);
  }
});

test("an unsafe target alias is refused at provisioning, naming the alias (no tree ever created)", async (t) => {
  const s = seed();
  const repo = gitRepo();
  s.repos.push(repo);
  const task = newTask(s, "TASK-ALIAS");
  // a target row that bypassed the wire validation (the backstop)
  addTarget(s, task, { alias: "../evil", type: "git_repo", root: repo, access: "read_write" });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, task, "run-ok"));
    assert.equal(outcome.finalState, "failed");
    const row = runRows(s, task)[0]!;
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /invalid target alias/);
    assert.match(row.error_summary ?? "", /evil/);
    assert.equal(row.worktree_root, null);
    assert.equal(existsSync(join(s.wsRoot, ".novaflow", "worktrees", row.id)), false);
    assert.equal(gitOk(repo, "worktree", "list", "--porcelain").includes("worktrees"), false);
  } finally {
    cleanup(s);
  }
});
