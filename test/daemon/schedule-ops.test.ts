import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../../src/store/ids.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { canonicalTimestamp } from "../../src/sched/iso.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";

/**
 * The schedule OPS over the wire (srs 4.1.1 `nova schedule`
 * [attach|list|pause|resume]; FR-SCH-01): the DDL XOR rule, cron/ISO
 * validation surfaced as schema_invalid, the task-exists + ACTIVE
 * workspace gates, the missed_policy default chain (workspace config
 * < explicit value), UTC-only timezone, computed next_run_at at
 * attach, multiple schedules per task, and pause/resume semantics.
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
    seed?: (db: ReturnType<typeof openDb>, seeded: SeededStore) => void;
  } = {},
): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-schedops-"));
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
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
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

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

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

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/* ------------------------------ attach validation ----------------------------- */

test("schedule attach: the DDL XOR rule — both or neither cron_expr/run_at is schema_invalid", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const both = await attachVia(env, taskId, { cron_expr: "* * * * *", run_at: "2026-01-01T00:00:00Z" });
    assert.equal(both["ok"], false);
    assert.equal((both["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((both["error"] as Record<string, unknown>)["message"]), /exactly one of cron_expr or run_at/);

    const neither = await attachVia(env, taskId, {});
    assert.equal(neither["ok"], false);
    assert.equal((neither["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((neither["error"] as Record<string, unknown>)["message"]), /exactly one of cron_expr or run_at/);
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: cron validation errors are schema_invalid and name the field + token", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    for (const [over, re] of [
      [{ cron_expr: "0 0 * * MON" }, /day-of-week.*MON/],
      [{ cron_expr: "* * * * " }, /5 fields/],
      [{ cron_expr: "61 * * * *" }, /minute.*"61"/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const res = await attachVia(env, taskId, over);
      assert.equal(res["ok"], false, JSON.stringify(over));
      assert.equal((res["error"] as Record<string, unknown>)["code"], "schema_invalid");
      assert.match(String((res["error"] as Record<string, unknown>)["message"]), re);
    }
    // a cron that can never match a calendar date is refused at attach
    const dead = await attachVia(env, taskId, { cron_expr: "0 0 31 2 *" });
    assert.equal(dead["ok"], false);
    assert.equal((dead["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((dead["error"] as Record<string, unknown>)["message"]), /never/);
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: ISO validation — a calendar date is not a moment; naive timestamps are refused", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const dateOnly = await attachVia(env, taskId, { run_at: "2026-01-01" });
    assert.equal(dateOnly["ok"], false);
    assert.equal((dateOnly["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((dateOnly["error"] as Record<string, unknown>)["message"]), /moment/);

    const naive = await attachVia(env, taskId, { run_at: "2026-01-01T00:00:00" });
    assert.equal(naive["ok"], false);
    assert.equal((naive["error"] as Record<string, unknown>)["code"], "schema_invalid");
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: the task must exist (dangling target_id is a DDL tolerance, not an attach feature)", async () => {
  const env = await boot();
  try {
    const res = await attachVia(env, ulid(), { cron_expr: "* * * * *" });
    assert.equal(res["ok"], false);
    assert.equal((res["error"] as Record<string, unknown>)["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: the task's workspace must be ACTIVE (the run/retry gate, reused)", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const archive = await env.client.request({
      id: "arch",
      op: "nova_workspace_archive",
      args: { workspace_id: env.workspaceId },
    });
    assert.equal(archive["ok"], true, JSON.stringify(archive));
    const res = await attachVia(env, taskId, { cron_expr: "* * * * *" });
    assert.equal(res["ok"], false);
    assert.equal((res["error"] as Record<string, unknown>)["code"], "aborted");
    assert.match(String((res["error"] as Record<string, unknown>)["message"]), /FR-WS-03|disabled/);
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: missed_policy defaults from the workspace config; an explicit value wins", async () => {
  const env = await boot({
    seed: (_db, seeded) => {
      mkdirSync(join(seeded.wsRoot, ".novaflow"), { recursive: true });
      writeFileSync(
        join(seeded.wsRoot, ".novaflow", "config.yaml"),
        "missed_run_policy: run_immediately\n",
      );
    },
  });
  try {
    const taskId = await createTaskVia(env, "T1");
    const res = await attachVia(env, taskId, { run_at: "2027-01-01T00:00:00Z" });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const row = scheduleRow(env, (res["data"] as { id: string }).id);
    assert.equal(row["missed_policy"], "run_immediately"); // from the workspace config

    const explicit = await attachVia(env, taskId, { run_at: "2027-01-01T00:00:00Z", missed_policy: "skip" });
    assert.equal(explicit["ok"], true, JSON.stringify(explicit));
    const row2 = scheduleRow(env, (explicit["data"] as { id: string }).id);
    assert.equal(row2["missed_policy"], "skip"); // explicit wins
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: computes and stores next_run_at at attach (cron strictly after; run_at canonical)", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const before = Date.now();
    const cronRes = await attachVia(env, taskId, { cron_expr: "*/5 * * * *" });
    assert.equal(cronRes["ok"], true, JSON.stringify(cronRes));
    const cronRow = scheduleRow(env, (cronRes["data"] as { id: string }).id);
    assert.match(String(cronRow["next_run_at"]), CANONICAL_RE);
    const nextMs = Date.parse(String(cronRow["next_run_at"]));
    assert.ok(nextMs > before, "the cron's next run is strictly after attach");
    assert.equal((nextMs / 60_000) % 5, 0, "the next run is on a */5 minute boundary");

    const runAt = "2027-06-01T12:00:00Z";
    const isoRes = await attachVia(env, taskId, { run_at: runAt });
    assert.equal(isoRes["ok"], true, JSON.stringify(isoRes));
    const isoRow = scheduleRow(env, (isoRes["data"] as { id: string }).id);
    assert.equal(isoRow["run_at"], "2027-06-01T12:00:00.000Z"); // canonical DDL form
    assert.equal(isoRow["next_run_at"], "2027-06-01T12:00:00.000Z");
    assert.equal(isoRow["last_run_at"], null);
    assert.equal(isoRow["enabled"], 1); // DDL default
    assert.equal(isoRow["target_type"], "task");
    assert.equal(isoRow["target_id"], taskId);
    assert.equal(isoRow["workspace_id"], env.workspaceId);
    assert.equal(isoRow["timezone"], "UTC");
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: timezone is UTC-only in v1 — other values are refused at the wire", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const res = await attachVia(env, taskId, { cron_expr: "* * * * *", timezone: "Europe/Berlin" });
    assert.equal(res["ok"], false);
    assert.equal((res["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((res["error"] as Record<string, unknown>)["message"]), /UTC/);
  } finally {
    await shutdown(env);
  }
});

test("schedule attach: multiple schedules per task are schema-legal — each fires independently", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const a = await attachVia(env, taskId, { cron_expr: "*/5 * * * *" });
    const b = await attachVia(env, taskId, { run_at: "2027-01-01T00:00:00Z" });
    assert.equal(a["ok"], true, JSON.stringify(a));
    assert.equal(b["ok"], true, JSON.stringify(b));
    const idA = (a["data"] as { id: string }).id;
    const idB = (b["data"] as { id: string }).id;
    assert.notEqual(idA, idB);
    assert.match(idA, ULID_RE);
    assert.match(idB, ULID_RE);
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------------ list ------------------------------------ */

test("schedule list: rows with the computed fields; workspace_id filter; unknown workspace not_found", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    await attachVia(env, taskId, { cron_expr: "*/10 * * * *", missed_policy: "run_immediately" });
    const res = await env.client.request({ id: "l1", op: "nova_schedule_list", args: {} });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const schedules = (res["data"] as { schedules: Array<Record<string, unknown>> }).schedules;
    assert.equal(schedules.length, 1);
    const row = schedules[0]!;
    for (const key of ["id", "task_id", "cron_expr", "run_at", "next_run_at", "enabled", "missed_policy", "last_run_at"]) {
      assert.ok(key in row, `list rows carry ${key}`);
    }
    assert.equal(row["task_id"], taskId);
    assert.equal(row["missed_policy"], "run_immediately");

    const scoped = await env.client.request({
      id: "l2",
      op: "nova_schedule_list",
      args: { workspace_id: env.workspaceId },
    });
    assert.equal(scoped["ok"], true);
    assert.equal(((scoped["data"] as { schedules: unknown[] }).schedules).length, 1);

    const none = await env.client.request({ id: "l3", op: "nova_schedule_list", args: { workspace_id: ulid() } });
    assert.equal(none["ok"], false);
    assert.equal((none["error"] as Record<string, unknown>)["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

test("schedule list: --task-style filter (task_id) and its not_found", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    await attachVia(env, taskId, { cron_expr: "*/10 * * * *" });
    const res = await env.client.request({ id: "t1", op: "nova_schedule_list", args: { task_id: taskId } });
    assert.equal(res["ok"], true, JSON.stringify(res));
    assert.equal(((res["data"] as { schedules: unknown[] }).schedules).length, 1);
    const missing = await env.client.request({ id: "t2", op: "nova_schedule_list", args: { task_id: ulid() } });
    assert.equal(missing["ok"], false);
    assert.equal((missing["error"] as Record<string, unknown>)["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ pause / resume ops ----------------------------- */

test("schedule pause: enabled=0, next_run_at kept; resume: enabled=1 + next_run_at recomputed from now", async () => {
  const env = await boot();
  try {
    const taskId = await createTaskVia(env, "T1");
    const attach = await attachVia(env, taskId, { cron_expr: "*/5 * * * *" });
    const id = (attach["data"] as { id: string }).id;
    const before = scheduleRow(env, id);

    const pause = await env.client.request({ id: "p1", op: "nova_schedule_pause", args: { schedule_id: id } });
    assert.equal(pause["ok"], true, JSON.stringify(pause));
    const pausedRow = scheduleRow(env, id);
    assert.equal(pausedRow["enabled"], 0);
    assert.equal(pausedRow["next_run_at"], before["next_run_at"]); // kept, not nulled

    // a paused schedule does NOT fire even when due (the evaluator only
    // considers enabled=1 — mirrors the partial index)
    const rw = new Database(env.dbPath);
    rw.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      canonicalTimestamp(Date.now() - 60_000),
      id,
    );
    rw.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(taskState(env, taskId), "draft");

    const resume = await env.client.request({ id: "r1", op: "nova_schedule_resume", args: { schedule_id: id } });
    assert.equal(resume["ok"], true, JSON.stringify(resume));
    const resumedRow = scheduleRow(env, id);
    assert.equal(resumedRow["enabled"], 1);
    const nextMs = Date.parse(String(resumedRow["next_run_at"]));
    assert.ok(nextMs > Date.now() - 1000, "resume recomputed next_run_at from now");
    assert.equal((nextMs / 60_000) % 5, 0, "the recomputed run is the cron's next occurrence");
    // no missed-run accumulation: the forced-due past value is gone
    assert.ok(nextMs > Date.now(), "a resumed cron fires its next occurrence, not the accumulated missed one");
  } finally {
    await shutdown(env);
  }
});

test("schedule pause/resume: unknown schedule_id is not_found; resume of a one-shot keeps run_at as its only occurrence", async () => {
  const env = await boot();
  try {
    const missing = await env.client.request({ id: "p0", op: "nova_schedule_pause", args: { schedule_id: ulid() } });
    assert.equal(missing["ok"], false);
    assert.equal((missing["error"] as Record<string, unknown>)["code"], "not_found");
    const missingResume = await env.client.request({ id: "r0", op: "nova_schedule_resume", args: { schedule_id: ulid() } });
    assert.equal(missingResume["ok"], false);
    assert.equal((missingResume["error"] as Record<string, unknown>)["code"], "not_found");

    const taskId = await createTaskVia(env, "T1");
    const attach = await attachVia(env, taskId, { run_at: "2027-01-01T00:00:00Z" });
    const id = (attach["data"] as { id: string }).id;
    await env.client.request({ id: "p1", op: "nova_schedule_pause", args: { schedule_id: id } });
    const resume = await env.client.request({ id: "r1", op: "nova_schedule_resume", args: { schedule_id: id } });
    assert.equal(resume["ok"], true, JSON.stringify(resume));
    const row = scheduleRow(env, id);
    assert.equal(row["next_run_at"], "2027-01-01T00:00:00.000Z"); // the one-shot's only moment
  } finally {
    await shutdown(env);
  }
});

