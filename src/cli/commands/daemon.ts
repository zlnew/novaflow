import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { daemonRequest, defaultDbPath, novaHome, socketPath } from "../client.ts";
import { renderKv } from "../format.ts";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_OPERATION_FAILED } from "../exitcode.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova daemon …` (srs 4.1.1): start/stop/status/pause/resume/kill-all/
 * logs. stop/status/pause/resume/kill-all are socket ops; logs tails
 * the daemon log file.
 *
 * start (detached, the default): spawns the daemon as its OWN process
 * group (`detached: true`, stdio to <home>/daemon.log), refuses when a
 * live daemon already answers (the p3a stale-socket probe semantics:
 * live answer → refuse; silent-but-accepting → treated live), then
 * waits bounded (15 s) for the socket to ANSWER. Every failure path
 * reaps the child group (SIGTERM → grace → SIGKILL) before exiting.
 *
 * start --foreground runs the daemon IN-PROCESS (tests/dev): the store
 * is opened by the daemon itself via a DYNAMIC lifecycle import — the
 * only sanctioned store touch in src/cli (pinned by the discipline
 * test). The foreground process ends when the daemon stops (socket op
 * or SIGINT/SIGTERM), removing its pidfile on the way out.
 *
 * Test-injection env knobs (documented; unset → the real `pi`):
 *   NOVAFLOW_PI_BIN, NOVAFLOW_PROBE_ARGS, NOVAFLOW_RUN_ARGS (JSON
 *   arrays), NOVAFLOW_PROBE_TIMEOUT_MS, NOVAFLOW_DAEMON_CONFIG,
 *   NOVAFLOW_DB, NOVAFLOW_SOCK, NOVAFLOW_HOME.
 */

const SPEC: ArgSpec = {
  booleanFlags: ["foreground"],
  valueFlags: ["lines", "workspace", "out", "retention-days"],
};

const START_BOUND_MS = 15_000;
const STOP_BOUND_MS = 15_000;

export async function daemonCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "start":
      return start(p, opts);
    case "stop":
      return stop(opts);
    case "status":
      return status(opts);
    case "pause":
      return simple("nova_daemon_pause", "scheduler paused", opts.json);
    case "resume":
      return simple("nova_daemon_resume", "scheduler resumed", opts.json);
    case "kill-all":
      return killAll(opts);
    case "backup":
      return backup(p, opts);
    case "prune":
      return prune(p, opts);
    case "logs":
      return logs(p, opts);
    default:
      throw new UsageError(`nova daemon [start|stop|status|pause|resume|kill-all|backup|prune|logs]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

/* ------------------------------- detached start ------------------------------- */

/** The p3a probe semantics: any answer = live; silent = live (conservative). */
function liveDaemonAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = connect(path, () => {
      sock.write(JSON.stringify({ id: "cli-probe", op: "nova_daemon_status", args: {} }) + "\n");
    });
    sock.setEncoding("utf8");
    sock.on("data", () => done(true));
    sock.on("error", () => done(false)); // refused: no live daemon
    const timer = setTimeout(() => done(true), 600); // silent-but-accepting = live
    timer.unref?.();
  });
}

function launcherPath(): string {
  return join(import.meta.dirname, "..", "..", "..", "bin", "nova");
}

async function start(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const home = novaHome();
  mkdirSync(home, { recursive: true });
  const sock = socketPath();

  if (p.flags.has("foreground")) {
    return runForeground(sock, home, opts.json);
  }

  if (existsSync(sock) && (await liveDaemonAnswers(sock))) {
    console.error(`nova: a live daemon already answers at ${sock} — refusing to start a second one`);
    return EXIT_OPERATION_FAILED;
  }
  // a stale socket file without a live daemon: the daemon's own bind
  // unlinks and rebinds it (p3a stale-socket handling)

  const logPath = join(home, "daemon.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [launcherPath(), "daemon", "start", "--foreground"],
    { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env } },
  );
  child.unref();
  closeSync(logFd);

  // bounded wait for the socket to ANSWER (not merely exist — a stale
  // file may still be present while the daemon probes it)
  const deadline = Date.now() + START_BOUND_MS;
  for (;;) {
    if (existsSync(sock) && (await liveDaemonAnswers(sock))) break;
    if (Date.now() > deadline) {
      await reapGroup(child.pid);
      console.error(`nova: the daemon did not answer at ${sock} within ${START_BOUND_MS / 1000} s — tail of ${logPath}:`);
      console.error(tailFile(logPath, 10));
      return EXIT_OPERATION_FAILED;
    }
    await sleep(150);
  }
  if (opts.json) {
    console.log(JSON.stringify({ started: true, pid: child.pid, socket: sock, log: logPath }));
  } else {
    console.log(`daemon started (pid ${child.pid})`);
    console.log(`  socket: ${sock}`);
    console.log(`  log: ${logPath}`);
  }
  return EXIT_OK;
}

/** SIGTERM → bounded grace → SIGKILL on the child's process group. */
async function reapGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, sig);
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // reaped
    }
    await sleep(100);
  }
  signal("SIGKILL");
  await sleep(200);
}

async function runForeground(sock: string, home: string, json: boolean): Promise<number> {
  const dbPath = defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  // DYNAMIC import — the daemon (and only the daemon) opens the store
  const { startDaemon } = await import("../../daemon/lifecycle.ts");
  const piBin = process.env["NOVAFLOW_PI_BIN"];
  const probeArgs = parseEnvJsonArray("NOVAFLOW_PROBE_ARGS");
  const runArgs = parseEnvJsonArray("NOVAFLOW_RUN_ARGS");
  const probeTimeoutMs = process.env["NOVAFLOW_PROBE_TIMEOUT_MS"];
  const handle = await startDaemon({
    dbPath,
    socketPath: sock,
    ...(process.env["NOVAFLOW_DAEMON_CONFIG"] !== undefined
      ? { daemonConfigPath: process.env["NOVAFLOW_DAEMON_CONFIG"] }
      : {}),
    ...(piBin !== undefined ? { probePiBin: piBin, runPiBin: piBin } : {}),
    ...(probeArgs !== undefined ? { probeArgs } : {}),
    ...(runArgs !== undefined ? { runArgs } : {}),
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs: Number(probeTimeoutMs) } : {}),
  });
  const pidFile = join(home, "daemon.pid");
  writeFileSync(pidFile, `${process.pid}\n`);
  if (!json) console.log(`daemon running (pid ${process.pid}, socket ${sock})`);

  let exiting = false;
  const shutdown = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      await handle.stop();
    } finally {
      try {
        rmSync(pidFile);
      } catch {
        // best effort
      }
      process.exit(EXIT_OK);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // run until the daemon stops itself (the socket op path)
  for (;;) {
    if (!existsSync(sock)) {
      try {
        rmSync(pidFile);
      } catch {
        // best effort
      }
      return EXIT_OK;
    }
    await sleep(250);
  }
}

function parseEnvJsonArray(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

/* --------------------------------- socket ops --------------------------------- */

async function stop(opts: CommandOpts): Promise<number> {
  const data = (await daemonRequest("nova_daemon_stop")) as { stopping: boolean };
  const sock = socketPath();
  const deadline = Date.now() + STOP_BOUND_MS;
  while (existsSync(sock) && Date.now() < deadline) {
    await sleep(150);
  }
  if (existsSync(sock)) {
    console.error(`nova: the daemon did not remove ${sock} within ${STOP_BOUND_MS / 1000} s`);
    return EXIT_OPERATION_FAILED;
  }
  if (opts.json) console.log(JSON.stringify({ stopped: true }));
  else console.log("daemon stopped");
  return EXIT_OK;
}

async function status(opts: CommandOpts): Promise<number> {
  const data = (await daemonRequest("nova_daemon_status")) as Record<string, unknown>;
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  const scheduler = data["scheduler"] as Record<string, unknown>;
  const budgets = data["budgets"] as Record<string, unknown>;
  console.log(
    renderKv([
      ["version", String(data["version"])],
      ["started_at", String(data["started_at"])],
      ["uptime_sec", String(data["uptime_sec"])],
      ["scheduler.paused", String(scheduler["paused"])],
      ["scheduler.running", String(scheduler["running"])],
      ["scheduler.queued", String(scheduler["queued"])],
      ["spend_today_usd", String(budgets["spend_today_usd"])],
      ["spend_month_usd", String(budgets["spend_month_usd"])],
    ]),
  );
  return EXIT_OK;
}

async function simple(op: string, message: string, json: boolean): Promise<number> {
  const data = (await daemonRequest(op));
  if (json) console.log(JSON.stringify(data));
  else console.log(message);
  return EXIT_OK;
}

async function killAll(opts: CommandOpts): Promise<number> {
  const data = (await daemonRequest("nova_kill_all")) as { paused: boolean; aborted: string[] };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  console.log(`scheduler paused; aborted ${data.aborted.length} live run(s)`);
  console.log("resume with: nova daemon resume");
  return EXIT_OK;
}

/* ---------------------------- storage maintenance ---------------------------- */

/**
 * `nova daemon backup [--out <path>]` — data.md 1.1's MUST: the backup runs
 * IN the daemon through the SQLite online backup API. The CLI sends one op
 * and prints the destination; it never opens the store (thin-client rule).
 *
 * Default destination (daemon-side): `<store dir>/state.db.bak-<stamp>`.
 * An existing destination refuses as `duplicate` (the srs exit map puts that
 * code on the operation-failure row, exit 1) — a backup never clobbers an
 * earlier one.
 */
async function backup(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const args: Record<string, unknown> = {};
  const out = p.values.get("out");
  if (out !== undefined) args["out"] = out;
  const data = (await daemonRequest("nova_daemon_backup", args)) as {
    destination: string;
    totalPages: number;
    remainingPages: number;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  console.log(data.destination);
  console.log(
    `  ${data.totalPages} pages copied (SQLite online backup API; live WAL readers and writers unaffected)`,
  );
  return EXIT_OK;
}

/**
 * `nova daemon prune [--retention-days N]` — data.md 1.2's MAY, with data.md's
 * own 30-day example as the default. The daemon deletes ONLY run-dir
 * `events.raw.jsonl` files past retention and reports every purge and every
 * skip with its reason; `events.jsonl` and every SQLite row are untouched.
 */
async function prune(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const args: Record<string, unknown> = {};
  const daysFlag = p.values.get("retention-days");
  if (daysFlag !== undefined) {
    const n = Number(daysFlag);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError("--retention-days must be a non-negative integer (days)");
    }
    args["retention_days"] = n;
  }
  const data = (await daemonRequest("nova_daemon_prune", args)) as {
    retention_days: number;
    purged: Array<{ path: string; age_days: number; reason: string }>;
    skipped: Array<{ path: string; age_days: number | null; reason: string }>;
    scanned_run_dirs: number;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  console.log(`retention: ${data.retention_days} days (run-dir events.raw.jsonl only)`);
  console.log(`purged: ${data.purged.length} of ${data.scanned_run_dirs} run dir(s) scanned`);
  for (const entry of data.purged) {
    console.log(`  - ${entry.path} (${entry.age_days} days old)`);
  }
  if (data.skipped.length > 0) {
    console.log(`skipped: ${data.skipped.length}`);
    for (const entry of data.skipped) {
      console.log(`  - ${entry.path} — ${entry.reason}`);
    }
  }
  return EXIT_OK;
}

/* ------------------------------------ logs ------------------------------------ */

async function logs(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const logPath = join(novaHome(), "daemon.log");
  if (!existsSync(logPath)) {
    console.error(`nova: no daemon log at ${logPath}`);
    return EXIT_NOT_FOUND;
  }
  let n = 50; // documented default tail
  const linesFlag = p.values.get("lines");
  if (linesFlag !== undefined) {
    const parsed = Number(linesFlag);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      throw new UsageError("--lines must be an integer 1..1000");
    }
    n = parsed;
  }
  const tail = tailFile(logPath, n);
  if (opts.json) {
    console.log(JSON.stringify({ log: logPath, lines: tail === "" ? [] : tail.split("\n") }));
    return EXIT_OK;
  }
  if (tail !== "") console.log(tail);
  return EXIT_OK;
}

function tailFile(path: string, n: number): string {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  return lines.slice(-n).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
