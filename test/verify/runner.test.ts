import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid } from "../../src/store/ids.ts";
import {
  collectScopeCommands,
  runVerification,
  type ScopeCommand,
  type VerifyOutcome,
} from "../../src/verify/runner.ts";

/**
 * FR-TSK-12 — the independent post-run command verifier. The engine
 * executes the task's configured verification commands directly (never
 * trusting the agent), judges exit codes as authoritative, and enforces
 * the `[novaflow-verify] tests=N pass=N fail=N` trailing-marker rule
 * (marker with tests=0 = gaming = fail; no marker = exit-code-only).
 */

const BOUND_MS = 15000;

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  projectId: string;
};

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-verify-"));
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
       (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run((ulid()), projectId, profileId);
  const taskId = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
  return { db, wsRoot, taskId, projectId };
}

function addTarget(
  s: Seed,
  opts: {
    alias: string;
    type?: "git_repo" | "directory";
    root: string;
    commands: string[];
    protected?: string[];
    write?: string[];
  },
): string {
  const targetId = ulid();
  s.db
    .prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, ?, ?, ?)",
    )
    .run(targetId, s.projectId, opts.alias, opts.type ?? "git_repo", opts.root);
  s.db
    .prepare(
      `INSERT INTO task_target_scopes
         (id, task_id, target_id, verification_commands_json,
          protected_test_globs_json, write_scope_globs_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ulid(),
      s.taskId,
      targetId,
      JSON.stringify(opts.commands),
      JSON.stringify(opts.protected ?? []),
      JSON.stringify(opts.write ?? ["**/*"]),
    );
  return targetId;
}

async function assertReaped(pid: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — gone
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`process ${pid} is still alive after the verifier resolved`);
}

/* ------------------------------ command collection ------------------------------ */

test("collectScopeCommands: union across scopes, first-seen order, each command pinned to its target's root_path", () => {
  const s = seed();
  try {
    const t1 = addTarget(s, { alias: "app", root: "/repo/app", commands: ["npm test", "npm run typecheck"] });
    addTarget(s, { alias: "docs", type: "directory", root: "/repo/docs", commands: ["npm test", "lint docs"] });
    const cmds = collectScopeCommands(s.db, s.taskId);
    const shapes: Array<Pick<ScopeCommand, "command" | "rootPath" | "alias">> = cmds.map((c) => ({
      command: c.command,
      rootPath: c.rootPath,
      alias: c.alias,
    }));
    assert.deepEqual(shapes, [
      { command: "npm test", rootPath: "/repo/app", alias: "app" },
      { command: "npm run typecheck", rootPath: "/repo/app", alias: "app" },
      { command: "lint docs", rootPath: "/repo/docs", alias: "docs" },
    ]);
    assert.equal(new Set(cmds.map((c) => c.command)).size, cmds.length, "deduped");
    assert.equal(cmds[0]?.targetId, t1);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("malformed verification_commands_json → FAILED command-set verdict, never a throw", async (t) => {
  const s = seed();
  try {
    const targetId = ulid();
    s.db
      .prepare(
        "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'app', 'git_repo', '/repo/app')",
      )
      .run(targetId, s.projectId);
    s.db
      .prepare(
        `INSERT INTO task_target_scopes
           (id, task_id, target_id, verification_commands_json,
            protected_test_globs_json, write_scope_globs_json)
         VALUES (?, ?, ?, '{oops', '[]', '["**/*"]')`,
      )
      .run(ulid(), s.taskId, targetId);
    // previously this rejected out of runVerification; it must resolve
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, false);
    assert.deepEqual(out.results, []);
    assert.match(out.collectionError ?? "", /JSON|verification_commands_json/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* --------------------------------- verdict rules --------------------------------- */

test("exit 0, no marker → exit-code-only pass", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, { alias: "app", root, commands: ["printf 'all good\\n'"] });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, true);
    assert.equal(out.results.length, 1);
    const r = out.results[0]!;
    assert.equal(r.exitCode, 0);
    assert.equal(r.marker, null);
    assert.equal(r.passed, true);
    assert.match(r.stdoutTail, /all good/);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("exit 0 with a trailing marker tests=3 → pass, marker counts recorded", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, {
      alias: "app",
      root,
      commands: ["printf '[novaflow-verify] tests=3 pass=3 fail=0\\n'"],
    });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, true);
    assert.deepEqual(out.results[0]?.marker, { tests: 3, pass: 3, fail: 0 });
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("marker with tests=0 is gaming → fail even at exit 0 (FR-TSK-12)", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, {
      alias: "app",
      root,
      commands: ["printf '[novaflow-verify] tests=0 pass=0 fail=0\\n'"],
    });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, false);
    const r = out.results[0]!;
    assert.equal(r.exitCode, 0); // the exit code is recorded honestly
    assert.deepEqual(r.marker, { tests: 0, pass: 0, fail: 0 });
    assert.equal(r.passed, false);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("exit code is authoritative: exit 1 with a healthy marker → fail", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, {
      alias: "app",
      root,
      commands: ["printf '[novaflow-verify] tests=5 pass=5 fail=0\\n'; exit 1"],
    });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, false);
    assert.equal(out.results[0]?.passed, false);
    assert.equal(out.results[0]?.exitCode, 1);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("the marker must be its own trailing line — text embedded around it is not a marker", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, {
      alias: "app",
      root,
      commands: ["printf 'prefix-[novaflow-verify] tests=9 pass=9 fail=0\\n'"],
    });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    // not the marker line → exit-code-only → exit 0 passes
    assert.equal(out.results[0]?.marker, null);
    assert.equal(out.passed, true);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("no configured verification commands → vacuous pass with empty results", async (t) => {
  const s = seed();
  try {
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    const vacuous: VerifyOutcome = { passed: true, collectionError: null, results: [] };
    assert.deepEqual(out, vacuous);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/* ------------------------------ cwd + multiple targets --------------------------- */

test("each command executes with cwd = its target's root_path", async (t) => {
  const s = seed();
  const root1 = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
  const root2 = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
  try {
    addTarget(s, { alias: "app", root: root1, commands: ["pwd"] });
    addTarget(s, { alias: "docs", root: root2, commands: ["echo docs; pwd"] });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, true);
    assert.match(out.results[0]?.stdoutTail ?? "", new RegExp(root1));
    assert.match(out.results[1]?.stdoutTail ?? "", new RegExp(root2));
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

/* ------------------------------- containment discipline -------------------------- */

test("a hung verifier command never hangs the engine: bounded timeout, SIGTERM→SIGKILL group, reaped", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    addTarget(s, { alias: "app", root, commands: ["sleep 600"] });
    const started = Date.now();
    const out = await withBound(
      t.signal,
      BOUND_MS,
      runVerification(s.db, s.taskId, { timeoutMs: 400 }),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `timeout path must not stall, took ${elapsed} ms`);
    assert.equal(out.passed, false);
    const r = out.results[0]!;
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null); // killed by signal, no exit code
    // the artifact mapping records the GNU timeout convention (documented)
    assert.equal(r.exitCodeForArtifact, 124);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("the verifier's group kill reaches the command's own children (killpg discipline)", async (t) => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
  try {
    // the command backgrounds a sleeper (its own child) and waits on it —
    // only a GROUP kill can end both
    addTarget(s, {
      alias: "app",
      root,
      commands: ["sleep 600 & echo $! > sleeper.pid; wait"],
    });
    const out = await withBound(
      t.signal,
      BOUND_MS,
      runVerification(s.db, s.taskId, { timeoutMs: 400 }),
    );
    assert.equal(out.passed, false);
    const pid = Number(readFileSync(join(root, "sleeper.pid"), "utf8").trim());
    assert.ok(pid > 0, "sleeper pid recorded");
    await assertReaped(pid); // the group kill reaped the grandchild too
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("an unspawnable verification command fails without throwing, with the spawn error recorded", async (t) => {
  const s = seed();
  try {
    const root = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
    // /bin/sh always exists; force a spawn failure through a nonexistent cwd
    // by pointing the target at a path that is a FILE, not a directory.
    const notADir = join(root, "plainfile");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(notADir, "x");
    addTarget(s, { alias: "app", root: notADir, commands: ["true"] });
    const out = await withBound(t.signal, BOUND_MS, runVerification(s.db, s.taskId));
    assert.equal(out.passed, false);
    const r = out.results[0]!;
    assert.equal(r.passed, false);
    assert.equal(r.exitCode, null);
    assert.match(r.spawnError ?? "", /ENOTDIR|spawn/i);
    rmSync(root, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});
