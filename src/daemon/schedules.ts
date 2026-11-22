import type { Db } from "../store/db.ts";
import { enqueueTask } from "../tasks.ts";
import { nextRun } from "../sched/cron.ts";
import { canonicalTimestamp } from "../sched/iso.ts";

/**
 * The schedule evaluator (FR-SCH-01 AC2 / FR-SCH-03): every enabled
 * schedule whose next_run_at is due fires the task's transition to
 * QUEUED through `enqueueTask` — the ONE draft→queued row of
 * architecture 8.1, with the log's `trigger_type` recording
 * `schedule` and the actor `scheduler` (the catalog probe and the
 * guarded write happen inside enqueueTask, never here).
 *
 * The evaluation point is the dispatcher's periodic tick (single
 * timer, same pause): a paused daemon freezes schedule evaluation
 * exactly like it freezes new spawns, and a pass is single-flight —
 * it can never overlap itself even while a fire's catalog probe is
 * in flight.
 *
 * Time discipline: one `now` per pass (never Date.now() twice inside
 * one evaluation); ALL schedule math is UTC and the store's timestamp
 * strings are the DDL's canonical form (canonicalTimestamp).
 *
 * Documented rulings (spec-silent; the matrix is the arbiter):
 *   - FIRE: only a DRAFT task transitions. A task in any other state
 *     (queued/running/terminal) means the schedule ADVANCES its own
 *     next_run_at (and records last_run_at — its occurrence was
 *     consumed) but forces NO transition: a schedule is a transition
 *     trigger, not an enqueuer of duplicates.
 *   - A fire whose enqueue is refused (catalog probe unresolved,
 *     another surface moved the task mid-probe, a task with no
 *     target_scopes — DEBT-010, or the like) is logged and ADVANCES —
 *     never wedged, never a hot re-probe loop.
 *   - A dangling target_id row (DDL tolerance: no FK) is skipped with
 *     a logged note and advanced — the evaluator never wedges on a
 *     dead reference.
 *   - The workspace gate is NEVER bypassed: firing a task in a
 *     non-active workspace skips + advances (mirrors dispatch's
 *     candidate gate, FR-WS-03).
 *   - Missed-run precedence (FR-SCH-03 AC2, boot recovery): a
 *     schedule whose next_run_at is already in the past at boot
 *     applies its missed_policy — `skip` advances without firing
 *     (last_run_at untouched: the run never happened); a one-shot
 *     expired under either policy carries next_run_at NULL.
 */

export type ScheduleRow = {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  cron_expr: string | null;
  run_at: string | null;
  timezone: string;
  missed_policy: "skip" | "run_immediately";
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
};

export type ScheduleEvaluatorOptions = {
  /** Catalog-probe injection threaded into enqueueTask (tests stub it). */
  enqueueOptions?: { piBin?: string; args?: string[]; timeoutMs?: number } | undefined;
  /** Dispatch hook: a fired task re-queued — request a scheduler pass. */
  onEnqueued?: ((taskId: string) => void) | undefined;
  /** Audit-log actor for the enqueue transitions (default "scheduler"). */
  actor?: string | undefined;
};

type TaskGateRow = {
  state: string;
  ws_status: string;
  ws_slug: string;
} | undefined;

function warn(message: string): void {
  console.warn(`[novaflow-schedules] ${message}`);
}

/**
 * The schedule's next occurrence AFTER fromMs: a cron steps by
 * nextRun; a one-shot has exactly one moment (its stored run_at,
 * already canonical) — and it counts only while that moment is still
 * ahead (a one-shot consumed or skipped by the evaluator is past by
 * definition, so it advances to NULL and is never re-selected).
 * The attach op is the one caller that stores a one-shot's moment
 * unconditionally (its creation, even if already past — it fires at
 * the next evaluation pass).
 */
export function nextOccurrenceAt(row: Pick<ScheduleRow, "cron_expr" | "run_at">, fromMs: number): number | null {
  if (row.cron_expr !== null) return nextRun(row.cron_expr, fromMs);
  const ms = row.run_at !== null ? Date.parse(row.run_at) : NaN;
  return Number.isFinite(ms) && ms > fromMs ? ms : null;
}

/**
 * Advance a schedule's own next_run_at WITHOUT recording a run (the
 * occurrence was skipped: missed-run `skip`, a dangling target, a
 * non-active workspace).
 */
function advanceSkipping(db: Db, row: ScheduleRow, nowMs: number): void {
  const next = nextOccurrenceAt(row, nowMs);
  db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
    next === null ? null : canonicalTimestamp(next),
    row.id,
  );
}

/**
 * Advance a schedule after its occurrence was consumed (fired, or
 * consumed by a non-draft target): last_run_at records the moment.
 */
function advanceAfterFire(db: Db, row: ScheduleRow, nowMs: number): void {
  const next = nextOccurrenceAt(row, nowMs);
  db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(
    canonicalTimestamp(nowMs),
    next === null ? null : canonicalTimestamp(next),
    row.id,
  );
}

export function createScheduleEvaluator(db: Db, opts: ScheduleEvaluatorOptions) {
  const actor = opts.actor ?? "scheduler";
  /** Single-flight: a pass never overlaps itself (a fire probes a subprocess). */
  let inFlight = false;
  /** The running pass (a shutdown awaits it, bounded — see stop()). */
  let inFlightPromise: Promise<void> | undefined;

  /**
   * Quarantine a row that blew up its own pass (e.g. an out-of-band DB edit
   * wrote an unparsable cron_expr): warn + disable so one corrupt row can
   * never crash a live daemon at every tick. The quarantine write itself is
   * best-effort — a closed store during shutdown must not re-throw.
   */
  function quarantine(row: ScheduleRow, err: unknown): void {
    warn(
      `schedule ${row.id}: evaluation failed (${(err as Error).message}) — quarantining the row (enabled=0, next_run_at NULL)`,
    );
    try {
      db.prepare("UPDATE schedules SET enabled = 0, next_run_at = NULL WHERE id = ?").run(row.id);
    } catch {
      // the store is closing/closed — nothing more to persist
    }
  }

  function dueRows(nowMs: number, strictlyPast: boolean): ScheduleRow[] {
    const cmp = strictlyPast ? "<" : "<=";
    return db
      .prepare(
        `SELECT * FROM schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at ${cmp} ?
          ORDER BY next_run_at, id`,
      )
      .all(canonicalTimestamp(nowMs)) as ScheduleRow[];
  }

  /** The task-side fire gate: state + workspace status (FR-WS-03). */
  function taskGate(taskId: string): TaskGateRow {
    return db
      .prepare(
        `SELECT t.state AS state, w.status AS ws_status, w.slug AS ws_slug
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN workspaces w ON w.id = p.workspace_id
          WHERE t.id = ?`,
      )
      .get(taskId) as TaskGateRow;
  }

  /**
   * FIRE (or skip) one due schedule: draft + active workspace →
   * enqueueTask (trigger_type 'schedule'); every refusal path advances
   * so the evaluator never re-picks the row.
   */
  async function fireIfEligible(row: ScheduleRow, nowMs: number): Promise<"fired" | "skipped" | "advanced"> {
    const task = taskGate(row.target_id);
    if (task === undefined) {
      warn(
        `schedule ${row.id}: target task ${row.target_id} no longer exists (dangling row) — skipping and advancing`,
      );
      advanceSkipping(db, row, nowMs);
      return "skipped";
    }
    if (task.ws_status !== "active") {
      warn(
        `schedule ${row.id}: task ${row.target_id} is in workspace "${task.ws_slug}" (${task.ws_status}) — the workspace gate (FR-WS-03) refuses execution; skipping and advancing`,
      );
      advanceSkipping(db, row, nowMs);
      return "skipped";
    }
    if (task.state !== "draft") {
      warn(
        `schedule ${row.id}: task ${row.target_id} is ${task.state}, not draft — the schedule advances without forcing a transition (the matrix is the arbiter)`,
      );
      advanceAfterFire(db, row, nowMs);
      return "advanced";
    }
    try {
      await enqueueTask(db, row.target_id, actor, {
        triggerType: "schedule",
        ...(opts.enqueueOptions?.piBin !== undefined ? { piBin: opts.enqueueOptions.piBin } : {}),
        ...(opts.enqueueOptions?.args !== undefined ? { args: opts.enqueueOptions.args } : {}),
        ...(opts.enqueueOptions?.timeoutMs !== undefined ? { timeoutMs: opts.enqueueOptions.timeoutMs } : {}),
      });
    } catch (err) {
      // a refused enqueue (unresolved profile, a task with no
      // target_scopes — DEBT-010, a concurrent surface moved the task
      // mid-probe) is logged and ADVANCES — never a re-probe hot loop,
      // never a wedge
      warn(`schedule ${row.id}: enqueue of task ${row.target_id} refused — ${(err as Error).message}; skipping (the run never happened) and advancing`);
      // last_run_at stays untouched — consistent with every other refusal
      // path (review finding: a refused occurrence must not claim a run)
      advanceSkipping(db, row, nowMs);
      return "skipped";
    }
    advanceAfterFire(db, row, nowMs);
    opts.onEnqueued?.(row.target_id);
    return "fired";
  }

  /**
   * One evaluation pass over every due enabled schedule (called from
   * the dispatcher's periodic tick; a paused daemon never calls it).
   * Single-flight; one `now` per pass.
   */
  async function evaluate(nowMs: number = Date.now()): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const pass = (async () => {
      for (const row of dueRows(nowMs, false)) {
        try {
          await fireIfEligible(row, nowMs);
        } catch (err) {
          quarantine(row, err);
        }
      }
    })();
    inFlightPromise = pass;
    try {
      await pass;
    } catch (err) {
      // belt under the per-row quarantine: a pass never rejects
      warn(`schedule pass failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
      inFlightPromise = undefined;
    }
  }

  /**
   * Boot recovery (FR-SCH-03 AC2): every enabled schedule whose
   * next_run_at expired during downtime applies its missed_policy —
   * `skip` advances to the next future occurrence (the run never
   * happened: last_run_at untouched); `run_immediately` fires EXACTLY
   * ONCE now (then advances — a cron to its next occurrence, a
   * one-shot to NULL). Runs BEFORE the dispatcher's first tick can
   * fire a missed schedule without its policy.
   */
  async function bootScan(nowMs: number = Date.now()): Promise<{ fired: number; skipped: number }> {
    let fired = 0;
    let skipped = 0;
    if (inFlight) return { fired, skipped };
    inFlight = true;
    try {
      for (const row of dueRows(nowMs, true)) {
        try {
          if (row.missed_policy === "run_immediately") {
            const outcome = await fireIfEligible(row, nowMs);
            if (outcome === "fired") fired += 1;
          } else {
            advanceSkipping(db, row, nowMs);
            skipped += 1;
          }
        } catch (err) {
          quarantine(row, err);
        }
      }
    } finally {
      inFlight = false;
    }
    return { fired, skipped };
  }

  /**
   * Await the in-flight pass, bounded: a fire's catalog probe is itself
   * timeout-bounded, so the wait is bounded by that plus a grace (the
   * review round's shutdown race: db.close() must not land inside a
   * fire's continuation).
   *
   * Best-effort bound (re-judge note): it assumes the common single-due-row
   * fire. A pass that serially probes N hanging rows can exceed it — the
   * belt catch + quarantine keep that safe (no crash), straggler rows stay
   * unadvanced and are absorbed at the next boot by their missed_policy.
   */
  async function stop(): Promise<void> {
    const probeBound = (opts.enqueueOptions?.timeoutMs ?? 5000) + 1500;
    await Promise.race([
      inFlightPromise ?? Promise.resolve(),
      new Promise<void>((r) => {
        const t = setTimeout(r, probeBound);
        t.unref?.();
      }),
    ]);
  }

  return { evaluate, bootScan, stop };
}

export type ScheduleEvaluator = ReturnType<typeof createScheduleEvaluator>;
