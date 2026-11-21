import type { Db } from "../store/db.ts";
import { ulid } from "../store/ids.ts";
import { createTask, type CreateTaskTargetScope, type TaskRow } from "../tasks.ts";
import {
  validateChainGraph,
  ChainValidationError,
  type ValidatedChainGraph,
} from "./graph.ts";

// one chain surface: the import path re-exports the validator's typed
// error so callers never import from two modules for one contract
export { ChainValidationError } from "./graph.ts";
export type { ChainErrorCode } from "./graph.ts";

/**
 * Chain import (srs FR-PRJ-04; architecture 8.1 chain run ownership):
 * one ALL-OR-NOTHING transaction that creates
 *   1. the `chain_runs` row — state `active`, `started_at` = import time
 *      (the DDL default fills it at INSERT; data.md field reference),
 *   2. every member task in DRAFT with `chain_run_id` stamped — via the
 *      p3b createTask machinery, so target_scopes / overrides /
 *      context_files get the exact same persistence and validation as
 *      every other task surface, and
 *   3. every `task_edges` row (endpoints resolved to task ids,
 *      condition_expr stored verbatim, never evaluated — p4b boundary:
 *      the §5.3 ruling defers edge expression language out of v1;
 *      on_changes_requested / on_failure edge EFFECTS are phase 4b).
 *
 * A failure at ANY point persists NOTHING: structural validation
 * (src/chain/graph.ts) throws before the store is touched, and the
 * transaction wraps every insert (a mid-way UNIQUE violation — e.g. a
 * member key colliding with an existing project task — rolls the whole
 * chain back; a half-imported chain is corrupt state).
 *
 * ROOTS ARE NOT AUTO-ENQUEUED (documented reading of FR-PRJ-04 AC3 +
 * mcp.md §1's orchestrator pattern — "drafts tasks and chains, enqueues
 * runs"): the operator/orchestrator starts a chain by enqueuing root
 * members (nova_task_run), and the engine propagates readiness from
 * completions thereafter (src/chain/readiness.ts). This is also the
 * only reading consistent with the matrix: the draft→queued row's
 * trigger is "operator/agent enqueues", and nothing in the import
 * contract names an enqueuer.
 */

export type ChainRunRow = {
  id: string;
  project_id: string;
  started_at: string;
  completed_at: string | null;
  state: "active" | "completed" | "failed" | "aborted";
};

export type ImportChainResult = {
  chainRun: ChainRunRow;
  /** key → created member task row. */
  tasks: Record<string, TaskRow>;
};

export function getChainRun(db: Db, chainRunId: string): ChainRunRow | undefined {
  return db.prepare("SELECT * FROM chain_runs WHERE id = ?").get(chainRunId) as
    | ChainRunRow
    | undefined;
}

export type ChainMemberRow = TaskRow;

/** The chain's member tasks in ULID creation order. */
export function listChainMembers(db: Db, chainRunId: string): ChainMemberRow[] {
  return db
    .prepare("SELECT * FROM tasks WHERE chain_run_id = ? ORDER BY id")
    .all(chainRunId) as ChainMemberRow[];
}

/**
 * Import a (parsed) chain graph into a project. `workspace` is the
 * owning workspace (profile resolution universe); `project` the target
 * project row — its slug must equal the graph's declared project_slug
 * (the schema carries the slug; a mismatch is refused, never silently
 * retargeted). Throws ChainValidationError (or the store's UNIQUE
 * error surfaced as duplicate by the caller) leaving NO rows behind.
 */
export function importChain(
  db: Db,
  workspace: { id: string },
  project: { id: string; slug: string },
  graph: unknown,
): ImportChainResult {
  const chain: ValidatedChainGraph = validateChainGraph(db, workspace.id, graph);
  if (chain.projectSlug !== project.slug) {
    throw new ChainValidationError(
      "schema_invalid",
      `the graph declares project_slug "${chain.projectSlug}" but the import targets project "${project.slug}" — mismatch refused (the schema carries project_slug)`,
    );
  }

  // target-alias resolution (read-only, before the transaction): each
  // scope's repo_alias must name a project_targets row of THIS project
  const resolvedScopes: Array<CreateTaskTargetScope[] | undefined> = [];
  for (const task of chain.tasks) {
    const scopes: CreateTaskTargetScope[] | undefined =
      task.targetScopes?.map((scope): CreateTaskTargetScope => {
        const target = db
          .prepare("SELECT id FROM project_targets WHERE project_id = ? AND alias = ?")
          .get(project.id, scope.repoAlias) as { id: string } | undefined;
        if (!target) {
          throw new ChainValidationError(
            "not_found",
            `task "${task.key}" target_scopes carry repo_alias "${scope.repoAlias}" — the project has no such target`,
          );
        }
        return {
          targetId: target.id,
          accessMode: scope.accessMode,
          ...(scope.writeScopeGlobs !== undefined ? { writeScopeGlobs: scope.writeScopeGlobs } : {}),
          ...(scope.protectedTestGlobs !== undefined
            ? { protectedTestGlobs: scope.protectedTestGlobs }
            : {}),
          ...(scope.verificationCommands !== undefined
            ? { verificationCommands: scope.verificationCommands }
            : {}),
        };
      });
    resolvedScopes.push(scopes);
  }

  const chainRunId = ulid();
  const created: Record<string, TaskRow> = {};

  const insert = db.transaction((): void => {
    db.prepare(
      "INSERT INTO chain_runs (id, project_id, state) VALUES (?, ?, 'active')",
    ).run(chainRunId, project.id);
    for (const [index, task] of chain.tasks.entries()) {
      let row: TaskRow;
      try {
        row = createTask(db, {
          projectId: project.id,
          key: task.key,
          title: task.title,
          objective: task.objective,
          profileId: task.profileId,
          ...(task.priority !== undefined ? { priority: task.priority } : {}),
          ...(task.requiresHumanGate !== undefined
            ? { requiresHumanGate: task.requiresHumanGate }
            : {}),
          ...(task.contextFiles !== undefined ? { contextFiles: task.contextFiles } : {}),
          ...(task.outputSchemaVersion !== undefined
            ? { outputSchemaVersion: task.outputSchemaVersion }
            : {}),
          ...(task.overrides !== undefined ? { overrides: task.overrides } : {}),
          ...(resolvedScopes[index] !== undefined
            ? { targetScopes: resolvedScopes[index] }
            : {}),
          chainRunId, // the 8.1 ownership stamp
        });
      } catch (err) {
        // a mid-transaction UNIQUE violation (a member key colliding with
        // an existing project task) is the all-or-nothing case: the whole
        // transaction rolls back and the refusal is TYPED (duplicate),
        // never a raw store error on the wire
        if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
          throw new ChainValidationError(
            "duplicate",
            `task key "${task.key}" already exists in the project "${project.slug}"`,
          );
        }
        throw err;
      }
      created[task.key] = row;
    }
    for (const edge of chain.edges) {
      db.prepare(
        `INSERT INTO task_edges
           (id, project_id, source_task_id, target_task_id, edge_type, condition_expr)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        project.id,
        created[edge.sourceKey]!.id,
        created[edge.targetKey]!.id,
        edge.edgeType,
        edge.conditionExpr ?? null, // stored verbatim, never evaluated (p4b)
      );
    }
  });
  insert();

  const chainRun = getChainRun(db, chainRunId);
  if (!chainRun) throw new Error(`created chain run ${chainRunId} is missing from the store`);
  return { chainRun, tasks: created };
}
