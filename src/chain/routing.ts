import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../store/db.ts";
import { enqueueTask } from "../tasks.ts";
import { isTerminalGateFailure } from "../daemon/retry.ts";
import {
  enterChangesRequested,
  escalateIfBudgetSpent,
  requeueFromChangesRequested,
} from "../validating.ts";
import { REVIEW_REENTRY_TRIGGER } from "../fsm/triggers.ts";
import { CHAIN_ENGINE_ACTOR } from "./readiness.ts";
import { listChainMembers } from "./import.ts";
import {
  taskHaltNotifier,
  type HaltNotifier,
  type NotifyOptions,
  type NotifyResult,
} from "../notify.ts";
import { novaflowDir } from "../workspaces.ts";
import { projectSummaryPath, writeProjectSummary } from "./summary.ts";

/**
 * The FEEDBACK ROUTING evaluator (architecture 8.1 feedback routing
 * rule + failure routing rule, ruled 2026-11-21 — the heart of the
 * chain design; card novaflow-impl-p4b-chain-routing).
 *
 * REVIEW PATH: a chain member that reaches `completed` whose result.json
 * carries `status: "changes_requested"` is a review occurrence. Every
 * task named as the `target_key` of an `on_changes_requested` edge
 * from the emitter:
 *   1. re-enters via the ONE verbatim completed→changes_requested row
 *      (REVIEW_REENTRY_TRIGGER — the only legal re-entry), with
 *      `retry_count` incremented EXACTLY on entry through the ONE
 *      `enterChangesRequested` the validating/reject paths use (never
 *      a second budget rule); the matrix row's own gate text
 *      (`retry_count < max_retries`) refuses a target whose budget is
 *      ALREADY spent — the occurrence is consumed, never force-moved;
 *   2. receives the emitter's VALIDATED result.json (annotated by the
 *      verification that just completed it) as its ONE sanctioned
 *      feedback context file (FR-TSK-04: the upstream handoff);
 *   3. continues via the retry evaluator's OWN rules — `escalateIfBudgetSpent`
 *      decides queued vs awaiting_gate, and the requeue rides the
 *      verbatim changes_requested→queued row with the delivered path
 *      recorded in the log's reason.
 *
 * FAILURE PATH (the 8.1 rule ruled 2026-11-21, DEC
 * 2026-11-21-novaflow-on-failure-fallback): a member CONFIRMED failed
 * (the awaiting_gate→failed terminal gate outcome — discriminated by
 * the retry evaluator's ONE `isTerminalGateFailure`) enqueues every
 * `on_failure` target in draft via the guarded draft→queued row
 * (`enqueueTask` — the same row readiness uses; trigger_type `engine`,
 * actor `chain-engine`; a target with no target_scopes refuses the
 * same way — DEBT-010), delivering a SYNTHESIZED failure context file:
 * the member's latest run `error_summary` plus its result.json content
 * when one exists. Non-draft targets are consumed (matrix is the
 * arbiter — the schedule evaluator's quarantine discipline). The
 * chain-failed rule is UNORDERED with the fallback: the chain records
 * `failed` while member-level routing continues (nothing halts
 * members on chain state in v1).
 *
 * IDEMPOTENCE (the readiness discipline, plus a durable marker):
 *   - review: the entry log row's `run_id` column carries the EMITTER's
 *     run id — the occurrence's identity. A second observation of the
 *     same completion finds the marker and skips silently; a crashed
 *     pass that entered but never delivered/requeued (the target still
 *     `changes_requested`) FINISHES the delivery instead of re-entering.
 *     A LATER review (a new emitter run) is a new occurrence and routes
 *     again. Spec-silent choice: the marker reuses the log row the
 *     transition itself writes — no new DDL, no new state.
 *   - failure: draft-only selection + enqueueTask's matrix guard (the
 *     readiness evaluator's own construction).
 *
 * BOOT SWEEP: a restart sweeps chains in state `active` or `failed` —
 * both routing rules are member-level and survive the chain's own
 * terminal move (a `failed` chain's fallbacks still run; the sweep
 * must not miss them). An ABORTED chain is never swept: the operator's
 * abort is the terminal decision (the chain abort consumes its
 * members; nothing re-opens them). A COMPLETED chain needs no sweep:
 * its terminal move required every member completed, so every review
 * occurrence was already routed or consumed before the move could
 * apply. Spec-silent choice (documented): routing is NOT pause-gated —
 * FR-TSK-08 is scheduler-level, and the dispatcher already withholds
 * admission of a paused chain's queued members; the state moves are
 * the matrix's business.
 *
 * FR-TSK-04 path recording (documented spec-silent choice): the
 * task_runs DDL has NO context-file column (data.md field reference),
 * and the repair-feedback precedent (src/runs/prompt.ts) rides the
 * prompt with provenance in state_transition_logs.reason — so the
 * delivered feedback path is recorded (1) durably in
 * `tasks.context_files_json`, the ONE injection source the run loop's
 * composePrompt reads (the file literally becomes an input context file
 * on the target's next run), idempotently appended once per emitter,
 * and (2) in the delivery transition's log reason (the requeue row
 * names the path; `deliveredFeedbackPaths` derives it back for the
 * status surfaces — no invented state).
 *
 * The evaluator never wedges: every per-target move is wrapped in
 * try/catch with warn-and-consume (a refused row is logged, the pass
 * continues — the schedule evaluator's discipline applied to its own
 * rows).
 */

export type RoutingOptions = {
  /** Catalog-probe injection threaded into enqueueTask (tests stub it). */
  enqueueOptions?: { piBin?: string; args?: string[]; timeoutMs?: number } | undefined;
  /** Dispatch hook: a requeued / fallback-enqueued member gets a pass. */
  onEnqueued?: ((taskId: string) => void) | undefined;
  /** Injected halt notifier (tests); default: workspace-config topic. */
  notify?: HaltNotifier | undefined;
  /** Transport injection for the DEFAULT (config-wired) notifier. */
  notifyOptions?: NotifyOptions | undefined;
};

export type ReviewRouted = {
  target: string;
  finalState: "queued" | "awaiting_gate";
  /** The workspace-root-relative delivered feedback path. */
  feedbackPath: string;
};

export type ReviewRoutingOutcome = {
  chainRunId: string;
  /** The occurrence's identity: the emitter run whose artifact requested changes. */
  emitterRunId: string;
  routed: ReviewRouted[];
};

export type FailureRoutingOutcome = {
  chainRunId: string;
  /** Fallback targets enqueued draft→queued by this pass. */
  enqueued: string[];
};

type TaskCoreRow = {
  id: string;
  chain_run_id: string | null;
  state: string;
};

type RunCore = {
  id: string;
  attempt_number: number;
  artifact_path: string | null;
  error_summary: string | null;
};

function warn(message: string): void {
  console.warn(`[novaflow-chain] ${message}`);
}

/**
 * The feedback context-file convention (spec-silent, documented):
 * `<workspace_root>/.novaflow/runs/<target_task_id>/feedback/<source_task_id>.json`
 * — the delivered review rides the target's own runs directory (data.md
 * 5.2 layout), one file per source, so a second review by the same
 * emitter overwrites in place (the latest review wins) and the retry
 * loop's composePrompt picks the path up through context_files_json.
 */
export function feedbackRelPath(targetTaskId: string, sourceTaskId: string): string {
  return `.novaflow/runs/${targetTaskId}/feedback/${sourceTaskId}.json`;
}

/**
 * The delivered feedback context paths recorded on a task (derived from
 * the ONE recording surface, tasks.context_files_json, by the path
 * convention above — no invented state; the status surfaces use this).
 */
export function deliveredFeedbackPaths(db: Db, taskId: string): string[] {
  const row = db
    .prepare("SELECT context_files_json FROM tasks WHERE id = ?")
    .get(taskId) as { context_files_json: string } | undefined;
  if (row === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.context_files_json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prefix = `.novaflow/runs/${taskId}/feedback/`;
  return parsed.filter((p): p is string => typeof p === "string" && p.startsWith(prefix));
}

/**
 * Record the delivered path on the target's context (the FR-TSK-04
 * choice documented in the module header): append once, never twice.
 * Throws on a malformed context column (the caller consumes with a
 * warn — the run loop's own preflight surfaces the same corruption).
 */
function appendContextFile(db: Db, taskId: string, relPath: string): void {
  const row = db
    .prepare("SELECT context_files_json FROM tasks WHERE id = ?")
    .get(taskId) as { context_files_json: string } | undefined;
  if (row === undefined) throw new Error(`no such task: ${taskId}`);
  const parsed: unknown = JSON.parse(row.context_files_json);
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
    throw new Error(`tasks.context_files_json for ${taskId} is not a JSON array of paths`);
  }
  if (parsed.includes(relPath)) return; // idempotent: exactly one file per emitter
  db.prepare("UPDATE tasks SET context_files_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify([...parsed, relPath]),
    new Date().toISOString(),
    taskId,
  );
}

function latestRun(db: Db, taskId: string): RunCore | undefined {
  return db
    .prepare(
      "SELECT id, attempt_number, artifact_path, error_summary FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1",
    )
    .get(taskId) as RunCore | undefined;
}

function workspaceOf(db: Db, taskId: string): { root: string; status: string; slug: string } | undefined {
  return db
    .prepare(
      `SELECT w.root_path AS root, w.status AS status, w.slug AS slug
         FROM tasks t JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id WHERE t.id = ?`,
    )
    .get(taskId) as { root: string; status: string; slug: string } | undefined;
}

export function createRoutingEvaluator(db: Db, opts: RoutingOptions) {
  const notifyFor = (taskId: string): HaltNotifier | null => {
    if (opts.notify !== undefined) return opts.notify;
    return taskHaltNotifier(db, taskId, opts.notifyOptions ?? {});
  };

  /** Write the feedback file under the target's runs dir; returns the rel path. */
  function deliverFeedback(
    wsRoot: string,
    targetTaskId: string,
    sourceTaskId: string,
    content: string,
  ): string {
    const rel = feedbackRelPath(targetTaskId, sourceTaskId);
    const abs = join(novaflowDir(wsRoot), "runs", targetTaskId, "feedback", `${sourceTaskId}.json`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return rel;
  }

  /**
   * The synthesized failure context file (the 8.1 failure routing
   * rule): the member's latest run error_summary plus its result.json
   * content when one exists — one documented JSON shape, delivered
   * under the same context convention as the review artifact.
   */
  function synthesizeFailureFeedback(failedTaskId: string, run: RunCore): string {
    let result: unknown = null;
    if (run.artifact_path !== null) {
      try {
        result = JSON.parse(readFileSync(run.artifact_path, "utf8"));
      } catch (err) {
        warn(
          `failure routing: result.json of task ${failedTaskId} is unreadable — synthesized without it: ${(err as Error).message}`,
        );
      }
    }
    return (
      JSON.stringify(
        {
          kind: "novaflow-failure-feedback",
          failed_task_id: failedTaskId,
          failed_run_id: run.id,
          error_summary: run.error_summary,
          result,
        },
        null,
        2,
      ) + "\n"
    );
  }

  /** The durable review-occurrence marker: the entry log row's run_id. */
  function reviewMarkerPresent(targetTaskId: string, emitterRunId: string): boolean {
    return (
      db
        .prepare(
          "SELECT 1 FROM state_transition_logs WHERE task_id = ? AND to_state = 'changes_requested' AND run_id = ? LIMIT 1",
        )
        .get(targetTaskId, emitterRunId) !== undefined
    );
  }

  /**
   * The post-entry continuation the review path shares with its
   * crash-window recovery: the ONE escalation check (budget spent →
   * awaiting_gate + halt alert), else the verbatim requeue row with the
   * delivered path recorded in the reason.
   */
  function finishAfterEntry(
    targetTaskId: string,
    feedbackPath: string,
    retryCount: number,
    maxRetries: number,
  ): ReviewRouted {
    const notifications: Promise<NotifyResult>[] = [];
    const notify = notifyFor(targetTaskId);
    const finalState = escalateIfBudgetSpent(
      db,
      targetTaskId,
      retryCount,
      maxRetries,
      { triggerType: "engine", actor: CHAIN_ENGINE_ACTOR },
      notify,
      notifications,
    );
    if (finalState === "awaiting_gate") {
      return { target: targetTaskId, finalState: "awaiting_gate", feedbackPath };
    }
    requeueFromChangesRequested(db, targetTaskId, CHAIN_ENGINE_ACTOR, { feedbackPath });
    opts.onEnqueued?.(targetTaskId);
    return { target: targetTaskId, finalState: "queued", feedbackPath };
  }

  function routeReviewTarget(
    targetTaskId: string,
    wsRoot: string,
    emitterTaskId: string,
    emitterRunId: string,
    artifactContent: string,
  ): ReviewRouted | null {
    const target = db
      .prepare("SELECT state, retry_count, max_retries FROM tasks WHERE id = ?")
      .get(targetTaskId) as { state: string; retry_count: number; max_retries: number } | undefined;
    if (target === undefined) {
      warn(`review routing: target ${targetTaskId} vanished mid-evaluation — occurrence consumed`);
      return null;
    }

    if (!reviewMarkerPresent(targetTaskId, emitterRunId)) {
      if (target.state !== "completed") {
        warn(
          `review routing: target ${targetTaskId} is ${target.state}, not completed — the completed→changes_requested row refuses; occurrence consumed (matrix is the arbiter)`,
        );
        return null;
      }
      if (target.retry_count >= target.max_retries) {
        warn(
          `review routing: target ${targetTaskId} has retry_count ${target.retry_count} >= max_retries ${target.max_retries} — the row's own gate (retry_count < max_retries) refuses; occurrence consumed`,
        );
        return null;
      }
      // deliver BEFORE the entry: an undeliverable occurrence never moves state
      const rel = deliverFeedback(wsRoot, targetTaskId, emitterTaskId, artifactContent);
      const retryCount = enterChangesRequested(db, targetTaskId, REVIEW_REENTRY_TRIGGER, {
        triggerType: "engine",
        actor: CHAIN_ENGINE_ACTOR,
        runId: emitterRunId,
        reason: `review-path re-entry: emitter task ${emitterTaskId} (run ${emitterRunId}) requested changes`,
      });
      appendContextFile(db, targetTaskId, rel);
      return finishAfterEntry(targetTaskId, rel, retryCount, target.max_retries);
    }

    // the marker exists: a fully-routed earlier pass (silent skip), or a
    // crashed pass left the target in changes_requested — finish the
    // delivery now, never re-enter (retry_count was already spent)
    if (target.state !== "changes_requested") return null;
    const rel = feedbackRelPath(targetTaskId, emitterTaskId);
    if (!existsSync(join(novaflowDir(wsRoot), "runs", targetTaskId, "feedback", `${emitterTaskId}.json`))) {
      deliverFeedback(wsRoot, targetTaskId, emitterTaskId, artifactContent);
    }
    appendContextFile(db, targetTaskId, rel);
    return finishAfterEntry(targetTaskId, rel, target.retry_count, target.max_retries);
  }

  /**
   * The review path (8.1 feedback routing rule): a COMPLETED chain
   * member whose latest run's validated result.json carries
   * `status: "changes_requested"` routes every on_changes_requested
   * target. Returns null when there is no occurrence (not a member,
   * not completed, no edges, or the artifact says otherwise); a
   * consumed occurrence returns an empty `routed` list.
   */
  async function routeReviewPath(taskId: string): Promise<ReviewRoutingOutcome | null> {
    const task = db
      .prepare("SELECT id, chain_run_id, state FROM tasks WHERE id = ?")
      .get(taskId) as TaskCoreRow | undefined;
    if (task === undefined || task.chain_run_id === null) return null;
    if (task.state !== "completed") return null;
    const edges = db
      .prepare(
        "SELECT target_task_id FROM task_edges WHERE source_task_id = ? AND edge_type = 'on_changes_requested' ORDER BY target_task_id",
      )
      .all(taskId) as Array<{ target_task_id: string }>;
    if (edges.length === 0) return null;

    const ws = workspaceOf(db, taskId);
    if (ws === undefined) {
      warn(`review routing: emitter ${taskId}'s workspace row is missing — occurrence consumed`);
      return null;
    }
    const run = latestRun(db, taskId);
    if (run === undefined || run.artifact_path === null) {
      warn(
        `chain ${task.chain_run_id}: member ${taskId} completed but has no artifact-bearing run — the review verdict cannot be read; occurrence consumed`,
      );
      return null;
    }
    let content: string;
    try {
      content = readFileSync(run.artifact_path, "utf8");
    } catch (err) {
      warn(`chain ${task.chain_run_id}: emitter ${taskId}'s result.json is unreadable — ${(err as Error).message}`);
      return null;
    }
    let status: unknown;
    try {
      status = (JSON.parse(content) as Record<string, unknown>)["status"];
    } catch {
      warn(`chain ${task.chain_run_id}: emitter ${taskId}'s result.json is not parseable JSON — occurrence consumed`);
      return null;
    }
    if (status !== "changes_requested") return null;

    const routed: ReviewRouted[] = [];
    for (const edge of edges) {
      try {
        const out = routeReviewTarget(edge.target_task_id, ws.root, taskId, run.id, content);
        if (out !== null) routed.push(out);
      } catch (err) {
        warn(
          `chain ${task.chain_run_id}: review routing of target ${edge.target_task_id} refused — ${(err as Error).message} (occurrence consumed)`,
        );
      }
    }
    return { chainRunId: task.chain_run_id, emitterRunId: run.id, routed };
  }

  /**
   * The failure path (8.1 failure routing rule): a CONFIRMED failed
   * member (the terminal gate outcome, discriminated by the retry
   * evaluator's ONE source) enqueues every on_failure target in draft
   * via the guarded draft→queued row, delivering the synthesized
   * failure context file. The chain's own state is irrelevant here —
   * the fallback continues on a failed (or still-active) chain.
   */
  async function routeFailurePath(taskId: string): Promise<FailureRoutingOutcome | null> {
    const task = db
      .prepare("SELECT id, chain_run_id, state FROM tasks WHERE id = ?")
      .get(taskId) as TaskCoreRow | undefined;
    if (task === undefined || task.chain_run_id === null) return null;
    if (task.state !== "failed") return null;
    if (!isTerminalGateFailure(db, taskId)) return null;
    const edges = db
      .prepare(
        "SELECT target_task_id FROM task_edges WHERE source_task_id = ? AND edge_type = 'on_failure' ORDER BY target_task_id",
      )
      .all(taskId) as Array<{ target_task_id: string }>;
    if (edges.length === 0) return null;

    const ws = workspaceOf(db, taskId);
    if (ws === undefined) {
      warn(`failure routing: member ${taskId}'s workspace row is missing — occurrence consumed`);
      return null;
    }
    const run = latestRun(db, taskId);
    if (run === undefined) {
      warn(`chain ${task.chain_run_id}: member ${taskId} failed with no run row — nothing to synthesize; occurrence consumed`);
      return null;
    }
    const content = synthesizeFailureFeedback(taskId, run);
    const enqueued: string[] = [];
    for (const edge of edges) {
      const targetId = edge.target_task_id;
      try {
        const target = db
          .prepare("SELECT state FROM tasks WHERE id = ?")
          .get(targetId) as { state: string } | undefined;
        if (target === undefined) {
          warn(`failure routing: target ${targetId} vanished mid-evaluation — occurrence consumed`);
          continue;
        }
        if (target.state !== "draft") {
          warn(
            `failure routing: target ${targetId} is ${target.state}, not draft — the draft→queued row refuses; occurrence consumed (matrix is the arbiter)`,
          );
          continue;
        }
        // FR-WS-03 discipline (mirrors the readiness evaluator): never
        // spend a catalog probe on a workspace whose execution is disabled
        const tws = workspaceOf(db, targetId);
        if (tws === undefined || tws.status !== "active") {
          warn(
            `failure routing: target ${targetId}'s workspace is ${tws?.status ?? "missing"} — the workspace gate (FR-WS-03) refuses execution; withholding`,
          );
          continue;
        }
        // deliver BEFORE the enqueue: no probe is spent on an undeliverable target
        const rel = deliverFeedback(ws.root, targetId, taskId, content);
        appendContextFile(db, targetId, rel);
        await enqueueTask(db, targetId, CHAIN_ENGINE_ACTOR, {
          triggerType: "engine",
          ...(opts.enqueueOptions?.piBin !== undefined ? { piBin: opts.enqueueOptions.piBin } : {}),
          ...(opts.enqueueOptions?.args !== undefined ? { args: opts.enqueueOptions.args } : {}),
          ...(opts.enqueueOptions?.timeoutMs !== undefined
            ? { timeoutMs: opts.enqueueOptions.timeoutMs }
            : {}),
        });
        enqueued.push(targetId);
        opts.onEnqueued?.(targetId);
      } catch (err) {
        warn(
          `chain ${task.chain_run_id}: failure routing of target ${targetId} refused — ${(err as Error).message} (occurrence consumed)`,
        );
        continue;
      }
    }
    return { chainRunId: task.chain_run_id, enqueued };
  }

  /**
   * The boot sweep (a daemon restart resumes routing — the readiness
   * evaluator's sweep discipline): every active or failed chain is
   * swept once; a review occurrence or a confirmed-failure fallback
   * that happened during downtime (or in a crash window) fires exactly
   * once — the per-target markers and the state guards back that up.
   */
  async function bootScan(): Promise<{
    chains: number;
    reviewRouted: number;
    fallbackEnqueued: number;
    selfPathResumed: number;
    summariesRecovered: number;
  }> {
    const chains = db
      .prepare("SELECT id FROM chain_runs WHERE state IN ('active', 'failed') ORDER BY id")
      .all() as Array<{ id: string }>;
    let reviewRouted = 0;
    let fallbackEnqueued = 0;
    let selfPathResumed = 0;
    for (const chain of chains) {
      const members = listChainMembers(db, chain.id);
      for (const m of members) {
        try {
          if (m.state === "completed") {
            const out = await routeReviewPath(m.id);
            if (out !== null) reviewRouted += out.routed.length;
          } else if (m.state === "failed" && isTerminalGateFailure(db, m.id)) {
            const out = await routeFailurePath(m.id);
            if (out !== null) fallbackEnqueued += out.enqueued.length;
          } else if (m.state === "changes_requested") {
            // SELF-PATH crash window (review round, judge A): a crash
            // between the changes_requested entry and its requeue wedged
            // the member — the routing rule promises "the task retries
            // itself", so boot finishes the interrupted delivery. The
            // feedback file usually exists (delivery precedes the entry
            // in the live path); when it does not, the latest run's
            // error_summary is the honest reconstruction.
            selfPathResumed += resumeSelfPath(m.id) ? 1 : 0;
          }
        } catch (err) {
          warn(`chain ${chain.id}: boot routing of member ${m.id} refused — ${(err as Error).message}`);
        }
      }
    }
    // FR-PRJ-05 crash window (review round): a crash between the guarded
    // completed move and the file write leaves a completed chain with no
    // report — recover it (write-once guard inside refuses duplicates).
    let summariesRecovered = 0;
    const done = db
      .prepare("SELECT id FROM chain_runs WHERE state = 'completed' ORDER BY id")
      .all() as Array<{ id: string }>;
    for (const chain of done) {
      try {
        const summaryPath = projectSummaryPath(db, chain.id);
        if (summaryPath !== null && !existsSync(summaryPath)) {
          writeProjectSummary(db, chain.id);
          summariesRecovered += 1;
        }
      } catch (err) {
        warn(`chain ${chain.id}: boot summary recovery failed — ${(err as Error).message}`);
      }
    }
    return { chains: chains.length, reviewRouted, fallbackEnqueued, selfPathResumed, summariesRecovered };
  }

  /**
   * Finish an interrupted self-path delivery for a member found in
   * changes_requested at boot: budget spent → the shared escalation;
   * budget remaining → the shared requeue with the feedback file (the
   * live path's own content when present, else the run's error_summary).
   */
  function resumeSelfPath(taskId: string): boolean {
    const task = db
      .prepare("SELECT retry_count, max_retries FROM tasks WHERE id = ?")
      .get(taskId) as { retry_count: number; max_retries: number } | undefined;
    if (task === undefined) return false;
    const ws = workspaceOf(db, taskId);
    if (ws === undefined) return false;
    // SOURCE from the entry row (re-judge finding): a wedge created by a
    // crash between rejectGate and the op's requeue recovers with the
    // GATE-REJECT label and the operator's feedback (the entry row's
    // reason), not a mislabeled engine-verification artifact.
    const entry = db
      .prepare(
        `SELECT from_state, reason FROM state_transition_logs
          WHERE task_id = ? AND to_state = 'changes_requested'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as { from_state: string; reason: string | null } | undefined;
    const source = entry?.from_state === "awaiting_gate" ? "gate-reject" : "engine-verification";
    const abs = join(novaflowDir(ws.root), "runs", taskId, "feedback", `${source}.json`);
    let content: string;
    if (existsSync(abs)) {
      content = readFileSync(abs, "utf8");
    } else {
      const run = latestRun(db, taskId);
      const recoveredSummary =
        entry?.reason ?? run?.error_summary ?? "engine verification failed (recovered at boot)";
      content =
        JSON.stringify(
          {
            kind:
              source === "gate-reject"
                ? "novaflow-gate-reject-feedback"
                : "novaflow-self-verification-feedback",
            task_id: taskId,
            ...(source === "gate-reject" ? { rejected_at_boot: true } : {}),
            summary: recoveredSummary,
          },
          null,
          2,
        ) + "\n";
    }
    if (task.retry_count >= task.max_retries) {
      const notifications: Promise<NotifyResult>[] = [];
      escalateIfBudgetSpent(
        db,
        taskId,
        task.retry_count,
        task.max_retries,
        { triggerType: "engine", actor: CHAIN_ENGINE_ACTOR },
        notifyFor(taskId),
        notifications,
      );
      return true;
    }
    if (driveSelfPathRequeue(db, taskId, source, content, CHAIN_ENGINE_ACTOR) !== null) {
      return true;
    }
    return false;
  }

  return { routeReviewPath, routeFailurePath, bootScan };
}

export type RoutingEvaluator = ReturnType<typeof createRoutingEvaluator>;

/**
 * The SELF-path requeue driver — the 8.1 feedback routing rule's path 1:
 * "the task retries itself within its retry budget." Review-round finding
 * (p4b, worker-flagged): the verbatim `changes_requested → queued` requeue
 * row had callers ONLY on the review path — a task failing its OWN engine
 * verification, or gate-rejected with feedback, dead-ended in
 * `changes_requested` while the matrix promises an automatic retry.
 *
 * The caller invokes this ONLY when the entry did NOT escalate (the
 * budget checks live upstream, in completeValidation/rejectGate via
 * escalateIfBudgetSpent — one source). The surface's feedback becomes the
 * task's ONE new context file (the same delivery convention as the review
 * artifact) and the requeue row records the delivered path.
 */
export function driveSelfPathRequeue(
  db: Db,
  taskId: string,
  source: string,
  content: string,
  actor: string,
): string | null {
  const task = db
    .prepare("SELECT state FROM tasks WHERE id = ?")
    .get(taskId) as { state: string } | undefined;
  if (task === undefined || task.state !== "changes_requested") {
    // consumed/escalated/foreign state — not ours to drive (the matrix is
    // the arbiter; the requeue row itself would refuse anyway)
    return null;
  }
  const ws = workspaceOf(db, taskId);
  if (ws === undefined) return null;
  const rel = feedbackRelPath(taskId, source);
  const abs = join(novaflowDir(ws.root), "runs", taskId, "feedback", `${source}.json`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  appendContextFile(db, taskId, rel);
  requeueFromChangesRequested(db, taskId, actor, { feedbackPath: rel });
  return rel;
}
