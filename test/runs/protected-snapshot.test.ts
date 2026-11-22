import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { startRun, type TaskRunRecord } from "../../src/runs/loop.ts";
import { SNAPSHOT_FILENAME } from "../../src/verify/protected.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const BOUND_MS = 15000;
const MODEL = "claude-3-5-sonnet-20241022";
const PRICES = { [MODEL]: { input: 3, output: 15 } };

/**
 * Deliverable wiring: the p2b preflight (FR-TSK-10, zero LLM tokens)
 * snapshots the pre-run protected digests into the run dir, so the p2c
 * verifier can prove protected-file integrity against the PRE-RUN
 * state (architecture 5.8 Post-Run Verifier).
 */

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  projectId: string;
  pricesPath: string;
  pidfile: string;
};

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-ws-"));
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
     VALUES (?, NULL, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 1.5)`,
  ).run(ulid(), MODEL);
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;

  const task = createTask(db, {
    projectId,
    key: "TASK-101",
    title: "Implement PKCE",
    objective: "Implement PKCE code challenge verification.",
    profileId,
  });
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });

  const dir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify(PRICES));
  return {
    db,
    wsRoot,
    taskId: task.id,
    projectId,
    pricesPath,
    pidfile: join(dir, "stub.pid"),
  };
}

/** A scoped target with one protected file on disk. */
function addTarget(
  s: Seed,
  root: string,
  protectedGlobs: string[],
  type: "directory" | "git_repo" = "directory",
): string {
  const targetId = ulid();
  s.db
    .prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, 'app', ?, ?)",
    )
    .run(targetId, s.projectId, type, root);
  s.db
    .prepare(
      `INSERT INTO task_target_scopes
         (id, task_id, target_id, verification_commands_json,
          protected_test_globs_json, write_scope_globs_json)
       VALUES (?, ?, ?, '[]', ?, '["**/*"]')`,
    )
    .run(ulid(), s.taskId, targetId, JSON.stringify(protectedGlobs));
  return targetId;
}

function runRow(s: Seed): TaskRunRecord {
  const rows = s.db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number")
    .all(s.taskId) as TaskRunRecord[];
  const row = rows[0];
  assert.ok(row, "no run row");
  return row;
}

test("startRun preflight writes protected-digests.json with the PRE-RUN protected digests", async (t) => {
  const s = seed();
  // a real scoped target with a protected test file
  const tgtRoot = mkdtempSync(join(tmpdir(), "novaflow-tgt-"));
  mkdirSync(join(tgtRoot, "tests"), { recursive: true });
  writeFileSync(join(tgtRoot, "tests", "p.test.ts"), "test('p', () => {});\n");
  addTarget(s, tgtRoot, ["tests/**"]);
  try {
    const outcome = await withBound(t.signal, BOUND_MS, startRun(s.db, s.taskId, "engine-worker", {
      piBin: "node",
      args: [STUB, "run-ok", s.pidfile],
      pricesPath: s.pricesPath,
      extensionPath: "/ext/novaflow.ts",
    }));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s);
    const snapshotPath = join(row.pi_session_dir, SNAPSHOT_FILENAME);
    assert.ok(existsSync(snapshotPath), "the preflight snapshot must land in the run dir");
    const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      task_id: string;
      run_id: string;
      targets: Array<{ alias: string; files: Record<string, string> }>;
    };
    assert.equal(snap.task_id, s.taskId);
    assert.equal(snap.run_id, row.id);
    assert.equal(snap.targets.length, 1);
    assert.equal(snap.targets[0]?.alias, "app");
    assert.deepEqual(Object.keys(snap.targets[0]?.files ?? {}), ["tests/p.test.ts"]);
    assert.match(snap.targets[0]?.files["tests/p.test.ts"] ?? "", /^[0-9a-f]{64}$/);
    // the artifact the stub wrote is still intact
    assert.equal(
      (JSON.parse(readFileSync(row.artifact_path!, "utf8")) as Record<string, unknown>)["status"],
      "completed",
    );
    rmSync(tgtRoot, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("a scoped target whose root is missing is a preflight failure — no spawn, zero tokens", async (t) => {
  const s = seed();
  addTarget(s, "/no/such/repo", ["tests/**"]);
  try {
    const outcome = await withBound(t.signal, BOUND_MS, startRun(s.db, s.taskId, "engine-worker", {
      piBin: "node",
      args: [STUB, "run-ok", s.pidfile],
      pricesPath: s.pricesPath,
      extensionPath: "/ext/novaflow.ts",
    }));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s);
    assert.equal(row.preflight_status, "failed");
    assert.equal(row.pid, null);
    assert.match(row.error_summary ?? "", /protected digests: target root missing/);
    // the stub was never spawned
    assert.equal(existsSync(s.pidfile), false);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("a scoped git_repo target with >20k files inside node_modules/ passes preflight (pruned walk)", async (t) => {
  const s = seed();
  const tgtRoot = mkdtempSync(join(tmpdir(), "novaflow-repo-"));
  mkdirSync(join(tgtRoot, "tests"), { recursive: true });
  writeFileSync(join(tgtRoot, "tests", "p.test.ts"), "test('p', () => {});\n");
  writeFileSync(join(tgtRoot, "readme.md"), "# readme\n");
  // a real, CLEAN git repo (FR-TSK-10 AC2 checks `git status --porcelain`
  // at preflight): node_modules is gitignored, so the base stays clean
  // while the digest walk still prunes it by name.
  writeFileSync(join(tgtRoot, ".gitignore"), "node_modules/\n");
  execSync(
    `git init -q && git config user.email t@example.com && git config user.name t && git add -A && git commit -q -m init`,
    { cwd: tgtRoot, stdio: "ignore" },
  );
  // a fat node_modules: 21 000 files, beyond the walk's safety bound —
  // digest-invariant, pruned from every walk
  execSync(`bash -c "mkdir -p node_modules && touch node_modules/f{1..21000}"`, {
    cwd: tgtRoot,
    stdio: "ignore",
  });
  // `**/*` has no literal prefix → the walk covers the whole (pruned) tree
  addTarget(s, tgtRoot, ["**/*"], "git_repo");
  try {
    const outcome = await withBound(t.signal, BOUND_MS, startRun(s.db, s.taskId, "engine-worker", {
      piBin: "node",
      args: [STUB, "run-ok", s.pidfile],
      pricesPath: s.pricesPath,
      extensionPath: "/ext/novaflow.ts",
    }));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s);
    assert.equal(row.preflight_status, "passed");
    const snap = JSON.parse(readFileSync(join(row.pi_session_dir, SNAPSHOT_FILENAME), "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(snap.targets[0]?.files ?? {}).sort(), [
      ".gitignore", // the fixture's clean-base marker (AC2)
      "readme.md",
      "tests/p.test.ts",
    ]);
    rmSync(tgtRoot, { recursive: true, force: true });
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("a task with no scopes still writes an (empty) snapshot — fail-closed uniformity", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, startRun(s.db, s.taskId, "engine-worker", {
      piBin: "node",
      args: [STUB, "run-ok", s.pidfile],
      pricesPath: s.pricesPath,
      extensionPath: "/ext/novaflow.ts",
    }));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s);
    const snap = JSON.parse(readFileSync(join(row.pi_session_dir, SNAPSHOT_FILENAME), "utf8")) as {
      targets: unknown[];
    };
    assert.deepEqual(snap.targets, []);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});
