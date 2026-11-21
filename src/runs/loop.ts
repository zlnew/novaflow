import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db.ts";
import { ulid } from "../store/ids.ts";
import { applyTransition, canTransition, InvalidTransitionError } from "../fsm/engine.ts";
import {
  START_TRIGGER,
  REPAIR_TRIGGER,
  RUN_FAILED_TRIGGER,
  ABORT_TRIGGER,
} from "./triggers.ts";
import { finalizeRunRecord, intakeSettledRun } from "./settle-replay.ts";
import { buildEngineContext, writeEngineContext } from "./context.ts";
import { writeProtectedDigests } from "../verify/protected.ts";
import { composePrompt, type ComposedPrompt } from "./prompt.ts";
import { buildRunArgv, defaultExtensionPath, runDirPath } from "./spawn.ts";
import { createPump } from "./pump.ts";
import { redactText } from "./redact.ts";
import {
  costUsd,
  defaultPricesPath,
  loadPricesDetailed,
  inertPricesNote,
  type PriceTable,
} from "./prices.ts";

/**
 * startRun — the daemon's call after a concurrency slot is granted
 * (novaflow-v1/architecture 8.1; the slot check itself is the caller's
 * duty). Drives one task through the Pi subprocess lifecycle end to
 * end: queued→running, task_runs row per attempt, engine-context +
 * prompt (FR-TSK-04), spawn per api.md §1, two-file event capture
 * (FR-LOG-02), settlement on agent_settled (FR-TSK-05), artifact intake
 * with the FR-TSK-06 bounded repair (max 1), budget/timeout kill
 * (SIGTERM → 3 s grace → SIGKILL), and run-record finalization
 * (FR-TSK-09).
 *
 * Resolves only when every spawned child is fully gone (reap
 * discipline: resolve after the exit event, SIGKILL backstop timer
 * cleared on exit) and the task has left `running`.
 */

/** SIGTERM grace before the SIGKILL backstop — the spec's only named escalation. */
export const KILL_GRACE_MS = 3000;

/**
 * The daemon's handle on one live attempt (the abort/steer ops).
 * The daemon marks `abortRequested` BEFORE performing the group kill
 * (SIGTERM → grace → SIGKILL); the loop then classifies the exit as an
 * operator abort and owns BOTH the run record ('cancelled') and the
 * running→cancelled matrix row — every write stays on the guarded path,
 * the op itself performs no state write. While the child is live the
 * loop installs `steer` so the daemon can forward api.md §3 frames
 * (e.g. the `steer` command) to the child's stdin; cleared on exit.
 */
export type RunControl = {
  abortRequested: boolean;
  /** trigger_type recorded on the operator-abort transition (default human). */
  abortTriggerType?: "human" | "mcp" | undefined;
  /** actor recorded on the operator-abort transition (default "operator"). */
  abortActor?: string | undefined;
  /** Installed by the loop while the child is live; null otherwise. */
  steer: ((frame: string) => void) | null;
};

export type RunOptions = {
  /** Pi binary; default "pi". Tests point this at the stub. */
  piBin?: string | undefined;
  /** Extra argv before the engine flags (stub script + mode). */
  args?: string[] | undefined;
  /** Extra child env entries (spread over the inherited environment). */
  env?: Record<string, string> | undefined;
  /** Extension path for api.md §1 `-e`; default ~/.pi/agent/extensions/novaflow.ts. */
  extensionPath?: string | undefined;
  /** Price table path; default ~/.novaflow/prices.json (data.md 4.4). */
  pricesPath?: string | undefined;
  /**
   * SIGTERM -> SIGKILL grace window. The spec pins 3 s (KILL_GRACE_MS);
   * tests may inject a shorter window so the escalation is proven fast.
   */
  killGraceMs?: number | undefined;
  /** The daemon's abort/steer handle on the live attempt (optional). */
  control?: RunControl | undefined;
};

export type TaskRunRecord = {
  id: string;
  task_id: string;
  profile_id: string | null;
  attempt_number: number;
  thinking_level: string | null;
  attempt_kind: string;
  pi_session_id: string;
  pi_session_dir: string;
  pid: number | null;
  status: string;
  preflight_status: string;
  engine_verification_passed: number;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  exit_code: number | null;
  artifact_path: string | null;
  events_log_path: string;
  git_commits_json: string;
  error_summary: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};

export type RunOutcome = {
  taskId: string;
  /** The task state after the loop concluded. */
  finalState: string;
  /** All run rows for this startRun call, in attempt order. */
  runs: TaskRunRecord[];
};

type TaskJoinRow = {
  id: string;
  objective: string;
  profile_id: string;
  state: string;
  requires_human_gate: number;
  output_schema_version: string;
  overrides_json: string | null;
  context_files_json: string;
  workspace_root: string;
};

type ProfileJoinRow = {
  id: string;
  model: string;
  thinking_level: string;
  system_prompt_path: string;
  max_timeout_sec: number;
  max_cost_usd: number;
};

/** Effective per-run parameters: profile baseline overridden by tasks.overrides_json. */
export type EffectiveParams = {
  maxTimeoutSec: number;
  maxCostUsd: number;
  thinkingLevel: string;
};

/**
 * Resolve the DDL-documented overrides (`timeout_sec`, `max_cost_usd`,
 * `thinking_level` — tasks DDL comment; the chain.yaml overrides block is
 * the spec'd shape, unknown keys rejected). Malformed overrides are a
 * preflight failure, never a crash mid-run.
 */
export function resolveParams(
  profile: Pick<ProfileJoinRow, "thinking_level" | "max_timeout_sec" | "max_cost_usd">,
  overridesJson: string | null,
): { ok: true; value: EffectiveParams } | { ok: false; error: string } {
  const value: EffectiveParams = {
    maxTimeoutSec: profile.max_timeout_sec,
    maxCostUsd: profile.max_cost_usd,
    thinkingLevel: profile.thinking_level,
  };
  if (overridesJson === null || overridesJson.trim() === "") return { ok: true, value };
  let raw: unknown;
  try {
    raw = JSON.parse(overridesJson);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["timeout_sec", "max_cost_usd", "thinking_level"].includes(key)) {
      return { ok: false, error: `unknown override key "${key}"` };
    }
  }
  if ("timeout_sec" in o) {
    if (typeof o["timeout_sec"] !== "number" || !Number.isInteger(o["timeout_sec"]) || o["timeout_sec"] < 1) {
      return { ok: false, error: '"timeout_sec" must be an integer >= 1' };
    }
    value.maxTimeoutSec = o["timeout_sec"];
  }
  if ("max_cost_usd" in o) {
    if (typeof o["max_cost_usd"] !== "number" || !Number.isFinite(o["max_cost_usd"]) || o["max_cost_usd"] < 0) {
      return { ok: false, error: '"max_cost_usd" must be a number >= 0' };
    }
    value.maxCostUsd = o["max_cost_usd"];
  }
  if ("thinking_level" in o) {
    if (typeof o["thinking_level"] !== "string" || (o["thinking_level"] as string).length === 0) {
      return { ok: false, error: '"thinking_level" must be a non-empty string' };
    }
    value.thinkingLevel = o["thinking_level"];
  }
  return { ok: true, value };
}

function nextAttemptNumber(db: Db, taskId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(attempt_number), 0) AS n FROM task_runs WHERE task_id = ?")
    .get(taskId) as { n: number };
  return row.n + 1;
}

function insertRunRow(
  db: Db,
  spec: {
    id: string;
    taskId: string;
    profileId: string;
    attemptNumber: number;
    thinkingLevel: string | null;
    attemptKind: "execution" | "repair";
    sessionDir: string;
    model: string;
    eventsLogPath: string;
  },
): void {
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, profile_id, attempt_number, thinking_level, attempt_kind,
        pi_session_id, pi_session_dir, status, preflight_status, model_used,
        events_log_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'pending', ?, ?)`,
  ).run(
    spec.id,
    spec.taskId,
    spec.profileId,
    spec.attemptNumber,
    spec.thinkingLevel,
    spec.attemptKind,
    spec.id, // pi_session_id = the run id (bare ULID, data.md 5.1)
    spec.sessionDir,
    spec.model,
    spec.eventsLogPath,
  );
}

type RawOutcome =
  | { kind: "spawn-error"; message: string }
  | { kind: "timeout"; code: number | null }
  | { kind: "budget"; code: number | null }
  | { kind: "abort"; code: number | null }
  | { kind: "crash"; code: number | null }
  | { kind: "settled"; code: number | null };

export async function startRun(
  db: Db,
  taskId: string,
  actor: string,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const task = db
    .prepare(
      `SELECT t.id, t.objective, t.profile_id, t.state, t.requires_human_gate,
              t.output_schema_version, t.overrides_json, t.context_files_json,
              w.root_path AS workspace_root
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE t.id = ?`,
    )
    .get(taskId) as TaskJoinRow | undefined;
  if (!task) throw new Error(`no such task: ${taskId}`);
  const profile = db
    .prepare("SELECT id, model, thinking_level, system_prompt_path, max_timeout_sec, max_cost_usd FROM agent_profiles WHERE id = ?")
    .get(task.profile_id) as ProfileJoinRow | undefined;
  if (!profile) throw new Error(`task ${taskId} references missing profile ${task.profile_id}`);

  // Matrix guard first: never spend preflight work on a task the FSM will
  // refuse anyway (the slot itself was the caller's duty).
  if (!canTransition(task.state, START_TRIGGER)) {
    throw new InvalidTransitionError(task.state, START_TRIGGER);
  }

  const priceLoad = loadPricesDetailed(opts.pricesPath ?? defaultPricesPath());
  const priceTable: PriceTable = priceLoad.table;
  const extensionPath = opts.extensionPath ?? defaultExtensionPath();

  // queued → running: the verbatim 8.1 scheduler-slot row.
  applyTransition(db, taskId, START_TRIGGER, { triggerType: "engine", actor });

  let attemptKind: "execution" | "repair" = "execution";
  let repairFeedback: string | undefined;

  for (;;) {
    const runId = ulid();
    const runDir = runDirPath(task.workspace_root, taskId, runId);
    const rawPath = join(runDir, "events.raw.jsonl");
    const redactedPath = join(runDir, "events.jsonl");
    const startedWall = Date.now();
    const attemptNumber = nextAttemptNumber(db, taskId);

    // Resolve overrides BEFORE the row so thinking_level is the level
    // actually used; a malformed overrides_json leaves a full audit trail
    // (failed run row) instead of a half-written attempt.
    const params = resolveParams(profile, task.overrides_json);
    const thinkingLevel = params.ok ? params.value.thinkingLevel : null;
    const effective: EffectiveParams = params.ok
      ? params.value
      : {
          maxTimeoutSec: profile.max_timeout_sec,
          maxCostUsd: profile.max_cost_usd,
          thinkingLevel: profile.thinking_level,
        };

    // A missing/unparseable prices.json silently disables the
    // max_cost_usd breaker (never-crash rule) - when the task HAS a
    // budget, the run record must say so instead of staying silent.
    const withPricesNote = (summary: string | null): string | null =>
      priceLoad.source !== "file" && effective.maxCostUsd > 0
        ? summary === null
          ? inertPricesNote(priceLoad.source)
          : summary + "\n" + inertPricesNote(priceLoad.source)
        : summary;

    insertRunRow(db, {
      id: runId,
      taskId,
      profileId: profile.id, // snapshot for THIS run (FR-TSK-09)
      attemptNumber,
      thinkingLevel,
      attemptKind,
      sessionDir: runDir,
      model: profile.model,
      eventsLogPath: redactedPath, // the run's log pointer is the READ surface
    });

    // ---- preflight: everything that must hold BEFORE a spawn ----
    let preflightError: string | null = params.ok ? null : `overrides_json invalid: ${params.error}`;
    const systemPromptFile = join(task.workspace_root, profile.system_prompt_path);
    if (preflightError === null && !existsSync(systemPromptFile)) {
      preflightError = `system prompt file missing: ${profile.system_prompt_path}`;
    }
    let prompt: ComposedPrompt | null = null;
    if (preflightError === null) {
      try {
        const contextFiles: unknown = JSON.parse(task.context_files_json);
        if (!Array.isArray(contextFiles) || contextFiles.some((f) => typeof f !== "string")) {
          throw new Error("context_files_json is not a JSON array of paths");
        }
        prompt = composePrompt({
          objective: task.objective,
          contextFiles: contextFiles as string[],
          workspaceRoot: task.workspace_root,
          ...(attemptKind === "repair" && repairFeedback !== undefined
            ? { repairFeedback }
            : {}),
        });
      } catch (err) {
        preflightError = (err as Error).message;
      }
    }
    let contextPath: string | null = null;
    if (preflightError === null) {
      try {
        mkdirSync(runDir, { recursive: true });
        const ctx = buildEngineContext(
          db,
          { id: taskId, output_schema_version: task.output_schema_version },
          runId,
          attemptKind,
          { max_timeout_sec: effective.maxTimeoutSec, max_cost_usd: effective.maxCostUsd },
        );
        contextPath = writeEngineContext(runDir, ctx);
      } catch (err) {
        preflightError = `engine context: ${(err as Error).message}`;
      }
    }
    // pre-run protected-digest snapshot (FR-TSK-11, architecture 5.8
    // Post-Run Verifier): taken at preflight, BEFORE the agent runs, so
    // the post-run verifier can prove protected-file integrity against
    // the pre-run state. A scoped target whose root is missing fails
    // preflight here (zero tokens, full audit trail).
    if (preflightError === null && contextPath !== null) {
      try {
        writeProtectedDigests(db, taskId, runDir, runId);
      } catch (err) {
        preflightError = `protected digests: ${(err as Error).message}`;
      }
    }

    if (preflightError !== null || prompt === null || contextPath === null) {
      const error = preflightError ?? "preflight failed";
      finalizeRunRecord(db, runId, {
        status: "failed",
        preflightStatus: "failed",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        exitCode: null,
        artifactPath: null,
        errorSummary: withPricesNote(`preflight failure: ${error}`),
        startedWall,
      });
      applyTransition(db, taskId, RUN_FAILED_TRIGGER, {
        triggerType: "engine",
        actor,
        runId,
        reason: error,
      });
      break;
    }

    // preflight passed — from here the run is live
    db.prepare("UPDATE task_runs SET preflight_status = 'passed' WHERE id = ?").run(runId);

    // ---- spawn: exactly api.md §1 ----
    const argv = [
      ...(opts.args ?? []),
      ...buildRunArgv({
        extensionPath,
        runDir,
        runId,
        model: profile.model,
        thinkingLevel: effective.thinkingLevel,
        systemPromptFile,
      }),
    ];
    // detached: the child leads its own process group (architecture 8.4
    // killpg) so a budget/timeout kill reaches pi's grandchildren (bash
    // tools etc.); stderr is piped and buffered for the crash path.
    const child = spawn(opts.piBin ?? "pi", argv, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        NOVAFLOW_RUN_CONTEXT: contextPath,
        ...(opts.env ?? {}),
      },
    });
    db.prepare("UPDATE task_runs SET pid = ? WHERE id = ?").run(child.pid ?? null, runId);

    // the daemon's steer op writes LF-framed api.md §3 frames through this
    // sink while the child is live; cleared on exit
    if (opts.control !== undefined) {
      opts.control.steer = (frame: string): void => {
        child.stdin!.write(frame + "\n");
      };
    }

    const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const pump = createPump(rawPath, redactedPath);
    let killed: "timeout" | "budget" | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let settleReapTimer: ReturnType<typeof setTimeout> | undefined;

    // Resolves when the child is fully gone — startRun never settles
    // before this, so no caller can observe a live child.
    const exited = new Promise<RawOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: RawOutcome): void => {
        if (done) return;
        done = true;
        if (opts.control !== undefined) opts.control.steer = null;
        resolve(outcome);
      };
      child.once("exit", (code) => {
        if (killed === "timeout") finish({ kind: "timeout", code });
        else if (killed === "budget") finish({ kind: "budget", code });
        // the daemon marked the abort before its group kill — operator
        // intent is terminal and outranks a settle that was not yet intaken
        else if (opts.control?.abortRequested === true) finish({ kind: "abort", code });
        else if (!pump.settled) finish({ kind: "crash", code });
        else finish({ kind: "settled", code });
      });
      child.once("error", (err) => {
        finish({ kind: "spawn-error", message: err.message });
      });
    });

    // budget breach cost, filled in when the kill is issued
    let breachCost = 0;

    // stderr capture for the 8.4 Subprocess Crashes row: buffered in
    // memory (bounded), only ever read into the REDACTED surfaces
    let stderrBuf = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
    });

    // architecture 8.4: killpg() — signal the child's whole process
    // group. ESRCH (group already gone) is fine on both signals.
    const signalGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
      if (child.pid === undefined || child.pid === null) return;
      try {
        process.kill(-child.pid, sig);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // The kill backstops run inside timer callbacks — a non-ESRCH
        // throw here is an uncaught daemon crash (re-judge finding; mirrors
        // the verify runner's swallow-and-warn).
        if (code !== "ESRCH") {
          console.warn(`[novaflow] group kill ${sig} failed (pid ${child.pid}): ${code}`);
        }
      }
    };

    /**
     * Classified kill (timeout/budget): SIGTERM the group, arm the
     * SIGKILL backstop, and CLEAR the run clock — a budget kill must
     * never be overwritten by the clock firing during its grace, and a
     * second classification must never overwrite the first.
     */
    const killChild = (reason: "timeout" | "budget"): void => {
      if (killed !== null || child.exitCode !== null) return;
      killed = reason;
      clearTimeout(timeoutTimer);
      signalGroup("SIGTERM");
      sigkillTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    };

    // the run clock: max_timeout_sec, profile baseline or task override.
    // No-op when a kill is already classified (guard inside killChild).
    const timeoutTimer = setTimeout(() => {
      killChild("timeout");
    }, effective.maxTimeoutSec * 1000);

    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        pump.onLine(line);

        // real-time budget breaker (architecture 8.4): cumulative tokens
        // vs the price table, checked on every usage-bearing frame
        const cost = costUsd(priceTable, profile.model, pump.inputTokens, pump.outputTokens);
        if (killed === null && cost > effective.maxCostUsd) {
          breachCost = cost;
          killChild("budget");
        }
        if (pump.settled && killed === null) {
          // graceful stream close on the completion signal (FR-TSK-05)
          child.stdin!.end();
          // A settled run is never killed by the run clock: intake takes
          // precedence over a lingering process. Disarm the clock and
          // arm an UNCLASSIFIED reap instead — killed stays null, so the
          // exit still resolves "settled" and the artifact is intaken;
          // the group reap ends a process that refuses to die on stdin
          // EOF.
          clearTimeout(timeoutTimer);
          if (settleReapTimer === undefined) {
            settleReapTimer = setTimeout(() => {
              if (child.exitCode !== null) return;
              signalGroup("SIGTERM");
              sigkillTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
            }, killGraceMs);
          }
        }
      }
    });

    // EPIPE after an early child death surfaces through exit/error above.
    child.stdin!.on("error", () => {});
    // api.md §3: the task prompt goes over stdin, LF-framed.
    child.stdin!.write(
      JSON.stringify({ id: `cmd_${ulid()}`, type: "prompt", message: prompt.message }) + "\n",
    );

    // resolves when every buffered stdout byte has been delivered — the
    // counters and log files are complete before any DB finalization
    const stdoutClosed = new Promise<void>((r) => child.stdout!.once("close", () => r()));

    const outcome = await exited;
    // The GROUP backstops stay armed through their grace windows: process
    // groups outlive their leader, and a grandchild can ignore SIGTERM —
    // clearing here (on leader exit) is exactly how a lingering grandchild
    // escapes architecture 8.4's killpg escalation (re-judge finding).
    // signalGroup tolerates ESRCH, so a late SIGKILL on a dead group is a
    // no-op. The run clock stops here; the kill escalations do not.
    clearTimeout(timeoutTimer);
    if (outcome.kind !== "spawn-error") {
      // A grandchild that inherited the pipe fd can keep stdout open
      // forever — bound the wait and continue without the close event;
      // the pump already holds every buffered byte.
      let stdoutFallback: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stdoutClosed,
        new Promise<void>((resolve) => {
          stdoutFallback = setTimeout(() => resolve(), killGraceMs);
          stdoutFallback.unref?.();
        }),
      ]);
      if (stdoutFallback !== undefined) clearTimeout(stdoutFallback);
    }
    pump.flushPartial(buf); // a trailing partial line still belongs in the raw file

    const cost = costUsd(priceTable, profile.model, pump.inputTokens, pump.outputTokens);

    if (outcome.kind === "spawn-error" || outcome.kind === "crash") {
      // crash path: run failed with exit_code; same matrix row either way
      // 8.4 Subprocess Crashes: capture stderr and record the failure
      // state — one engine frame in events.jsonl (the REDACTED read
      // surface only, never the raw file), the scrubbed tail (last ~2 KB)
      // in the run's error_summary.
      const stderrTail = redactText(stderrBuf.slice(-2048));
      pump.appendEngineLine(
        JSON.stringify({
          type: "novaflow_run_failure",
          reason: outcome.kind === "crash" ? "crash" : "spawn",
          exit: outcome.kind === "crash" ? outcome.code : null,
          stderr_tail: stderrTail,
        }),
      );
      const error =
        outcome.kind === "spawn-error"
          ? `spawn failed: ${outcome.message}`
          : `subprocess exited before agent_settled (exit=${outcome.code ?? "null"})` +
            (stderrTail !== "" ? `\nstderr tail: ${stderrTail}` : "");
      finalizeRunRecord(db, runId, {
        status: "failed",
        preflightStatus: "passed",
        inputTokens: pump.inputTokens,
        outputTokens: pump.outputTokens,
        costUsd: cost,
        exitCode: outcome.kind === "spawn-error" ? null : outcome.code,
        artifactPath: null,
        errorSummary: withPricesNote(error),
        startedWall,
      });
      applyTransition(db, taskId, RUN_FAILED_TRIGGER, {
        triggerType: "engine",
        actor,
        runId,
        reason: error,
      });
      break;
    }

    if (outcome.kind === "timeout" || outcome.kind === "budget") {
      // the spec's kill escalation: SIGTERM → 3 s grace → SIGKILL
      const timedOut = outcome.kind === "timeout";
      const error = timedOut
        ? `timeout: exceeded max_timeout_sec ${effective.maxTimeoutSec}s (SIGTERM -> SIGKILL)`
        : `budget_exceeded: cost $${breachCost.toFixed(6)} > max_cost_usd $${effective.maxCostUsd} (SIGTERM -> SIGKILL)`;
      finalizeRunRecord(db, runId, {
        status: timedOut ? "timed_out" : "failed",
        preflightStatus: "passed",
        inputTokens: pump.inputTokens,
        outputTokens: pump.outputTokens,
        costUsd: cost,
        exitCode: outcome.code,
        artifactPath: null,
        errorSummary: withPricesNote(error),
        startedWall,
      });
      applyTransition(db, taskId, RUN_FAILED_TRIGGER, {
        triggerType: timedOut ? "timeout" : "engine",
        actor,
        runId,
        reason: error,
      });
      break;
    }

    // ---- operator abort: the daemon marked the run and performed the
    // group kill (abort_bash -> SIGTERM -> 3 s grace -> SIGKILL); the
    // loop owns the run record AND the running→cancelled row, so every
    // write stays on the guarded path ----
    if (outcome.kind === "abort") {
      const error = "operator abort (abort_bash -> SIGTERM -> SIGKILL)";
      finalizeRunRecord(db, runId, {
        status: "cancelled",
        preflightStatus: "passed",
        inputTokens: pump.inputTokens,
        outputTokens: pump.outputTokens,
        costUsd: cost,
        exitCode: outcome.code,
        artifactPath: null,
        errorSummary: withPricesNote(error),
        startedWall,
      });
      applyTransition(db, taskId, ABORT_TRIGGER, {
        triggerType: opts.control?.abortTriggerType ?? "human",
        actor: opts.control?.abortActor ?? "operator",
        runId,
        reason: error,
      });
      break;
    }

    // ---- settled (FR-TSK-05): artifact intake via the SHARED module
    // (src/runs/settle-replay.ts) — the daemon's boot crash recovery
    // (§8.4) feeds the same intake; never a reimplementation ----
    const intake = intakeSettledRun({
      db,
      taskId,
      runId,
      requiresHumanGate: task.requires_human_gate === 1,
      runDir,
      model: profile.model,
      priceTable,
      exitCode: outcome.code,
      inputTokens: pump.inputTokens,
      outputTokens: pump.outputTokens,
      startedWall,
      pricesNote: withPricesNote,
      actor,
    });
    if (intake.ok) break;

    // missing or schema-invalid artifact → FR-TSK-06 repair (max 1)
    const error = intake.error;

    if (attemptKind === "execution") {
      // repair budget remains: running → running, new run with the
      // repair prompt (the feedback rides the prompt, FR-TSK-06)
      applyTransition(db, taskId, REPAIR_TRIGGER, {
        triggerType: "engine",
        actor,
        runId,
        reason: error,
      });
      attemptKind = "repair";
      repairFeedback = error;
      continue;
    }

    // repair also failed → the row whose trigger covers invalid JSON
    applyTransition(db, taskId, RUN_FAILED_TRIGGER, {
      triggerType: "engine",
      actor,
      runId,
      reason: error,
    });
    break;
  }

  const runs = db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number")
    .all(taskId) as TaskRunRecord[];
  const finalState = (
    db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }
  ).state;
  return { taskId, finalState, runs };
}
