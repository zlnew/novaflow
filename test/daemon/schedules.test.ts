import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../../src/store/ids.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { createTask } from "../../src/tasks.ts";
import { canonicalTimestamp } from "../../src/sched/iso.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";

/**
 * FR-SCH-01/03 end to end: the schedule ops (attach/list/pause/resume),
 * the dispatch-tick evaluator (fire = the ONE draft→queued row via
 * enqueueTask, trigger_type 'schedule', actor 'scheduler'), and the
 * missed-run boot recovery (skip advances; run_immediately fires
 * EXACTLY once; expired one-shots carry next_run_at NULL).
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(
  over: {
    daemonConfig?: string;
    tickMs?: number;
    probeArgs?: string[];
    probeTimeoutMs?: number;
    seed?: (db: Database.Database, seeded: SeededStore) => void;
  } = {},
): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-sched-"));
  const seeded = seedFileStore(dir);
  if (over.seed !== undefined) {
    const db = openDb(seeded.dbPath);
    migrate(db); // idempotent
    over.seed(db, seeded);
    db.close();
  }
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(
    cfgPath,
    over.daemonConfig ?? "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n",
  );
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: over.probeArgs ?? [STUB, "ok"],
    probeTimeoutMs: over.probeTimeoutMs ?? 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: over.tickMs ?? 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return {
    dir,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    workspaceId: seeded.workspaceId,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    handle,
    client,
  };
}


/** A draft task inserted directly (schedule-seed helper; schedules fire the
 *  guarded enqueue later, so raw insert of the DRAFT row is safe here).
 *  The row carries the seeded target's scope — the guarded enqueue
 *  refuses a task with zero target_scopes (DEBT-010). */
function insertDraftTask(db: Database.Database, seeded: SeededStore, key: string): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, seeded.projectId, key, key, `Objective for ${key}.`, seeded.profileId);
  db.prepare(
    `INSERT INTO task_target_scopes (id, task_id, target_id, access_mode)
     VALUES (?, ?, ?, 'read_write')`,
  ).run(ulid(), id, seeded.targetId);
  return id;
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

/** A draft task in the seeded store (pre-boot, via the guarded service). */
async function createTaskVia(env: Env, key: string): Promise<string> {
  const res = await env.client.request({
    id: `c-${key}`,
    op: "nova_task_create",
    args: {
      project_id: env.projectId,
      key,
      title: key,
      objective: "Implement the thing end to end.",
      profile_name: "dev",
      target_scopes: [{ repo_alias: "ws-app", access_mode: "read_write" }],
    },
  });
  assert.equal(res["ok"], true, JSON.stringify(res));
  return (res["data"] as { task: { id: string } }).task.id;
}

async function attachVia(
  env: Env,
  taskId: string,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await env.client.request({
    id: "attach",
    op: "nova_schedule_attach",
    args: { task_id: taskId, ...over },
  });
  return res;
}

function taskState(env: Env, taskId: string): string {
  const ro = readConnection(env.dbPath);
  const state = (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
  ro.close();
  return state;
}

function scheduleRow(env: Env, scheduleId: string): Record<string, unknown> {
  const ro = readConnection(env.dbPath);
  const row = ro.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Record<string, unknown>;
  ro.close();
  return row;
}

function enqueueRows(env: Env, taskId: string): Array<Record<string, unknown>> {
  const ro = readConnection(env.dbPath);
  const rows = ro
    .prepare(
      "SELECT * FROM state_transition_logs WHERE task_id = ? AND from_state = 'draft' AND to_state = 'queued' ORDER BY created_at",
    )
    .all(taskId) as Array<Record<string, unknown>>;
  ro.close();
  return rows;
}

/** Insert a raw schedule row (the DDL tolerates dangling target_id). */
function insertScheduleRow(
  dbPath: string,
  row: {
    target_id: string;
    cron_expr?: string | null;
    run_at?: string | null;
    missed_policy?: string;
    enabled?: number;
    last_run_at?: string | null;
    next_run_at?: string | null;
  },
): string {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const id = ulid();
  db.prepare(
    `INSERT INTO schedules
       (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
        missed_policy, enabled, last_run_at, next_run_at)
     VALUES (?, ?, 'task', ?, ?, ?, 'UTC', ?, ?, ?, ?)`,
  ).run(
    id,
    (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id,
    row.target_id,
    row.cron_expr ?? null,
    row.run_at ?? null,
    row.missed_policy ?? "skip",
    row.enabled ?? 1,
    row.last_run_at ?? null,
    row.next_run_at ?? null,
  );
  db.close();
  return id;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/* ------------------------------- the evaluator ------------------------------- */

test("evaluator: a due one-shot fires the verbatim draft→queued row (trigger_type schedule, actor scheduler) and expires to NULL", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    // a run_at already past at attach fires at the next evaluation pass
    const past = new Date(Date.now() - 30_000).toISOString();
    const attach = await attachVia(env, taskId, { run_at: past });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const id = (attach["data"] as { id: string }).id;

    await waitFor(() => enqueueRows(env, taskId).length === 1, 6000);
    assert.notEqual(taskState(env, taskId), "draft", "the task left draft");
    const rows = enqueueRows(env, taskId);
    assert.equal(rows.length, 1, "exactly ONE draft→queued row — the enqueue row, fired by the schedule");
    assert.equal(rows[0]!["trigger_type"], "schedule");
    assert.equal(rows[0]!["actor"], "scheduler");

    const row = scheduleRow(env, id);
    assert.equal(row["next_run_at"], null, "FR-SCH-03: an expired one-shot carries NULL");
    assert.match(String(row["last_run_at"]), CANONICAL_RE);
    // it never re-fires
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(enqueueRows(env, taskId).length, 1);
  } finally {
    await shutdown(env);
  }
});

test("evaluator: a due cron fires once, then advances to its next occurrence (last_run_at recorded)", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const attach = await attachVia(env, taskId, { cron_expr: "*/5 * * * *" });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const id = (attach["data"] as { id: string }).id;
    // force the row due (the runtime equivalent of a pause across the
    // boundary — the evaluator's normal pass handles it the same way)
    const rw = new Database(env.dbPath);
    rw.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      canonicalTimestamp(Date.now() - 60_000),
      id,
    );
    rw.close();

    await waitFor(() => enqueueRows(env, taskId).length === 1, 6000);
    assert.notEqual(taskState(env, taskId), "draft");
    const rows = enqueueRows(env, taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["trigger_type"], "schedule");
    assert.equal(rows[0]!["actor"], "scheduler");

    const row = scheduleRow(env, id);
    const nextMs = Date.parse(String(row["next_run_at"]));
    assert.ok(nextMs > Date.now() - 1000, "the cron advanced past its fired occurrence");
    assert.equal((nextMs / 60_000) % 5, 0);
    assert.match(String(row["last_run_at"]), CANONICAL_RE);
  } finally {
    await shutdown(env);
  }
});

test("evaluator: a non-draft target advances WITHOUT a second transition (the matrix is the arbiter)", async () => {
  const env = await boot();
  try {
    // freeze dispatch, enqueue the task by the human surface, attach a
    // due one-shot, resume: the schedule must not double-enqueue
    await env.client.request({ id: "pause", op: "nova_daemon_pause", args: {} });
    const taskId = await createTaskVia(env, "T1");
    const run = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: taskId } });
    assert.equal(run["ok"], true, JSON.stringify(run));
    assert.equal(taskState(env, taskId), "queued");

    const attach = await attachVia(env, taskId, { run_at: new Date(Date.now() - 30_000).toISOString() });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const id = (attach["data"] as { id: string }).id;
    await env.client.request({ id: "resume", op: "nova_daemon_resume", args: {} });

    await waitFor(() => {
      const row = scheduleRow(env, id);
      return row["next_run_at"] === null;
    }, 6000);
    // exactly one draft→queued row — the human one; the schedule advanced silently
    const rows = enqueueRows(env, taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["trigger_type"], "human");
    assert.equal(scheduleRow(env, id)["last_run_at"] !== null, true, "the occurrence is recorded as consumed");
  } finally {
    await shutdown(env);
  }
});

test("evaluator: a dangling target_id row is skipped with a note and advanced — never a wedge", async () => {
  const env = await boot();
  try {
    const id = insertScheduleRow(env.dbPath, {
      target_id: ulid(), // no such task
      cron_expr: "*/5 * * * *",
      next_run_at: canonicalTimestamp(Date.now() - 60_000),
    });
    await waitFor(() => {
      const row = scheduleRow(env, id);
      return row["next_run_at"] !== null && Date.parse(String(row["next_run_at"])) > Date.now() - 1000;
    }, 6000);
    const row = scheduleRow(env, id);
    assert.equal(row["last_run_at"], null, "no run happened — the reference is dead");
    assert.ok(Date.parse(String(row["next_run_at"])) > Date.now(), "the cron advanced to its next occurrence");
  } finally {
    await shutdown(env);
  }
});

test("evaluator: NEVER bypasses the workspace gate — a non-active workspace skips + advances", async () => {
  const env = await boot();
  try {
    // DEBT-004 (the second member of the same family, found by the 40× stress
    // loop): the one-shot is due the moment it is attached, so a tick landing
    // between the attach and the archive fired it LEGITIMATELY — the workspace
    // was still active then, and the test's own premise was violated rather
    // than the product's. Ordering is what makes this deterministic: pause
    // freezes schedule evaluation too (pinned by the pause test), so the due
    // row is only ever evaluated AFTER the archive.
    await env.client.request({ id: "pause", op: "nova_daemon_pause", args: {} });
    const taskId = await createTaskVia(env, "T1");
    const attach = await attachVia(env, taskId, { run_at: new Date(Date.now() - 30_000).toISOString() });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const id = (attach["data"] as { id: string }).id;

    const archive = await env.client.request({
      id: "arch",
      op: "nova_workspace_archive",
      args: { workspace_id: env.workspaceId },
    });
    assert.equal(archive["ok"], true, JSON.stringify(archive));
    // resume: the FIRST evaluation of the due row now sees an archived workspace
    await env.client.request({ id: "resume", op: "nova_daemon_resume", args: {} });

    await waitFor(() => scheduleRow(env, id)["next_run_at"] === null, 15_000);
    assert.equal(taskState(env, taskId), "draft", "the task never moved — FR-WS-03 refuses");
    assert.equal(scheduleRow(env, id)["last_run_at"], null, "the run never happened");
  } finally {
    await shutdown(env);
  }
});

test("evaluator: a paused daemon freezes schedule evaluation too (the same pause the dispatch loop honors)", async () => {
  const env = await boot();
  try {
    await env.client.request({ id: "pause", op: "nova_daemon_pause", args: {} });
    const taskId = await createTaskVia(env, "T1");
    const attach = await attachVia(env, taskId, { run_at: new Date(Date.now() - 30_000).toISOString() });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const id = (attach["data"] as { id: string }).id;

    await new Promise((r) => setTimeout(r, 400)); // many 30 ms ticks pass while paused
    assert.equal(taskState(env, taskId), "draft", "paused: no schedule fires");
    assert.notEqual(scheduleRow(env, id)["next_run_at"], null, "paused: the due row is untouched");

    await env.client.request({ id: "resume", op: "nova_daemon_resume", args: {} });
    await waitFor(() => enqueueRows(env, taskId).length === 1, 6000);
    assert.notEqual(taskState(env, taskId), "draft");
    assert.equal(scheduleRow(env, id)["next_run_at"], null);
  } finally {
    await shutdown(env);
  }
});

/* ------------------------- boot recovery (FR-SCH-03 AC2) ------------------------- */

test("boot recovery: skip policy advances a missed cron without firing (last_run_at untouched)", async () => {
  const holder: { id?: string } = {};
  const env = await boot({
    seed: (db, seeded) => {
      createTask(db, {
        projectId: seeded.projectId,
        key: "MISSED-SKIP",
        title: "missed",
        objective: "o",
        profileId: seeded.profileId,
      });
      const row = db
        .prepare("SELECT id FROM tasks WHERE key = 'MISSED-SKIP'")
        .get() as { id: string };
      holder.id = row.id;
      db.prepare(
        `INSERT INTO schedules
           (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
            missed_policy, enabled, last_run_at, next_run_at)
         VALUES (?, ?, 'task', ?, '*/5 * * * *', NULL, 'UTC', 'skip', 1, NULL, ?)`,
      ).run(
        ulid(),
        seeded.workspaceId,
        row.id,
        canonicalTimestamp(Date.now() - 3_600_000), // missed by an hour of downtime
      );
    },
  });
  try {
    assert.equal(taskState(env, holder.id!), "draft", "the missed occurrence was SKIPPED, not fired");
    const row = db_row(env, holder.id!);
    assert.equal(row["last_run_at"], null, "the run never happened");
    const nextMs = Date.parse(String(row["next_run_at"]));
    assert.ok(nextMs > Date.now() - 1000, "advanced to the next future occurrence");
    assert.equal((nextMs / 60_000) % 5, 0);
    // and it will NOT fire again as "missed" on the next tick
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(taskState(env, holder.id!), "draft");
  } finally {
    await shutdown(env);
  }
});

test("boot recovery: run_immediately fires a missed cron EXACTLY ONCE, then advances", async () => {
  const holder: { id?: string } = {};
  const env = await boot({
    seed: (db, seeded) => {
      createTask(db, {
        projectId: seeded.projectId,
        key: "MISSED-RUN",
        title: "missed",
        objective: "o",
        profileId: seeded.profileId,
        targetScopes: [{ targetId: seeded.targetId, accessMode: "read_write" }],
      });
      const row = db.prepare("SELECT id FROM tasks WHERE key = 'MISSED-RUN'").get() as { id: string };
      holder.id = row.id;
      db.prepare(
        `INSERT INTO schedules
           (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
            missed_policy, enabled, last_run_at, next_run_at)
         VALUES (?, ?, 'task', ?, '*/5 * * * *', NULL, 'UTC', 'run_immediately', 1, NULL, ?)`,
      ).run(
        ulid(),
        seeded.workspaceId,
        row.id,
        canonicalTimestamp(Date.now() - 3_600_000),
      );
    },
  });
  try {
    await waitFor(() => taskState(env, holder.id!) !== "draft", 6000);
    const rows = enqueueRows(env, holder.id!);
    assert.equal(rows.length, 1, "fired EXACTLY once");
    assert.equal(rows[0]!["trigger_type"], "schedule");
    assert.equal(rows[0]!["actor"], "scheduler");
    const row = db_row(env, holder.id!);
    assert.match(String(row["last_run_at"]), CANONICAL_RE);
    const nextMs = Date.parse(String(row["next_run_at"]));
    assert.ok(nextMs > Date.now() - 1000, "the cron advanced to its next occurrence after the catch-up fire");
    assert.equal((nextMs / 60_000) % 5, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(enqueueRows(env, holder.id!).length, 1, "no second fire");
  } finally {
    await shutdown(env);
  }
});

test("boot recovery: an expired one-shot goes NULL — skip leaves last_run_at untouched, run_immediately fires once", async () => {
  // skip: the run never happened
  const skipHolder: { id?: string } = {};
  const envSkip = await boot({
    seed: (db, seeded) => {
      createTask(db, {
        projectId: seeded.projectId,
        key: "ONE-SKIP",
        title: "one",
        objective: "o",
        profileId: seeded.profileId,
        targetScopes: [{ targetId: seeded.targetId, accessMode: "read_write" }],
      });
      const row = db.prepare("SELECT id FROM tasks WHERE key = 'ONE-SKIP'").get() as { id: string };
      skipHolder.id = row.id;
      db.prepare(
        `INSERT INTO schedules
           (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
            missed_policy, enabled, last_run_at, next_run_at)
         VALUES (?, ?, 'task', ?, NULL, ?, 'UTC', 'skip', 1, NULL, ?)`,
      ).run(
        ulid(),
        seeded.workspaceId,
        row.id,
        canonicalTimestamp(Date.now() - 3_600_000),
        canonicalTimestamp(Date.now() - 3_600_000),
      );
    },
  });
  try {
    assert.equal(taskState(envSkip, skipHolder.id!), "draft");
    const row = db_row(envSkip, skipHolder.id!);
    assert.equal(row["next_run_at"], null, "FR-SCH-03: an expired one-shot carries NULL");
    assert.equal(row["last_run_at"], null, "the run never happened");
  } finally {
    await shutdown(envSkip);
  }

  // run_immediately: fires exactly once, then expires
  const runHolder: { id?: string } = {};
  const envRun = await boot({
    seed: (db, seeded) => {
      createTask(db, {
        projectId: seeded.projectId,
        key: "ONE-RUN",
        title: "one",
        objective: "o",
        profileId: seeded.profileId,
        targetScopes: [{ targetId: seeded.targetId, accessMode: "read_write" }],
      });
      const row = db.prepare("SELECT id FROM tasks WHERE key = 'ONE-RUN'").get() as { id: string };
      runHolder.id = row.id;
      db.prepare(
        `INSERT INTO schedules
           (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
            missed_policy, enabled, last_run_at, next_run_at)
         VALUES (?, ?, 'task', ?, NULL, ?, 'UTC', 'run_immediately', 1, NULL, ?)`,
      ).run(
        ulid(),
        seeded.workspaceId,
        row.id,
        canonicalTimestamp(Date.now() - 3_600_000),
        canonicalTimestamp(Date.now() - 3_600_000),
      );
    },
  });
  try {
    await waitFor(() => taskState(envRun, runHolder.id!) !== "draft", 6000);
    assert.equal(enqueueRows(envRun, runHolder.id!).length, 1);
    assert.equal(enqueueRows(envRun, runHolder.id!)[0]!["trigger_type"], "schedule");
    const row = db_row(envRun, runHolder.id!);
    assert.equal(row["next_run_at"], null);
    assert.match(String(row["last_run_at"]), CANONICAL_RE);
  } finally {
    await shutdown(envRun);
  }
});

/* ------------------------------ PRESERVE (shared code) ------------------------------ */

test("PRESERVE: the human enqueue path is unchanged — nova_task_run still logs trigger_type 'human'", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    await attachVia(env, taskId, { cron_expr: "*/5 * * * *" }); // schedules exist; irrelevant to the human path
    const run = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: taskId } });
    assert.equal(run["ok"], true, JSON.stringify(run));
    const rows = enqueueRows(env, taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["trigger_type"], "human");
  } finally {
    await shutdown(env);
  }
});

test("PRESERVE: a paused scheduler still admits nothing (the dispatch tick change is additive)", async () => {
  const env = await boot();
  try {
    await env.client.request({ id: "pause", op: "nova_daemon_pause", args: {} });
    const taskId = await createTaskVia(env, "T2");
    const run = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: taskId } });
    assert.equal(run["ok"], true, JSON.stringify(run));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(taskState(env, taskId), "queued", "paused: no new spawn");
  } finally {
    await shutdown(env);
  }
});

/** The schedule row targeting the given task (single-schedule helper). */
function db_row(env: Env, taskId: string): Record<string, unknown> {
  const ro = readConnection(env.dbPath);
  const row = ro
    .prepare("SELECT * FROM schedules WHERE target_id = ? ORDER BY id LIMIT 1")
    .get(taskId) as Record<string, unknown>;
  ro.close();
  return row;
}

test("shutdown during a schedule fire: stop() awaits the in-flight pass — no unhandled rejection, the occurrence resolves cleanly (review round)", async () => {
  // slow probe so a fire hangs long enough for stop() to land mid-flight
  const env = await boot({ probeArgs: [STUB, "silent"], probeTimeoutMs: 2000, tickMs: 20 });
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  const SCHED = "01ARZ3NDEKTSV4RRFFQ69G5FAVS";
  try {
    const taskId = await createTaskVia(env, "SD-RACE");
    // attach a PAST one-shot post-boot (boot scan is done; the row goes due
    // immediately) — the next tick fires it and its probe then hangs ~2 s
    const attach = await env.client.request({
      id: "attach-race",
      op: "nova_schedule_attach",
      args: { task_id: taskId, run_at: "2026-01-01T00:00:00Z" },
    });
    assert.equal(attach["ok"], true, JSON.stringify(attach));
    const row0 = (attach["data"] as { schedule: { id: string } }).schedule;
    // wait for the tick to fire (probe now hanging)
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await env.handle.stop(); // mid-probe: must bound-await the in-flight pass
    const waited = Date.now() - t0;
    assert.ok(waited < 4500, `stop() took ${waited} ms`);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(rejections.length, 0, `unhandled rejections: ${rejections.map(String).join("; ")}`);
    // DISCRIMINATOR: the awaited pass completed against the still-open store
    // — the probe timed out, the occurrence was cleanly SKIPPED (A3:
    // last_run_at untouched, one-shot advanced to NULL). A gutted stop()
    // closes the store mid-fire and the row is left with its past
    // next_run_at (the pass died at its first store read).
    const db = openDb(env.dbPath);
    const row = db
      .prepare("SELECT enabled, next_run_at, last_run_at FROM schedules WHERE id = ?")
      .get(row0.id) as { enabled: number; next_run_at: string | null; last_run_at: string | null };
    db.close();
    assert.equal(row.enabled, 1, "the pass completed cleanly — no quarantine");
    assert.equal(row.next_run_at, null, "the expired one-shot advanced to NULL");
    assert.equal(row.last_run_at, null, "the refused occurrence claims no run");
    void SCHED;
  } finally {
    process.off("unhandledRejection", onRejection);
    env.client.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("an out-of-band corrupt cron row is quarantined, not fatal: warn + enabled=0 + NULL next_run_at", async () => {
  const env = await boot({
    tickMs: 20,
    seed: (db, seeded) => {
      db.prepare(
        `INSERT INTO schedules (id, workspace_id, target_type, target_id, cron_expr, next_run_at)
         VALUES (?, ?, 'task', ?, 'not a cron', ?)`,
      ).run(
        "01ARZ3NDEKTSV4RRFFQ69G5FAWC",
        seeded.workspaceId,
        insertDraftTask(db, seeded, "SD-CORRUPT"),
        "2026-01-01T00:00:00.000Z",
      );
    },
  });
  try {
    // DEBT-004: the quarantine lands on the first evaluation pass, but a
    // FIXED 250 ms wait assumed that pass had run by then — under full-suite
    // load the pass (and any catalog probe ahead of it in the tick) can be
    // later than that, which is the captured flake. Poll the ROW itself,
    // bounded: the assertions below are unchanged.
    await waitFor(() => {
      const db = openDb(env.dbPath);
      try {
        const r = db
          .prepare("SELECT enabled FROM schedules WHERE cron_expr = 'not a cron'")
          .get() as { enabled: number } | undefined;
        return r?.enabled === 0;
      } finally {
        db.close();
      }
    }, 15_000);
    const db = openDb(env.dbPath);
    const row = db
      .prepare("SELECT enabled, next_run_at FROM schedules WHERE cron_expr = 'not a cron'")
      .get() as { enabled: number; next_run_at: string | null };
    db.close();
    assert.equal(row.enabled, 0, "the corrupt row is quarantined");
    assert.equal(row.next_run_at, null, "never re-selected by a later tick");
    // daemon still answers over the socket
    const status = await env.client.request({ id: "alive", op: "nova_daemon_status", args: {} });
    assert.equal(status["ok"], true, JSON.stringify(status));
  } finally {
    await shutdown(env);
  }
});
