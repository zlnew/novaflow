import { join } from "node:path";
import type { Db } from "../store/db.ts";
import { applyTransition } from "../fsm/engine.ts";
import { planSettleTransition } from "./settle.ts";
import { readArtifactFile } from "./artifact.ts";
import { costUsdTokens, type PriceTable } from "./prices.ts";

/**
 * The post-stream settlement, refactored out of src/runs/loop.ts so the
 * live run loop AND the daemon's boot crash recovery (§8.4) feed the
 * SAME intake — recovery must never reimplement intake logic. The live
 * path passes the pump's tallied tokens; recovery passes a re-tally of
 * the run's events.raw.jsonl (createFrameTally, src/runs/pump.ts).
 *
 * finalizeRunRecord is the ONE run-record finalization path: every
 * task_runs outcome update (live or recovered) goes through it.
 */

export type RunFinalizeFields = {
  status: string;
  preflightStatus: "passed" | "failed";
  /** FRESH prompt tokens only (cache is recorded in its own columns). */
  inputTokens: number;
  outputTokens: number;
  /** `usage.cacheRead` sum — novaflow-v02/spend.md column. */
  cacheReadTokens: number;
  /** `usage.cacheWrite` sum — novaflow-v02/spend.md column. */
  cacheWriteTokens: number;
  costUsd: number;
  exitCode: number | null;
  artifactPath: string | null;
  errorSummary: string | null;
  startedWall: number;
};

/**
 * Finalize one task_runs row (FR-TSK-09): status, preflight, token/cost
 * attribution, exit code, artifact pointer, error summary, ended_at and
 * duration. Moved verbatim from src/runs/loop.ts; the cache counters are
 * novaflow-v02/spend.md's two added columns.
 */
export function finalizeRunRecord(db: Db, runId: string, fields: RunFinalizeFields): void {
  db.prepare(
    `UPDATE task_runs
        SET status = ?, preflight_status = ?, input_tokens = ?, output_tokens = ?,
            cache_read_tokens = ?, cache_write_tokens = ?,
            cost_usd = ?, exit_code = ?, artifact_path = ?, error_summary = ?,
            ended_at = ?, duration_ms = ?
      WHERE id = ?`,
  ).run(
    fields.status,
    fields.preflightStatus,
    fields.inputTokens,
    fields.outputTokens,
    fields.cacheReadTokens,
    fields.cacheWriteTokens,
    fields.costUsd,
    fields.exitCode,
    fields.artifactPath,
    fields.errorSummary,
    new Date().toISOString(),
    Date.now() - fields.startedWall,
    runId,
  );
}

export type SettledIntakeInput = {
  db: Db;
  taskId: string;
  runId: string;
  /** tasks.requires_human_gate — the settle plan input. */
  requiresHumanGate: boolean;
  runDir: string;
  /** model for cost attribution (task_runs.model_used). */
  model: string;
  priceTable: PriceTable;
  /** The observed child exit code; recovery passes null (unobserved). */
  exitCode: number | null;
  inputTokens: number;
  outputTokens: number;
  /** The tallied cache components (spend.md: the prompt side stays split). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Wall-clock ms at attempt start (duration_ms attribution). */
  startedWall: number;
  /**
   * The prices-inert note applier (the live loop's withPricesNote
   * closure). Default: identity — recovery builds its own with the
   * same inert-prices convention.
   */
  pricesNote?: ((summary: string | null) => string | null) | undefined;
  actor: string;
};

export type SettledIntake =
  | {
      ok: true;
      target: "validating" | "awaiting_gate";
      artifactPath: string;
      artifactStatus: string;
    }
  | { ok: false; error: string };

/**
 * Intake one agent_settled run: read + structurally validate
 * result.json, finalize the run row, and on a valid artifact apply the
 * legal 8.1 settle transition (planSettleTransition — the gate row or
 * the agent_settled row). On a missing/invalid artifact the run row is
 * finalized failed and NO transition is applied — the caller owns the
 * follow-up (live loop: the FR-TSK-06 repair decision; recovery: the
 * running→failed row, since a crashed daemon cannot resume a repair
 * mid-flight). Exactly the live loop's previous behavior, extracted.
 */
export function intakeSettledRun(input: SettledIntakeInput): SettledIntake {
  const pricesNote = input.pricesNote ?? ((s: string | null) => s);
  const artifactPath = join(input.runDir, "result.json");
  // cache-aware costing (novaflow-v02/spend.md): fresh input + cache read +
  // cache write + output, each at its own per-1M rate
  const cost = costUsdTokens(input.priceTable, input.model, {
    input: input.inputTokens,
    cacheRead: input.cacheReadTokens,
    cacheWrite: input.cacheWriteTokens,
    output: input.outputTokens,
  });
  const artifact = readArtifactFile(artifactPath);

  if (artifact.ok) {
    // Structurally valid. The engine-owned annotations (engine_verified,
    // protected_files_untouched, verification_results, role) are NEVER
    // trusted from the agent — the engine overwrites them after
    // VALIDATING (p2c scope; the run record leaves them untouched here).
    finalizeRunRecord(input.db, input.runId, {
      status: "succeeded",
      preflightStatus: "passed",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      costUsd: cost,
      exitCode: input.exitCode,
      artifactPath,
      errorSummary: pricesNote(null),
      startedWall: input.startedWall,
    });
    const plan = planSettleTransition(
      artifact.artifact.status ?? "",
      input.requiresHumanGate,
    );
    applyTransition(input.db, input.taskId, plan.trigger, {
      triggerType: "engine",
      actor: input.actor,
      runId: input.runId,
      reason: `artifact status: ${String(artifact.artifact.status)}`,
    });
    return {
      ok: true,
      target: plan.target,
      artifactPath,
      artifactStatus: String(artifact.artifact.status ?? ""),
    };
  }

  // missing or schema-invalid artifact — the run row fails here; the
  // caller decides the task transition (repair vs running→failed)
  const error =
    artifact.reason === "missing"
      ? "result.json missing after agent_settled"
      : `result.json failed structural validation: ${artifact.errors.join("; ")}`;
  finalizeRunRecord(input.db, input.runId, {
    status: "failed",
    preflightStatus: "passed",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    costUsd: cost,
    exitCode: input.exitCode,
    artifactPath: null,
    errorSummary: pricesNote(error),
    startedWall: input.startedWall,
  });
  return { ok: false, error };
}
