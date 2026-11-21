import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { startRun, type TaskRunRecord } from "../../src/runs/loop.ts";
import { MODEL } from "../daemon/seed.ts";

/**
 * DEBT-002 closure — FR-TSK-10 pre-flight zero-token readiness, the
 * four checks the card adds to src/runs/loop.ts's preflight section:
 *   AC1 target roots exist + accessible (W_OK read_write, R_OK read_only)
 *   AC2 git_repo targets clean (`git status --porcelain` empty, local-only)
 *   AC3 the pi binary resolves (X_OK literal / on PATH) + the env hook
 *   AC4 the workspace/global budget ceiling vs run spend since UTC
 *       day/month start
 *   AC5 no LLM tokens on any failure (zero spawns).
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  projectId: string;
  pricesPath: string;
  pidfile: string;
};

function seed(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-pf-"));
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

  const task = createTask(db, {
    projectId,
    key: "TASK-101",
    title: "Implement PKCE",
    objective: "Implement PKCE code challenge verification.",
    profileId,
  });
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });

  const dir = mkdtempSync(join(tmpdir(), "novaflow-pfp-"));
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify({ [MODEL]: { input: 3, output: 15 } }));
  return { db, wsRoot, taskId: task.id, projectId, pricesPath, pidfile: join(dir, "stub.pid") };
}

/** Attach a scoped target (data.md project_targets/task_target_scopes). */
function addTarget(
  s: Seed,
  opts: { alias: string; type: "git_repo" | "directory"; root: string; access?: "read_only" | "read_write" },
): void {
  s.db
    .prepare(
      `INSERT INTO project_targets (id, project_id, alias, target_type, root_path, default_access)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ulid(), s.projectId, opts.alias, opts.type, opts.root, opts.access ?? "read_write");
  const targetId = (
    s.db.prepare("SELECT id FROM project_targets WHERE alias = ? AND project_id = ?").get(opts.alias, s.projectId) as { id: string }
  ).id;
  s.db
    .prepare(
      `INSERT INTO task_target_scopes (id, task_id, target_id, access_mode)
       VALUES (?, ?, ?, ?)`,
    )
    .run(ulid(), s.taskId, targetId, opts.access ?? "read_write");
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "novaflow-git-"));
  const run = (...args: string[]): void => {
    const res = spawnSync("git", args, { cwd: root });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  };
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "# clean\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return root;
}

function run(s: Seed, over: Record<string, unknown> = {}): Promise<{ finalState: string }> {
  return startRun(s.db, s.taskId, "engine-worker", {
    piBin: "node",
    args: [STUB, "run-ok", s.pidfile],
    pricesPath: s.pricesPath,
    extensionPath: "/ext/novaflow.ts",
    ...over,
  });
}

function runRow(s: Seed): TaskRunRecord {
  return s.db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(s.taskId) as TaskRunRecord;
}

function cleanup(s: Seed): void {
  s.db.close();
  rmSync(s.wsRoot, { recursive: true, force: true });
  rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
}

const BOUND = 15000;
function bound<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("preflight test stalled")), BOUND);
      t.unref?.();
    }),
  ]);
}

/* ------------------------------------- AC1 ------------------------------------- */

test("AC1: a scoped target whose root is missing → preflight failure naming alias+path, zero spawns", async () => {
  const s = seed();
  addTarget(s, { alias: "app", type: "directory", root: join(s.wsRoot, "gone") });
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s);
    assert.equal(row.preflight_status, "failed");
    assert.equal(row.pid, null);
    assert.match(row.error_summary ?? "", /preflight failure/);
    // the missing root is caught by the preflight layer (the protected
    // digest snapshot names it first — both are zero-token AC1 refusals)
    assert.match(row.error_summary ?? "", /app/);
    assert.match(row.error_summary ?? "", /gone/);
    assert.equal(existsSync(s.pidfile), false); // AC5: zero spawns
  } finally {
    cleanup(s);
  }
});

test("AC1: a read_write target on an unwritable root → preflight failure; read_only passes with R_OK", async () => {
  const s = seed();
  const ro = join(s.wsRoot, "readonly");
  mkdirSync(ro);
  chmodSync(ro, 0o555); // readable, not writable (we are not root)
  addTarget(s, { alias: "docs", type: "directory", root: ro, access: "read_only" });
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "validating"); // R_OK is enough for read_only
  } finally {
    chmodSync(ro, 0o755);
    cleanup(s);
  }

  const s2 = seed();
  const locked = join(s2.wsRoot, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  addTarget(s2, { alias: "app", type: "directory", root: locked, access: "read_write" });
  try {
    const outcome = await bound(run(s2));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s2);
    assert.match(row.error_summary ?? "", /target "app"/);
    assert.match(row.error_summary ?? "", /not writable/);
    assert.equal(existsSync(s2.pidfile), false);
  } finally {
    chmodSync(locked, 0o755);
    cleanup(s2);
  }
});

/* ------------------------------------- AC2 ------------------------------------- */

test("AC2: a clean git_repo target passes; a dirty one → preflight_failed naming the dirty paths, zero spawns", async () => {
  const clean = gitRepo();
  const s = seed();
  addTarget(s, { alias: "repo", type: "git_repo", root: clean });
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "validating"); // clean base: the run proceeds
  } finally {
    cleanup(s);
    rmSync(clean, { recursive: true, force: true });
  }

  const dirty = gitRepo();
  writeFileSync(join(dirty, "uncommitted.txt"), "dirt");
  const s2 = seed();
  addTarget(s2, { alias: "repo", type: "git_repo", root: dirty });
  try {
    const outcome = await bound(run(s2));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s2);
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /preflight failure/);
    assert.match(row.error_summary ?? "", /git_repo target "repo"/);
    assert.match(row.error_summary ?? "", /uncommitted\.txt/); // the dirty path is named
    assert.equal(existsSync(s2.pidfile), false); // AC5
  } finally {
    cleanup(s2);
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("AC2: a plain directory target is never git-checked (no git repo required)", async () => {
  const s = seed();
  const plain = join(s.wsRoot, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "loose.txt"), "not a git repo at all");
  addTarget(s, { alias: "data", type: "directory", root: plain });
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "validating");
  } finally {
    cleanup(s);
  }
});

/* ------------------------------------- AC3 ------------------------------------- */

test("AC3: an unresolvable pi binary → preflight failure (X_OK/PATH), zero spawns", async () => {
  const s = seed();
  try {
    const outcome = await bound(run(s, { piBin: "novaflow-no-such-pi-binary" }));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s);
    assert.equal(row.preflight_status, "failed");
    assert.equal(row.pid, null);
    assert.match(row.error_summary ?? "", /pi binary/);
    assert.match(row.error_summary ?? "", /novaflow-no-such-pi-binary/);
    assert.equal(existsSync(s.pidfile), false); // AC5
  } finally {
    cleanup(s);
  }
});

test("AC3: a literal path that is not executable → preflight failure; a PATH-resolvable bare name passes", async () => {
  const s = seed();
  try {
    const outcome = await bound(run(s, { piBin: "/etc/hostname" })); // exists, not executable
    assert.equal(outcome.finalState, "failed");
    assert.match(runRow(s).error_summary ?? "", /not executable/);
  } finally {
    cleanup(s);
  }
  // "node" resolves on PATH — the default suite shape already proves it;
  // this test pins that the check happens BEFORE the spawn (zero tokens)
  // by asserting a failing literal path never writes a pidfile above.
});

/* ------------------------------------- AC4 ------------------------------------- */

/** A past run's spend inside the workspace (started today, UTC). */
function addSpend(s: Seed, costUsd: number): void {
  s.db
    .prepare(
      `INSERT INTO task_runs (id, task_id, profile_id, attempt_number, pi_session_id,
         pi_session_dir, status, preflight_status, model_used, events_log_path, cost_usd)
       VALUES (?, ?, (SELECT id FROM agent_profiles), 1, ?, ?, 'succeeded', 'passed', ?, ?, ?)`,
    )
    .run(ulid(), s.taskId, ulid(), "/tmp/x", MODEL, "/tmp/e.jsonl", costUsd);
}

test("AC4: workspace daily budget exhausted → preflight_failed with the spend summary, zero spawns", async () => {
  const s = seed();
  mkdirSync(join(s.wsRoot, ".novaflow"));
  writeFileSync(
    join(s.wsRoot, ".novaflow", "config.yaml"),
    "budgets:\n  daily_usd: 5\n  monthly_usd: 500\n",
  );
  addSpend(s, 5.0);
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s);
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /budget_exceeded at preflight/);
    assert.match(row.error_summary ?? "", /daily spend \$5\.00 >= daily_usd \$5/);
    assert.equal(existsSync(s.pidfile), false); // AC5
  } finally {
    cleanup(s);
  }
});

test("AC4: the monthly ceiling applies across the UTC month", async () => {
  const s = seed();
  mkdirSync(join(s.wsRoot, ".novaflow"));
  writeFileSync(
    join(s.wsRoot, ".novaflow", "config.yaml"),
    "budgets:\n  daily_usd: 500\n  monthly_usd: 10\n",
  );
  addSpend(s, 10.0);
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "failed");
    assert.match(runRow(s).error_summary ?? "", /monthly spend \$10\.00 >= monthly_usd \$10/);
  } finally {
    cleanup(s);
  }
});

test("AC4 precedence: the daemon-global budget applies when the workspace defines none; a workspace value overrides it", async () => {
  // no workspace config file → the daemon global daily_usd 1 governs,
  // and existing spend 2 >= 1 blocks the run
  const s = seed();
  addSpend(s, 2.0);
  try {
    const outcome = await bound(run(s, { globalBudgets: { dailyUsd: 1, monthlyUsd: null } }));
    assert.equal(outcome.finalState, "failed");
    assert.match(runRow(s).error_summary ?? "", /daily spend \$2\.00 >= daily_usd \$1/);
    assert.match(runRow(s).error_summary ?? "", /daemon global/); // provenance named
  } finally {
    cleanup(s);
  }

  // the workspace pins its own (higher) ceiling → it wins over the global
  const s2 = seed();
  mkdirSync(join(s2.wsRoot, ".novaflow"));
  writeFileSync(join(s2.wsRoot, ".novaflow", "config.yaml"), "budgets:\n  daily_usd: 50\n");
  addSpend(s2, 2.0);
  try {
    const outcome = await bound(
      run(s2, { globalBudgets: { dailyUsd: 1, monthlyUsd: null } }),
    );
    assert.equal(outcome.finalState, "validating"); // 2 < 50: the run proceeds
  } finally {
    cleanup(s2);
  }
});

test("AC4: no budgets anywhere → unlimited, the run proceeds", async () => {
  const s = seed();
  addSpend(s, 1000);
  try {
    const outcome = await bound(run(s));
    assert.equal(outcome.finalState, "validating");
  } finally {
    cleanup(s);
  }
});
