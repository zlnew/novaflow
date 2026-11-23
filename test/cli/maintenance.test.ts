import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFileStore } from "../daemon/seed.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * The p7 CLI verbs (srs 4.1.1 amendment): `nova daemon backup [--out
 * <path>]` and `nova daemon prune [--retention-days N]`, driven through
 * the REAL binary like every other CLI test in this suite.
 *
 * They are DAEMON-level ops by the storage ruling: the daemon owns the
 * store, the CLI is a thin client of the socket and never opens it (pinned
 * by test/cli/discipline.test.ts). The exit codes below are the srs 4.1.1
 * rows (0 success, 2 usage, 3 engine-state rejection).
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
  dbPath: string;
  wsRoot: string;
  projectId: string;
  profileId: string;
  env: Record<string, string>;
  sock: string;
};

/** A temp operator home + a detached daemon started through the CLI itself. */
async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-maint-"));
  const seeded = seedFileStore(dir);
  const home = join(dir, "novahome");
  mkdirSync(home);
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, "concurrency:\n  global: 2\nretry:\n  delay_sec: 3600\n");
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: seeded.dbPath,
    NOVAFLOW_DAEMON_CONFIG: cfg,
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
  };
  const start = runNova(["daemon", "start"], env);
  assert.equal(start.code, 0, `daemon start failed: ${start.stderr}`);
  return {
    dir,
    home,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    env,
    sock: env["NOVAFLOW_SOCK"]!,
  };
}

/** Stop the daemon and remove the temp tree (never leak a spawned child). */
async function shutdown(e: Env): Promise<void> {
  const stop = runNova(["daemon", "stop"], e.env);
  if (stop.code !== 0) {
    // backstop: the pidfile's process group
    try {
      const { readFileSync } = await import("node:fs");
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

test("nova daemon backup: prints the destination; the file is a valid, consistent copy of the store", async () => {
  const e = await boot();
  try {
    const res = runNova(["daemon", "backup"], e.env);
    assert.equal(res.code, 0, res.stderr);
    const dest = res.stdout.split("\n")[0]!.trim();
    assert.match(dest, /\.db\.bak-\d{8}T\d{6}Z$/, `destination line: ${res.stdout}`);
    assert.ok(existsSync(dest), `backup exists at ${dest}`);
    const copy = new Database(dest, { readonly: true });
    try {
      assert.equal(
        (copy.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]!.integrity_check,
        "ok",
      );
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n, 1);
    } finally {
      copy.close();
    }

    // --out + --json: the machine envelope names the path
    const out = join(e.dir, "operator-copy.db");
    const json = runNova(["daemon", "backup", "--out", out, "--json"], e.env);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.trim()) as Record<string, unknown>;
    assert.equal(parsed["destination"], out);
    assert.ok(existsSync(out));
  } finally {
    await shutdown(e);
  }
});

test("nova daemon backup: an existing destination refuses as `duplicate` (exit 1, an operation failure) and keeps the file", async () => {
  const e = await boot();
  try {
    const out = join(e.dir, "taken.db");
    writeFileSync(out, "operator data\n");
    const res = runNova(["daemon", "backup", "--out", out], e.env);
    // the srs exit map puts `duplicate` on the operation-failure row (1);
    // exit 3 is reserved for engine-state rejections (invalid_transition,
    // schema_invalid) — the backup refusal is neither
    assert.equal(res.code, 1, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /duplicate/);
    assert.match(res.stderr, /already exists/);
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(out, "utf8"), "operator data\n");
  } finally {
    await shutdown(e);
  }
});

test("nova daemon backup: daemon-down is `daemon_unreachable` (exit 5) — the CLI never opens the store itself", async () => {
  const e = await boot();
  await shutdown(e);
  try {
    const res = runNova(["daemon", "backup"], e.env);
    assert.equal(res.code, 5, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /daemon/);
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("nova daemon prune: prints the purge report; --retention-days is honored; events.jsonl survives", async () => {
  const e = await boot();
  try {
    const day = 24 * 60 * 60 * 1000;
    const taskId = ulid();
    const runId = ulid();
    const runDir = join(e.wsRoot, ".novaflow", "runs", taskId, runId);
    const db = openDb(e.dbPath);
    migrate(db);
    db.prepare(
      "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?,?,?,?,'o',?)",
    ).run(taskId, e.projectId, "PRUNE-1", "PRUNE-1", e.profileId);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, 1, 'succeeded', ?, ?, 'm', ?, ?)`,
    ).run(runId, taskId, runId, runDir, join(runDir, "events.jsonl"), new Date().toISOString());
    db.close();
    mkdirSync(runDir, { recursive: true });
    const raw = join(runDir, "events.raw.jsonl");
    const redacted = join(runDir, "events.jsonl");
    writeFileSync(raw, '{"frame":1}\n');
    writeFileSync(redacted, '{"frame":1}\n');
    const old = new Date(Date.now() - 45 * day);
    utimesSync(raw, old, old);
    utimesSync(redacted, old, old);

    const res = runNova(["daemon", "prune"], e.env);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /retention:\s*30 days/i);
    assert.ok(res.stdout.includes(raw), `the report names the purged path:\n${res.stdout}`);
    assert.equal(existsSync(raw), false, "the stale raw stream is gone");
    assert.equal(existsSync(redacted), true, "events.jsonl (the read surface) is NEVER pruned");

    // a fresh raw stream inside the window is kept and reported as skipped
    writeFileSync(raw, '{"frame":2}\n');
    const json = runNova(["daemon", "prune", "--json"], e.env);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.trim()) as {
      retention_days: number;
      purged: unknown[];
      skipped: Array<{ path: string; reason: string }>;
    };
    assert.equal(parsed.retention_days, 30);
    assert.deepEqual(parsed.purged, []);
    assert.ok(parsed.skipped.some((s) => s.path === raw && s.reason === "within retention"));
    assert.ok(existsSync(raw));
  } finally {
    await shutdown(e);
  }
});

test("nova daemon prune: a bad --retention-days is a usage error (exit 2), never a silent default", async () => {
  const e = await boot();
  try {
    for (const bad of ["-1", "abc", "1.5"]) {
      const res = runNova(["daemon", "prune", "--retention-days", bad], e.env);
      assert.equal(res.code, 2, `--retention-days ${bad}: ${res.stderr}`);
      assert.match(res.stderr, /retention-days/);
    }
  } finally {
    await shutdown(e);
  }
});

test("nova help names the new verbs: daemon backup/prune and docs list (the 4.1.1 amendment)", () => {
  // P12 (R4.1): an EXPLICIT `nova help` is a request, not a mistake — the
  // overview on stdout, exit 0. The mistake (bare `nova`) keeps the v1 usage
  // semantics, which is the assertion below it.
  const res = runNova(["help"], {});
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /nova daemon start.*backup.*prune/s);
  assert.match(res.stdout, /nova docs list/);

  const bare = runNova([], {});
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /nova daemon start.*backup.*prune/s);
  assert.match(bare.stderr, /nova docs list/);
});
