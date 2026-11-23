import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFileStore, type SeededStore } from "../daemon/seed.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * `nova web sync [--run <id|key> | --all]` — the tier-D mirror
 * (novaflow-v030/panel.md): settled runs only, copies never links, and
 * `events.raw.jsonl` is never mirrored by any path. The command is a thin
 * client (socket ops or the filesystem); the store is opened HERE, on the
 * test side, only to plant run rows the daemon then serves.
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
  db: ReturnType<typeof openDb>;
};

/** A temp operator home + a detached daemon started through the CLI itself. */
async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-web-"));
  const seeded: SeededStore = seedFileStore(dir);
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
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    env,
    sock: env["NOVAFLOW_SOCK"]!,
    db,
  };
}

async function shutdown(e: Env): Promise<void> {
  e.db.close();
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

type Planted = { taskId: string; runId: string; runDir: string; sessionName: string };

/**
 * Plant a task + one run row + its run directory. The session file is the
 * pi-native `<ts>_<run id>.jsonl` name (the engine runs pi with
 * `--session-dir <run dir> --session-id <run id>`), with a real header line
 * carrying the session cwd — pi-web groups by that cwd's slug.
 */
function plantRun(
  e: Env,
  opts: {
    key: string;
    status: string;
    cwd?: string | null;
    sessionLines?: string[];
    withSession?: boolean;
    taskId?: string;
    attempt?: number;
  },
): Planted {
  const taskId = opts.taskId ?? ulid();
  if (opts.taskId === undefined) {
    e.db
      .prepare(
        "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?,?,?,?,'objective',?)",
      )
      .run(taskId, e.projectId, opts.key, opts.key, e.profileId);
  }
  const runId = ulid();
  const runDir = join(e.wsRoot, ".novaflow", "runs", taskId, runId);
  mkdirSync(runDir, { recursive: true });
  e.db
    .prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'm', ?, ?)`,
    )
    .run(
      runId,
      taskId,
      opts.attempt ?? 1,
      opts.status,
      runId,
      runDir,
      join(runDir, "events.jsonl"),
      new Date().toISOString(),
    );
  writeFileSync(join(runDir, "events.jsonl"), '{"type":"scrubbed"}\n');
  writeFileSync(join(runDir, "events.raw.jsonl"), '{"type":"verbatim"}\n');
  const sessionName = `2026-11-23T10-00-00-000Z_${runId}.jsonl`;
  if (opts.withSession !== false) {
    const lines =
      opts.sessionLines ??
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: runId,
          timestamp: "2026-11-23T10:00:00.000Z",
          cwd: opts.cwd === undefined ? "/home/x/y" : opts.cwd,
        }),
        JSON.stringify({ type: "message", role: "user", content: "objective" }),
      ];
    writeFileSync(join(runDir, sessionName), lines.join("\n") + "\n");
  }
  return { taskId, runId, runDir, sessionName };
}

function sessionsRoot(e: Env): string {
  return join(e.home, "piweb", "sessions");
}

/** Every file under a directory tree, relative to it (bounded walk). */
function walkTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) {
      for (const inner of walkTree(path)) out.push(join(name.name, inner));
    } else {
      out.push(name.name);
    }
  }
  return out;
}

test("nova web sync --all mirrors each settled run's session file; a second run changes nothing", async () => {
  const e = await boot();
  try {
    const settled = plantRun(e, { key: "WC2", status: "succeeded", cwd: "/home/x/y" });
    const dest = join(sessionsRoot(e), "--home-x-y--", settled.sessionName);

    const first = runNova(["web", "sync", "--all"], e.env);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(existsSync(dest), `the session file is mirrored under pi-web's cwd slug:\n${first.stdout}`);
    const source = readFileSync(join(settled.runDir, settled.sessionName));
    assert.deepEqual(readFileSync(dest), source, "a copy, byte for byte (never a link)");
    assert.match(first.stdout, /WC2/);
    assert.match(first.stdout, new RegExp(`${settled.runId}\\s+WC2\\s+copied ${source.length} bytes`));

    // idempotent: nothing rewritten, no mtime churn
    const before = statSync(dest).mtimeMs;
    await sleep(20);
    const second = runNova(["web", "sync", "--all"], e.env);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(statSync(dest).mtimeMs, before, "an unchanged source never touches the mirror");
    assert.match(second.stdout, new RegExp(`${settled.runId}\\s+WC2\\s+unchanged`));

    // a source that grew is re-copied exactly once
    appendFileSync(
      join(settled.runDir, settled.sessionName),
      JSON.stringify({ type: "message", role: "assistant", content: "done" }) + "\n",
    );
    const third = runNova(["web", "sync", "--all"], e.env);
    assert.equal(third.code, 0, third.stderr);
    const grown = statSync(join(settled.runDir, settled.sessionName)).size;
    assert.match(third.stdout, new RegExp(`${settled.runId}\\s+WC2\\s+copied ${grown} bytes`));
    assert.equal(readFileSync(dest).length, grown);
    const fourth = runNova(["web", "sync", "--all"], e.env);
    assert.equal(fourth.code, 0, fourth.stderr);
    assert.match(fourth.stdout, new RegExp(`${settled.runId}\\s+WC2\\s+unchanged`));
  } finally {
    await shutdown(e);
  }
});

test("nova web sync never mirrors events.raw.jsonl (or events.jsonl): the mirror holds session files only", async () => {
  const e = await boot();
  try {
    plantRun(e, { key: "WC2", status: "succeeded" });
    plantRun(e, { key: "WC3", status: "failed", cwd: "/home/x/y" });
    const res = runNova(["web", "sync", "--all"], e.env);
    assert.equal(res.code, 0, res.stderr);

    const files = walkTree(sessionsRoot(e));
    assert.equal(files.length, 2, `exactly the two session files:\n${files.join("\n")}`);
    for (const rel of files) {
      assert.doesNotMatch(rel, /events\.raw\.jsonl/, "the verbatim raw stream is never mirrored");
      assert.doesNotMatch(rel, /events\.jsonl/, "the redacted event log is not the mirror's unit");
      assert.match(rel, /^\-\-home-x-y\-\-\/.*\.jsonl$/);
    }
  } finally {
    await shutdown(e);
  }
});

test("nova web sync --run on a live run refuses with the tier-C pointer, exit non-zero, nothing copied", async () => {
  const e = await boot();
  try {
    const live = plantRun(e, { key: "WC2", status: "running" });
    const res = runNova(["web", "sync", "--run", live.runId], e.env);
    assert.equal(res.code, 1, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /not settled/);
    assert.match(res.stderr, /nova status --watch/, "the refusal points at the live screen");
    assert.match(res.stderr, new RegExp(live.runId));
    assert.equal(existsSync(sessionsRoot(e)), false, "nothing was copied");

    // a settled run of the same task mirrors once the run itself is settled
    e.db.prepare("UPDATE task_runs SET status = 'succeeded' WHERE id = ?").run(live.runId);
    const ok = runNova(["web", "sync", "--run", live.runId], e.env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(join(sessionsRoot(e), "--home-x-y--", live.sessionName)));
  } finally {
    await shutdown(e);
  }
});

test("nova web sync --run accepts a task key and refuses while any of its runs is live", async () => {
  const e = await boot();
  try {
    const task = plantRun(e, { key: "WC2", status: "succeeded" });
    const live = plantRun(e, { key: "WC2", status: "running", taskId: task.taskId, attempt: 2 });

    const refused = runNova(["web", "sync", "--run", "WC2"], e.env);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(live.runId));
    assert.equal(existsSync(sessionsRoot(e)), false, "an explicit request refuses atomically");

    e.db.prepare("UPDATE task_runs SET status = 'succeeded' WHERE id = ?").run(live.runId);
    const ok = runNova(["web", "sync", "--run", "WC2"], e.env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(walkTree(sessionsRoot(e)).length, 2, "both of the task's runs are mirrored");
  } finally {
    await shutdown(e);
  }
});

test("nova web sync --all reports a run directory with no session file and continues", async () => {
  const e = await boot();
  try {
    const noSession = plantRun(e, { key: "WC4", status: "succeeded", withSession: false });
    const settled = plantRun(e, { key: "WC5", status: "succeeded" });
    const res = runNova(["web", "sync", "--all"], e.env);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${noSession.runId}\\s+WC4\\s+skipped \\(no session file\\)`));
    assert.match(res.stdout, new RegExp(`${settled.runId}\\s+WC5\\s+copied`));
    assert.equal(walkTree(sessionsRoot(e)).length, 1);
  } finally {
    await shutdown(e);
  }
});

test("nova web sync: --run and --all are exclusive and one of them is required (usage, exit 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-web-usage-"));
  const env = { NOVAFLOW_HOME: join(dir, "home"), NOVAFLOW_SOCK: join(dir, "novaflow.sock") };
  mkdirSync(env.NOVAFLOW_HOME);
  try {
    for (const args of [["web", "sync"], ["web", "sync", "--run", "x", "--all"]]) {
      const res = runNova(args, env);
      assert.equal(res.code, 2, `args ${args.join(" ")}: ${res.stderr}`);
      assert.match(res.stderr, /--run|--all/);
    }
    const help = runNova(["help"], {});
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /nova web sync \[--run <id\|key> \| --all\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
