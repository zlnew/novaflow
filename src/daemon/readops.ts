/**
 * The read-only op bodies, shared verbatim by the daemon's socket op
 * table (src/daemon/server.ts) and by the MCP server's SQLite-direct
 * fallback (src/mcp/read.ts).
 *
 * WHY THIS MODULE EXISTS (mcp.md §4): "read-only tools serve from the
 * SQLite store directly" when the daemon is unreachable. The MCP path
 * must serve EXACTLY what the socket op serves — same rows, same
 * envelopes, same taxonomy codes, same log file (`events.jsonl`, the
 * redacted read surface; `events.raw.jsonl` is never opened). Duplicating
 * these bodies in the MCP surface would be a second implementation of
 * the read contract, so the bodies live here ONCE and both surfaces call
 * them.
 *
 * Pure reads: no INSERT/UPDATE/DELETE, no filesystem writes, no daemon
 * state. They take a store handle and a validated-args object and either
 * return the op's `data` envelope or throw `OpError`.
 */

import { readFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import { getTask } from "../tasks.ts";
import { listTasks } from "../tasks.ts";
import { getWorkspace, listWorkspaces } from "../workspaces.ts";
import { getProject, listProjects } from "../projects.ts";
import { validateArtifact, type TaskHandoffArtifact } from "../runs/artifact.ts";
import { OpError } from "../opcodes.ts";

export type RunRow = {
  id: string;
  task_id: string;
  attempt_number: number;
  status: string;
  preflight_status: string;
  model_used: string;
  pid: number | null;
  /** FRESH prompt tokens only (spend.md: cache has its own two columns). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  exit_code: number | null;
  artifact_path: string | null;
  events_log_path: string;
  error_summary: string | null;
  started_at: string;
  ended_at: string | null;
};

export function latestRun(db: Db, taskId: string): RunRow | undefined {
  return db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as RunRow | undefined;
}

export function runById(db: Db, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as RunRow | undefined;
}

/**
 * `cost_basis` (novaflow-v02/spend.md): "History is not rewritten: rows written
 * before the migration keep their values and are reported as
 * `cost_basis: "legacy"`."
 *
 * The pinned migration carries no marker column (its two statements are
 * fixed), so the marker is the store's own migration record: a run row whose
 * `started_at` predates `schema_migrations.applied_at` for 0003 was written by
 * earlier code (cache tokens unrecorded, cost priced without them) and reports
 * "legacy". A store without that record cannot prove any row is priced, so it
 * conservatively reports "legacy" too. Such rows are only READ — their stored
 * tokens and cost_usd are never rewritten.
 */
export type CostBasis = "priced" | "legacy";

const COST_BASIS_MIGRATION = "0003_cache_tokens.sql";

export function costBasis(db: Db, run: { started_at: string }): CostBasis {
  const marker = db
    .prepare("SELECT applied_at FROM schema_migrations WHERE filename = ?")
    .get(COST_BASIS_MIGRATION) as { applied_at: string } | undefined;
  if (marker === undefined) return "legacy";
  // both columns are the store's own UTC `YYYY-MM-DDTHH:MM:SS.sssZ` format,
  // so the lexicographic compare is a chronological compare
  return run.started_at < marker.applied_at ? "legacy" : "priced";
}

export function requireTask(db: Db, taskId: string) {
  const task = getTask(db, taskId);
  if (!task) throw new OpError("not_found", `no such task: ${taskId}`);
  return task;
}

/** `nova_task_status` — full record, current run, elapsed, workspace status. */
export function taskStatus(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const task = requireTask(db, String(args["task_id"]));
  const current = latestRun(db, task.id);
  const elapsedMs =
    current !== undefined && current.status === "running"
      ? Date.now() - Date.parse(current.started_at)
      : null;
  const ws = db
    .prepare(
      `SELECT w.status AS status, w.slug AS slug
         FROM tasks t JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id WHERE t.id = ?`,
    )
    .get(task.id) as { status: string; slug: string };
  return {
    task,
    // the run record carries the cache columns (SELECT *) plus the derived
    // cost basis, so a reader can tell a legacy row from a priced one
    current_run: current === undefined ? null : { ...current, cost_basis: costBasis(db, current) },
    elapsed_ms: elapsedMs,
    workspace: ws,
  };
}

/**
 * `nova_run_logs` — the tail of the run's REDACTED `events.jsonl`
 * (FR-LOG-02: the run's log pointer IS the read surface; the verbatim
 * `events.raw.jsonl` is never opened by any surface).
 */
export function runLogs(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const taskId = String(args["task_id"]);
  requireTask(db, taskId);
  const run =
    args["run_id"] === undefined
      ? latestRun(db, taskId)
      : runById(db, String(args["run_id"]));
  if (!run) throw new OpError("not_found", `no run for task ${taskId}`);
  let text = "";
  try {
    text = readFileSync(run.events_log_path, "utf8");
  } catch {
    throw new OpError("not_found", `no events.jsonl for run ${run.id}`);
  }
  const tailLines = args["tail_lines"] === undefined ? 100 : (() => {
    const n = args["tail_lines"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1000) {
      throw new OpError("schema_invalid", "args.tail_lines must be an integer 1..1000");
    }
    return n;
  })();
  const lines = text.split("\n").filter((l) => l !== "");
  return { run_id: run.id, lines: lines.slice(-tailLines) };
}

/** `nova_result_get` — the validated §4.1 handoff artifact of a run. */
export function resultGet(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const taskId = String(args["task_id"]);
  requireTask(db, taskId);
  const run =
    args["run_id"] === undefined ? latestRun(db, taskId) : runById(db, String(args["run_id"]));
  if (!run) throw new OpError("not_found", `no run for task ${taskId}`);
  if (run.artifact_path === null) {
    throw new OpError("not_found", `run ${run.id} has no validated result.json`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(run.artifact_path, "utf8"));
  } catch {
    throw new OpError("not_found", `result.json of run ${run.id} is unreadable`);
  }
  const res = validateArtifact(raw);
  if (!res.ok) {
    throw new OpError(
      "schema_invalid",
      `result.json of run ${run.id} failed validation: ${res.errors.join("; ")}`,
    );
  }
  return { run_id: run.id, artifact: res.artifact as TaskHandoffArtifact };
}

/** `nova_workspace_list` — every registered workspace. */
export function workspaceList(db: Db): Record<string, unknown> {
  return { workspaces: listWorkspaces(db) };
}

/**
 * `nova_project_list` — projects and their FSM summary; `workspace_id`
 * scopes (and must exist), absent means every workspace's projects.
 */
export function projectList(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const workspaceId =
    args["workspace_id"] === undefined ? undefined : String(args["workspace_id"]);
  if (workspaceId !== undefined && getWorkspace(db, workspaceId) === undefined) {
    throw new OpError("not_found", `no such workspace: ${workspaceId}`);
  }
  return { projects: listProjects(db, workspaceId) };
}

/** `nova_task_list` — tasks with state, optionally project-scoped and filtered. */
export function taskList(db: Db, args: Record<string, unknown>): Record<string, unknown> {
  const projectId = args["project_id"] === undefined ? undefined : String(args["project_id"]);
  const state = args["state"] === undefined ? undefined : String(args["state"]);
  let rows = listTasks(db, projectId);
  if (state !== undefined) rows = rows.filter((t) => t.state === state);
  return { tasks: rows };
}

/** Kept for symmetry with the op table's project lookup (read-only). */
export function projectExists(db: Db, projectId: string): boolean {
  return getProject(db, projectId) !== undefined;
}
