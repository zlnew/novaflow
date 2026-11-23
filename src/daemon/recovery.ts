import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db.ts";
import { applyTransition, InvalidTransitionError } from "../fsm/engine.ts";
import { RUN_FAILED_TRIGGER } from "../runs/triggers.ts";
import { createFrameTally } from "../runs/pump.ts";
import { finalizeRunRecord, intakeSettledRun } from "../runs/settle-replay.ts";
import {
  costUsdTokens,
  defaultPricesPath,
  inertPricesNote,
  loadPricesDetailed,
  type PriceTable,
} from "../runs/prices.ts";
import {
  fireHalt,
  taskHaltNotifier,
  type HaltNotifier,
  type NotifyOptions,
  type NotifyResult,
} from "../notify.ts";

/**
 * Boot crash recovery per novaflow-v1/architecture 8.4 ("Daemon Crash
 * Recovery" row): on initialization, reconcile every task_runs row still
 * marked running (an orphan after a crash) by inspecting the
 * filesystem:
 *   - `agent_settled` present in the run dir's events.raw.jsonl →
 *     REPLAY the settlement through the SAME intake the live loop uses
 *     (src/runs/settle-replay.ts) — never a reimplementation. The replay
 *     re-tallies the raw stream with the pump's own frame logic
 *     (createFrameTally) and produces the same run-record updates and
 *     transitions as the live path (validating / awaiting_gate /
 *     failed-with-reason).
 *   - no `agent_settled` → mark the run crashed: task_runs.status
 *     'failed' with the crash detail in error_summary, task state
 *     UNCHANGED (the fallback table's INTERRUPTED row), plus a halt
 *     notify.
 *
 * Spec-silent choices (documented, minimal-convention readings):
 *   - exit_code on a recovered run is null: the daemon never observed
 *     the process's exit — the same convention as the spawn-error path.
 *   - a settled orphan whose artifact is missing/invalid fails via the
 *     running→failed row: a crashed daemon cannot RESUME the FR-TSK-06
 *     repair loop mid-flight (a repair needs a new spawn), so the
 *     intake failure lands on the failure row and the retry evaluator
 *     picks the task up from `failed`.
 *   - duration/cost are attributed from the orphan row's started_at and
 *     the raw-stream tally, so the recovered record matches the live
 *     path's fields the daemon could still observe.
 *   - preflight_status is preserved when it was already 'passed'; a
 *     row still 'pending' (crash between row insert and the preflight
 *     update) is finalized 'failed' — preflight never completed.
 *   - known edge (out of the 8.4 row's scope, left to the row's rule):
 *     a crash in the microsecond window between run-row finalization
 *     ('succeeded') and the settle transition would leave the task in
 *     running with no 'running' row — §8.4 reconciles by scanning
 *     status='running' rows, so that window is not re-derived here.
 */

export type RecoveryOptions = {
  /** Price table path; default ~/.novaflow/prices.json (data.md 4.4). */
  pricesPath?: string | undefined;
  /** Injected halt notifier (tests); default: workspace-config topic. */
  notify?: HaltNotifier | undefined;
  /** Transport injection for the DEFAULT (config-wired) notifier. */
  notifyOptions?: NotifyOptions | undefined;
};

export type RecoveryReport = {
  /** Settled orphans whose settlement was replayed end to end. */
  replayed: Array<{ taskId: string; runId: string; target: string }>;
  /** Settled orphans whose intake failed → running→failed applied. */
  failedIntake: Array<{ taskId: string; runId: string; reason: string }>;
  /** Unsettled orphans marked crashed (task state unchanged). */
  crashed: Array<{ taskId: string; runId: string }>;
};

type OrphanRow = {
  id: string;
  task_id: string;
  profile_id: string | null;
  pi_session_dir: string;
  status: string;
  preflight_status: string;
  model_used: string;
  started_at: string;
};

type TaskInfo = {
  state: string;
  requires_human_gate: number;
};

function notifierFor(db: Db, taskId: string, opts: RecoveryOptions): HaltNotifier | null {
  if (opts.notify !== undefined) return opts.notify;
  return taskHaltNotifier(db, taskId, opts.notifyOptions ?? {});
}

function withPricesNoteFactory(
  source: "file" | "missing" | "invalid",
  maxCostUsd: number,
  pricesPath: string,
): (summary: string | null) => string | null {
  return (summary: string | null): string | null => {
    if (source !== "file" && maxCostUsd > 0) {
      return summary === null
        ? inertPricesNote(source, pricesPath)
        : summary + "\n" + inertPricesNote(source, pricesPath);
    }
    return summary;
  };
}

/**
 * Reconcile every orphaned run. Runs BEFORE dispatch starts (the boot
 * sequence in src/daemon/lifecycle.ts). Never throws on a single bad
 * orphan — each row is reconciled independently; a guard failure (the
 * task already moved, e.g. a second stale 'running' row) is logged and
 * the row is marked crashed so boot cannot wedge.
 */
export function recoverOrphanedRuns(db: Db, opts: RecoveryOptions = {}): RecoveryReport {
  const report: RecoveryReport = { replayed: [], failedIntake: [], crashed: [] };

  const pricesPath = opts.pricesPath ?? defaultPricesPath();
  const priceLoad = loadPricesDetailed(pricesPath);
  const priceTable: PriceTable = priceLoad.table;
  const notify: Array<Promise<NotifyResult>> = [];

  const orphans = db
    .prepare(
      `SELECT id, task_id, profile_id, pi_session_dir, status, preflight_status,
              model_used, started_at
         FROM task_runs
        WHERE status = 'running'
        ORDER BY task_id, attempt_number`,
    )
    .all() as OrphanRow[];

  for (const row of orphans) {
    const task = db
      .prepare("SELECT state, requires_human_gate FROM tasks WHERE id = ?")
      .get(row.task_id) as TaskInfo | undefined;
    if (!task) continue; // FK-guaranteed to exist; defensive only

    // re-tally the orphan's raw stream with the live pump's own frame logic
    const rawPath = join(row.pi_session_dir, "events.raw.jsonl");
    const tally = createFrameTally();
    if (existsSync(rawPath)) {
      const text = readFileSync(rawPath, "utf8");
      for (const line of text.split("\n")) {
        if (line !== "") tally.observe(line);
      }
    }

    // prices-inert note convention, from the run's profile snapshot
    const profileMaxCost = row.profile_id
      ? (
          db
            .prepare("SELECT max_cost_usd FROM agent_profiles WHERE id = ?")
            .get(row.profile_id) as { max_cost_usd: number } | undefined
        )?.max_cost_usd ?? 0
      : 0;
    const pricesNote = withPricesNoteFactory(priceLoad.source, profileMaxCost, pricesPath);
    const parsedWall = Date.parse(row.started_at);
    const wall = Number.isFinite(parsedWall) ? parsedWall : Date.now();
    const crashNotify = notifierFor(db, row.task_id, opts);

    try {
      if (tally.settled) {
        const intake = intakeSettledRun({
          db,
          taskId: row.task_id,
          runId: row.id,
          requiresHumanGate: task.requires_human_gate === 1,
          runDir: row.pi_session_dir,
          model: row.model_used,
          priceTable,
          exitCode: null, // unobserved: the process died with the daemon
          inputTokens: tally.inputTokens,
          outputTokens: tally.outputTokens,
          cacheReadTokens: tally.cacheReadTokens,
          cacheWriteTokens: tally.cacheWriteTokens,
          startedWall: wall,
          pricesNote,
          actor: "daemon-recovery",
        });
        if (intake.ok) {
          report.replayed.push({ taskId: row.task_id, runId: row.id, target: intake.target });
        } else {
          // the repair loop cannot resume mid-flight — running→failed
          applyTransition(db, row.task_id, RUN_FAILED_TRIGGER, {
            triggerType: "engine",
            actor: "daemon-recovery",
            runId: row.id,
            reason: intake.error,
          });
          report.failedIntake.push({ taskId: row.task_id, runId: row.id, reason: intake.error });
        }
        continue;
      }

      // §8.4: no agent_settled → the run crashed, the TASK STATE STAYS
      finalizeRunRecord(db, row.id, {
        status: "failed",
        preflightStatus: row.preflight_status === "passed" ? "passed" : "failed",
        inputTokens: tally.inputTokens,
        outputTokens: tally.outputTokens,
        cacheReadTokens: tally.cacheReadTokens,
        cacheWriteTokens: tally.cacheWriteTokens,
        costUsd: costUsdTokens(priceTable, row.model_used, {
          input: tally.inputTokens,
          cacheRead: tally.cacheReadTokens,
          cacheWrite: tally.cacheWriteTokens,
          output: tally.outputTokens,
        }),
        exitCode: null,
        artifactPath: null,
        errorSummary: pricesNote(
          "crashed: daemon died mid-run — no agent_settled in events.raw.jsonl " +
            "(architecture 8.4 boot recovery; task state unchanged)",
        ),
        startedWall: wall,
      });
      report.crashed.push({ taskId: row.task_id, runId: row.id });
      if (crashNotify !== null) {
        notify.push(
          fireHalt(crashNotify, {
            title: "NovaFlow run crashed",
            message: `run ${row.id} of task ${row.task_id} was orphaned by a daemon crash and marked failed (task state unchanged)`,
          }),
        );
      }
    } catch (err) {
      // a stale second 'running' row (state already moved) or any guard
      // refusal — mark the row crashed so boot never wedges on it
      if (err instanceof InvalidTransitionError) {
        finalizeRunRecord(db, row.id, {
          status: "failed",
          // the same preserve rule as the main crashed path: a row still
          // 'pending' (crash between row insert and the preflight update)
          // is finalized 'failed' — preflight never completed
          preflightStatus: row.preflight_status === "passed" ? "passed" : "failed",
          inputTokens: tally.inputTokens,
          outputTokens: tally.outputTokens,
          cacheReadTokens: tally.cacheReadTokens,
          cacheWriteTokens: tally.cacheWriteTokens,
          costUsd: 0,
          exitCode: null,
          artifactPath: null,
          errorSummary: `crashed: boot recovery could not reconcile this orphan (${err.message}); task state untouched`,
          startedWall: wall,
        });
        report.crashed.push({ taskId: row.task_id, runId: row.id });
        continue;
      }
      throw err;
    }
  }
  return report;
}
