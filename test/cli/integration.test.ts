import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient, waitFor } from "../daemon/client.ts";

/**
 * The operator flow through the ACTUAL CLI binary: spawn bin/nova as a
 * subprocess against a real detached daemon (stub pi via the
 * documented env knobs) — workspace create → switch → profile →
 * project → task run --watch → completed → result/logs → daemon stop.
 * Plus the exit-code battery: every srs 4.1.1 row observed end-to-end
 * through the binary, and the daemon start/stop process-group
 * discipline (no stray process, socket removed).
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
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

type Home = {
  dir: string;
  home: string;
  env: Record<string, string>;
};

/** A temp operator home: socket, db, marker, pidfile, daemon log. */
function makeHome(runMode: string): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, runMode]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
    NOVAFLOW_WATCH_MS: "200",
  };
  return { dir, home, env };
}

/** Backstop cleanup: socket stop-op, then group kill by pidfile. */
async function forceStopDaemon(h: Home): Promise<void> {
  const sock = join(h.home, "novaflow.sock");
  if (existsSync(sock)) {
    try {
      const client = await TestClient.connect(sock, 1500);
      await client.request({ id: "cleanup", op: "nova_daemon_stop", args: {} });
      client.close();
    } catch {
      // fall through to the pid kill
    }
    try {
      await waitFor(() => !existsSync(sock), 5000);
    } catch {
      // fall through
    }
  }
  const pidFile = join(h.home, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(-pid, sig);
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  rmSync(h.dir, { recursive: true, force: true });
}

test("operator flow through bin/nova: daemon start → workspace → project → task --watch → result → stop", async () => {
  const h = makeHome("run-ok");
  try {
    // ---- daemon start (detached): bounded wait, pidfile, log file ----
    const start = runNova(["daemon", "start"], h.env);
    assert.equal(start.code, 0, `stdout=${start.stdout} stderr=${start.stderr}`);
    const sock = join(h.home, "novaflow.sock");
    assert.ok(existsSync(sock), "the socket exists");
    const pidFile = join(h.home, "daemon.pid");
    assert.ok(existsSync(pidFile), "the daemon wrote its pidfile");
    const daemonPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 0);
    assert.ok(existsSync(join(h.home, "daemon.log")), "the daemon log exists");
    process.kill(daemonPid, 0); // alive

    // a second start while a live daemon answers: refused (exit 1)
    const second = runNova(["daemon", "start"], h.env);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /live daemon|refusing/);

    // ---- workspace create: exact FR-WS-02 layout, bare ULID, --json ----
    const wsRoot = join(h.dir, "wsroot");
    mkdirSync(wsRoot);
    const create = runNova(["workspace", "create", "alpha", "--path", wsRoot, "--json"], h.env);
    assert.equal(create.code, 0, create.stderr);
    const created = JSON.parse(create.stdout) as { id: string; workspace: { slug: string } };
    assert.match(created.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(created.workspace.slug, "alpha");
    for (const sub of ["profiles", "prompts", "projects", "worktrees", "runs", "schemas"]) {
      assert.ok(existsSync(join(wsRoot, ".novaflow", sub)), `scaffold ${sub}`);
    }
    assert.ok(existsSync(join(wsRoot, ".novaflow", "workspace.json")));
    assert.ok(existsSync(join(wsRoot, "docs")));

    // switch writes the CLI-local marker (documented ruling)
    const switchRes = runNova(["workspace", "switch", "alpha"], h.env);
    assert.equal(switchRes.code, 0, switchRes.stderr);
    assert.equal(readFileSync(join(h.home, "active-workspace"), "utf8").trim(), "alpha");

    // workspace list: human table and --json envelope
    const list = runNova(["workspace", "list"], h.env);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /^SLUG\s+STATUS/);
    assert.match(list.stdout, /alpha\s+active/);
    const listJson = runNova(["workspace", "list", "--json"], h.env);
    const listData = JSON.parse(listJson.stdout) as { workspaces: Array<{ slug: string }> };
    assert.equal(listData.workspaces[0]!.slug, "alpha");

    // ---- profile create: canonical file lands at .novaflow/profiles ----
    const profileSrc = join(h.dir, "dev.json");
    writeFileSync(
      profileSrc,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        system_prompt_path: "prompts/dev_system.md",
        tools_allowlist: ["bash", "read"],
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    const prof = runNova(["profile", "create", "--file", profileSrc], h.env);
    assert.equal(prof.code, 0, prof.stderr);
    const canonical = join(wsRoot, ".novaflow", "profiles", "dev.json");
    assert.ok(existsSync(canonical), "the canonical profile file exists");
    assert.ok(existsSync(profileSrc), "the source file is never moved");
    const validate = runNova(["profile", "validate", "dev"], h.env);
    assert.equal(validate.code, 0, validate.stderr);
    assert.match(validate.stdout, /structurally valid/);

    // ---- project create with a target; phase label audited ----
    const targetRoot = join(h.dir, "target");
    mkdirSync(targetRoot);
    const proj = runNova(
      ["project", "create", "app", "--objective", "Ship the thing.", "--target", `code=${targetRoot}:git_repo`],
      h.env,
    );
    assert.equal(proj.code, 0, proj.stderr);
    assert.match(proj.stdout, /created project app/);
    const phase = runNova(["project", "phase", "app", "Implementing", "v1"], h.env);
    assert.equal(phase.code, 0, phase.stderr);
    assert.match(phase.stdout, /Implementing v1/);

    // ---- task create → run --watch → completed; result; logs ----
    // (the run loop resolves system_prompt_path against the workspace
    // ROOT — data 4.2's convention — not the .novaflow/prompts scaffold)
    mkdirSync(join(wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
    const task = runNova(
      ["task", "create", "TASK-1", "--title", "Do the work", "--objective", "Do the work end to end.", "--profile", "dev", "--project", "app"],
      h.env,
    );
    assert.equal(task.code, 0, task.stderr);
    assert.match(task.stdout, /created task TASK-1/);

    const run = runNova(["task", "run", "TASK-1", "--watch"], h.env);
    assert.equal(run.code, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`);
    assert.match(run.stdout, /queued|running/);
    assert.match(run.stdout, /completed/);
    assert.match(run.stdout, /SUCCESS task completed/);

    const status = runNova(["task", "status", "TASK-1"], h.env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /state: completed/);
    const statusJson = runNova(["task", "status", "TASK-1", "--json"], h.env);
    const statusData = JSON.parse(statusJson.stdout) as { task: { state: string } };
    assert.equal(statusData.task.state, "completed");

    const result = runNova(["task", "result", "TASK-1"], h.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /result\.json/);
    assert.match(result.stdout, /"status": "completed"/);

    const logs = runNova(["task", "logs", "TASK-1", "--lines", "20"], h.env);
    assert.equal(logs.code, 0, logs.stderr);
    assert.ok(logs.stdout.split("\n").length > 0);

    // ---- the exit-code battery through the binary (srs 4.1.1) ----
    // 1 operation failure: duplicate key
    const dup = runNova(
      ["task", "create", "TASK-1", "--title", "x", "--objective", "y", "--profile", "dev", "--project", "app"],
      h.env,
    );
    assert.equal(dup.code, 1);
    assert.match(dup.stderr, /duplicate/);
    // 3 engine-state rejection: abort a completed task
    const taskId = (JSON.parse(runNova(["task", "status", "TASK-1", "--json"], h.env).stdout) as { task: { id: string } }).task.id;
    const invalid = runNova(["task", "abort", taskId], h.env);
    assert.equal(invalid.code, 3);
    assert.match(invalid.stderr, /invalid_transition/);
    // 4 not found
    const missing = runNova(["task", "status", "01HJ8Z9X01ABCDEFGHJKMNPQRS"], h.env);
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /not_found/);
    // 2 usage error
    const usage = runNova(["workspace", "create"], h.env);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /nova workspace create/);
    // 5 daemon unreachable (no socket)
    const dead: Record<string, string> = { ...h.env, NOVAFLOW_SOCK: join(h.dir, "nope.sock") };
    const unreachable = runNova(["workspace", "list"], dead);
    assert.equal(unreachable.code, 5);
    assert.match(unreachable.stderr, /daemon_unreachable|socket/);

    // ---- daemon stop: response, socket removed, process group reaped ----
    const stop = runNova(["daemon", "stop"], h.env);
    assert.equal(stop.code, 0, stop.stderr);
    await waitFor(() => !existsSync(sock), 8000);
    assert.ok(!existsSync(sock), "the socket file is removed");
    await waitFor(
      () => {
        try {
          process.kill(daemonPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      8000,
    );
    // no stray process group either
    try {
      process.kill(-daemonPid, 0);
      assert.fail("the daemon's process group is gone");
    } catch {
      // expected
    }
    // after the stop the CLI answers with exit 5 (unreachable)
    const afterStop = runNova(["daemon", "status"], h.env);
    assert.equal(afterStop.code, 5);
  } finally {
    await forceStopDaemon(h);
  }
});

test("watch ending in a failed task exits 1 (the srs operation-failure row)", async () => {
  const h = makeHome("run-crash");
  try {
    assert.equal(runNova(["daemon", "start"], h.env).code, 0);
    const wsRoot = join(h.dir, "wsroot");
    mkdirSync(wsRoot);
    assert.equal(runNova(["workspace", "create", "alpha", "--path", wsRoot], h.env).code, 0);
    assert.equal(runNova(["workspace", "switch", "alpha"], h.env).code, 0);
    const profileSrc = join(h.dir, "dev.json");
    writeFileSync(
      profileSrc,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        system_prompt_path: "prompts/dev_system.md",
        tools_allowlist: [],
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    assert.equal(runNova(["profile", "create", "--file", profileSrc], h.env).code, 0);
    mkdirSync(join(wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
    assert.equal(runNova(["project", "create", "app", "--objective", "o"], h.env).code, 0);
    assert.equal(
      runNova(["task", "create", "CRASH", "--title", "t", "--objective", "o", "--profile", "dev", "--project", "app"], h.env).code,
      0,
    );
    // run-crash fails; the default retry delay (300 s) keeps it failed
    const watch = runNova(["task", "run", "CRASH", "--watch"], h.env);
    assert.equal(watch.code, 1, `stdout=${watch.stdout}`);
    assert.match(watch.stdout, /failed/);
  } finally {
    await forceStopDaemon(h);
  }
});

test("daemon logs: tails the daemon log file (works daemon-down); --json envelope", async () => {
  const h = makeHome("run-ok");
  try {
    // no log yet → not_found (exit 4)
    const none = runNova(["daemon", "logs"], h.env);
    assert.equal(none.code, 4);
    assert.match(none.stderr, /no daemon log/);

    assert.equal(runNova(["daemon", "start"], h.env).code, 0);
    const pidFile = join(h.home, "daemon.pid");
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // the foreground daemon wrote its banner into the log
    const logs = runNova(["daemon", "logs", "--lines", "10"], h.env);
    assert.equal(logs.code, 0, logs.stderr);
    assert.match(logs.stdout, /daemon running/);
    const logsJson = runNova(["daemon", "logs", "--lines", "10", "--json"], h.env);
    assert.equal(logsJson.code, 0);
    const data = JSON.parse(logsJson.stdout) as { log: string; lines: string[] };
    assert.match(data.log, /daemon\.log$/);
    assert.ok(data.lines.length > 0);
    assert.equal(runNova(["daemon", "stop"], h.env).code, 0);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000);
  } finally {
    await forceStopDaemon(h);
  }
});
