import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { daemonRequest, novaHome, OpFailureError } from "../client.ts";
import { resolveTaskIdent, workspaceContext } from "../context.ts";
import { renderKv, renderTable } from "../format.ts";
import { EXIT_OK, EXIT_OPERATION_FAILED } from "../exitcode.ts";
import {
  findOnPath,
  listDirs,
  listFiles,
  pidAlive,
  portHolder,
  reapGroup,
  sleep,
  tailFile,
} from "../procs.ts";
import type { CommandOpts } from "../opts.ts";
import { withFixHint } from "../../fixhint.ts";

/**
 * `nova web …` (srs 4.1.1's web verbs, novaflow-v030/panel.md tier D).
 *
 *   sync [--run <id|key> | --all]   mirror settled runs' session files into
 *                                   the PRIVATE Pi Web agent dir
 *   start | stop | status           the dedicated Pi Web instance
 *
 * THE RULINGS THIS FILE ENFORCES (panel.md, "The tier this release ships"):
 *
 *   - COPIES, NEVER LINKS. A hardlink would let Pi Web's rename/delete/resume
 *     write through to a run's record; `sync` writes an independent byte copy.
 *   - SETTLED ONLY. A live run's transcript is still being written; copying it
 *     is a torn read. `--run` on a live run refuses (exit 1) and copies NOTHING;
 *     `--all` (a workspace sweep, where in-flight work is expected and not an
 *     error) reports the live run as refused and mirrors the settled ones.
 *   - NO RAW STREAM, EVER. Only the run's pi session file is copied —
 *     `events.raw.jsonl` and `events.jsonl` are excluded by name, and the
 *     mirror walk in the tests pins that.
 *   - READ-ONLY on the run directory: every run-dir read is a `readFileSync` /
 *     directory listing; nothing writes, renames or unlinks inside it.
 *   - NO NEW SOCKET OP (panel.md non-goals): run discovery is a bounded
 *     filesystem walk of `<workspace_root>/.novaflow/runs`, settle-ness is the
 *     existing `nova_run_logs_since` op's `done` flag, and identity comes from
 *     `nova_task_list` / `nova_task_resolve` / `nova_workspace_list`.
 *
 * The mirror destination is Pi Web's OWN convention (verified against the
 * installed pi 1.6.0 session store): a session lives at
 * `<agent dir>/sessions/<cwd-slug>/<file>.jsonl`, where the slug is the run's
 * cwd with separators flattened and wrapped in `--…--`
 * (`/home/x/y` → `--home-x-y--`) and the file keeps the run's own name
 * (`<ts>_<run id>.jsonl`). Nothing here invents a second layout.
 *
 * Test-injection knobs (documented; unset → the real values):
 *   NOVAFLOW_PIWEB_PORT   the port (default 30142, the panel's dedicated port)
 *   NOVAFLOW_PIWEB_BIN    the pi-web binary (default: `pi-web` on PATH)
 *   NOVAFLOW_HOME         the base dir (<home>/piweb is the private agent dir)
 */

const SPEC: ArgSpec = { booleanFlags: ["all"], valueFlags: ["run"] };

/** panel.md's dedicated port; never 30141 (the operator's own Pi Web). */
export const DEFAULT_PIWEB_PORT = 30142;

const START_BOUND_MS = 15_000;
const STOP_GRACE_MS = 3000;
/** The mirrored session files' extension Pi Web scans for. */
const SESSION_SUFFIX = ".jsonl";
/** Never mirrored, by name (FR-LOG-02's two run-dir logs). */
const RUN_LOG_NAMES: ReadonlySet<string> = new Set(["events.jsonl", "events.raw.jsonl"]);

export async function webCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  if (p.positionals.length > 1) {
    throw new UsageError(`nova web ${sub ?? "<sub>"} takes no positional arguments`);
  }
  switch (sub) {
    case "sync":
      return sync(p, opts);
    case "start":
      return startInstance(opts);
    case "stop":
      return stopInstance(opts);
    case "status":
      return instanceStatus(opts);
    default:
      throw new UsageError(
        `nova web [sync|start|stop|status]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`,
      );
  }
}

/* ------------------------------ shared locations ------------------------------ */

/** The private Pi Web agent dir: `<NOVAFLOW_HOME>/piweb` (never ~/.pi). */
export function piwebRoot(): string {
  return join(novaHome(), "piweb");
}

function piwebSessionsRoot(): string {
  return join(piwebRoot(), "sessions");
}

function piwebPidPath(): string {
  return join(piwebRoot(), "piweb.pid");
}

function piwebLogPath(): string {
  return join(piwebRoot(), "piweb.log");
}

function piwebPort(): number {
  const raw = process.env["NOVAFLOW_PIWEB_PORT"];
  if (raw === undefined) return DEFAULT_PIWEB_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError("NOVAFLOW_PIWEB_PORT must be an integer 1..65535");
  }
  return port;
}

function piwebUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** `pi-web` on PATH, or the documented injection override (tests). */
function resolvePiwebBin(): string | null {
  const override = process.env["NOVAFLOW_PIWEB_BIN"];
  if (override !== undefined) return existsSync(override) ? override : null;
  return findOnPath("pi-web");
}

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/* ---------------------------------- nova web sync ---------------------------------- */

type SyncOutcome = "copied" | "unchanged" | "refused" | "skipped";

type SyncRow = {
  run_id: string;
  task_id: string;
  task_key: string;
  outcome: SyncOutcome;
  bytes: number;
  destination: string | null;
  reason: string | null;
};

type RunDir = { taskId: string; runId: string; dir: string };

function runsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".novaflow", "runs");
}

/**
 * Every run directory recorded on disk, in a deterministic order. The
 * filesystem is the enum- eration side (task/run ULIDs are the directory
 * names, data.md 5.1); the store answers only the settle-ness question.
 */
function runDirs(workspaceRoot: string, taskId?: string): RunDir[] {
  const root = runsRoot(workspaceRoot);
  const taskDirs = taskId === undefined ? listDirs(root) : [taskId];
  const out: RunDir[] = [];
  for (const task of taskDirs.sort()) {
    for (const run of listDirs(join(root, task)).sort()) {
      out.push({ taskId: task, runId: run, dir: join(root, task, run) });
    }
  }
  return out;
}

function findRunDirById(workspaceRoot: string, runId: string): RunDir | null {
  for (const entry of runDirs(workspaceRoot)) {
    if (entry.runId === runId) return entry;
  }
  return null;
}

/**
 * The run's pi session file inside its run dir. The engine spawns pi with
 * `--session-dir <run dir> --session-id <run id>`, so the pi-native name is
 * `<ts>_<run id>.jsonl`; `session.jsonl` is accepted as the documented
 * fallback. The two run logs are excluded by name and are never candidates.
 */
function sessionFile(runDir: string, runId: string): string | null {
  const candidates = listFiles(runDir)
    .filter((name) => name.endsWith(SESSION_SUFFIX) && !RUN_LOG_NAMES.has(name))
    .sort();
  return (
    candidates.find((name) => name.endsWith(`_${runId}${SESSION_SUFFIX}`)) ??
    candidates.find((name) => name === `session${SESSION_SUFFIX}`) ??
    candidates[0] ??
    null
  );
}

/** Pi's own cwd → session-directory encoding (`/home/x/y` → `--home-x-y--`). */
export function cwdSlug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The cwd recorded in the session file's own header line (pi writes
 * `{type:"session", …, cwd}` first, verified against the installed pi
 * 1.6.0). This is the run's cwd as the transcript itself asserts it — the
 * store does not record one, and the session header is the only truthful
 * source. Returns null when the header is absent/unparseable; the caller
 * then falls back to the workspace root.
 */
function sessionCwd(bytes: Buffer): string | null {
  const newline = bytes.indexOf(0x0a);
  const line = bytes.toString("utf8", 0, newline < 0 ? bytes.length : newline);
  try {
    const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" && header.cwd !== ""
      ? header.cwd
      : null;
  } catch {
    return null;
  }
}

/**
 * Settle-ness from the existing op's `done` flag (`nova_run_logs_since`
 * documents `done: run.status !== 'running'`, i.e. terminal). The op is the
 * only existing surface that reports a SPECIFIC run's status — `nova_task_status`
 * reports the latest run only — so it is what panel.md's "consumes existing
 * ops" clause leaves us. A run with no store record is `not_found`.
 */
async function runIsSettled(taskId: string, runId: string): Promise<boolean> {
  const data = (await daemonRequest("nova_run_logs_since", {
    task_id: taskId,
    run_id: runId,
    limit: 1,
  })) as { done?: unknown };
  return data.done === true;
}

type SyncTarget = { entry: RunDir; key: string };

/** Resolve `--run <id|key>` to the run dirs it names (a run id or a whole task). */
async function resolveRunTargets(
  workspaceRoot: string,
  ident: string,
  workspaceId: string,
): Promise<SyncTarget[]> {
  const direct = findRunDirById(workspaceRoot, ident);
  if (direct !== null) {
    const tasks = await taskKeys();
    return [{ entry: direct, key: tasks.get(direct.taskId) ?? direct.taskId }];
  }
  const task = await resolveTaskIdent(ident, workspaceId);
  const entries = runDirs(workspaceRoot, task.id);
  const tasks = await taskKeys();
  if (entries.length === 0) {
    throw new OpFailureError("not_found", `no runs on disk for task ${task.key} (${task.id})`);
  }
  return entries.map((entry) => ({ entry, key: tasks.get(entry.taskId) ?? task.key }));
}

async function taskKeys(): Promise<Map<string, string>> {
  const data = (await daemonRequest("nova_task_list")) as { tasks: Array<{ id: string; key: string }> };
  return new Map(data.tasks.map((t) => [t.id, t.key]));
}

function renderSync(rows: SyncRow[], mirror: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ mirror, runs: rows }));
    return;
  }
  console.log(
    renderTable(
      rows.map((row) => ({
        run: row.run_id,
        task: row.task_key,
        result:
          row.outcome === "copied"
            ? `copied ${row.bytes} bytes`
            : row.outcome === "unchanged"
              ? "unchanged"
              : row.outcome === "refused"
                ? `refused (${row.reason ?? "not settled"})`
                : `skipped (${row.reason ?? "no session file"})`,
      })),
      [
        { key: "run", header: "RUN" },
        { key: "task", header: "TASK" },
        { key: "result", header: "RESULT" },
      ],
    ),
  );
  console.log(`mirror: ${mirror} (read-only for NovaFlow; Pi Web only reads it)`);
}

async function sync(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const runFlag = p.values.get("run");
  const all = p.flags.has("all");
  if (runFlag !== undefined && all) {
    throw new UsageError("nova web sync takes exactly one of --run <id|key> or --all (not both)");
  }
  if (runFlag === undefined && !all) {
    throw new UsageError("nova web sync takes one of --run <id|key> or --all");
  }
  const ctx = await workspaceContext(opts.workspace);
  const mirror = piwebSessionsRoot();

  // ---- resolve the requested runs (filesystem enumeration + existing ops) ----
  const targets: SyncTarget[] =
    runFlag !== undefined
      ? await resolveRunTargets(ctx.rootPath, runFlag, ctx.id)
      : await (async () => {
          const keys = await taskKeys();
          return runDirs(ctx.rootPath).map((entry) => ({
            entry,
            key: keys.get(entry.taskId) ?? entry.taskId,
          }));
        })();

  // ---- settle-ness FIRST: an explicit --run refuses atomically ----
  const settleErrors = new Map<string, string>();
  const settled: boolean[] = [];
  for (const target of targets) {
    try {
      settled.push(await runIsSettled(target.entry.taskId, target.entry.runId));
    } catch (err) {
      if (!(err instanceof OpFailureError) || err.code !== "not_found") throw err;
      // the op's own reason (a missing run row, or a run whose log file is gone)
      settleErrors.set(target.entry.runId, err.message);
      settled.push(false);
    }
  }

  if (runFlag !== undefined) {
    const live = targets.filter((_, i) => !settled[i] && !settleErrors.has(targets[i]!.entry.runId));
    if (live.length > 0) {
      for (const target of live) {
        console.error(
          withFixHint(
            `nova: run ${target.entry.runId} (${target.key}) is running, not settled — refusing to mirror a transcript still being written`,
            "follow it live with `nova status --watch`, then re-run `nova web sync --run <id|key>` once it settles",
          ),
        );
      }
      console.error("nova: nothing was copied");
      return EXIT_OPERATION_FAILED;
    }
    const unknown = targets.filter((_, i) => settleErrors.has(targets[i]!.entry.runId));
    if (unknown.length > 0 && unknown.length === targets.length) {
      throw new OpFailureError("not_found", settleErrors.get(unknown[0]!.entry.runId)!);
    }
  }

  // ---- copy: byte-compare first, write only when the source actually moved ----
  const rows: SyncRow[] = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const row: SyncRow = {
      run_id: target.entry.runId,
      task_id: target.entry.taskId,
      task_key: target.key,
      outcome: "skipped",
      bytes: 0,
      destination: null,
      reason: null,
    };
    const settleError = settleErrors.get(target.entry.runId);
    if (settleError !== undefined) {
      rows.push({ ...row, reason: settleError });
      continue;
    }
    if (!settled[i]) {
      rows.push({ ...row, outcome: "refused", reason: "running" });
      continue;
    }
    const name = sessionFile(target.entry.dir, target.entry.runId);
    if (name === null) {
      rows.push({ ...row, reason: "no session file" });
      continue;
    }
    const source = readFileSync(join(target.entry.dir, name));
    const cwd = sessionCwd(source) ?? ctx.rootPath;
    const destination = join(mirror, cwdSlug(cwd), name);
    const existing = existsSync(destination) ? readFileSync(destination) : null;
    if (existing !== null && existing.equals(source)) {
      rows.push({ ...row, outcome: "unchanged", bytes: source.length, destination });
      continue;
    }
    mkdirSync(join(mirror, cwdSlug(cwd)), { recursive: true });
    writeFileSync(destination, source);
    rows.push({ ...row, outcome: "copied", bytes: source.length, destination });
  }

  renderSync(rows, mirror, opts.json);
  const copied = rows.filter((r) => r.outcome === "copied").length;
  const unchanged = rows.filter((r) => r.outcome === "unchanged").length;
  const refused = rows.filter((r) => r.outcome === "refused").length;
  if (!opts.json) {
    console.log(`${copied} copied, ${unchanged} unchanged, ${refused} refused (settled runs only)`);
  }
  // `--all` is a workspace sweep: in-flight work is expected, reported, and not
  // an error (the card's ambiguity, resolved here and documented in README).
  return EXIT_OK;
}

/* ------------------------------- nova web start ------------------------------- */

/** Any answer (or a silent bound socket) means the port is taken. */
function portBusy(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(timeoutMs, () => done(true)); // bound but silent: treat as busy
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** One GET, resolving the status code (0 when nothing answered within the bound). */
function httpGet(port: number, path: string, timeoutMs = 1500): Promise<number> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
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

/** Pi Web answers `/api/sessions` with 2xx once its server is up. */
async function apiAnswers(port: number): Promise<boolean> {
  const status = await httpGet(port, "/api/sessions");
  return status >= 200 && status < 300;
}

async function startInstance(opts: CommandOpts): Promise<number> {
  const port = piwebPort();
  const root = piwebRoot();
  const url = piwebUrl(port);
  const pidPath = piwebPidPath();
  const logPath = piwebLogPath();

  // an instance we already launched: refuse a second one (the daemon rule)
  const existing = readPid(pidPath);
  if (existing !== null) {
    if (pidAlive(existing) && (await apiAnswers(port))) {
      console.error(
        withFixHint(
          `nova: a live pi-web already answers at ${url} (pid ${existing}) — refusing to start a second one`,
          `browse ${url}, or stop it with \`nova web stop\``,
        ),
      );
      return EXIT_OPERATION_FAILED;
    }
    if (!pidAlive(existing)) rmSync(pidPath, { force: true }); // stale pid file
  }

  // a busy port is somebody else's server: name it, never kill it
  if (await portBusy(port)) {
    console.error(
      withFixHint(
        `nova: port ${port} is already in use — held by ${portHolder(port)}; refusing to start pi-web on a busy port`,
        `stop the process holding port ${port}, or set NOVAFLOW_PIWEB_PORT to a free port`,
      ),
    );
    return EXIT_OPERATION_FAILED;
  }

  const bin = resolvePiwebBin();
  if (bin === null) {
    console.error("nova: pi-web is not on PATH — install it with: npm install -g @agegr/pi-web");
    return EXIT_OPERATION_FAILED;
  }

  // the private agent dir: Pi Web reads <root>/sessions, nothing else is ours
  mkdirSync(piwebSessionsRoot(), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(bin, ["--port", String(port), "--no-open"], {
    detached: true,
    cwd: root,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
  });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + START_BOUND_MS;
  for (;;) {
    if (await apiAnswers(port)) break;
    if (child.exitCode !== null) {
      await reapGroup(child.pid);
      console.error(
        withFixHint(
          `nova: pi-web exited (code ${child.exitCode}) before answering ${url}`,
          "read the log tail below, fix the cause it names, then re-run `nova web start`",
        ) + ` — tail of ${logPath}:`,
      );
      console.error(existsSync(logPath) ? tailFile(logPath, 10) : "(no log)");
      return EXIT_OPERATION_FAILED;
    }
    if (Date.now() > deadline) {
      await reapGroup(child.pid);
      console.error(
        withFixHint(
          `nova: pi-web did not answer ${url} within ${START_BOUND_MS / 1000} s`,
          "read the log tail below, fix the cause it names, then re-run `nova web start`",
        ) + ` — tail of ${logPath}:`,
      );
      console.error(existsSync(logPath) ? tailFile(logPath, 10) : "(no log)");
      return EXIT_OPERATION_FAILED;
    }
    await sleep(150);
  }

  writeFileSync(pidPath, `${child.pid}\n`);
  if (opts.json) {
    console.log(
      JSON.stringify({
        started: true,
        pid: child.pid,
        port,
        url,
        agent_dir: root,
        log: logPath,
        mirrored_runs: countMirroredRuns(),
      }),
    );
    return EXIT_OK;
  }
  console.log(`pi-web started (pid ${child.pid}) on ${url}`);
  console.log(`  agent dir: ${root}`);
  console.log(`  log: ${logPath}`);
  console.log(`  mirrored runs: ${countMirroredRuns()}`);
  return EXIT_OK;
}

/* -------------------------------- nova web stop -------------------------------- */

async function stopInstance(opts: CommandOpts): Promise<number> {
  const pidPath = piwebPidPath();
  const pid = readPid(pidPath);
  if (pid === null) {
    if (opts.json) console.log(JSON.stringify({ stopped: false, reason: "no pid file", pid_file: pidPath }));
    else console.log(`pi-web is not running (no pid file at ${pidPath})`);
    return EXIT_OK;
  }
  if (!pidAlive(pid)) {
    rmSync(pidPath, { force: true });
    if (opts.json) console.log(JSON.stringify({ stopped: false, reason: "stale pid file removed", pid }));
    else console.log(`pi-web is not running (removed stale pid file ${pidPath})`);
    return EXIT_OK;
  }
  await reapGroup(pid, STOP_GRACE_MS);
  if (pidAlive(pid)) {
    console.error(`nova: pi-web (pid ${pid}) did not stop after SIGTERM and SIGKILL`);
    return EXIT_OPERATION_FAILED;
  }
  rmSync(pidPath, { force: true });
  if (opts.json) console.log(JSON.stringify({ stopped: true, pid }));
  else console.log(`pi-web stopped (pid ${pid})`);
  return EXIT_OK;
}

/* ------------------------------- nova web status ------------------------------- */

/** Count the mirrored session files Pi Web can list (bounded two-level walk). */
function countMirroredRuns(): number {
  const root = piwebSessionsRoot();
  let count = 0;
  for (const slug of listDirs(root)) {
    count += listFiles(join(root, slug)).filter((name) => name.endsWith(SESSION_SUFFIX)).length;
  }
  return count;
}

async function instanceStatus(opts: CommandOpts): Promise<number> {
  const port = piwebPort();
  const root = piwebRoot();
  const pidPath = piwebPidPath();
  const pid = readPid(pidPath);
  const running = pid !== null && pidAlive(pid);
  const answering = await apiAnswers(port);
  const mirrored = countMirroredRuns();
  const url = piwebUrl(port);
  const payload = {
    running,
    pid,
    port,
    url,
    answering,
    mirrored_runs: mirrored,
    agent_dir: root,
    log: piwebLogPath(),
    pid_file: pidPath,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload));
    return EXIT_OK;
  }
  console.log(
    renderKv([
      ["running", String(running)],
      ["pid", pid === null ? "-" : String(pid)],
      ["port", String(port)],
      ["url", url],
      ["answering", String(answering)],
      ["mirrored_runs", String(mirrored)],
      ["agent_dir", root],
    ]),
  );
  return EXIT_OK;
}
