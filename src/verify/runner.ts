import { spawn } from "node:child_process";
import type { Db } from "../store/db.ts";

/**
 * FR-TSK-12 — the independent post-run command verifier. The engine
 * executes the task's configured verification commands (test runners,
 * typecheckers, linters) directly in the target's root_path, never
 * trusting the agent's self-report.
 *
 * Verdict per command: the exit code is authoritative. When the
 * command's stdout contains the TRAILING MARKER LINE
 *   [novaflow-verify] tests=N pass=N fail=N
 * the engine additionally requires a non-zero executed test count
 * (tests > 0) — a marker with tests=0 is test gaming (a suite skipped
 * to zero tests and exited 0, RSK-15) and fails the command. A command
 * without the marker is exit-code-only (the count check is skipped).
 * The marker must be its own line: text embedded around the pattern is
 * not the marker.
 *
 * Every spawned process follows the run loop's containment discipline
 * (architecture 8.4): detached process group, bounded output capture,
 * timeout → SIGTERM → 3 s grace → SIGKILL group kill, backstops stay
 * armed past leader exit, ESRCH tolerated — a hung verifier command
 * can never hang the engine.
 *
 * Spec-silent choices (documented, minimal-convention readings):
 *   - commands are shell strings (they read like "npm test"); they run
 *     via `/bin/sh -c <command>` with cwd = the target's root_path and
 *     the inherited environment.
 *   - default per-command timeout: 600 s. The spec names no bound for
 *     verifier commands; the run clock default (3600 s) bounds agent
 *     sessions, while verification suites are heavyweight but must
 *     stay bounded — 10 minutes is the documented default, injectable
 *     via opts.timeoutMs.
 *   - exit codes for commands that never produced one follow the
 *     GNU-coreutils timeout conventions: 124 (timed out), 126 (could
 *     not be spawned), 125 (died by signal otherwise) — the artifact
 *     schema requires an integer `exit_code` (data.md 4.1).
 *   - output capture keeps the last 8 KiB of stdout and stderr per
 *     command (bounded tails, recorded verbatim).
 */

/** The spec's only named kill escalation grace (3 s, as in the run loop). */
export const KILL_GRACE_MS = 3000;

/** Default per-command timeout (spec-silent; see module doc). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/** Bounded output capture: keep the last 8 KiB per stream. */
const MAX_OUTPUT_BYTES = 8192;

/**
 * The trailing marker line, anchored as its own line
 * (FR-TSK-12 / SRS "the trailing marker line").
 */
const MARKER_LINE_RE = /^\[novaflow-verify\] tests=(\d+) pass=(\d+) fail=(\d+)[ \t]*$/;

export type MarkerCounts = { tests: number; pass: number; fail: number };

/**
 * Find the LAST `[novaflow-verify] tests=N pass=N fail=N` line in the
 * captured stdout (the marker is trailing by contract). Returns null
 * when no line matches.
 */
export function parseVerifyMarker(stdout: string): MarkerCounts | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(MARKER_LINE_RE);
    if (m) {
      return { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) };
    }
  }
  return null;
}

/* ----------------------------- scope command collection ---------------------------- */

export type ScopeCommand = {
  command: string;
  rootPath: string;
  targetId: string;
  alias: string;
};

type ScopeRow = {
  target_id: string;
  alias: string;
  verification_commands_json: string;
  root_path: string;
};

function parseStringArray(json: string, column: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`${column} is not a JSON array of strings`);
  }
  return parsed as string[];
}

/**
 * The task's verification commands: the UNION across its
 * task_target_scopes rows, first-seen order, deduped — the same
 * extraction the p2b engine-context builder performs (src/runs/context.ts;
 * the context builder does not export its per-target pairing, so this
 * is reimplemented identically: scopes in tts.id ULID order, commands
 * deduped first-seen). Each command carries the root_path of the
 * target it came from (its cwd at execution).
 */
export function collectScopeCommands(db: Db, taskId: string): ScopeCommand[] {
  const rows = db
    .prepare(
      `SELECT tts.target_id AS target_id, pt.alias AS alias,
              tts.verification_commands_json AS verification_commands_json,
              pt.root_path AS root_path
         FROM task_target_scopes tts
         JOIN project_targets pt ON pt.id = tts.target_id
        WHERE tts.task_id = ?
        ORDER BY tts.id`,
    )
    .all(taskId) as ScopeRow[];
  const out: ScopeCommand[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const commands = parseStringArray(r.verification_commands_json, "verification_commands_json");
    for (const command of commands) {
      if (seen.has(command)) continue;
      seen.add(command);
      out.push({ command, rootPath: r.root_path, targetId: r.target_id, alias: r.alias });
    }
  }
  return out;
}

/* ------------------------------- grouped command run ------------------------------- */

export type GroupedCommandOptions = {
  timeoutMs?: number;
  killGraceMs?: number;
};

export type GroupedCommandResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
};

/**
 * Run one command in its own detached process group with the full kill
 * discipline. Resolves when the LEADER exits (or fails to spawn); the
 * SIGKILL backstop stays armed past leader exit (group children may
 * outlive the leader — ESRCH on a dead group is a no-op), and the
 * backstop timer never holds the engine's event loop (unref'd).
 */
export function runGroupedCommand(
  argv: string[],
  cwd: string,
  opts: GroupedCommandOptions = {},
): Promise<GroupedCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      // an invalid cwd (or a bad binary) can throw synchronously —
      // that is a spawn failure, never an engine crash
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: (err as Error).message,
        stdout: "",
        stderr: "",
      });
      return;
    }

    // bounded capture: keep the last 8 KiB of each stream in memory
    let stdoutAcc = "";
    let stderrAcc = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutAcc += chunk;
      if (stdoutAcc.length > MAX_OUTPUT_BYTES * 2) stdoutAcc = stdoutAcc.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrAcc += chunk;
      if (stderrAcc.length > MAX_OUTPUT_BYTES * 2) stderrAcc = stderrAcc.slice(-MAX_OUTPUT_BYTES);
    });

    // architecture 8.4 killpg(): signal the child's whole process group;
    // ESRCH (group already gone) is fine on both signals.
    const signalGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
      if (child.pid === undefined || child.pid === null) return;
      try {
        process.kill(-child.pid, sig);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Omit<GroupedCommandResult, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ ...result, stdout: stdoutAcc, stderr: stderrAcc });
    };

    child.once("exit", (code, signal) => {
      finish({ exitCode: code, signal, timedOut, spawnError: null });
    });
    child.once("error", (err) => {
      finish({ exitCode: null, signal: null, timedOut, spawnError: err.message });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      // the SIGKILL backstop stays armed PAST leader exit (a group
      // child can ignore SIGTERM); unref'd so it never blocks shutdown
      sigkillTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
      sigkillTimer.unref?.();
    }, timeoutMs);
  });
}

/* --------------------------------- the verifier ----------------------------------- */

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  /** The integer recorded in artifacts (GNU timeout conventions; see module doc). */
  exitCodeForArtifact: number;
  timedOut: boolean;
  spawnError: string | null;
  marker: MarkerCounts | null;
  passed: boolean;
  stdoutTail: string;
  stderrTail: string;
};

export type VerifyOutcome = {
  /** ALL commands passed. No commands configured → vacuous pass. */
  passed: boolean;
  results: CommandResult[];
};

export type VerifyOptions = GroupedCommandOptions;

/** Map a raw group-command outcome to the per-command verdict + artifact exit code. */
function judge(command: string, cwd: string, res: GroupedCommandResult): CommandResult {
  const marker = parseVerifyMarker(res.stdout);
  const passed =
    res.exitCode === 0 &&
    res.spawnError === null &&
    !res.timedOut &&
    (marker === null || marker.tests > 0);
  let exitCodeForArtifact: number;
  if (res.timedOut) exitCodeForArtifact = 124;
  else if (res.spawnError !== null) exitCodeForArtifact = 126;
  else if (res.exitCode === null) exitCodeForArtifact = 125;
  else exitCodeForArtifact = res.exitCode;
  return {
    command,
    cwd,
    exitCode: res.exitCode,
    exitCodeForArtifact,
    timedOut: res.timedOut,
    spawnError: res.spawnError,
    marker,
    passed,
    stdoutTail: res.stdout.slice(-MAX_OUTPUT_BYTES),
    stderrTail: res.stderr.slice(-MAX_OUTPUT_BYTES),
  };
}

/**
 * Execute the task's verification commands sequentially (deterministic,
 * first-seen order) and judge each per FR-TSK-12. Never throws — spawn
 * failures and timeouts become failed command results.
 */
export async function runVerification(
  db: Db,
  taskId: string,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const commands = collectScopeCommands(db, taskId);
  const results: CommandResult[] = [];
  for (const c of commands) {
    const res = await runGroupedCommand(["/bin/sh", "-c", c.command], c.rootPath, opts);
    results.push(judge(c.command, c.rootPath, res));
  }
  return { passed: results.every((r) => r.passed), results };
}
