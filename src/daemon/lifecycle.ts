import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../store/db.ts";
import { migrate } from "../store/migrate.ts";
import {
  defaultDaemonConfigPath,
  loadDaemonConfig,
  type DaemonConfig,
} from "../daemonconfig.ts";
import { recoverOrphanedRuns, type RecoveryReport } from "./recovery.ts";
import { createDispatcher, type DispatchStatus } from "./dispatch.ts";
import { createRetryEvaluator, type RetryEvaluator } from "./retry.ts";
import { createScheduleEvaluator, type ScheduleEvaluator } from "./schedules.ts";
import { bindControlServer, type ControlServer } from "./server.ts";
import { runVerification } from "../verify/runner.ts";
import { verifyProtectedAndScope } from "../verify/protected.ts";
import { annotateRunVerification } from "../verify/artifact-annotate.ts";
import { completeValidation } from "../validating.ts";
import type { RunOptions, RunOutcome } from "../runs/loop.ts";
import type { NotifyOptions } from "../notify.ts";

/**
 * startDaemon — the boot sequence (architecture 8.4: recovery BEFORE
 * dispatch; 8.1: the socket is the only control surface):
 *
 *   1. open the store (openDb + migrate — the block-on-contract-mismatch
 *      rule lives in migrate);
 *   2. load the daemon config (~/.novaflow/config.yaml; a missing file
 *      is defaults, a BROKEN file refuses the boot — the concurrency
 *      and retry semantics it governs must never run on guesses);
 *   3. boot crash recovery (§8.4): reconcile every orphaned run;
 *   4. the retry evaluator's boot scan (spent budgets escalate,
 *      elapsed delays requeue — requeues dispatch because the
 *      dispatcher already exists);
 *   4b. the schedule evaluator's missed-run boot scan (FR-SCH-03 AC2:
 *      skip advances, run_immediately fires exactly once) — BEFORE
 *      the first dispatch tick can fire a missed schedule without
 *      its policy;
 *   5. the dispatch loop (FIFO semaphores) and the JSONL socket.
 *
 * stop() rule (documented): the daemon is the single owner of every
 * run process, so a shutdown REAPS the live runs via the operator-abort
 * path (SIGTERM → grace → SIGKILL, run rows 'cancelled', tasks
 * 'cancelled' by the loop's guarded row), awaits their conclusion,
 * unlinks the socket, clears every timer, and closes the store. No
 * spawned process, socket file, or timer outlives the handle.
 */

export type StartDaemonOptions = {
  /** SQLite database file path (opened + migrated here). */
  dbPath: string;
  /** Override ~/.novaflow/novaflow.sock (tests). */
  socketPath?: string | undefined;
  /** Override ~/.novaflow/config.yaml (tests). */
  daemonConfigPath?: string | undefined;
  /** Catalog-probe injection for nova_task_run (tests point at the stub). */
  probePiBin?: string | undefined;
  probeArgs?: string[] | undefined;
  probeTimeoutMs?: number | undefined;
  /** Run injection for dispatch-granted startRun calls (tests). */
  runPiBin?: string | undefined;
  runArgs?: string[] | undefined;
  extensionPath?: string | undefined;
  pricesPath?: string | undefined;
  killGraceMs?: number | undefined;
  /** Dispatch periodic tick (tests). */
  tickMs?: number | undefined;
  /** Notify transport injection (tests). */
  notifyOptions?: NotifyOptions | undefined;
};

export type DaemonStatus = {
  version: string;
  started_at: string;
  uptime_sec: number;
  scheduler: DispatchStatus;
  recovery: { replayed: number; failedIntake: number; crashed: number };
  budgets: {
    daily_usd: number | null;
    monthly_usd: number | null;
    spend_today_usd: number;
    spend_month_usd: number;
  };
};

export type DaemonHandle = {
  socketPath: string;
  dbPath: string;
  /** Graceful stop — see the header's documented rule. */
  stop: () => Promise<void>;
  status: () => DaemonStatus;
};

/** The version from package.json (read from disk; no JSON import step in v1). */
function readVersion(): string {
  try {
    return String(
      (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string })
        .version,
    );
  } catch {
    return "0.0.0";
  }
}

function warn(message: string): void {
  console.warn(`[novaflow-daemon] ${message}`);
}

/** Global spend since the current UTC day/month start (spec-silent: UTC boundaries). */
function globalSpend(db: Db): { today: number; month: number } {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const q = (since: Date): number =>
    (
      db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM task_runs WHERE started_at >= ?").get(
        since.toISOString(),
      ) as { s: number }
    ).s;
  return { today: q(dayStart), month: q(monthStart) };
}

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const db = openDb(opts.dbPath);
  let server: ControlServer | undefined;
  let dispatcherRef: ReturnType<typeof createDispatcher> | undefined;
  let retryRef: RetryEvaluator | undefined;
  let stopped = false;
  try {
    migrate(db);

    const configLoad = loadDaemonConfig(opts.daemonConfigPath ?? defaultDaemonConfigPath());
    if (!configLoad.ok) {
      throw new Error(`daemon config invalid, refusing to boot: ${configLoad.error}`);
    }
    const daemonConfig: DaemonConfig = configLoad.config;

    // §8.4: recovery reconciles orphans BEFORE any dispatch starts
    const recovery: RecoveryReport = recoverOrphanedRuns(db, {
      ...(opts.pricesPath !== undefined ? { pricesPath: opts.pricesPath } : {}),
      ...(opts.notifyOptions !== undefined ? { notifyOptions: opts.notifyOptions } : {}),
    });

    const runOptions: Omit<RunOptions, "control"> = {
      ...(opts.runPiBin !== undefined ? { piBin: opts.runPiBin } : {}),
      ...(opts.runArgs !== undefined ? { args: opts.runArgs } : {}),
      ...(opts.extensionPath !== undefined ? { extensionPath: opts.extensionPath } : {}),
      ...(opts.pricesPath !== undefined ? { pricesPath: opts.pricesPath } : {}),
      ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
      // FR-TSK-10 AC4: the daemon's global budgets apply when a
      // workspace defines none (documented precedence)
      globalBudgets: daemonConfig.budgets,
    };

    const startedAt = Date.now();
    const version = readVersion();

    // retry first (its onRequeue closure late-binds the dispatcher),
    // then the dispatcher (its boot pass is the first admission check),
    // then the boot scan — an elapsed delay requeues INTO a live
    // dispatcher instead of being lost
    const retry: RetryEvaluator = createRetryEvaluator(db, {
      delaySec: daemonConfig.retry.delaySec,
      ...(opts.notifyOptions !== undefined ? { notifyOptions: opts.notifyOptions } : {}),
      onRequeue: (taskId: string) => {
        dispatcherRef?.requestDispatch();
      },
      actor: "daemon-retry",
    });
    // the boot-failure catch below stops everything it started — the
    // evaluator MUST be registered the moment it exists (regression:
    // an unregistered evaluator left its bootScan-armed timer alive
    // past a refused boot, firing on the closed store)
    retryRef = retry;

    // FR-TSK-12 auto-verification wiring. THE SEAM: dispatch's
    // run-conclusion hook — i.e. AFTER startRun has fully resolved
    // (task settled into validating, child reaped), never inside the
    // startRun call path, so the verification spawns can never recurse
    // into dispatch. Scope (documented): the run-settle outcome only;
    // a gate-APPROVED validating task is left to the operator/scheduler
    // surfaces, and boot-recovery replays stay in validating (recovery
    // owns §8.4 reconciliation, not new engine verdicts).
    const verificationInFlight = new Set<Promise<void>>();
    const settleVerification = (taskId: string, outcome: RunOutcome): void => {
      const run = outcome.runs[outcome.runs.length - 1]!; // the settled attempt
      const job = (async (): Promise<void> => {
        try {
          const verify = await runVerification(db, taskId);
          const protectedCheck = await verifyProtectedAndScope(db, taskId, run.pi_session_dir);
          annotateRunVerification(db, run.id, verify, protectedCheck);
          const passed =
            verify.passed &&
            protectedCheck.protectedFilesUntouched &&
            protectedCheck.scopeCreepPaths.length === 0 &&
            !protectedCheck.scopeCheckInconclusive;
          const summary = passed
            ? `engine verification passed (${verify.results.length} command${
                verify.results.length === 1 ? "" : "s"
              })`
            : [
                verify.collectionError !== null
                  ? `verification command collection failed: ${verify.collectionError}`
                  : null,
                ...verify.results
                  .filter((r) => !r.passed)
                  .map((r) => `command "${r.command}" failed (exit ${r.exitCode ?? "none"})`),
                ...protectedCheck.scopeCreepPaths.map((p) => `scope creep: ${p}`),
                ...protectedCheck.notes,
              ]
                .filter((s): s is string => s !== null)
                .join("; ") || "engine verification failed";
          const validation = completeValidation(
            db,
            taskId,
            passed ? { passed, summary } : { passed, summary },
            "daemon-verify",
            ...(opts.notifyOptions !== undefined ? [{ notifyOptions: opts.notifyOptions }] : []),
          );
          // the failure-entry hook fires naturally: a failed verdict
          // reaches the retry/escalation evaluator exactly like a run
          // failure (which the dispatch hook already routes)
          if (validation.finalState === "failed") retry.evaluate(taskId);
        } catch (err) {
          // never-crash: a guard refusal (the task moved meanwhile —
          // operator abort, gate op) or a store closing mid-verification
          // is logged, and the task stays where the other surface put it
          warn(`auto-verification of task ${taskId} did not complete: ${(err as Error).message}`);
        }
      })();
      verificationInFlight.add(job);
      void job.finally(() => verificationInFlight.delete(job));
    };

    // the schedule evaluator (FR-SCH-01/03): every fire goes through
    // enqueueTask — the ONE draft→queued row, trigger_type 'schedule',
    // actor 'scheduler' — and its missed-run boot scan runs before the
    // first dispatch tick. Evaluation rides the dispatcher's tick;
    // a fired enqueue requests a dispatch pass (late-bound like retry).
    const enqueueOptions = {
      ...(opts.probePiBin !== undefined ? { piBin: opts.probePiBin } : {}),
      ...(opts.probeArgs !== undefined ? { args: opts.probeArgs } : {}),
      ...(opts.probeTimeoutMs !== undefined ? { timeoutMs: opts.probeTimeoutMs } : {}),
    };
    const schedules: ScheduleEvaluator = createScheduleEvaluator(db, {
      enqueueOptions,
      onEnqueued: (taskId: string) => {
        dispatcherRef?.requestDispatch();
      },
      actor: "scheduler",
    });

    const dispatcher = createDispatcher(db, {
      globalConcurrency: daemonConfig.concurrency.global,
      runOptions,
      ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
      scheduleTick: () => {
        void schedules.evaluate();
      },
      onRunConcluded: (taskId: string, outcome) => {
        if ("finalState" in outcome && outcome.finalState === "failed") {
          retry.evaluate(taskId);
        } else if ("finalState" in outcome && outcome.finalState === "validating") {
          // FR-TSK-12: a settled validating task gets its independent
          // engine verification (see settleVerification's seam doc)
          settleVerification(taskId, outcome);
        }
      },
    });
    dispatcherRef = dispatcher;
    // FR-SCH-03 AC2 first: missed-run recovery applies each schedule's
    // policy (skip | run_immediately) BEFORE any tick can fire a
    // missed schedule unreviewed; then the retry boot scan.
    await schedules.bootScan();
    retry.bootScan(); // spent budgets escalate; elapsed delays requeue

    const daemonStatus = (): DaemonStatus => {
      const spend = globalSpend(db);
      return {
        version,
        started_at: new Date(startedAt).toISOString(),
        uptime_sec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        scheduler: dispatcher.status(),
        recovery: {
          replayed: recovery.replayed.length,
          failedIntake: recovery.failedIntake.length,
          crashed: recovery.crashed.length,
        },
        budgets: {
          daily_usd: daemonConfig.budgets.dailyUsd,
          monthly_usd: daemonConfig.budgets.monthlyUsd,
          spend_today_usd: spend.today,
          spend_month_usd: spend.month,
        },
      };
    };

    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (server !== undefined) await server.close(); // stop accepting, unlink the socket
      await dispatcher.stop(); // reap live runs (operator-abort semantics)
      retry.stop(); // clear every armed timer
      // the documented stop rule (header): no spawned process outlives
      // the handle — in-flight verification commands are awaited (their
      // own timeout/kill discipline bounds the wait)
      await Promise.allSettled([...verificationInFlight]);
      db.close();
    };

    server = await bindControlServer(
      {
        db,
        dispatcher,
        retry,
        daemonConfig,
        daemonStatus,
        requestStop: () => {
          void stop();
        },
        ...(opts.probePiBin !== undefined || opts.probeArgs !== undefined || opts.probeTimeoutMs !== undefined
          ? { enqueueOptions }
          : {}),
      },
      opts.socketPath ?? join(homedir(), ".novaflow", "novaflow.sock"),
    );

    return {
      socketPath: server.socketPath,
      dbPath: opts.dbPath,
      stop,
      status: daemonStatus,
    };
  } catch (err) {
    // never leak a half-open daemon: a failed boot stops everything it
    // started (timers, dispatcher, socket) and closes the store
    if (dispatcherRef !== undefined) await dispatcherRef.stop();
    if (retryRef !== undefined) retryRef.stop();
    if (server !== undefined) await server.close();
    db.close();
    throw err;
  }
}
