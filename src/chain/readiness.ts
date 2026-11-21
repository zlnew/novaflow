import type { Db } from "../store/db.ts";
import { enqueueTask } from "../tasks.ts";
import { isTerminalGateFailure } from "../daemon/retry.ts";
import { getChainRun, listChainMembers } from "./import.ts";

/**
 * The chain readiness + terminal-rules evaluator (FR-TSK-07 downstream
 * auto-enqueue; architecture 8.1 chain run ownership; data.md
 * chain_runs lifecycle).
 *
 * READINESS: a member is READY when every `depends_on` source is
 * `completed` and the member is `draft`. Ready members enqueue through
 * the ONE guarded draft→queued row (enqueueTask — the catalog probe and
 * the FSM guard happen inside it, never here), with the log's
 * trigger_type `engine` and the actor `chain-engine`. Propagation is
 * idempotent by construction: only draft members are selected, and the
 * matrix guard backs that up (a member evaluated twice refuses the
 * second enqueue).
 *
 * TERMINAL RULES (evaluated on every member terminal outcome):
 *   - all members `completed` → chain `completed`;
 *   - any member CONFIRMED failed — the `awaiting_gate → failed`
 *     terminal gate outcome — → chain `failed`. The discrimination is
 *     the retry evaluator's own terminal-gate discriminator
 *     (src/daemon/retry.ts isTerminalGateFailure, ONE source): every
 *     other failed entry (running→failed, validating→failed) still has
 *     its retry/escalation path ahead and does not fail the chain;
 *   - a member cancelled by single-task abort does NOT change the
 *     chain state (the non-rule — the operator decides via chain
 *     abort or lets remaining members finish).
 * Chain state moves are GUARDED: `UPDATE … WHERE state = 'active'` — a
 * terminal chain never moves again.
 *
 * PAUSE (FR-TSK-08: scheduler-level, NO paused task state — the
 * chain_runs DDL has no paused value, the row stays `active`): a paused
 * chain withholds propagation entirely (documented: no new spawns;
 * ready members stay draft until resume) — the daemon's in-memory
 * paused set is consulted through the isPaused hook.
 *
 * BOOT: a daemon restart resumes evaluation — bootScan sweeps every
 * active chain once (terminal rules + readiness), so a completion that
 * happened while the daemon was down still propagates exactly once.
 *
 * Spec-silent choice (documented): a ready member in a NON-ACTIVE
 * workspace is skipped with a logged note (the schedules evaluator's
 * FR-WS-03 discipline — never enqueue work into a workspace whose
 * execution is disabled); a refused enqueue (unresolved profile, a
 * surface moving the member mid-probe) is logged and skipped — the
 * evaluator never wedges and never hot-loops.
 */

/** The audit-log actor for chain-engine transitions. */
export const CHAIN_ENGINE_ACTOR = "chain-engine";

export type ChainEvaluatorOptions = {
  /** Catalog-probe injection threaded into enqueueTask (tests stub it). */
  enqueueOptions?: { piBin?: string; args?: string[]; timeoutMs?: number } | undefined;
  /** Dispatch hook: a propagated member should get a scheduler pass. */
  onEnqueued?: ((taskId: string) => void) | undefined;
  /** The daemon's in-memory paused-chain set (FR-TSK-08 scheduler level). */
  isPaused?: ((chainRunId: string) => boolean) | undefined;
};

export type ChainEvaluationOutcome = {
  chainRunId: string;
  /** The terminal move applied by this evaluation, if any. */
  terminal: "completed" | "failed" | null;
  /** Members enqueued by this evaluation (draft → queued). */
  enqueued: string[];
  /** True when propagation was withheld by the pause flag. */
  withheld: boolean;
};

type MemberCore = { id: string; state: string };

function warn(message: string): void {
  console.warn(`[novaflow-chain] ${message}`);
}

export function createChainEvaluator(db: Db, opts: ChainEvaluatorOptions) {
  /**
   * The chain's terminal rules. GUARDED: the move only ever applies to
   * an `active` chain (a terminal chain never moves again); the update
   * itself is the guard (`WHERE state = 'active'`).
   */
  function applyTerminalRules(chainRunId: string): "completed" | "failed" | null {
    const chain = getChainRun(db, chainRunId);
    if (chain === undefined || chain.state !== "active") return null;
    const members = listChainMembers(db, chainRunId);
    if (members.length === 0) return null;
    if (members.some((m) => m.state === "failed" && isTerminalGateFailure(db, m.id))) {
      db.prepare(
        "UPDATE chain_runs SET state = 'failed', completed_at = ? WHERE id = ? AND state = 'active'",
      ).run(new Date().toISOString(), chainRunId);
      return "failed";
    }
    if (members.every((m) => m.state === "completed")) {
      db.prepare(
        "UPDATE chain_runs SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'active'",
      ).run(new Date().toISOString(), chainRunId);
      return "completed";
    }
    return null;
  }

  /**
   * The chain's ready members: draft, with at least one depends_on
   * in-edge, and every depends_on source completed. ROOTS (members with
   * no depends_on in-edges) are deliberately EXCLUDED — the operator /
   * orchestrator starts a chain by enqueuing its roots (nova_task_run,
   * mcp.md §1's pattern); the engine propagates from completions
   * thereafter and never starts a chain on its own.
   */
  function readyMembers(chainRunId: string): string[] {
    const drafts = db
      .prepare(
        `SELECT t.id FROM tasks t
          WHERE t.chain_run_id = ? AND t.state = 'draft'
            AND EXISTS (
              SELECT 1 FROM task_edges e
               WHERE e.target_task_id = t.id AND e.edge_type = 'depends_on'
            )
          ORDER BY t.id`,
      )
      .all(chainRunId) as Array<{ id: string }>;
    const ready: string[] = [];
    for (const draft of drafts) {
      const unmet = (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM task_edges e JOIN tasks s ON s.id = e.source_task_id
              WHERE e.target_task_id = ? AND e.edge_type = 'depends_on'
                AND s.state != 'completed'`,
          )
          .get(draft.id) as { n: number }
      ).n;
      if (unmet === 0) ready.push(draft.id);
    }
    return ready;
  }

  /**
   * Propagate readiness for one chain: enqueue every ready member via
   * the guarded row. A paused chain withholds entirely; a terminal
   * chain propagates nothing. Refusals are logged and skipped — never
   * a wedge, never a hot loop.
   */
  async function propagateChain(chainRunId: string): Promise<{ enqueued: string[]; withheld: boolean }> {
    const chain = getChainRun(db, chainRunId);
    if (chain === undefined || chain.state !== "active") return { enqueued: [], withheld: false };
    if (opts.isPaused?.(chainRunId) === true) return { enqueued: [], withheld: true };
    const enqueued: string[] = [];
    for (const taskId of readyMembers(chainRunId)) {
      // FR-WS-03 discipline (mirrors the schedules evaluator): never
      // enqueue into a workspace whose execution is disabled
      const ws = db
        .prepare(
          `SELECT w.status AS status, w.slug AS slug
             FROM tasks t JOIN projects p ON p.id = t.project_id
             JOIN workspaces w ON w.id = p.workspace_id WHERE t.id = ?`,
        )
        .get(taskId) as { status: string; slug: string } | undefined;
      if (ws === undefined) continue; // task vanished mid-evaluation — skip
      if (ws.status !== "active") {
        warn(
          `chain ${chainRunId}: member ${taskId} is ready but workspace "${ws.slug}" is ${ws.status} — the workspace gate (FR-WS-03) refuses execution; withholding`,
        );
        continue;
      }
      try {
        await enqueueTask(db, taskId, CHAIN_ENGINE_ACTOR, {
          triggerType: "engine",
          ...(opts.enqueueOptions?.piBin !== undefined ? { piBin: opts.enqueueOptions.piBin } : {}),
          ...(opts.enqueueOptions?.args !== undefined ? { args: opts.enqueueOptions.args } : {}),
          ...(opts.enqueueOptions?.timeoutMs !== undefined
            ? { timeoutMs: opts.enqueueOptions.timeoutMs }
            : {}),
        });
      } catch (err) {
        // a refused enqueue (unresolved profile, a surface moving the
        // member mid-probe) is logged and skipped — the pass continues
        warn(`chain ${chainRunId}: propagation of member ${taskId} refused — ${(err as Error).message}`);
        continue;
      }
      enqueued.push(taskId);
      opts.onEnqueued?.(taskId);
    }
    return { enqueued, withheld: false };
  }

  /**
   * Evaluate the chain a task belongs to: terminal rules first, then
   * readiness propagation. A null return means the task is not a chain
   * member (chain_run_id NULL — single tasks never evaluate).
   */
  async function evaluateForTask(taskId: string): Promise<ChainEvaluationOutcome | null> {
    const row = db
      .prepare("SELECT chain_run_id FROM tasks WHERE id = ?")
      .get(taskId) as { chain_run_id: string | null } | undefined;
    if (row === undefined || row.chain_run_id === null) return null;
    const chainRunId = row.chain_run_id;
    const terminal = applyTerminalRules(chainRunId);
    // a chain the terminal rules just ended propagates nothing; an
    // already-terminal chain propagates nothing either (guarded)
    if (terminal !== null || getChainRun(db, chainRunId)?.state !== "active") {
      return { chainRunId, terminal, enqueued: [], withheld: false };
    }
    const propagation = await propagateChain(chainRunId);
    return { chainRunId, terminal, ...propagation };
  }

  /**
   * The boot sweep (a daemon restart resumes evaluation): every active
   * chain evaluates once — terminal rules (a completion that happened
   * during downtime completes/fails the chain now) plus readiness (a
   * member whose dependencies completed during downtime enqueues now).
   */
  async function bootScan(): Promise<{ chains: number; enqueued: number }> {
    const chains = db
      .prepare("SELECT id FROM chain_runs WHERE state = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    let enqueued = 0;
    for (const chain of chains) {
      applyTerminalRules(chain.id);
      const propagation = await propagateChain(chain.id);
      enqueued += propagation.enqueued.length;
    }
    return { chains: chains.length, enqueued };
  }

  return { evaluateForTask, applyTerminalRules, propagateChain, bootScan };
}

export type ChainEvaluator = ReturnType<typeof createChainEvaluator>;

/** The member rows a chain status surface needs (id, key, state, readiness). */
export type MemberReadiness = MemberCore & { key: string; ready: boolean; root: boolean };

/**
 * Readiness view for the status surface: each member's state plus its
 * ready flag. `ready` matches the EVALUATOR exactly (review round finding):
 * draft AND has a depends_on in-edge AND every source completed. Roots
 * (no depends_on in-edge) are never auto-enqueued by the engine — the
 * operator starts them — so they carry ready=false and root=true.
 */
export function memberReadiness(db: Db, chainRunId: string): MemberReadiness[] {
  const members = listChainMembers(db, chainRunId);
  return members.map((m: MemberCore & { key: string }) => {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM task_edges
             WHERE target_task_id = ? AND edge_type = 'depends_on') AS in_edges,
           (SELECT COUNT(*) FROM task_edges e JOIN tasks s ON s.id = e.source_task_id
             WHERE e.target_task_id = ? AND e.edge_type = 'depends_on'
               AND s.state != 'completed') AS unmet`,
      )
      .get(m.id, m.id) as { in_edges: number; unmet: number };
    const root = row.in_edges === 0;
    return {
      id: m.id,
      key: m.key,
      state: m.state,
      root,
      ready: m.state === "draft" && !root && row.unmet === 0,
    };
  });
}
