import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import {
  SNAPSHOT_FILENAME,
  writeProtectedDigests,
  type ProtectedSnapshot,
} from "../../src/verify/protected.ts";
import { collectScopeCommands, runVerification } from "../../src/verify/runner.ts";
import { checkWritePath, loadRunContext } from "../../extensions/novaflow.ts";

/**
 * P9 re-judge CRITICAL — re-rooting every enforcement surface to the run's
 * EXECUTION root. Before the fix, `writeProtectedDigests` snapshotted every
 * target with its SHARED `root_path` BEFORE provisioning, so the pi extension
 * (which resolves scope roots ONLY from that snapshot) refused every write
 * inside the agent's own worktree, and verification ran against code the
 * agent never touched. These tests exercise the REAL enforcement path
 * deterministically (the extension's own `loadRunContext` + `checkWritePath`
 * over a snapshot written by the engine's own `writeProtectedDigests`):
 *
 *   - a snapshot rooted at the shared repo REFUSES a write inside
 *     `.novaflow/worktrees/<run_id>/<alias>/` (the pre-fix behavior, pinned);
 *   - a re-rooted snapshot (worktree path for worktree-placed targets,
 *     shared root for in-place targets) ALLOWS that write;
 *   - verification commands execute with cwd = the worktree path.
 */

const BOUND_MS = 15000;

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function gitOk(cwd: string, ...args: string[]): string {
  const res = git(cwd, ...args);
  assert.equal(res.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}

type Seed = {
  db: Database.Database;
  wsRoot: string;
  projectId: string;
  taskId: string;
  /** The SHARED checkout (the target's recorded root_path). */
  sharedRepo: string;
  /** The run's isolated tree under `.novaflow/worktrees/<run_id>/app`. */
  worktreePath: string;
  /** An in-place directory target root. */
  dirRoot: string;
  appTargetId: string;
  runDir: string;
  runId: string;
};

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-reroot-"));
  // the shared checkout: clean, one commit, protected tests/ + writable src/
  const sharedRepo = mkdtempSync(join(tmpdir(), "novaflow-reroot-repo-"));
  mkdirSync(join(sharedRepo, "src"));
  mkdirSync(join(sharedRepo, "tests"));
  writeFileSync(join(sharedRepo, "src", "main.ts"), "export {}\n");
  writeFileSync(join(sharedRepo, "tests", "p.test.ts"), "test('p', () => {});\n");
  gitOk(sharedRepo, "init", "-q");
  gitOk(sharedRepo, "config", "user.email", "t@example.com");
  gitOk(sharedRepo, "config", "user.name", "t");
  gitOk(sharedRepo, "add", "-A");
  gitOk(sharedRepo, "commit", "-q", "-m", "base");

  const runId = ulid();
  const worktreePath = join(wsRoot, ".novaflow", "worktrees", runId, "app");
  gitOk(sharedRepo, "worktree", "add", "-q", "-b", `novaflow/run-${runId}`, worktreePath, "HEAD");

  const dirRoot = mkdtempSync(join(tmpdir(), "novaflow-reroot-dir-"));
  writeFileSync(join(dirRoot, "notes.md"), "# notes\n");

  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare("INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')").run(
    ulid(),
    workspaceId,
  );
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'medium', 'prompts/dev_system.md', 60, 5)`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  const task = createTask(db, {
    projectId,
    key: "TASK-REROOT",
    title: "reroot",
    objective: "Re-root the enforcement surfaces.",
    profileId,
  });
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });

  const appTargetId = ulid();
  db.prepare(
    "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'app', 'git_repo', ?)",
  ).run(appTargetId, projectId, sharedRepo);
  db.prepare(
    `INSERT INTO task_target_scopes
       (id, task_id, target_id, access_mode, verification_commands_json,
        protected_test_globs_json, write_scope_globs_json)
     VALUES (?, ?, ?, 'read_write', '["pwd"]', ?, ?)`,
  ).run(ulid(), task.id, appTargetId, JSON.stringify(["tests/**"]), JSON.stringify(["src/**", "WORKTREE.md"]));
  const docsTargetId = ulid();
  db.prepare(
    "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'docs', 'directory', ?)",
  ).run(docsTargetId, projectId, dirRoot);
  db.prepare(
    `INSERT INTO task_target_scopes
       (id, task_id, target_id, access_mode, verification_commands_json,
        protected_test_globs_json, write_scope_globs_json)
     VALUES (?, ?, ?, 'read_write', '[]', '[]', '["**"]')`,
  ).run(ulid(), task.id, docsTargetId);

  const runDir = join(wsRoot, ".novaflow", "runs", task.id, runId);
  mkdirSync(runDir, { recursive: true });
  return { db, wsRoot, projectId, taskId: task.id, sharedRepo, worktreePath, dirRoot, appTargetId, runDir, runId };
}

function cleanup(s: Seed): void {
  gitOk(s.sharedRepo, "worktree", "remove", "--force", s.worktreePath);
  gitOk(s.sharedRepo, "branch", "-D", `novaflow/run-${s.runId}`);
  s.db.close();
  rmSync(s.wsRoot, { recursive: true, force: true });
  rmSync(s.sharedRepo, { recursive: true, force: true });
  rmSync(s.dirRoot, { recursive: true, force: true });
}

/** The engine-context.json the extension's loadRunContext consumes. */
function writeEngineContext(s: Seed, scopes: Array<Record<string, unknown>>): string {
  const path = join(s.runDir, "engine-context.json");
  writeFileSync(
    path,
    JSON.stringify({ task_id: s.taskId, run_id: s.runId, scopes }) + "\n",
  );
  return path;
}

function scopeShapes(s: Seed): Array<Record<string, unknown>> {
  return [
    {
      target_id: s.appTargetId,
      alias: "app",
      access_mode: "read_write",
      write_scope_globs: ["src/**", "WORKTREE.md"],
      protected_test_globs: ["tests/**"],
    },
    {
      target_id: (s.db.prepare("SELECT id FROM project_targets WHERE alias = 'docs'").get() as { id: string }).id,
      alias: "docs",
      access_mode: "read_write",
      write_scope_globs: ["**"],
      protected_test_globs: [],
    },
  ];
}

/* ------------------------------- the snapshot contents ---------------------------- */

test("the snapshot re-roots worktree-placed targets to the worktree path; in-place targets keep the shared root", () => {
  const s = seed();
  try {
    writeProtectedDigests(s.db, s.taskId, s.runDir, s.runId, { [s.appTargetId]: s.worktreePath });
    const snap = JSON.parse(readFileSync(join(s.runDir, SNAPSHOT_FILENAME), "utf8")) as ProtectedSnapshot;
    const app = snap.targets.find((t) => t.alias === "app")!;
    const docs = snap.targets.find((t) => t.alias === "docs")!;
    // the worktree-placed target's root IS the run's worktree path …
    assert.equal(app.root_path, s.worktreePath);
    // … and the in-place directory target keeps its shared root
    assert.equal(docs.root_path, s.dirRoot);
    // the protected DIGESTS stay sourced from the base (the shared tree,
    // clean at the base ref): the protected set is snapshotted exactly as
    // before, with the same relative paths enforceable inside the worktree
    assert.deepEqual(Object.keys(app.files), ["tests/p.test.ts"]);
    assert.match(app.files["tests/p.test.ts"] ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(docs.files).sort(), ["notes.md"]);
  } finally {
    cleanup(s);
  }
});

/* --------------------- the REAL extension enforcement path ------------------------ */

test("the extension's write scope follows the snapshot root: a re-rooted snapshot allows the worktree write the shared-root snapshot refuses", () => {
  const s = seed();
  try {
    const contextPath = writeEngineContext(s, scopeShapes(s));
    const writeInWorktree = join(s.worktreePath, "src", "feature.ts");

    // AFTER the fix: the snapshot carries the worktree path as the target
    // root, so the agent's own worktree is inside its write scope
    writeProtectedDigests(s.db, s.taskId, s.runDir, s.runId, { [s.appTargetId]: s.worktreePath });
    const rerooted = loadRunContext(contextPath);
    assert.equal(rerooted.loadError, null);
    assert.equal(rerooted.scopes.find((x) => x.alias === "app")!.root_path, s.worktreePath);
    assert.deepEqual(checkWritePath(rerooted.scopes, writeInWorktree), { ok: true });
    // protected paths are still refused INSIDE the worktree, and the shared
    // checkout (outside the worktree root) is no longer writable at all
    assert.equal(checkWritePath(rerooted.scopes, join(s.worktreePath, "tests", "p.test.ts")).ok, false);
    assert.equal(checkWritePath(rerooted.scopes, join(s.sharedRepo, "src", "escape.ts")).ok, false);
    // the in-place directory target keeps its shared-root scope
    assert.deepEqual(checkWritePath(rerooted.scopes, join(s.dirRoot, "more.md")), { ok: true });

    // BEFORE the fix (pinned): a snapshot rooted at the shared repo —
    // the pre-provisioning behavior — refuses the agent's own worktree
    writeProtectedDigests(s.db, s.taskId, s.runDir, ulid());
    const legacy = loadRunContext(contextPath);
    assert.equal(legacy.loadError, null);
    const refused = checkWritePath(legacy.scopes, writeInWorktree);
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.reason : "", /no target scope covers/);
  } finally {
    cleanup(s);
  }
});

/* -------------------------- verification runs where the agent worked --------------- */

test("verification commands execute with cwd = the worktree path for worktree-placed targets", async (t) => {
  const s = seed();
  try {
    const cmds = collectScopeCommands(s.db, s.taskId, { [s.appTargetId]: s.worktreePath });
    const app = cmds.find((c) => c.alias === "app")!;
    assert.equal(app.command, "pwd");
    assert.equal(app.rootPath, s.worktreePath, "the command's cwd is pinned to the execution root");

    const out = await withBound(
      t.signal,
      BOUND_MS,
      runVerification(s.db, s.taskId, { executionRoots: { [s.appTargetId]: s.worktreePath } }),
    );
    assert.equal(out.passed, true);
    assert.equal(out.results[0]!.cwd, s.worktreePath);
    assert.match(out.results[0]!.stdoutTail ?? "", new RegExp(s.worktreePath));
  } finally {
    cleanup(s);
  }
});
