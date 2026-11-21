import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER } from "../../src/runs/triggers.ts";
import { seedFileStore, readConnection, MODEL } from "./seed.ts";
import { waitFor } from "./client.ts";

/**
 * startDaemon boot sequence (open+migrate → config → §8.4 recovery →
 * retry boot scan → dispatch → socket) and stop() discipline: no socket
 * file, no stray processes, no open handles, store closed.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

function daemonOpts(dir: string, seeded: { dbPath: string }, over: Record<string, unknown> = {}) {
  return {
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok", join(dir, "stub.pid")],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    tickMs: 30,
    ...over,
  };
}

function pkgVersion(): string {
  return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
}

async function assertReaped(pid: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`stub process ${pid} is still alive after stop()`);
}

test("boot: store opened + migrated, socket bound 0600 (TB-1), status data, clean stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const handle = await startDaemon(daemonOpts(dir, seeded));
  try {
    // the socket exists, operator-only (security TB-1)
    assert.ok(existsSync(handle.socketPath));
    assert.equal(statSync(handle.socketPath).mode & 0o777, 0o600);

    const status = handle.status();
    assert.equal(status.version, pkgVersion());
    assert.equal(status.scheduler.paused, false);
    assert.ok(status.uptime_sec >= 0);
    assert.deepEqual(status.recovery, { replayed: 0, failedIntake: 0, crashed: 0 });
    assert.equal(status.budgets.daily_usd, null); // no daemon config file → defaults
    assert.equal(status.budgets.monthly_usd, null);
    await handle.stop();
    // stop discipline: socket gone, store closed (a fresh connection works)
    assert.equal(existsSync(handle.socketPath), false);
    const check = new Database(seeded.dbPath);
    check.prepare("SELECT COUNT(*) AS n FROM tasks").get();
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken daemon config refuses the boot — no socket, store closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: bogus\n");
  await assert.rejects(
    startDaemon(daemonOpts(dir, seeded, { daemonConfigPath: cfgPath })),
    /refusing to boot/,
  );
  assert.equal(existsSync(join(dir, "novaflow.sock")), false);
  const check = new Database(seeded.dbPath); // the store was closed, not leaked
  check.prepare("SELECT COUNT(*) AS n FROM tasks").get();
  check.close();
  rmSync(dir, { recursive: true, force: true });
});

test("boot runs §8.4 recovery BEFORE dispatch: a pre-existing orphan is reconciled at start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  // pre-crash state, written straight into the store the daemon will open
  const db = new Database(seeded.dbPath);
  const task = createTask(db, {
    projectId: seeded.projectId,
    key: "ORPHAN",
    title: "t",
    objective: "o",
    profileId: seeded.profileId,
  });
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(db, task.id, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  const runId = task.id.slice(0, 25) + "A".repeat(1); // any distinct 26-char id
  const runDir = join(seeded.wsRoot, ".novaflow", "runs", task.id, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.raw.jsonl"),
    [JSON.stringify({ type: "message_end", usage: { input: 100, output: 20 } }), JSON.stringify({ type: "agent_settled" })].join("\n") + "\n",
  );
  writeFileSync(
    join(runDir, "result.json"),
    JSON.stringify({
      schema_version: "1.0.0",
      task_id: task.id,
      run_id: runId,
      status: "completed",
      summary: "Finished the orphaned work fully.",
      assumptions_made: [],
      open_questions: [],
      artifacts_modified: [],
      feedback_items: [],
      next_recommended_action: "proceed_to_next",
    }),
  );
  db.prepare(
    `INSERT INTO task_runs (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
        status, preflight_status, model_used, events_log_path)
     VALUES (?, ?, ?, 1, ?, ?, 'running', 'passed', ?, ?)`,
  ).run(runId, task.id, seeded.profileId, runId, runDir, MODEL, join(runDir, "events.jsonl"));
  db.close();

  const handle = await startDaemon(daemonOpts(dir, seeded));
  try {
    assert.deepEqual(handle.status().recovery, { replayed: 1, failedIntake: 0, crashed: 0 });
    const ro = readConnection(seeded.dbPath);
    const state = (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as { state: string }).state;
    const runStatus = (ro.prepare("SELECT status FROM task_runs WHERE id = ?").get(runId) as { status: string }).status;
    ro.close();
    assert.equal(state, "validating"); // the settlement was replayed at boot
    assert.equal(runStatus, "succeeded");
  } finally {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() reaps live runs via operator-abort semantics — no strays, socket removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const handle = await startDaemon(
    daemonOpts(dir, seeded, {
      runArgs: [STUB, "run-hang", join(dir, "stub.pid")],
    }),
  );
  try {
    // enqueue a task over the store-side connection; dispatch starts it
    const db = new Database(seeded.dbPath);
    const task = createTask(db, {
      projectId: seeded.projectId,
      key: "HANG",
      title: "t",
      objective: "o",
      profileId: seeded.profileId,
    });
    db.prepare("UPDATE tasks SET overrides_json = ? WHERE id = ?").run(
      JSON.stringify({ timeout_sec: 3600 }),
      task.id,
    );
    applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    db.close();

    const ro = readConnection(seeded.dbPath);
    await waitFor(() => {
      const row = ro
        .prepare("SELECT pid, status FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
        .get(task.id) as { pid: number | null; status: string } | undefined;
      return row !== undefined && row.status === "running" && row.pid !== null;
    });
    const pid = (ro
      .prepare("SELECT pid FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(task.id) as { pid: number }).pid;
    ro.close();

    await handle.stop();
    assert.equal(existsSync(handle.socketPath), false);

    const after = new Database(seeded.dbPath);
    const state = (after.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as { state: string }).state;
    const runStatus = (after
      .prepare("SELECT status FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(task.id) as { status: string }).status;
    after.close();
    assert.equal(state, "cancelled");
    assert.equal(runStatus, "cancelled");
    await assertReaped(pid);
  } finally {
    await handle.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second startDaemon on the same socket refuses (a live daemon is never stolen)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const a = await startDaemon(daemonOpts(dir, seeded));
  try {
    await assert.rejects(startDaemon(daemonOpts(dir, seeded)), /refusing to steal/);
  } finally {
    await a.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale socket file (no live daemon) is unlinked and rebound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const socketPath = join(dir, "novaflow.sock");
  // simulate a crashed daemon: a leftover socket file nobody answers on
  writeFileSync(socketPath, "stale");
  const handle = await startDaemon(daemonOpts(dir, seeded));
  try {
    assert.ok(existsSync(socketPath));
    assert.equal(statSync(socketPath).mode & 0o777, 0o600); // it is OUR socket now
  } finally {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRESERVE: startDaemon leaves zero stray node processes (child count unchanged)", async () => {
  const before = childCount();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-life-"));
  const seeded = seedFileStore(dir);
  const handle = await startDaemon(daemonOpts(dir, seeded));
  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 100)); // let the reaper settle
  assert.equal(childCount(), before);
});

function childCount(): number {
  try {
    const out = execSync('ps -o pid= --ppid "$PPID"', {
      shell: "/bin/bash",
      env: { ...process.env, PPID: String(process.pid) },
    }).toString();
    return out.trim() === "" ? 0 : out.trim().split("\n").length;
  } catch {
    return 0;
  }
}
