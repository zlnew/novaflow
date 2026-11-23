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
import { OpError, optNonEmptyString } from "../opcodes.ts";

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

/* ---------------- nova_transitions_since (novaflow-v02/events.md) ---------------- */

/**
 * The public projection of one `state_transition_logs` row, exactly as
 * events.md lists it, plus the joined readability fields.
 *
 * Two projection rulings the spec leaves to the implementation (both
 * documented here rather than hidden in the SQL):
 *   - `chain_run_id` is the TASK's chain membership (`tasks.chain_run_id`
 *     — the transition table has no chain column), so a chain member's
 *     rows are attributable to its chain run without a second join table.
 *   - `chain_slug` is the chain run's PROJECT slug: `chain_runs` carries
 *     no slug column (data.md DDL), so the readable name of a chain run
 *     can only be the project it was imported into.
 */
export type TransitionEvent = {
  cursor: number;
  task_id: string;
  run_id: string | null;
  chain_run_id: string | null;
  task_key: string;
  chain_slug: string | null;
  from_state: string;
  to_state: string;
  trigger_type: string;
  actor: string;
  reason: string | null;
  created_at: string;
};

export type TransitionsPage = {
  transitions: TransitionEvent[];
  next_cursor: number;
  has_more: boolean;
};

const DEFAULT_TRANSITION_LIMIT = 100;
const MAX_TRANSITION_LIMIT = 1000;

/** An optional integer arg with a documented range, else `schema_invalid`. */
function intArg(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new OpError(
      "schema_invalid",
      max === Number.MAX_SAFE_INTEGER
        ? `args.${key} must be an integer >= ${min}`
        : `args.${key} must be an integer ${min}..${max}`,
    );
  }
  return v;
}

/**
 * `nova_transitions_since` — the v0.2.0 transition stream (frozen contract:
 * novaflow-v02/events.md). Every consumer (wake, `--watch`/`--follow`, the
 * v0.2.1 panel) polls it; there is no push and no protocol change.
 *
 * CURSOR INVARIANT (pinned by events.md rule 1, MUST be read before ever
 * adding a delete verb): the cursor is `state_transition_logs.rowid`,
 * compared strictly as `rowid > cursor`. That is sound ONLY while
 * transition rows are never deleted — the table's `id TEXT` PRIMARY KEY
 * carries no AUTOINCREMENT, so SQLite may REUSE the rowid of a deleted
 * maximum row, which would silently re-deliver or skip transitions to a
 * caller holding the old cursor. v0.2.0 ships no transition-delete
 * surface (and `workspace unregister` removes registry entries without
 * deleting rows). If a task-delete surface (and its ON DELETE CASCADE)
 * ever lands, this contract must FIRST gain a monotonic sequence column;
 * a delete verb without it is a defect, not an enhancement.
 *
 * Head semantics (rule 2): `cursor: 0` means "start at head" — the most
 * recent `limit` rows in ASCENDING rowid order, `next_cursor` the highest
 * returned rowid, `has_more: false`. Older history is not observable by
 * design: this feed is for liveness, the store remains the audit truth.
 *
 * Paging (rule 3): `rowid > cursor` ordered ascending, at most `limit`
 * rows, `has_more` true iff a greater rowid exists beyond the page. Scope
 * filters are part of the WHERE clause, so they apply BEFORE the limit:
 * a busy workspace can never crowd a filtered task's rows out of a page.
 * An empty page echoes the cursor (nothing to advance to) — the drain
 * loop terminates because `next_cursor` advances strictly on every page
 * that carries rows and the store is finite.
 *
 * Read-only (rule 4): SELECTs only — it serves from WAL-safe SQLite and
 * writes nothing.
 *
 * A NOTE ON THE "ACTIVE WORKSPACE" DEFAULT (rule table: `workspace_id`
 * "default the active workspace"): the daemon holds NO active-workspace
 * marker — the active workspace is CLI-local state (no switch op exists,
 * documented in src/daemon/server.ts). An absent `workspace_id` therefore
 * scopes to every workspace, exactly like the other list ops.
 */
export function transitionsSince(
  db: Db,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const cursor = intArg(args, "cursor", 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const limit = intArg(args, "limit", 1, MAX_TRANSITION_LIMIT) ?? DEFAULT_TRANSITION_LIMIT;
  const workspaceId = optNonEmptyString(args, "workspace_id");
  const projectId = optNonEmptyString(args, "project_id");
  const taskId = optNonEmptyString(args, "task_id");
  const chainRunId = optNonEmptyString(args, "chain_run_id");
  // events.md rule 5: not_found for unknown workspace/project ids. task_id
  // and chain_run_id are SCOPE, not lookups: an unknown one is an honest
  // empty page (the spec names only the two registry scopes).
  if (workspaceId !== undefined && getWorkspace(db, workspaceId) === undefined) {
    throw new OpError("not_found", `no such workspace: ${workspaceId}`);
  }
  if (projectId !== undefined && getProject(db, projectId) === undefined) {
    throw new OpError("not_found", `no such project: ${projectId}`);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (workspaceId !== undefined) {
    where.push("tp.workspace_id = ?");
    params.push(workspaceId);
  }
  if (projectId !== undefined) {
    where.push("tp.id = ?");
    params.push(projectId);
  }
  if (taskId !== undefined) {
    where.push("t.id = ?");
    params.push(taskId);
  }
  if (chainRunId !== undefined) {
    where.push("t.chain_run_id = ?");
    params.push(chainRunId);
  }

  // the joins supply the readability fields; FKs forbid true orphans, so a
  // deleted-ish reference still resolves (rule 4)
  const SELECT = `SELECT l.rowid AS cursor, l.task_id AS task_id, l.run_id AS run_id,
         t.chain_run_id AS chain_run_id, t.key AS task_key, cp.slug AS chain_slug,
         l.from_state AS from_state, l.to_state AS to_state,
         l.trigger_type AS trigger_type, l.actor AS actor, l.reason AS reason,
         l.created_at AS created_at
    FROM state_transition_logs l
    JOIN tasks t ON t.id = l.task_id
    JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN chain_runs cr ON cr.id = t.chain_run_id
    LEFT JOIN projects cp ON cp.id = cr.project_id`;

  if (cursor === 0) {
    // head: the most recent `limit` rows, read backwards then presented
    // ascending. has_more is false by definition — there is no "after the
    // head" to offer, and older history is deliberately not observable.
    const sql =
      SELECT +
      (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
      " ORDER BY l.rowid DESC LIMIT ?";
    const rows = (db.prepare(sql).all(...params, limit) as TransitionEvent[]).reverse();
    const highest = rows.length === 0 ? 0 : rows[rows.length - 1]!.cursor;
    const page: TransitionsPage = { transitions: rows, next_cursor: highest, has_more: false };
    return page;
  }

  // one row past the page tells us whether more exists — never a COUNT(*),
  // so a page costs one bounded index walk
  const sql = `${SELECT} WHERE ${[...where, "l.rowid > ?"].join(" AND ")} ORDER BY l.rowid ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, cursor, limit + 1) as TransitionEvent[];
  const hasMore = rows.length > limit;
  const transitions = hasMore ? rows.slice(0, limit) : rows;
  const page: TransitionsPage = {
    transitions,
    next_cursor:
      transitions.length === 0 ? cursor : transitions[transitions.length - 1]!.cursor,
    has_more: hasMore,
  };
  return page;
}
