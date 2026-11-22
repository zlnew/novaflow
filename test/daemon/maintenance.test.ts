import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { ulid } from "../../src/store/ids.ts";
import { TestClient } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";

/**
 * p7 storage-maintenance ops over the LIVE daemon socket:
 *
 *   nova_daemon_backup  — data.md 1.1 "Database Backup Strategy" (MUST:
 *                         the SQLite online backup API, never a file copy
 *                         of a live WAL store). The daemon owns the store,
 *                         so the backup runs IN the daemon; the CLI is a
 *                         thin client and never opens it.
 *   nova_daemon_prune   — data.md 1.2 "Log Pruning & Rotation" (MAY:
 *                         `events.raw.jsonl` purged on a retention period,
 *                         independent of SQLite run records).
 *
 * Both are daemon-level ops: the CLI verbs are `nova daemon backup` and
 * `nova daemon prune` (srs 4.1.1 amendment).
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  seeded: SeededStore;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-maint-"));
  const seeded = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok", join(dir, "run.pid")],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return { dir, dbPath: seeded.dbPath, wsRoot: seeded.wsRoot, seeded, handle, client };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

function ok(res: Record<string, unknown>): Record<string, unknown> {
  assert.equal(res["ok"], true, JSON.stringify(res));
  return res["data"] as Record<string, unknown>;
}

function countWorkspaces(dbPath: string): number {
  const db = readConnection(dbPath);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n;
  db.close();
  return n;
}

/* ------------------------------ nova_daemon_backup ------------------------------ */

test("nova_daemon_backup: the daemon writes a consistent copy of ITS store (default path alongside the store)", async () => {
  const env = await boot();
  try {
    const before = countWorkspaces(env.dbPath);
    const data = ok(await env.client.request({ id: "b1", op: "nova_daemon_backup", args: {} }));
    const dest = String(data["destination"]);
    assert.ok(existsSync(dest), `backup file exists: ${dest}`);
    // the documented default: alongside the store, state.db.bak-<stamp>
    assert.match(
      dest,
      /^.*store-ws\.db\.bak-\d{8}T\d{6}Z$/,
      "default destination is <store>.bak-<YYYYMMDDTHHMMSSZ> in the store's own directory",
    );
    // it is a real database with the source's rows
    const copy = new Database(dest, { readonly: true });
    try {
      assert.equal(
        (copy.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]!.integrity_check,
        "ok",
      );
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n, before);
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM agent_profiles").get() as { n: number }).n, 1);
    } finally {
      copy.close();
    }
    // the copy is FORCED to 0600 (judge B finding 3: a state store backup
    // is operator-private; the 0644-by-umask default was the false posture
    // the source doc claimed against)
    assert.equal(statSync(dest).mode & 0o777, 0o600);
    // the live store is untouched and still serving
    assert.equal(countWorkspaces(env.dbPath), before);
    ok(await env.client.request({ id: "s1", op: "nova_daemon_status", args: {} }));
    // the destination is a WAL database like its source (SQLite creates the
    // -wal/-shm siblings for the copy too — a plain file copy would not)
    const siblings = readdirSync(env.dir).filter((f) => f.startsWith("store-ws.db.bak-"));
    assert.ok(
      siblings.some((f) => /^store-ws\.db\.bak-\d{8}T\d{6}Z$/.test(f)),
      `the backup database file exists among ${siblings.join(",")}`,
    );
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_backup --out: an explicit destination is honored; a second backup exists alongside the first", async () => {
  const env = await boot();
  try {
    const out = join(env.dir, "explicit-backup.db");
    const data = ok(
      await env.client.request({ id: "b1", op: "nova_daemon_backup", args: { out } }),
    );
    assert.equal(data["destination"], out);
    assert.ok(existsSync(out));
    // a second backup to the SAME path is refused (never clobbers)
    const dup = await env.client.request({ id: "b2", op: "nova_daemon_backup", args: { out } });
    assert.equal(dup["ok"], false);
    assert.equal((dup["error"] as { code: string }).code, "duplicate");
    assert.match(String((dup["error"] as { message: string }).message), /already exists/);
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_backup refusals: a missing destination directory is schema_invalid naming the path", async () => {
  const env = await boot();
  try {
    const missing = join(env.dir, "nope", "state.db.bak");
    const res = await env.client.request({ id: "b", op: "nova_daemon_backup", args: { out: missing } });
    assert.equal(res["ok"], false);
    assert.equal((res["error"] as { code: string }).code, "schema_invalid");
    assert.match(String((res["error"] as { message: string }).message), /directory does not exist/);
    // a non-string `out` is schema_invalid too
    const bad = await env.client.request({ id: "b2", op: "nova_daemon_backup", args: { out: 42 } });
    assert.equal(bad["ok"], false);
    assert.equal((bad["error"] as { code: string }).code, "schema_invalid");
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_backup while a run is LIVE: the copy is consistent and the run is unaffected", async () => {
  const env = await boot();
  try {
    const created = ok(
      await env.client.request({
        id: "c",
        op: "nova_task_create",
        args: {
          project_id: env.seeded.projectId,
          key: "BAK-LIVE",
          title: "live",
          objective: "Take a backup while I run.",
          profile_name: "dev",
        },
      }),
    );
    const taskId = (created["task"] as { id: string }).id;
    ok(await env.client.request({ id: "r", op: "nova_task_run", args: { task_id: taskId } }));

    const data = ok(await env.client.request({ id: "b", op: "nova_daemon_backup", args: {} }));
    const copy = new Database(String(data["destination"]), { readonly: true });
    try {
      assert.equal(
        (copy.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]!.integrity_check,
        "ok",
      );
      // the run row the daemon had written by then is present (the run may
      // still be in flight: the contract is consistency, not quiescence)
      assert.ok((copy.prepare("SELECT COUNT(*) AS n FROM task_runs").get() as { n: number }).n >= 1);
    } finally {
      copy.close();
    }
    // the daemon keeps working after the backup (no wedged store)
    ok(await env.client.request({ id: "s", op: "nova_daemon_status", args: {} }));
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ nova_daemon_prune ------------------------------ */

/**
 * A run row whose pi_session_dir points at the canonical run dir — the
 * prune derives its allowlist from exactly these rows (never from a glob).
 */
function insertRun(env: Env, taskId: string, runId: string): void {
  const db = new Database(env.dbPath);
  try {
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
       VALUES (?, ?, ?, ?, 'o', ?)`,
    ).run(taskId, env.seeded.projectId, `K-${runId.slice(-6)}`, `K-${runId.slice(-6)}`, env.seeded.profileId);
    const runDir = join(env.wsRoot, ".novaflow", "runs", taskId, runId);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, 1, 'succeeded', ?, ?, 'm', ?, ?)`,
    ).run(runId, taskId, runId, runDir, join(runDir, "events.jsonl"), new Date().toISOString());
  } finally {
    db.close();
  }
}

type RunFixture = {
  runDir: string;
  raw: string;
  redacted: string;
  result: string;
  context: string;
};

/** A run dir shaped exactly like a real one (data.md 5.2 layout). */
function makeRun(env: Env, taskId: string, runId: string, ageMs: number): RunFixture {
  const runDir = join(env.wsRoot, ".novaflow", "runs", taskId, runId);
  const raw = join(runDir, "events.raw.jsonl");
  const redacted = join(runDir, "events.jsonl");
  const result = join(runDir, "result.json");
  const context = join(runDir, "engine-context.json");
  mkdirSync(runDir, { recursive: true });
  for (const f of [raw, redacted, result, context]) {
    writeFileSync(f, `{"frame":"${runId}"}\n`);
    const when = new Date(Date.now() - ageMs);
    utimesSync(f, when, when);
  }
  return { runDir, raw, redacted, result, context };
}

test("nova_daemon_prune (default 30 days): purges ONLY stale run-dir events.raw.jsonl; everything else survives", async () => {
  const env = await boot();
  try {
    const day = 24 * 60 * 60 * 1000;
    // real ULIDs: the prune's allowlist is built from the store's run rows
    const oldIds = { task: ulid(), run: ulid() };
    const freshIds = { task: ulid(), run: ulid() };
    insertRun(env, oldIds.task, oldIds.run);
    insertRun(env, freshIds.task, freshIds.run);
    const old = makeRun(env, oldIds.task, oldIds.run, 40 * day);
    const fresh = makeRun(env, freshIds.task, freshIds.run, 1 * day);
    // a NON-run file named events.raw.jsonl: never in a run dir → never pruned
    const strayDir = join(env.wsRoot, "docs");
    const stray = join(strayDir, "events.raw.jsonl");
    writeFileSync(stray, "not a run log\n");
    const strayWhen = new Date(Date.now() - 90 * day);
    utimesSync(stray, strayWhen, strayWhen);

    const data = ok(await env.client.request({ id: "p", op: "nova_daemon_prune", args: {} }));
    assert.equal(data["retention_days"], 30);
    const purged = data["purged"] as Array<Record<string, unknown>>;
    assert.deepEqual(purged.map((p) => p["path"]), [old.raw], "exactly the stale run-dir raw stream");
    assert.ok(typeof purged[0]!["age_days"] === "number" && Number(purged[0]!["age_days"]) > 39);

    assert.equal(existsSync(old.raw), false, "the stale raw stream is gone");
    assert.equal(existsSync(old.redacted), true, "events.jsonl (the read surface) survives");
    assert.equal(existsSync(old.result), true, "result.json survives");
    assert.equal(existsSync(old.context), true, "engine-context.json survives");
    assert.equal(existsSync(fresh.raw), true, "within retention: kept");
    assert.equal(existsSync(stray), true, "not a run-dir path: kept");

    // nothing was "skipped" here except by retention/allowlist — the report is explicit
    const skipped = data["skipped"] as Array<Record<string, unknown>>;
    assert.ok(skipped.some((s) => s["path"] === fresh.raw && s["reason"] === "within retention"));
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_prune containment: a run row OUTSIDE the runs tree is refused, nothing deleted (judge A finding 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prune-out-"));
  const env = await boot(dir);
  try {
    const outside = join(dir, "outside-home");
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, "events.raw.jsonl");
    writeFileSync(victim, "{}\n");
    const taskId = ulid();
    const runId = ulid();
    // a corrupted row: pi_session_dir outside the workspace runs tree
    const db = new Database(env.dbPath);
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
       VALUES (?, ?, ?, ?, 'o', ?)`,
    ).run(taskId, env.seeded.projectId, "K-OUT", "K-OUT", env.seeded.profileId);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, 1, 'succeeded', ?, ?, 'm', ?, ?)`,
    ).run(runId, taskId, runId, outside, join(outside, "events.jsonl"), new Date().toISOString());
    db.close();
    const data = ok(await env.client.request({ id: "p", op: "nova_daemon_prune", args: { retention_days: 0 } }));
    const skipped = (data["skipped"] ?? []) as Array<Record<string, unknown>>;
    assert.equal((data["purged"] as unknown[]).length, 0, "nothing purged");
    assert.ok(
      skipped.some((s) => String(s["reason"]).includes("outside the workspace")),
      "the outside row is reported as refused",
    );
    assert.equal(existsSync(victim), true, "the outside file survives");
  } finally {
    await shutdown(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nova_daemon_prune containment: a SYMLINKED run dir cannot steer the delete outside the tree (judge B finding 1, CRITICAL)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prune-sym-"));
  const env = await boot(dir);
  try {
    // the victim home outside the runs tree, with a stale-looking raw file
    const victimHome = join(dir, "victim-home");
    mkdirSync(victimHome, { recursive: true });
    const victim = join(victimHome, "events.raw.jsonl");
    writeFileSync(victim, "{}\n");
    const when = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    utimesSync(victim, when, when);

    const taskId = ulid();
    const runId = ulid();
    // the recorded dir is LEXICALLY inside the runs tree but is a symlink
    // to the victim home — the old resolve()-only containment admitted it
    const linkDir = join(env.wsRoot, ".novaflow", "runs", taskId, runId);
    mkdirSync(join(env.wsRoot, ".novaflow", "runs", taskId), { recursive: true });
    symlinkSync(victimHome, linkDir);
    const db = new Database(env.dbPath);
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id)
       VALUES (?, ?, ?, ?, 'o', ?)`,
    ).run(taskId, env.seeded.projectId, "K-SYM", "K-SYM", env.seeded.profileId);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, 1, 'succeeded', ?, ?, 'm', ?, ?)`,
    ).run(runId, taskId, runId, linkDir, join(linkDir, "events.jsonl"), new Date().toISOString());
    db.close();

    const data = ok(await env.client.request({ id: "p", op: "nova_daemon_prune", args: { retention_days: 0 } }));
    const skipped = (data["skipped"] ?? []) as Array<Record<string, unknown>>;
    assert.equal((data["purged"] as unknown[]).length, 0, "nothing purged through the symlink");
    assert.ok(
      skipped.some((s) => String(s["reason"]).includes("symlink pointing outside")),
      "the symlinked run dir is reported as refused",
    );
    assert.equal(existsSync(victim), true, "the victim file outside the tree SURVIVES");
    // pre-fix, this exact probe deleted the victim (judge B live-proven)
  } finally {
    await shutdown(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nova_daemon_prune --retention-days: the window is honored (0 days purges everything run-scoped and old)", async () => {
  const env = await boot();
  try {
    const day = 24 * 60 * 60 * 1000;
    const ids = { task: ulid(), run: ulid() };
    insertRun(env, ids.task, ids.run);
    const fresh = makeRun(env, ids.task, ids.run, 2 * day);
    const data = ok(
      await env.client.request({ id: "p", op: "nova_daemon_prune", args: { retention_days: 1 } }),
    );
    assert.equal(data["retention_days"], 1);
    assert.deepEqual((data["purged"] as Array<Record<string, unknown>>).map((p) => p["path"]), [fresh.raw]);
    assert.equal(existsSync(fresh.raw), false);
    assert.equal(existsSync(fresh.redacted), true);
    // no-op when everything is young
    const again = ok(await env.client.request({ id: "p2", op: "nova_daemon_prune", args: { retention_days: 1 } }));
    assert.deepEqual(again["purged"], []);
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_prune never touches SQLite rows (run records survive their purged raw streams)", async () => {
  const env = await boot();
  try {
    const day = 24 * 60 * 60 * 1000;
    const ids = { task: ulid(), run: ulid() };
    insertRun(env, ids.task, ids.run);
    const fx = makeRun(env, ids.task, ids.run, 60 * day);
    const runId = ids.run;
    const db0 = new Database(env.dbPath, { readonly: true });
    const before = (db0.prepare("SELECT COUNT(*) AS n FROM task_runs").get() as { n: number }).n;
    db0.close();

    ok(await env.client.request({ id: "p", op: "nova_daemon_prune", args: {} }));
    assert.equal(existsSync(fx.raw), false, "the raw stream is purged");

    const after = new Database(env.dbPath, { readonly: true });
    try {
      assert.equal((after.prepare("SELECT COUNT(*) AS n FROM task_runs").get() as { n: number }).n, before);
      const row = after.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as Record<string, unknown>;
      assert.equal(row["status"], "succeeded", "no row was rewritten");
      assert.equal(row["events_log_path"], fx.redacted, "the read surface pointer is untouched");
    } finally {
      after.close();
    }
  } finally {
    await shutdown(env);
  }
});

test("nova_daemon_prune refusals: a bad retention_days is schema_invalid (never a silent default)", async () => {
  const env = await boot();
  try {
    for (const bad of [-1, 1.5, "30", true]) {
      const res = await env.client.request({ id: "p", op: "nova_daemon_prune", args: { retention_days: bad } });
      assert.equal(res["ok"], false, `retention_days=${JSON.stringify(bad)} must refuse`);
      assert.equal((res["error"] as { code: string }).code, "schema_invalid");
    }
  } finally {
    await shutdown(env);
  }
});
