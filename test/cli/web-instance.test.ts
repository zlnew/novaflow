import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
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
import { seedFileStore } from "../daemon/seed.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";

/**
 * `nova web start|stop|status` — the dedicated Pi Web instance on the
 * private agent dir (novaflow-v030/panel.md, tier D). Everything here runs
 * through the REAL binary; the instance is bound to a free ephemeral port
 * via the documented NOVAFLOW_PIWEB_PORT test knob (the shipped default is
 * 30142), so a developer's own Pi Web on 30142 can never make this suite
 * flaky.
 *
 * The last test is the guarded integration test: it needs `pi-web` on PATH
 * and SKIPS with one printed line when the binary is absent.
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

function piwebOnPath(): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue;
    const path = join(dir, "pi-web");
    if (existsSync(path)) return path;
  }
  return null;
}

/** Bind port 0, read the assigned port, release it (the OS then reuses it). */
async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", timeout: 4000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

type Home = { dir: string; home: string; env: Record<string, string>; seeded: ReturnType<typeof seedFileStore> };

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-piweb-"));
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
  return { dir, home, env, seeded };
}

function piwebRoot(h: Home): string {
  return join(h.home, "piweb");
}

function pidPath(h: Home): string {
  return join(piwebRoot(h), "piweb.pid");
}

test("nova web start refuses a busy port naming what holds it — no pid file, no second server", async () => {
  const h = makeHome();
  const server = createServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const res = runNova(["web", "start"], {
      ...h.env,
      NOVAFLOW_PIWEB_PORT: String(port),
      // a present binary keeps the busy-port check the only refusal in play
      NOVAFLOW_PIWEB_BIN: "/bin/sh",
    });
    assert.equal(res.code, 1, `stderr: ${res.stderr}`);
    assert.match(res.stderr, new RegExp(`port ${port} is already in use`), res.stderr);
    assert.match(res.stderr, /refusing to start pi-web on a busy port/);
    assert.match(res.stderr, /held by /, "the message names the holder");
    assert.match(res.stderr, / — fix: /, "the busy-port refusal names the next move");
    // the holder is this test process: the pid is discoverable via ss/fuser
    assert.match(res.stderr, new RegExp(String(process.pid)), res.stderr);
    assert.equal(existsSync(pidPath(h)), false, "nothing was launched, so no pid file");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("nova web start refuses when pi-web is absent, naming the install command", async () => {
  const h = makeHome();
  try {
    const port = await freePort();
    const res = runNova(["web", "start"], {
      ...h.env,
      NOVAFLOW_PIWEB_PORT: String(port),
      NOVAFLOW_PIWEB_BIN: join(h.dir, "not-a-pi-web"),
    });
    assert.equal(res.code, 1, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /pi-web is not on PATH/);
    assert.match(res.stderr, /npm install -g @agegr\/pi-web/);
    assert.equal(existsSync(pidPath(h)), false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("nova web stop is idempotent when not running: no pid file, and a stale one is removed", async () => {
  const h = makeHome();
  try {
    const first = runNova(["web", "stop"], h.env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /not running/);
    assert.match(first.stdout, /no pid file/);

    mkdirSync(piwebRoot(h), { recursive: true });
    writeFileSync(pidPath(h), "999999\n");
    const second = runNova(["web", "stop"], h.env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /not running/);
    assert.match(second.stdout, /stale pid file/);
    assert.equal(existsSync(pidPath(h)), false, "the stale pid file is cleaned up");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("nova web status reports pid liveness, the port, the mirrored-run count and the URL (--json too)", async () => {
  const h = makeHome();
  try {
    const port = await freePort();
    // a live pid (this test process) and two mirrored session files
    mkdirSync(join(piwebRoot(h), "sessions", "--home-x-y--"), { recursive: true });
    writeFileSync(join(piwebRoot(h), "sessions", "--home-x-y--", "one.jsonl"), "{}\n");
    writeFileSync(join(piwebRoot(h), "sessions", "--home-x-y--", "two.jsonl"), "{}\n");
    writeFileSync(join(piwebRoot(h), "sessions", "notes.txt"), "not a session\n");
    writeFileSync(pidPath(h), `${process.pid}\n`);

    const res = runNova(["web", "status"], { ...h.env, NOVAFLOW_PIWEB_PORT: String(port) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /running: true/);
    assert.match(res.stdout, new RegExp(`pid: ${process.pid}`));
    assert.match(res.stdout, new RegExp(`port: ${port}`));
    assert.match(res.stdout, new RegExp(`url: http://127.0.0.1:${port}`));
    assert.match(res.stdout, /mirrored_runs: 2/, "only *.jsonl under sessions/ counts");
    assert.match(res.stdout, /answering: false/, "the pid is alive but nothing answers on the port");

    const json = runNova(["web", "status", "--json"], { ...h.env, NOVAFLOW_PIWEB_PORT: String(port) });
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.trim()) as Record<string, unknown>;
    assert.equal(parsed["running"], true);
    assert.equal(parsed["pid"], process.pid);
    assert.equal(parsed["port"], port);
    assert.equal(parsed["mirrored_runs"], 2);
    assert.equal(parsed["url"], `http://127.0.0.1:${port}`);

    // a dead pid is reported as not running (and never killed)
    writeFileSync(pidPath(h), "999999\n");
    const dead = runNova(["web", "status"], { ...h.env, NOVAFLOW_PIWEB_PORT: String(port) });
    assert.equal(dead.code, 0, dead.stderr);
    assert.match(dead.stdout, /running: false/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("nova web start/stop with a real pi-web: /api/sessions lists the mirrored run", async (t) => {
  const bin = piwebOnPath();
  if (bin === null) {
    t.skip("pi-web is not on PATH — install it with: npm install -g @agegr/pi-web");
    return;
  }
  const h = makeHome();
  const port = await freePort();
  const env = { ...h.env, NOVAFLOW_PIWEB_PORT: String(port) };
  const db = openDb(h.seeded.dbPath);
  try {
    migrate(db);
    // one settled run, planted exactly like the sync tests plant it
    const taskId = ulid();
    const runId = ulid();
    db.prepare(
      "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?,?,'WC2','WC2','objective',?)",
    ).run(taskId, h.seeded.projectId, h.seeded.profileId);
    const runDir = join(h.seeded.wsRoot, ".novaflow", "runs", taskId, runId);
    mkdirSync(runDir, { recursive: true });
    db.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, status, pi_session_id,
                              pi_session_dir, model_used, events_log_path, started_at)
       VALUES (?, ?, 1, 'succeeded', ?, ?, 'm', ?, ?)`,
    ).run(runId, taskId, runId, runDir, join(runDir, "events.jsonl"), new Date().toISOString());
    writeFileSync(join(runDir, "events.jsonl"), "{}\n");
    writeFileSync(
      join(runDir, `2026-11-23T10-00-00-000Z_${runId}.jsonl`),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: runId,
          timestamp: "2026-11-23T10:00:00.000Z",
          cwd: h.seeded.wsRoot,
        }),
        JSON.stringify({ type: "message", role: "user", content: "mirror me" }),
      ].join("\n") + "\n",
    );
    // start the daemon, sync the settled run, then start the private instance
    assert.equal(runNova(["daemon", "start"], env).code, 0);
    const sync = runNova(["web", "sync", "--all"], env);
    assert.equal(sync.code, 0, sync.stderr);

    const started = runNova(["web", "start"], env, 60_000);
    assert.equal(started.code, 0, `start stdout=${started.stdout} stderr=${started.stderr}`);
    assert.match(started.stdout, new RegExp(`http://127.0.0.1:${port}`));
    assert.ok(existsSync(pidPath(h)), "pid file written");

    // the spike's proof, end to end: GET /api/sessions lists the mirrored run
    const body = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/sessions", method: "GET", timeout: 4000 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", () => resolve(""));
      req.on("timeout", () => {
        req.destroy();
        resolve("");
      });
      req.end();
    });
    assert.ok(body !== "", "GET /api/sessions answered");
    const sessions = JSON.parse(body) as { sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const list = Array.isArray(sessions) ? sessions : (sessions.sessions ?? []);
    assert.equal(list.length, 1, `one mirrored session:\n${body.slice(0, 2000)}`);
    assert.equal(list[0]!["id"], runId);

    const stopped = runNova(["web", "stop"], env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /pi-web stopped/);
    assert.equal(existsSync(pidPath(h)), false);
    assert.equal(await get(port, "/api/sessions"), 0, "the port is closed after stop");
    // stopping again is a no-op, never an error
    assert.equal(runNova(["web", "stop"], env).code, 0);
    runNova(["daemon", "stop"], env);
  } finally {
    db.close();
    // backstop: never leak a child
    try {
      const pid = Number(readFileSync(pidPath(h), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      /* no pid file */
    }
    try {
      const pid = Number(readFileSync(join(h.home, "daemon.pid"), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      /* no pid file */
    }
    await sleep(200);
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("nova web start/stop/status appear in the help text (the 4.1.1 web verbs)", () => {
  const res = runNova(["help"], {});
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /nova web sync/);
  assert.match(res.stdout, /nova web start/);
  assert.match(res.stdout, /nova web stop/);
  assert.match(res.stdout, /nova web status/);
  assert.match(res.stdout, /nova status \[--watch\]/);
});
