import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFileStore } from "../daemon/seed.ts";
import { openDb, type Db } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * `nova status [--watch]` — the tier-C live screen (novaflow-v030/panel.md;
 * W4 R4.4's minimal form, which P12 extends). One screen: daemon state,
 * scheduler in-flight count, today/month spend with `prices_armed` and
 * `inert_models`, and the last three transitions as
 * `HH:MM:SS UTC KEY from→to`.
 *
 * The `--watch` loop polls `nova_transitions_since` with a CURSOR and only
 * reprints when the screen actually changes; the assertions below pin both
 * halves (it reprints on a new transition, and it does not churn while
 * nothing moves).
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>, timeoutMs = 60_000): Run {
  const res = spawnSync(NOVA, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Env = {
  dir: string;
  home: string;
  wsRoot: string;
  projectId: string;
  profileId: string;
  env: Record<string, string>;
  sock: string;
  db: Db;
};

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-status-"));
  const seeded = seedFileStore(dir);
  const home = join(dir, "novahome");
  mkdirSync(home);
  writeFileSync(join(home, "active-workspace"), "ws\n");
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: seeded.dbPath,
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
  };
  const start = runNova(["daemon", "start"], env);
  assert.equal(start.code, 0, `daemon start failed: ${start.stderr}`);
  const db = openDb(seeded.dbPath);
  migrate(db);
  return {
    dir,
    home,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    env,
    sock: env["NOVAFLOW_SOCK"]!,
    db,
  };
}

async function shutdown(e: Env): Promise<void> {
  try {
    e.db.close();
  } catch {
    // already closed by the test body
  }
  const stop = runNova(["daemon", "stop"], e.env);
  if (stop.code !== 0) {
    try {
      const pid = Number(readFileSync(join(e.home, "daemon.pid"), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 10_000;
  while (existsSync(e.sock) && Date.now() < deadline) await sleep(100);
  rmSync(e.dir, { recursive: true, force: true });
}

function addTask(e: Env, key: string): string {
  const taskId = ulid();
  e.db
    .prepare(
      "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?,?,?,?,'objective',?)",
    )
    .run(taskId, e.projectId, key, key, e.profileId);
  return taskId;
}

function addTransition(e: Env, taskId: string, from: string, to: string, createdAt: string): void {
  e.db
    .prepare(
      `INSERT INTO state_transition_logs
         (id, task_id, from_state, to_state, trigger_type, actor, created_at)
       VALUES (?, ?, ?, ?, 'engine', 'daemon-dispatch', ?)`,
    )
    .run(ulid(), taskId, from, to, createdAt);
}

test("nova status prints one screen: daemon state, in-flight, spend with prices_armed, last three transitions", async () => {
  const e = await boot();
  try {
    const wc2 = addTask(e, "WC2");
    const wc3 = addTask(e, "WC3");
    // four transitions: only the LAST THREE may be shown
    addTransition(e, wc2, "draft", "queued", "2026-11-23T09:00:00.000Z");
    addTransition(e, wc2, "queued", "running", "2026-11-23T12:06:54.000Z");
    addTransition(e, wc2, "running", "validating", "2026-11-23T12:07:02.000Z");
    addTransition(e, wc3, "validating", "completed", "2026-11-23T12:07:10.000Z");

    const res = runNova(["status"], e.env);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^daemon: running/m);
    assert.match(res.stdout, /^scheduler: inflight 0 queued 0 paused false$/m);
    // the spend block is the spec's verbatim shape; `prices_armed` depends on
    // the operator's own prices.json (the daemon's default path), so the screen
    // test pins that the flag and the inert-model list are SHOWN
    assert.match(
      res.stdout,
      /^spend: today \$0\.0000 \(0 runs\), month \$0\.0000 \(0 runs\), prices_armed (true|false), inert_models (-|\S+)$/m,
    );
    assert.match(res.stdout, /^transitions \(last 3\):$/m);
    assert.match(res.stdout, /^ {2}12:06:54 UTC WC2 queued→running$/m, res.stdout);
    assert.match(res.stdout, /^ {2}12:07:02 UTC WC2 running→validating$/m);
    assert.match(res.stdout, /^ {2}12:07:10 UTC WC3 validating→completed$/m);
    assert.doesNotMatch(res.stdout, /09:00:00 UTC/, "older history is not on the minimal screen");
    // exactly three transition lines
    assert.equal(res.stdout.split("\n").filter((l) => /^\s{2}\d{2}:\d{2}:\d{2} UTC /.test(l)).length, 3);

    const json = runNova(["status", "--json"], e.env);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.trim()) as {
      daemon: {
        scheduler: { running: number; paused: boolean };
        spend: { prices_armed: boolean; inert_models: string[] };
      };
      transitions: Array<{ task_key: string; from_state: string; to_state: string }>;
    };
    assert.equal(parsed.daemon.scheduler.running, 0);
    assert.equal(typeof parsed.daemon.spend.prices_armed, "boolean");
    assert.ok(Array.isArray(parsed.daemon.spend.inert_models));
    assert.deepEqual(
      parsed.transitions.map((t) => `${t.task_key} ${t.from_state}→${t.to_state}`),
      ["WC2 queued→running", "WC2 running→validating", "WC3 validating→completed"],
    );
  } finally {
    await shutdown(e);
  }
});

test("nova status --watch reprints on a new transition and never busy-loops while nothing moves", async () => {
  const e = await boot();
  const childEnv = { ...process.env, ...e.env, NOVAFLOW_STATUS_WATCH_MS: "150" };
  const child = spawn(NOVA, ["status", "--watch"], { env: childEnv });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (out += chunk));
  try {
    const deadline0 = Date.now() + 20_000;
    while (!out.includes("transitions (last 3):") && Date.now() < deadline0) await sleep(50);
    assert.match(out, /^daemon: running/m, `first screen:\n${out}`);

    // quiet window: the screen is unchanged, so nothing is reprinted
    const quietStart = out.split("scheduler:").length - 1;
    await sleep(700);
    const quietEnd = out.split("scheduler:").length - 1;
    assert.equal(quietEnd, quietStart, `no churn without a change:\n${out}`);

    // a new transition moves the cursor → one reprint carrying it
    const wc2 = addTask(e, "WC7");
    addTransition(e, wc2, "queued", "running", "2026-11-23T13:14:15.000Z");
    const deadline = Date.now() + 20_000;
    while (!out.includes("13:14:15 UTC WC7 queued→running") && Date.now() < deadline) await sleep(50);
    assert.match(out, /13:14:15 UTC WC7 queued→running/, `watch reprint:\n${out}`);
    assert.ok((out.split("scheduler:").length - 1) > quietEnd, "the screen was reprinted for the change");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(5000),
    ]);
    await shutdown(e);
  }
});

test("nova status exits 5 (daemon unreachable) rather than inventing a screen from nothing", async () => {
  const e = await boot();
  try {
    assert.equal(runNova(["daemon", "stop"], e.env).code, 0);
    const res = runNova(["status"], e.env);
    assert.equal(res.code, 5, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /daemon/);
  } finally {
    await shutdown(e);
  }
});
