import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db.ts";

/**
 * engine-context.json per novaflow-v1/api §6 ("Extension context
 * injection"): the spawner writes
 * `.novaflow/runs/<task_id>/<run_id>/engine-context.json` containing
 * `{task_id, run_id, scopes (write/protected globs per target),
 * output_schema (id + inline copy), budget, verification_commands}` and
 * passes the path to the Pi subprocess via NOVAFLOW_RUN_CONTEXT.
 *
 * `attempt_kind` is carried alongside the §6 fields so a repair attempt
 * can be told apart from the execution attempt (the card's stub
 * contract; it adds no convention to the spec's own six fields).
 *
 * output_schema: the task's `output_schema_version` is the id. No inline
 * schema file is configured anywhere in the v1 data model (the tasks
 * DDL carries only the version string), so the inline copy is `null`
 * plus the version — exactly the spec's "no inline schema configured"
 * case.
 */

export type EngineContextScope = {
  target_id: string;
  alias: string;
  access_mode: "read_only" | "read_write";
  write_scope_globs: string[];
  protected_test_globs: string[];
};

export type EngineContext = {
  task_id: string;
  run_id: string;
  attempt_kind: "execution" | "repair";
  scopes: EngineContextScope[];
  output_schema: { id: string; inline: null };
  budget: { max_timeout_sec: number; max_cost_usd: number };
  verification_commands: string[];
};

/** The task row fields the context needs. */
export type ContextTaskInfo = {
  id: string;
  output_schema_version: string;
};

type ScopeRow = {
  target_id: string;
  alias: string;
  access_mode: "read_only" | "read_write";
  write_scope_globs_json: string;
  protected_test_globs_json: string;
  verification_commands_json: string;
};

function parseStringArray(json: string, column: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`${column} is not a JSON array of strings`);
  }
  return parsed as string[];
}

/**
 * Build the engine context for a run. Scopes come from
 * task_target_scopes joined to project_targets (alias), in ULID order;
 * with no mapped targets the structures are empty. verification_commands
 * is the union across scopes, first-seen order, deduped.
 */
export function buildEngineContext(
  db: Db,
  task: ContextTaskInfo,
  runId: string,
  attemptKind: "execution" | "repair",
  budget: { max_timeout_sec: number; max_cost_usd: number },
): EngineContext {
  const scopeRows = db
    .prepare(
      `SELECT tts.target_id AS target_id, pt.alias AS alias, tts.access_mode AS access_mode,
              tts.write_scope_globs_json AS write_scope_globs_json,
              tts.protected_test_globs_json AS protected_test_globs_json,
              tts.verification_commands_json AS verification_commands_json
         FROM task_target_scopes tts
         JOIN project_targets pt ON pt.id = tts.target_id
        WHERE tts.task_id = ?
        ORDER BY tts.id`,
    )
    .all(task.id) as ScopeRow[];

  const scopes: EngineContextScope[] = scopeRows.map((r) => ({
    target_id: r.target_id,
    alias: r.alias,
    access_mode: r.access_mode,
    write_scope_globs: parseStringArray(r.write_scope_globs_json, "write_scope_globs_json"),
    protected_test_globs: parseStringArray(r.protected_test_globs_json, "protected_test_globs_json"),
  }));

  const verificationCommands: string[] = [];
  for (const r of scopeRows) {
    for (const cmd of parseStringArray(r.verification_commands_json, "verification_commands_json")) {
      if (!verificationCommands.includes(cmd)) verificationCommands.push(cmd);
    }
  }

  return {
    task_id: task.id,
    run_id: runId,
    attempt_kind: attemptKind,
    scopes,
    output_schema: { id: task.output_schema_version, inline: null },
    budget,
    verification_commands: verificationCommands,
  };
}

/** Write engine-context.json into the run dir; returns its path. */
export function writeEngineContext(runDir: string, ctx: EngineContext): string {
  const path = join(runDir, "engine-context.json");
  writeFileSync(path, JSON.stringify(ctx, null, 2) + "\n");
  return path;
}
