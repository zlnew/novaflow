import { connect, createServer, type Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import { ulid } from "../store/ids.ts";
import { applyTransition, InvalidTransitionError } from "../fsm/engine.ts";
import {
  createTask,
  enqueueTask,
  getTask,
  type CreateTaskTargetScope,
} from "../tasks.ts";
import {
  approveGate,
  confirmFailureGate,
  rejectGate,
  GateError,
  type GatePayload,
  type GateSurface,
} from "../gates.ts";
import { validateProfile, ProfileValidationError } from "../profiles.ts";
import {
  canonicalProfilePath,
  countProfilePins,
  deleteProfile,
  profileMatchesRow,
  resolveProfileRow,
  updateProfile,
} from "../profiles.ts";
import {
  ProfileUnresolvedError,
  probeCatalog,
  type ProbeOptions,
} from "../catalog.ts";
import {
  createWorkspace,
  getWorkspace,
  isWritableDirectory,
  resolveWorkspaceArg,
  setWorkspaceStatus,
  deleteWorkspace,
  WORKSPACE_NAME_PATTERN,
  type WorkspaceRow,
} from "../workspaces.ts";
import {
  createProject,
  getProject,
  listProjectTargets,
  projectTaskCounts,
  setProjectPhase,
  MAX_PHASE_LENGTH,
  PROJECT_NAME_PATTERN,
  type ProjectTargetInput,
} from "../projects.ts";
import { bareId, isUlid } from "../store/ids.ts";
import { RetryBudgetExhaustedError } from "../validating.ts";
import { parseCron, nextRun } from "../sched/cron.ts";
import { parseIsoRunAt, canonicalTimestamp } from "../sched/iso.ts";
import { nextOccurrenceAt, type ScheduleRow } from "./schedules.ts";
import { loadWorkspaceConfig, DEFAULT_MISSED_RUN_POLICY } from "../config.ts";
import type { DaemonConfig } from "../daemonconfig.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { RetryEvaluator } from "./retry.ts";
import { abortTriggerFor } from "./triggers.ts";
import {
  backupDaemonStore,
  pruneRawEventStreams,
  DEFAULT_RETENTION_DAYS,
} from "./maintenance.ts";
import { BackupRefusedError } from "../store/backup.ts";
import { DocReferenceError, indexDocs, resolveDocReferences } from "../docs.ts";
import {
  importChain,
  getChainRun,
  setChainRunAborted,
  listChainMembers,
  ChainValidationError,
} from "../chain/import.ts";
import { memberReadiness, type ChainEvaluator } from "../chain/readiness.ts";
import { deliveredFeedbackPaths, driveSelfPathRequeue, type RoutingEvaluator } from "../chain/routing.ts";
import { parseYaml, YamlParseError } from "../chain/yaml.ts";
import {
  latestRun,
  projectList as readProjectList,
  requireTask,
  resultGet as readResultGet,
  runById,
  runLogs as readRunLogs,
  taskList as readTaskList,
  taskStatus as readTaskStatus,
  transitionsSince as readTransitionsSince,
  workspaceList as readWorkspaceList,
  runLogsSince as readRunLogsSince,
} from "./readops.ts";
import {
  invalidTargetAlias,
  pruneWorktrees,
  removeWorktree,
  runWorktreeTargets,
  worktreeIsDirty,
} from "../runs/worktrees.ts";
import {
  OpError,
  optBoolean,
  optNonEmptyString,
  optString,
  optStringArray,
  reqString,
} from "../opcodes.ts";
import type { TaxonomyCode } from "../opcodes.ts";

/**
 * THE v1 CONTROL PLANE (architecture 8.1, control-surface transport):
 * a loopback Unix domain socket, JSONL, the daemon owning every state
 * write — the CLI (p3b) and the MCP server (p5) are thin clients of
 * exactly this surface. No TCP, no HTTP (srs 4.3; a missing socket is
 * the CLIENT's `daemon_unreachable`, exit 5).
 *
 * WIRE CONTRACT (v1, spec-pinned where marked; the rest is this card's
 * documented envelope — MCP p5 and CLI p3b build on it):
 *   - one JSON request per line:
 *       {"id": <any JSON scalar, echoed verbatim>, "op": "<name>",
 *        "args": {…}, "surface": "human" | "mcp"}
 *     `args` defaults to {}; `surface` defaults to "human" and is the
 *     recorded trigger_type for mutating ops (mcp.md §5 audit rule).
 *   - one JSON response per line, in request order (per-connection
 *     serialization):
 *       {"id": <echo>, "ok": true, "data": …}
 *       {"id": <echo>, "ok": false, "error": {"code": "<taxonomy>", "message": "…"}}
 *     A non-JSON or non-object request answers with id null and code
 *     `schema_invalid`.
 *   - the error taxonomy is EXACTLY the srs 4.1.1 row: invalid_transition,
 *     schema_invalid, preflight_failed, budget_exceeded, not_found,
 *     daemon_unreachable, duplicate, aborted, profile_unresolved.
 *     Spec-silent mappings (documented): an unknown op is `not_found`
 *     (the requested operation does not exist — `schema_invalid` is
 *     reserved for payload violations); a GateError's wrong_state and
 *     stale_run map to invalid_transition (an operation not legal in
 *     the current state), missing_field to schema_invalid; a stored
 *     profile that fails §4.2 structural validation maps to
 *     schema_invalid (profile_unresolved is the catalog-probe
 *     rejection, used at enqueue); an unexpected internal failure maps
 *     to `aborted` (the operation did not complete) with the original
 *     message preserved.
 *
 * Socket discipline (security TB-1): the socket file is chmod 0600 at
 * bind — operator-user only. Stale-socket handling: on EADDRINUSE the
 * server probes whether a live daemon answers nova_daemon_status; a
 * live answer refuses the bind (never steal a live socket), a refused
 * connection unlinks the stale file and rebinds. A connection that
 * accepts but stays silent is treated as live (conservative: the
 * operator investigates; the daemon never steals a maybe-live socket).
 *
 * Write discipline: every state write goes through the guarded
 * services (applyTransition / startRun via dispatch / the gate
 * service); this module NEVER issues a raw state UPDATE (grep-pinned
 * by tests).
 */

/**
 * The taxonomy itself lives in src/opcodes.ts so the MCP server's
 * SQLite-direct fallback (src/mcp/read.ts) raises the SAME typed
 * failures this op table raises (mcp.md §4: one error taxonomy).
 * Re-exported here for the established import sites.
 */
export type { TaxonomyCode } from "../opcodes.ts";
export { OpError } from "../opcodes.ts";

export type SocketSurface = "human" | "mcp";

export type EnqueueInjection = {
  piBin?: string | undefined;
  args?: string[] | undefined;
  timeoutMs?: number | undefined;
};

export type ServerDeps = {
  db: Db;
  dispatcher: Dispatcher;
  retry: RetryEvaluator;
  /** The chain readiness/terminal evaluator (p4a chains; FR-TSK-07). */
  chains: ChainEvaluator;
  /** The chain feedback-routing evaluator (p4b; 8.1 feedback + failure routing rules). */
  routing: RoutingEvaluator;
  /**
   * The gate-approved verification driver (p4b — the p4a residual):
   * invoked by nova_gate_approve AFTER the awaiting_gate→validating
   * move; runs the SAME verification pipeline the settle seam uses so
   * the ENGINE still decides the validating→terminal verdict
   * (FR-TSK-12 — approving never bypasses verification). Fire-and-
   * forget: the op returns at validating, the verdict lands async.
   */
  onGateApproved: (taskId: string, runId: string) => void;
  /** The daemon's in-memory paused-chain set (FR-TSK-08 scheduler level). */
  pausedChains: Set<string>;
  daemonConfig: DaemonConfig;
  /** The full nova_daemon_status payload (lifecycle owns uptime/version/budgets). */
  daemonStatus: () => Record<string, unknown>;
  /**
   * The store's on-disk path — the ONLY thing nova_daemon_backup needs
   * besides the handle itself (the default destination sits alongside it).
   * The daemon owns the store, so this is daemon state, not CLI state.
   */
  dbPath: string;
  /** Invoked AFTER the nova_daemon_stop response is written. */
  requestStop: () => void | Promise<void>;
  /** Catalog-probe injection for nova_task_run (tests point at the stub). */
  enqueueOptions?: EnqueueInjection | undefined;
};

export type ControlServer = {
  socketPath: string;
  /**
   * Stop accepting, DESTROY every tracked connection, then unlink the
   * socket file. An op still executing when close() runs is NOT awaited
   * for delivery: its handler continuation finishes on the store side,
   * but the response frame is dropped (the socket is destroyed — the
   * write is a no-op on a destroyed stream). Resolves once the listener
   * itself is closed. (The lifecycle's stop() ordering — socket first,
   * then dispatcher, timers, store — is what actually bounds in-flight
   * work.)
   */
  close: () => Promise<void>;
};

/* ------------------------------ arg validation ------------------------------ */
// the shared validators (src/opcodes.ts) — imported above, re-used here so
// the socket and the MCP fallback validate identically

/**
 * mcp.md §3.2 optional payload parts of nova_task_create, validated
 * against the data.md 4.3 shapes: overrides
 * ({timeout_sec?, max_cost_usd?, thinking_level?}, additionalProperties
 * false), output_schema_version (non-empty string), and target_scopes
 * (repo_alias + access_mode, optional string-array fields; column
 * defaults apply when omitted).
 */
function parseOverridesArg(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = args["overrides"];
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new OpError(
      "schema_invalid",
      "args.overrides must be a JSON object (timeout_sec, max_cost_usd, thinking_level — FR-AGT-03)",
    );
  }
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "timeout_sec" && key !== "max_cost_usd" && key !== "thinking_level") {
      throw new OpError(
        "schema_invalid",
        `args.overrides has an unknown key "${key}" (allowed: timeout_sec, max_cost_usd, thinking_level — FR-AGT-03)`,
      );
    }
  }
  if ("timeout_sec" in o) {
    const t = o["timeout_sec"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1) {
      throw new OpError("schema_invalid", "args.overrides.timeout_sec must be an integer >= 1");
    }
  }
  if ("max_cost_usd" in o) {
    const m = o["max_cost_usd"];
    if (typeof m !== "number" || !Number.isFinite(m) || m < 0) {
      throw new OpError("schema_invalid", "args.overrides.max_cost_usd must be a number >= 0");
    }
  }
  if ("thinking_level" in o) {
    const t = o["thinking_level"];
    if (typeof t !== "string" || t.trim() === "") {
      throw new OpError("schema_invalid", "args.overrides.thinking_level must be a non-empty string");
    }
  }
  return o;
}

function parseTargetScopesArg(
  db: Db,
  projectId: string,
  args: Record<string, unknown>,
): CreateTaskTargetScope[] | undefined {
  const v = args["target_scopes"];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new OpError(
      "schema_invalid",
      "args.target_scopes must be an array of {repo_alias, access_mode, …} scope objects",
    );
  }
  const out: CreateTaskTargetScope[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new OpError(
        "schema_invalid",
        "args.target_scopes items must be objects {repo_alias, access_mode, …}",
      );
    }
    const o = item as Record<string, unknown>;
    // data.md 4.3: scope items are closed (additionalProperties false) —
    // a typo'd field is refused, not silently dropped (re-judge finding 2).
    const KNOWN_SCOPE_KEYS = new Set([
      "repo_alias", "access_mode", "write_scope_globs",
      "protected_test_globs", "verification_commands",
    ]);
    for (const k of Object.keys(o)) {
      if (!KNOWN_SCOPE_KEYS.has(k)) {
        throw new OpError(
          "schema_invalid",
          `args.target_scopes items carry an unknown key "${k}" — keys are closed per the scope schema`,
        );
      }
    }
    const alias = reqString(o, "repo_alias");
    const accessMode = o["access_mode"];
    if (accessMode !== "read_only" && accessMode !== "read_write") {
      throw new OpError(
        "schema_invalid",
        'args.target_scopes access_mode must be "read_only" or "read_write"',
      );
    }
    const writeScopeGlobs = optStringArray(o, "write_scope_globs");
    const protectedTestGlobs = optStringArray(o, "protected_test_globs");
    const verificationCommands = optStringArray(o, "verification_commands");
    const target = db
      .prepare("SELECT id FROM project_targets WHERE project_id = ? AND alias = ?")
      .get(projectId, alias) as { id: string } | undefined;
    if (!target) {
      throw new OpError("not_found", `project has no target with repo_alias "${alias}"`);
    }
    if (out.some((s) => s.targetId === target.id)) {
      // UNIQUE(task_id, target_id) inside the transaction would report a
      // misleading "task key already exists" — refuse truthfully here first.
      throw new OpError(
        "duplicate",
        `args.target_scopes carries repo_alias "${alias}" twice — one scope row per target`,
      );
    }
    out.push({
      targetId: target.id,
      accessMode,
      ...(writeScopeGlobs !== undefined ? { writeScopeGlobs } : {}),
      ...(protectedTestGlobs !== undefined ? { protectedTestGlobs } : {}),
      ...(verificationCommands !== undefined ? { verificationCommands } : {}),
    });
  }
  return out;
}

/* ------------------------------ shared queries ------------------------------ */

/** Resolve `{workspace_id}` (id form) or throw not_found. */
function requireWorkspaceById(db: Db, workspaceId: string): WorkspaceRow {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) throw new OpError("not_found", `no such workspace: ${workspaceId}`);
  return workspace;
}

/** Resolve the op arg shape `{workspace_id} | {slug}` or throw not_found. */
function requireWorkspaceArg(db: Db, args: Record<string, unknown>): WorkspaceRow {
  const workspace = resolveWorkspaceArg(db, args);
  if (!workspace) {
    throw new OpError("not_found", `no such workspace: ${String(args["workspace_id"] ?? args["slug"])}`);
  }
  return workspace;
}

/**
 * project_targets payload (FR-PRJ-01/03, data.md DDL): closed keys,
 * alias + root_path + target_type required, DDL-typed optional columns.
 * A repeated alias in one payload is refused truthfully (UNIQUE(project_id,
 * alias) would otherwise surface as a misleading message).
 */
function parseTargetsArg(args: Record<string, unknown>): ProjectTargetInput[] | undefined {
  const v = args["targets"];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new OpError(
      "schema_invalid",
      "args.targets must be an array of {alias, root_path, target_type, ...}",
    );
  }
  const KNOWN_TARGET_KEYS = new Set([
    "alias", "root_path", "target_type", "base_branch", "branch_prefix", "default_access",
  ]);
  const out: ProjectTargetInput[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new OpError(
        "schema_invalid",
        "args.targets items must be objects {alias, root_path, target_type, ...}",
      );
    }
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!KNOWN_TARGET_KEYS.has(k)) {
        throw new OpError(
          "schema_invalid",
          `args.targets items carry an unknown key "${k}" — keys are closed per the DDL`,
        );
      }
    }
    const alias = reqString(o, "alias");
    const badAlias = invalidTargetAlias(alias);
    if (badAlias !== null) {
      throw new OpError(
        "schema_invalid",
        `args.targets alias is invalid: ${badAlias}`,
      );
    }
    const rootPath = reqString(o, "root_path");
    const targetType = o["target_type"];
    if (targetType !== "git_repo" && targetType !== "directory") {
      throw new OpError(
        "schema_invalid",
        'args.targets target_type must be "git_repo" or "directory"',
      );
    }
    const defaultAccess = o["default_access"];
    if (
      defaultAccess !== undefined &&
      defaultAccess !== "read_only" &&
      defaultAccess !== "read_write"
    ) {
      throw new OpError(
        "schema_invalid",
        'args.targets default_access must be "read_only" or "read_write"',
      );
    }
    const baseBranch = optNonEmptyString(o, "base_branch");
    const branchPrefix = optNonEmptyString(o, "branch_prefix");
    if (out.some((t) => t.alias === alias)) {
      throw new OpError(
        "duplicate",
        `args.targets carries alias "${alias}" twice — one target row per alias`,
      );
    }
    out.push({
      alias,
      root_path: rootPath,
      target_type: targetType,
      ...(baseBranch !== undefined ? { base_branch: baseBranch } : {}),
      ...(branchPrefix !== undefined ? { branch_prefix: branchPrefix } : {}),
      ...(defaultAccess !== undefined ? { default_access: defaultAccess } : {}),
    });
  }
  return out;
}

/** mcp.md §3.2 payload is {project_id, key, title, objective, profile_name…}. */
function resolveProfileByName(db: Db, projectId: string, name: string): string {
  const project = db
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .get(projectId) as { workspace_id: string } | undefined;
  if (!project) throw new OpError("not_found", `no such project: ${projectId}`);
  // workspace-scoped FIRST (NULLS-last on the workspace column): a stale
  // global row must never shadow the workspace's own profile — found in
  // real use when a trial-era global "worker" (with a prompt path that no
  // longer resolved) silently beat the workspace fleet on rowid order.
  // The rule lives in src/profiles.ts's resolveProfileRow so the p5
  // lifecycle verbs resolve through the very same statement.
  const row = resolveProfileRow(db, name, project.workspace_id);
  if (!row) {
    throw new OpError("not_found", `no profile named "${name}" in the project's workspace`);
  }
  if (process.env["NF_DEBUG_PROFILE"] === "1") {
  }
  return row.id;
}

/**
 * The catalog-probe injection seam (tests point it at the stub): the
 * enqueue gate and the p5 profile lifecycle verbs probe through the SAME
 * options, so an injected stub covers both paths.
 */
function probeOptions(injection: EnqueueInjection | undefined): ProbeOptions {
  return {
    ...(injection?.piBin !== undefined ? { piBin: injection.piBin } : {}),
    ...(injection?.args !== undefined ? { args: injection.args } : {}),
    ...(injection?.timeoutMs !== undefined ? { timeoutMs: injection.timeoutMs } : {}),
  };
}

/* --------------------------------- op table --------------------------------- */

export type OpContext = {
  surface: SocketSurface;
  deps: ServerDeps;
};

type OpHandler = (args: Record<string, unknown>, ctx: OpContext) => unknown | Promise<unknown>;

function gatePayload(
  db: Db,
  args: Record<string, unknown>,
  defaults: { fillRun?: boolean; approvedBy?: string; note?: string } = {},
): GatePayload {
  let runId: string;
  if (args["run_id"] === undefined && defaults.fillRun) {
    const live = latestRun(db, reqString(args, "task_id"));
    if (!live) throw new OpError("not_found", "task has no runs");
    runId = live.id;
  } else {
    runId = reqString(args, "run_id");
  }
  return {
    task_id: reqString(args, "task_id"),
    run_id: runId,
    approved_by: optString(args, "approved_by", defaults.approvedBy ?? "operator"),
    note: optString(args, "note", defaults.note ?? ""),
  };
}

export function buildOpTable(): Map<string, OpHandler> {
  const ops = new Map<string, OpHandler>();

  /* ----------------------------- read-only ops ----------------------------- */

  // srs 4.1.1 task-identifier resolution: ULID direct (bare or tsk_
  // display form), key within the workspace context. The CLI is a thin
  // client (it never opens the store), so the daemon serves the lookup.
  ops.set("nova_task_resolve", (args, { deps }) => {
    const ident = reqString(args, "ident");
    const bare = isUlid(ident) || (ident.startsWith("tsk_") && isUlid(ident.slice(4)))
      ? bareId(ident)
      : null;
    if (bare !== null) {
      const task = getTask(deps.db, bare);
      if (!task) throw new OpError("not_found", `no such task: ${ident}`);
      return { task };
    }
    // the human key: resolved within the workspace context — the CLI's
    // active-workspace scope (a key may repeat across projects, so an
    // ambiguous key is a truthful duplicate, never a silent pick)
    if (args["workspace_id"] === undefined) {
      throw new OpError(
        "schema_invalid",
        "key-form identifiers require workspace_id — no workspace context was given",
      );
    }
    const workspace = requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const rows = deps.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE p.workspace_id = ? AND t.key = ?`,
      )
      .all(workspace.id, ident) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new OpError(
        "not_found",
        `no task with key "${ident}" in workspace "${workspace.slug}"`,
      );
    }
    if (rows.length > 1) {
      throw new OpError(
        "duplicate",
        `key "${ident}" matches ${rows.length} tasks in workspace "${workspace.slug}" — use the ULID id`,
      );
    }
    const task = getTask(deps.db, rows[0]!.id);
    if (!task) throw new OpError("not_found", `no such task: ${rows[0]!.id}`);
    return { task };
  });

  ops.set("nova_task_status", (args, { deps }) =>
    // shared body (src/daemon/readops.ts) — the MCP daemon-down fallback
    // serves the identical envelope (mcp.md §4)
    readTaskStatus(deps.db, { task_id: reqString(args, "task_id") }),
  );

  ops.set("nova_task_list", (args, { deps }) =>
    readTaskList(deps.db, {
      ...(args["project_id"] === undefined ? {} : { project_id: reqString(args, "project_id") }),
      ...(args["state"] === undefined ? {} : { state: reqString(args, "state") }),
    }),
  );

  // mcp.md §3.1 tool table: the wire name is `nova_result_get` — never
  // `nova_task_result` (one contract, no alias; the MCP server (p5) and
  // the CLI (p3b) build on exactly this name).
  ops.set("nova_result_get", (args, { deps }) =>
    readResultGet(deps.db, {
      task_id: reqString(args, "task_id"),
      ...(args["run_id"] === undefined ? {} : { run_id: reqString(args, "run_id") }),
    }),
  );

  ops.set("nova_run_logs", (args, { deps }) =>
    // FR-LOG-02: the run's log pointer IS the redacted read surface
    // (events_log_path = events.jsonl). The raw file is never served.
    readRunLogs(deps.db, {
      task_id: reqString(args, "task_id"),
      ...(args["run_id"] === undefined ? {} : { run_id: reqString(args, "run_id") }),
      ...(args["tail_lines"] === undefined ? {} : { tail_lines: args["tail_lines"] }),
    }),
  );

  /**
   * `nova_run_logs_since` (novaflow-v02/watch.md) — the run-log follow window.
   * The body lives beside `runLogs` in src/daemon/readops.ts and reads through
   * the SAME redacted-file path (never `events.raw.jsonl`, never a second
   * scrubber); the op table only routes. `offset`, `limit` and `tail_lines`
   * pass through unvalidated so the body stays the one rejection surface
   * (schema_invalid), exactly like `nova_transitions_since` below.
   */
  ops.set("nova_run_logs_since", (args, { deps }) =>
    readRunLogsSince(deps.db, {
      task_id: reqString(args, "task_id"),
      ...(args["run_id"] === undefined ? {} : { run_id: reqString(args, "run_id") }),
      ...(args["offset"] === undefined ? {} : { offset: args["offset"] }),
      ...(args["limit"] === undefined ? {} : { limit: args["limit"] }),
      ...(args["tail_lines"] === undefined ? {} : { tail_lines: args["tail_lines"] }),
    }),
  );

  ops.set("nova_profile_list", (args, { deps }) => {
    // workspace filter (p3b, documented): the workspace's own profiles
    // plus the global defaults — together the resolution universe
    // (data.md 4.3: workspace-local first, then global).
    if (args["workspace_id"] === undefined) {
      return { profiles: deps.db.prepare("SELECT * FROM agent_profiles ORDER BY name").all() };
    }
    const workspace = requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const profiles = deps.db
      .prepare(
        "SELECT * FROM agent_profiles WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY name",
      )
      .all(workspace.id);
    return { profiles };
  });

  ops.set("nova_profile_validate", (args, { deps }) => {
    const profileId = reqString(args, "profile_id");
    const row = deps.db
      .prepare("SELECT * FROM agent_profiles WHERE id = ?")
      .get(profileId) as
      | {
          name: string; role: string | null; provider: string; model: string;
          thinking_level: string; system_prompt_path: string; tools_allowlist_json: string;
          max_timeout_sec: number; max_cost_usd: number;
        }
      | undefined;
    if (!row) throw new OpError("not_found", `no such profile: ${profileId}`);
    // Structural validation only (the §4.2 schema, zero tokens). The live
    // catalog probe is the enqueue gate's duty (8.1 catalog validation).
    let tools: unknown;
    try {
      tools = JSON.parse(row.tools_allowlist_json);
    } catch {
      throw new OpError("schema_invalid", `stored tools_allowlist_json is not valid JSON for profile ${profileId}`);
    }
    const profile = validateProfile({
      name: row.name,
      ...(row.role !== null ? { role: row.role } : {}),
      provider: row.provider,
      model: row.model,
      thinking_level: row.thinking_level,
      tools_allowlist: tools,
      system_prompt_path: row.system_prompt_path,
      limits: { max_timeout_sec: row.max_timeout_sec, max_cost_usd: row.max_cost_usd },
    });
    return { ok: true, profile_id: profileId, name: profile.name };
  });

  ops.set("nova_daemon_status", (_args, { deps }) => deps.daemonStatus());

  /**
   * `nova_transitions_since` (novaflow-v02/events.md — the v0.2.0 transition
   * stream). The cursor rules, the head semantics and the read-only pledge
   * live in the shared body (src/daemon/readops.ts) so every surface serves
   * the identical page; the op table only routes.
   *
   * Argument validation happens in that body (it validates `cursor`,
   * `limit`, the four scope ids uniformly), so the op passes the args
   * through rather than pre-validating a subset here.
   *
   * Daemon-down rule (events.md rule 6): this op has NO SQLite fallback —
   * src/mcp/server.ts keeps it out of the store-backed read path, because a
   * liveness feed served from a store whose writer just died would report a
   * frozen world as current.
   */
  ops.set("nova_transitions_since", (args, { deps }) => readTransitionsSince(deps.db, args));

  /* -------------------- storage maintenance (p7; data.md 1.1/1.2) -------------------- */

  /**
   * data.md 1.1 "Database Backup Strategy" (MUST): live backups go through
   * the SQLite online backup API. The op runs the copy IN THE DAEMON — it
   * owns the store handle, so no other process ever opens the live file to
   * take a backup (`src/daemon/maintenance.ts` → `src/store/backup.ts`).
   * Default destination: alongside the store, `state.db.bak-<stamp>`.
   * Attempting to write over an existing destination is `duplicate`.
   */
  ops.set("nova_daemon_backup", async (args, { deps }) => {
    const out = optNonEmptyString(args, "out");
    try {
      return await backupDaemonStore(deps.db, deps.dbPath, out === undefined ? {} : { out });
    } catch (err) {
      if (err instanceof BackupRefusedError) {
        // an existing destination is the taxonomy's `duplicate`; anything
        // else the operator got wrong is `schema_invalid`
        throw new OpError(/already exists/.test(err.message) ? "duplicate" : "schema_invalid", err.message);
      }
      throw err;
    }
  });

  /**
   * data.md 1.2 "Log Pruning & Rotation" (MAY): purge run-dir
   * `events.raw.jsonl` files older than the retention window. The path
   * allowlist — never a glob walk — lives in the op body.
   */
  ops.set("nova_daemon_prune", (args, { deps }) => {
    const raw = args["retention_days"];
    let retentionDays = DEFAULT_RETENTION_DAYS;
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw new OpError(
          "schema_invalid",
          "args.retention_days must be a non-negative integer",
        );
      }
      retentionDays = raw;
    }
    return pruneRawEventStreams(deps.db, { retentionDays });
  });

  /* --------------- workspace / project / profile setup ops (p3b) -------------- */

  // FR-WS-01: create + register. The op validates (single writer: the
  // pre-check cannot race a second creator); the service owns every
  // store + filesystem effect.
  ops.set("nova_workspace_create", (args, { deps }) => {
    const name = reqString(args, "name");
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new OpError(
        "schema_invalid",
        `workspace name must be lower-case kebab-case (${WORKSPACE_NAME_PATTERN}), got "${name}"`,
      );
    }
    const rootPath = resolve(reqString(args, "root_path"));
    if (!isWritableDirectory(rootPath)) {
      throw new OpError(
        "schema_invalid",
        `root_path is not an existing writable directory: ${rootPath}`,
      );
    }
    if (deps.db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(name) !== undefined) {
      throw new OpError("duplicate", `a workspace named "${name}" already exists`);
    }
    if (deps.db.prepare("SELECT id FROM workspaces WHERE root_path = ?").get(rootPath) !== undefined) {
      throw new OpError("duplicate", `root_path is already registered to another workspace: ${rootPath}`);
    }
    const workspace = createWorkspace(deps.db, {
      name,
      rootPath,
      defaultBranch: optString(args, "default_branch", "main"),
    });
    // FR-WS-01 AC3: reports the unique workspace id (bare ULID, data 5.1)
    return { id: workspace.id, workspace };
  });

  ops.set("nova_workspace_list", (_args, { deps }) => readWorkspaceList(deps.db));

  /**
   * FR-WS-04 AC2 — the selectable prompt-injection list: every `.md`/`.txt`/
   * `.rst` document under `<workspace_root>/docs/`, computed by a SCAN at
   * call time (src/docs.ts: no watcher, no daemon state, nothing to go
   * stale). The workspace resolves from an id/slug arg; absent, the single
   * registered workspace is implied, and an ambiguous registry refuses
   * rather than picking one silently. A missing docs directory is an honest
   * empty list (FR-WS-02 creates `docs/` at registration, but an operator
   * may have removed it).
   */
  ops.set("nova_docs_list", (args, { deps }) => {
    const workspace =
      args["workspace_id"] === undefined && args["slug"] === undefined
        ? (() => {
            const rows = deps.db.prepare("SELECT * FROM workspaces ORDER BY created_at, id").all() as WorkspaceRow[];
            if (rows.length === 0) {
              throw new OpError("not_found", "no workspace is registered — register one first (nova workspace create)");
            }
            if (rows.length > 1) {
              throw new OpError(
                "schema_invalid",
                `${rows.length} workspaces are registered — name one (nova docs list <workspace>)`,
              );
            }
            return rows[0]!;
          })()
        : requireWorkspaceArg(deps.db, args);
    return {
      workspace: workspace.slug,
      workspace_id: workspace.id,
      docs_dir: join(workspace.root_path, "docs"),
      docs: indexDocs(workspace.root_path),
    };
  });

  // FR-WS-03 AC2: archive disables execution (dispatch skips non-active
  // workspaces). Idempotent by design: archiving an archived workspace
  // is a no-op success (documented). NO switch op exists — the active
  // workspace marker is CLI-local state (srs 4.1.1 names `nova workspace
  // switch` a CLI concern; the daemon stays stateless about which
  // workspace the operator is looking at).
  ops.set("nova_workspace_archive", (args, { deps }) => {
    const workspace = requireWorkspaceArg(deps.db, args);
    setWorkspaceStatus(deps.db, workspace.id, "archived");
    return { workspace_id: workspace.id, slug: workspace.slug, status: "archived" };
  });

  // FR-WS-03 AC1: remove the DB entry (cascades per the DDL) and NEVER
  // touch files. A workspace that still has tasks is refused by the
  // store's FK RESTRICT — surfaced as `aborted` with the store's message.
  ops.set("nova_workspace_unregister", (args, { deps }) => {
    const workspace = requireWorkspaceArg(deps.db, args);
    deleteWorkspace(deps.db, workspace.id);
    return { unregistered: workspace.slug, files_untouched: true };
  });

  // FR-PRJ-01: project + 0..N project_targets in one transaction, plus
  // the canonical project directory under the workspace root.
  ops.set("nova_project_create", (args, { deps }) => {
    const workspace = requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const name = reqString(args, "name");
    if (!PROJECT_NAME_PATTERN.test(name)) {
      throw new OpError(
        "schema_invalid",
        `project name must be lower-case kebab-case (${PROJECT_NAME_PATTERN}), got "${name}"`,
      );
    }
    const objective = reqString(args, "objective");
    const targets = parseTargetsArg(args);
    if (deps.db.prepare("SELECT id FROM projects WHERE workspace_id = ? AND slug = ?").get(workspace.id, name) !== undefined) {
      throw new OpError("duplicate", `a project named "${name}" already exists in workspace "${workspace.slug}"`);
    }
    try {
      return createProject(deps.db, {
        workspaceId: workspace.id,
        name,
        objective,
        ...(targets !== undefined ? { targets } : {}),
        workspaceRoot: workspace.root_path,
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        throw new OpError("duplicate", `a project named "${name}" already exists in workspace "${workspace.slug}"`);
      }
      throw err;
    }
  });

  // workspace-scoped when workspace_id is given; otherwise every
  // workspace's projects (documented).
  ops.set("nova_project_list", (args, { deps }) =>
    readProjectList(deps.db, {
      ...(args["workspace_id"] === undefined
        ? {}
        : { workspace_id: reqString(args, "workspace_id") }),
    }),
  );

  ops.set("nova_project_status", (args, { deps }) => {
    const projectId = reqString(args, "project_id");
    const project = getProject(deps.db, projectId);
    if (!project) throw new OpError("not_found", `no such project: ${projectId}`);
    return {
      project,
      task_counts: projectTaskCounts(deps.db, projectId),
      targets: listProjectTargets(deps.db, projectId),
    };
  });

  // FR-PRJ-02: free-text label, no transition rules; every CHANGE is
  // audited with the triggering identity (migration 0002's audit surface).
  ops.set("nova_project_phase_set", (args, { deps }) => {
    const projectId = reqString(args, "project_id");
    const phase = reqString(args, "phase");
    if (phase.length > MAX_PHASE_LENGTH) {
      throw new OpError(
        "schema_invalid",
        `phase label is ${phase.length} characters — the documented bound is ${MAX_PHASE_LENGTH}`,
      );
    }
    const actor = optString(args, "actor", "operator");
    if (!getProject(deps.db, projectId)) {
      throw new OpError("not_found", `no such project: ${projectId}`);
    }
    const outcome = setProjectPhase(deps.db, projectId, phase, actor);
    return { project_id: projectId, phase, changed: outcome.changed };
  });

  // FR-AGT-01: read + structurally validate the profile file (§4.2
  // validator, zero tokens — the live catalog probe is the enqueue
  // gate's duty), insert the row, store the canonical file at
  // <root>/.novaflow/profiles/<name>.json. The source file is read,
  // never moved. Without workspace_id the profile is GLOBAL (row only —
  // data 5.2 has no canonical home for global profiles in v1).
  ops.set("nova_profile_create", (args, { deps }) => {
    const filePath = reqString(args, "file_path");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new OpError(
        "schema_invalid",
        `profile file unreadable or not JSON: ${filePath} (${(err as Error).message})`,
      );
    }
    const profile = validateProfile(raw); // ProfileValidationError -> schema_invalid
    const workspace =
      args["workspace_id"] === undefined
        ? undefined
        : requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const existing = deps.db
      .prepare(
        "SELECT id FROM agent_profiles WHERE name = ? AND workspace_id IS ?",
      )
      .get(profile.name, workspace?.id ?? null);
    if (existing !== undefined) {
      throw new OpError(
        "duplicate",
        `a profile named "${profile.name}" already exists in ${workspace ? `workspace "${workspace.slug}"` : "the global scope"}`,
      );
    }
    let canonicalPath: string | null = null;
    if (workspace !== undefined) {
      canonicalPath = canonicalProfilePath(workspace.root_path, profile.name);
      writeFileSync(canonicalPath, JSON.stringify(raw, null, 2) + "\n");
    }
    const id = ulid();
    try {
      deps.db
        .prepare(
          `INSERT INTO agent_profiles
             (id, workspace_id, name, role, provider, model, thinking_level,
              tools_allowlist_json, system_prompt_path, max_timeout_sec, max_cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspace?.id ?? null,
          profile.name,
          profile.role ?? null,
          profile.provider,
          profile.model,
          profile.thinking_level,
          JSON.stringify(profile.tools_allowlist),
          profile.system_prompt_path,
          profile.limits.max_timeout_sec,
          profile.limits.max_cost_usd,
        );
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        throw new OpError("duplicate", `a profile named "${profile.name}" already exists`);
      }
      throw err;
    }
    const row = deps.db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as Record<string, unknown>;
    return { profile: row, canonical_path: canonicalPath };
  });

  /**
   * DEBT-008 (v0.2.0 P5): change a stored profile in place. The verb is
   * `update`, NOT the frozen roadmap's `archive` — `agent_profiles` has no
   * archived column and v0.2.0 is pinned to one migration (the deviation
   * is recorded in the v0.2 amendments by the parent).
   *
   * Contract:
   *   - the file's `name` MUST equal `<name>`: renaming is not an update
   *     (schema_invalid; delete + create is the rename path);
   *   - the SAME §4.2 validator and the SAME live catalog probe the enqueue
   *     gate spends run BEFORE any write, so an invalid profile or an
   *     unresolvable model leaves the store and the file untouched;
   *   - then the row and the canonical `<ws>/.novaflow/profiles/<name>.json`
   *     are rewritten in ONE transaction (src/profiles.ts updateProfile);
   *   - a file identical to the stored profile is REFUSED as `duplicate`
   *     ("no change") — this verb never rewrites identical state.
   *
   * Scope: resolved exactly as the engine resolves a task's profile
   * (workspace-scoped first, then global), and the answer REPORTS the scope
   * it acted on — never a silent pick.
   */
  ops.set("nova_profile_update", async (args, { deps }) => {
    const name = reqString(args, "name");
    const raw = args["profile"];
    if (raw === undefined) {
      throw new OpError(
        "schema_invalid",
        'args.profile is required — it carries the profile file\'s raw JSON document ({"name", "provider", "model", …}, data.md 4.2)',
      );
    }
    const profile = validateProfile(raw); // ProfileValidationError -> schema_invalid
    if (profile.name !== name) {
      throw new OpError(
        "schema_invalid",
        `profile file names "${profile.name}" but the update targets "${name}" — renaming is not an update (delete + create instead)`,
      );
    }
    const workspace =
      args["workspace_id"] === undefined
        ? undefined
        : requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const row = resolveProfileRow(deps.db, name, workspace?.id);
    if (!row) {
      throw new OpError(
        "not_found",
        `no profile named "${name}" in ${workspace ? `workspace "${workspace.slug}" or the global scope` : "the global scope"}`,
      );
    }
    // the scope actually acted on comes from the ROW, not the request
    const scope = row.workspace_id === null ? "global" : "workspace";
    const scopeLabel = scope === "global" ? "global" : "workspace-scoped";
    // the live catalog probe (architecture 8.1), before any write: a model
    // the catalog cannot resolve is profile_unresolved, nothing written
    const probe = await probeCatalog(
      {
        provider: profile.provider,
        model: profile.model,
        thinking_level: profile.thinking_level,
      },
      probeOptions(deps.enqueueOptions),
    );
    if (!probe.ok) throw new ProfileUnresolvedError(probe.reason);
    if (profileMatchesRow(row, profile)) {
      throw new OpError(
        "duplicate",
        `no change: profile "${name}" (${scopeLabel}) already matches the file — nothing was written`,
      );
    }
    const canonicalPath =
      row.workspace_id === null
        ? null
        : canonicalProfilePath(requireWorkspaceById(deps.db, row.workspace_id).root_path, name);
    let updated: ReturnType<typeof updateProfile>;
    try {
      updated = updateProfile(deps.db, { row, profile, raw, canonicalPath });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // the row update rolls back with the file write (one transaction); the
      // message names the canonical path so the operator can repair it. A
      // store failure (no fs errno) is not a payload violation — rethrow.
      if (typeof e.code !== "string" || !/^E[A-Z]+$/.test(e.code)) throw err;
      throw new OpError(
        "schema_invalid",
        `canonical profile file write failed for "${name}" (${canonicalPath ?? "no file for a global profile"}): ${e.message}`,
      );
    }
    return { profile: updated, scope, workspace_id: row.workspace_id, canonical_path: canonicalPath, changed: true };
  });

  /**
   * DEBT-008 (v0.2.0 P5): delete an UNPINNED profile. FK-safe by explicit
   * count, not by hopeful FK: `tasks.profile_id` is ON DELETE RESTRICT, but
   * the check is counted here so the refusal NAMES the count and the
   * profile ("schema_invalid", the card's code). A pinned profile is never
   * deleted. `task_runs.profile_id` is a FK-less historical snapshot
   * (FR-TSK-09), so a run does not pin.
   *
   * Order (the card's risk note): the row first, inside a transaction; the
   * canonical file second; a file-removal failure is RETURNED and printed
   * by the CLI — never silent.
   */
  ops.set("nova_profile_delete", (args, { deps }) => {
    const name = reqString(args, "name");
    const workspace =
      args["workspace_id"] === undefined
        ? undefined
        : requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
    const row = resolveProfileRow(deps.db, name, workspace?.id);
    if (!row) {
      throw new OpError(
        "not_found",
        `no profile named "${name}" in ${workspace ? `workspace "${workspace.slug}" or the global scope` : "the global scope"}`,
      );
    }
    const scope = row.workspace_id === null ? "global" : "workspace";
    const scopeLabel = scope === "global" ? "global" : "workspace-scoped";
    const pins = countProfilePins(deps.db, row.id);
    if (pins > 0) {
      throw new OpError(
        "schema_invalid",
        `profile "${name}" (${scopeLabel}) is pinned by ${pins} task${pins === 1 ? "" : "s"} — a pinned profile is never deleted (tasks.profile_id is ON DELETE RESTRICT); reassign or delete those tasks first`,
      );
    }
    const canonicalPath =
      row.workspace_id === null
        ? null
        : canonicalProfilePath(requireWorkspaceById(deps.db, row.workspace_id).root_path, name);
    const removal = deleteProfile(deps.db, { row, canonicalPath });
    return {
      deleted: true,
      name,
      scope,
      workspace_id: row.workspace_id,
      canonical_path: canonicalPath,
      file_removed: removal.file_removed,
      file_removal_error: removal.file_removal_error,
    };
  });

  /* ------------------------------- mutating ops ------------------------------ */

  ops.set("nova_task_create", (args, { deps }) => {
    const projectId = reqString(args, "project_id");
    const key = reqString(args, "key");
    const title = reqString(args, "title");
    const objective = reqString(args, "objective");
    const profileId = resolveProfileByName(deps.db, projectId, reqString(args, "profile_name"));
    const requiresGate = optBoolean(args, "requires_human_gate");
    const contextFiles = optStringArray(args, "context_files");
    /**
     * FR-WS-04 AC2: `doc_references` (the CLI's `--context docs/<name>`
     * inputs) resolve against the workspace docs index and land in the SAME
     * `tasks.context_files_json` array the run loop feeds composePrompt —
     * one injection path, never a second. An unresolvable reference throws
     * DocReferenceError (mapped to schema_invalid), so nothing is created.
     */
    const docReferences = optStringArray(args, "doc_references");
    const mergedContextFiles = (() => {
      if (docReferences === undefined) return contextFiles;
      const workspaceRoot = deps.db
        .prepare(
          `SELECT w.root_path AS root_path
             FROM projects p JOIN workspaces w ON w.id = p.workspace_id
            WHERE p.id = ?`,
        )
        .get(projectId) as { root_path: string } | undefined;
      if (workspaceRoot === undefined) {
        throw new OpError("not_found", `no such project: ${projectId}`);
      }
      const resolved = resolveDocReferences(workspaceRoot.root_path, docReferences);
      const merged = [...resolved.contextFiles];
      for (const extra of contextFiles ?? []) {
        if (!merged.includes(extra)) merged.push(extra);
      }
      return merged;
    })();
    // mcp.md §3.2 optional payload parts (previously dropped silently):
    // validate the shapes here, persist via the create service
    const overrides = parseOverridesArg(args);
    const outputSchemaVersion = optNonEmptyString(args, "output_schema_version");
    const targetScopes = parseTargetScopesArg(deps.db, projectId, args);
    try {
      const task = createTask(deps.db, {
        projectId,
        key,
        title,
        objective,
        profileId,
        ...(requiresGate !== undefined ? { requiresHumanGate: requiresGate } : {}),
        ...(mergedContextFiles !== undefined ? { contextFiles: mergedContextFiles } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
        ...(outputSchemaVersion !== undefined ? { outputSchemaVersion } : {}),
        ...(targetScopes !== undefined ? { targetScopes } : {}),
      });
      return { task };
    } catch (err) {
      if (
        err instanceof Error &&
        /UNIQUE constraint failed/i.test(err.message)
      ) {
        throw new OpError("duplicate", `a task with key "${key}" already exists in the project`);
      }
      throw err;
    }
  });


/**
 * FR-WS-03 AC2: execution is disabled in non-active workspaces. Enqueue and
 * operator-retry refuse BEFORE any state write (review round finding); the
 * dispatch candidate query additionally skips non-active workspaces, so a
 * task queued before archiving never spawns either.
 */
function requireActiveWorkspace(db: Db, taskId: string): void {
  const row = db
    .prepare(
      `SELECT w.status AS status, w.slug AS slug
         FROM tasks t JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id WHERE t.id = ?`,
    )
    .get(taskId) as { status: string; slug: string } | undefined;
  if (row === undefined) throw new OpError("not_found", `no such task: ${taskId}`);
  if (row.status !== "active") {
    throw new OpError(
      "aborted",
      `workspace "${row.slug}" is ${row.status} — task execution is disabled (FR-WS-03); ` +
        "dispatch will never admit this task. Unarchive is not a v1 surface.",
    );
  }
}

  ops.set("nova_task_run", async (args, { deps, surface }) => {
    const taskId = reqString(args, "task_id");
    requireActiveWorkspace(deps.db, taskId);
    // the guarded draft→queued row (enqueueTask) carries the DEBT-010
    // scope guard: a task with zero target_scopes refuses here with
    // schema_invalid naming DEBT-010, and the task stays draft
    const actor = optString(args, "actor", "operator");
    const task = await enqueueTask(deps.db, taskId, actor, {
      ...probeOptions(deps.enqueueOptions),
      triggerType: surface,
    });
    deps.dispatcher.requestDispatch(); // admission changed
    return { task };
  });

  ops.set("nova_task_retry", (args, { deps, surface }) => {
    const taskId = reqString(args, "task_id");
    requireActiveWorkspace(deps.db, taskId);
    const decision = deps.retry.operatorRetry(taskId, {
      triggerType: surface,
      actor: optString(args, "actor", "operator"),
    });
    if (decision.kind === "not-failed") {
      throw new OpError("not_found", `no such task: ${taskId}`);
    }
    deps.dispatcher.requestDispatch();
    return { decision };
  });

  ops.set("nova_task_abort", async (args, { deps, surface }) => {
    const taskId = reqString(args, "task_id");
    const task = requireTask(deps.db, taskId);
    const actor = optString(args, "actor", "operator");
    deps.retry.clearFor(taskId); // a moved task never fires its armed timer

    if (task.state === "running") {
      // the LIVE run: the dispatcher marks + group-kills; the run loop
      // owns the cancelled record and the running→cancelled row
      const res = await deps.dispatcher.abortTask(taskId, { triggerType: surface, actor });
      if (res.aborted) {
        return { task_id: taskId, final_state: "cancelled", live_run: true };
      }
      // no live dispatcher entry — a boot-recovered crashed orphan
      // (§8.4 marked the run row crashed and left the task in running).
      // Fall through to the matrix's running→cancelled operator-abort
      // row via abortTriggerFor("running") so the task is never wedged:
      // the crashed run row stays untouched (crashed stays crashed).
    }

    const trigger = abortTriggerFor(task.state);
    if (trigger === null) {
      throw new OpError(
        "invalid_transition",
        `task ${taskId} is in ${task.state} — the 8.1 matrix has no operator-abort row from it`,
      );
    }
    applyTransition(deps.db, taskId, trigger, { triggerType: surface, actor });
    return { task_id: taskId, final_state: "cancelled", live_run: false };
  });

  ops.set("nova_task_steer", (args, { deps }) => {
    const taskId = reqString(args, "task_id");
    const message = reqString(args, "message");
    const task = requireTask(deps.db, taskId);
    if (task.state !== "running") {
      throw new OpError(
        "invalid_transition",
        `steer requires a running task, task ${taskId} is in ${task.state}`,
      );
    }
    // api.md §3 outbound steer frame, LF-framed on the child's stdin
    const frame = JSON.stringify({ id: `steer_${ulid()}`, type: "steer", message });
    const res = deps.dispatcher.steerFrame(taskId, frame);
    if (!res.ok) {
      throw new OpError("not_found", `cannot steer task ${taskId}: ${res.reason}`);
    }
    return { task_id: taskId, steered: true };
  });

  ops.set("nova_gate_approve", (args, { deps, surface }) => {
    // the 8.1 gate approval contract: all four fields required
    const payload = gatePayload(deps.db, args);
    const outcome = approveGate(deps.db, payload, surface as GateSurface);
    // p4b (the p4a residual): the operator approved the GATE; the ENGINE
    // still decides the validating→terminal verdict per FR-TSK-12. The
    // same verification pipeline the settle seam uses drives this task
    // now (fire-and-forget — the response returns at validating).
    deps.onGateApproved(payload.task_id, payload.run_id);
    return { final_state: outcome.finalState, retry_count: outcome.retryCount };
  });

  ops.set("nova_gate_reject", (args, { deps, surface }) => {
    const feedback = reqString(args, "feedback");
    // mcp.md §3.2 payload is {task_id, feedback}; the engine contract
    // still requires the four approval fields, so procedural defaults
    // fill them (documented — the surface is trusted, TB-1)
    const payload = gatePayload(deps.db, args, {
      fillRun: true,
      approvedBy: "operator",
      note: "gate rejection",
    });
    const outcome = rejectGate(deps.db, payload, feedback, surface as GateSurface);
    // the SELF path for gate rejections (8.1 routing rule path 1): a
    // rejected task with remaining budget retries itself — the operator's
    // feedback is the artifact (p4b review finding: no requeue driver)
    let feedbackPath: string | null = null;
    let finalState = outcome.finalState;
    if (outcome.finalState === "changes_requested") {
      feedbackPath = driveSelfPathRequeue(
        deps.db,
        payload.task_id,
        "gate-reject",
        JSON.stringify(
          {
            kind: "novaflow-gate-reject-feedback",
            task_id: payload.task_id,
            run_id: payload.run_id,
            rejected_by: payload.approved_by,
            feedback,
          },
          null,
          2,
        ) + "\n",
        payload.approved_by,
      );
      if (feedbackPath !== null) {
        finalState = "queued"; // the requeue row moved it — report the truth
        deps.dispatcher.requestDispatch();
      }
    }
    return { final_state: finalState, retry_count: outcome.retryCount, feedback_path: feedbackPath };
  });

  ops.set("nova_gate_confirm_failure", async (args, { deps, surface }) => {
    const payload = gatePayload(deps.db, args, {
      fillRun: true,
      approvedBy: "operator",
      note: "failure confirmed",
    });
    const outcome = confirmFailureGate(deps.db, payload, surface as GateSurface);
    // p4a chain wiring: the terminal gate outcome (awaiting_gate→failed)
    // is the CHAIN FAILED rule's trigger (8.1 chain run ownership) —
    // evaluate the member's chain terminal rules synchronously (no
    // catalog probe involved; readiness propagation is completion's
    // business, this is the confirmed-failure rule)
    const member = deps.db
      .prepare("SELECT chain_run_id FROM tasks WHERE id = ?")
      .get(payload.task_id) as { chain_run_id: string | null } | undefined;
    let fallbackEnqueued: string[] | undefined;
    if (member !== undefined && member.chain_run_id !== null) {
      deps.chains.applyTerminalRules(member.chain_run_id);
      // p4b: the 8.1 failure routing rule — UNORDERED with the
      // chain-failed rule above (both happen): the chain records
      // failed while member-level routing continues (nothing halts
      // members on chain state in v1). Draft on_failure targets
      // enqueue via the guarded draft→queued row with the synthesized
      // failure context file; non-draft targets are consumed.
      const fallback = await deps.routing.routeFailurePath(payload.task_id);
      fallbackEnqueued = fallback === null ? [] : fallback.enqueued;
    }
    return {
      final_state: outcome.finalState,
      retry_count: outcome.retryCount,
      ...(fallbackEnqueued !== undefined ? { fallback_enqueued: fallbackEnqueued } : {}),
    };
  });


  /* -------------------- chain ops (FR-PRJ-04, FR-TSK-07/08; p4a) -------------------- */

  /**
   * `nova project import-dag <file>` (srs 4.1.1; FR-PRJ-04).
   *
   * WIRE RULING (documented): the op receives RAW TEXT + a `format`
   * hint ("json" | "yaml"; omitted = auto: JSON first, then the YAML
   * subset — FR-PRJ-04 says "JSON or YAML"). The CLI is a thin client
   * that reads the file and passes its content — the daemon is the
   * single parse+validate+import source, so the two formats can never
   * drift between surfaces.
   *
   * `project_slug` (the CLI's --project): a consistency pin only — the
   * §4.3 schema CARRIES project_slug, so a mismatch refuses; the arg
   * never retargets the import. Without `workspace_id`, the graph's
   * project_slug must resolve unambiguously across workspaces (a slug
   * repeated in N workspaces is a truthful duplicate refusal).
   */
  ops.set("nova_project_import_dag", (args, { deps }) => {
    const graphText = reqString(args, "graph_text");
    const format = args["format"];
    if (format !== undefined && format !== "json" && format !== "yaml") {
      throw new OpError("schema_invalid", 'args.format must be "json" or "yaml"');
    }
    // YamlParseError propagates to toErrorPayload (schema_invalid, line named)
    const graph: unknown =
      format === "yaml"
        ? parseYaml(graphText)
        : (() => {
            try {
              return JSON.parse(graphText) as unknown;
            } catch (jsonErr) {
              if (format === "json") {
                throw new OpError(
                  "schema_invalid",
                  `graph_text is not valid JSON: ${(jsonErr as Error).message}`,
                );
              }
              // auto (documented): JSON first, then the YAML subset
              return parseYaml(graphText);
            }
          })();
    if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
      throw new OpError("schema_invalid", "the chain graph must be a JSON/YAML object");
    }
    const obj = graph as Record<string, unknown>;
    if (typeof obj["project_slug"] !== "string" || obj["project_slug"] === "") {
      throw new OpError(
        "schema_invalid",
        'the chain graph must declare a non-empty string "project_slug" (§4.3 required key)',
      );
    }
    const slug = obj["project_slug"];
    if (args["project_slug"] !== undefined && args["project_slug"] !== slug) {
      throw new OpError(
        "schema_invalid",
        `the graph declares project_slug "${slug}" but "${String(args["project_slug"])}" was given — mismatch refused (the schema carries project_slug)`,
      );
    }
    let workspace: WorkspaceRow | undefined;
    let project: { id: string; workspace_id: string; slug: string } | undefined;
    if (args["workspace_id"] !== undefined) {
      workspace = requireWorkspaceById(deps.db, reqString(args, "workspace_id"));
      project = deps.db
        .prepare("SELECT id, workspace_id, slug FROM projects WHERE workspace_id = ? AND slug = ?")
        .get(workspace.id, slug) as { id: string; workspace_id: string; slug: string } | undefined;
      if (project === undefined) {
        throw new OpError("not_found", `no project "${slug}" in workspace "${workspace.slug}"`);
      }
    } else {
      const rows = deps.db
        .prepare("SELECT id, workspace_id, slug FROM projects WHERE slug = ?")
        .all(slug) as Array<{ id: string; workspace_id: string; slug: string }>;
      if (rows.length === 0) {
        throw new OpError("not_found", `no project "${slug}" in any workspace`);
      }
      if (rows.length > 1) {
        throw new OpError(
          "duplicate",
          `project slug "${slug}" exists in ${rows.length} workspaces — pass workspace_id to disambiguate`,
        );
      }
      project = rows[0]!;
      workspace = requireWorkspaceById(deps.db, project.workspace_id);
    }
    // ChainValidationError propagates to toErrorPayload (its code IS the
    // taxonomy: schema_invalid / not_found / duplicate / profile_unresolved)
    const { chainRun, tasks } = importChain(
      deps.db,
      { id: workspace.id },
      { id: project.id, slug: project.slug },
      graph,
    );
    const taskViews: Record<string, { id: string; key: string; state: string }> = {};
    for (const [key, row] of Object.entries(tasks)) {
      taskViews[key] = { id: row.id, key: row.key, state: row.state };
    }
    // FR-PRJ-04 AC3: tasks in draft; roots are NOT auto-enqueued (the
    // operator/orchestrator enqueues roots; readiness propagates after)
    return { chain_run_id: chainRun.id, chain_run: chainRun, tasks: taskViews };
  });

  /**
   * `nova chain list` (srs 4.1.1): chain runs with member counts and
   * the pause flag. Filters mirror the other list ops: `workspace_id`
   * and `project_id` (both validated); without either, every chain.
   */
  ops.set("nova_chain_list", (args, { deps }) => {
    const workspaceId =
      args["workspace_id"] === undefined ? undefined : reqString(args, "workspace_id");
    const projectId =
      args["project_id"] === undefined ? undefined : reqString(args, "project_id");
    if (workspaceId !== undefined) requireWorkspaceById(deps.db, workspaceId);
    if (projectId !== undefined && getProject(deps.db, projectId) === undefined) {
      throw new OpError("not_found", `no such project: ${projectId}`);
    }
    const base =
      `SELECT c.id, c.project_id, p.slug AS project_slug, c.state, c.started_at, c.completed_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.chain_run_id = c.id) AS member_count
         FROM chain_runs c JOIN projects p ON p.id = c.project_id`;
    const rows =
      projectId !== undefined
        ? deps.db.prepare(`${base} WHERE c.project_id = ? ORDER BY c.id`).all(projectId)
        : workspaceId !== undefined
          ? deps.db.prepare(`${base} WHERE p.workspace_id = ? ORDER BY c.id`).all(workspaceId)
          : deps.db.prepare(`${base} ORDER BY c.id`).all();
    return {
      chains: (rows as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        paused: deps.pausedChains.has(String(r["id"])),
      })),
    };
  });

  /**
   * `nova chain status <chain-run-id>` (srs 4.1.1): the chain row,
   * members with states + readiness, and the pause flag.
   */
  ops.set("nova_chain_status", (args, { deps }) => {
    const chainRunId = reqString(args, "chain_run_id");
    const chain = getChainRun(deps.db, chainRunId);
    if (chain === undefined) throw new OpError("not_found", `no such chain run: ${chainRunId}`);
    const members = memberReadiness(deps.db, chainRunId).map((m) => ({
      ...m,
      // p4b (ops surface, derived — no invented state): the delivered
      // feedback context paths recorded on each member (FR-TSK-04)
      feedback: deliveredFeedbackPaths(deps.db, m.id),
    }));
    return { chain, members, paused: deps.pausedChains.has(chainRunId) };
  });

  /**
   * `nova chain abort <chain-run-id>` (srs 4.1.1; mcp.md nova_chain_abort):
   * every NON-TERMINAL member aborts per the matrix abort rows — live
   * runs via dispatcher.abortTask (group kill; the loop owns the
   * cancelled record + row), non-live members via the per-state
   * operator-abort rows (abortTriggerFor — the same machinery as
   * nova_task_abort, including the crashed-orphan fall-through for a
   * running member with no live dispatcher entry). Terminal members
   * (completed/cancelled) stay untouched; a draft member has no abort
   * row in the matrix and stays draft (reported, never faked). The
   * chain's terminal move is guarded: active → aborted only.
   */
  ops.set("nova_chain_abort", async (args, { deps, surface }) => {
    const chainRunId = reqString(args, "chain_run_id");
    const chain = getChainRun(deps.db, chainRunId);
    if (chain === undefined) throw new OpError("not_found", `no such chain run: ${chainRunId}`);
    if (chain.state !== "active") {
      throw new OpError(
        "invalid_transition",
        `chain run ${chainRunId} is already ${chain.state} — a terminal chain never moves again`,
      );
    }
    const actor = optString(args, "actor", "operator");
    const members = listChainMembers(deps.db, chainRunId);
    const outcomes: Array<Record<string, unknown>> = [];
    for (const m of members) {
      if (m.state === "completed" || m.state === "cancelled") {
        outcomes.push({ task_id: m.id, key: m.key, from_state: m.state, outcome: "already-terminal" });
        continue;
      }
      const trigger = abortTriggerFor(m.state);
      if (trigger === null) {
        // draft: the 8.1 matrix has no draft abort row — the member
        // stays draft (inert: nothing dispatches or propagates into an
        // aborted chain). Honest reporting, never an invented row.
        outcomes.push({ task_id: m.id, key: m.key, from_state: m.state, outcome: "no-abort-row" });
        continue;
      }
      deps.retry.clearFor(m.id); // a moved member never fires its armed timer
      if (m.state === "running") {
        const res = await deps.dispatcher.abortTask(m.id, { triggerType: surface, actor });
        if (res.aborted) {
          outcomes.push({ task_id: m.id, key: m.key, from_state: m.state, outcome: "cancelled", live_run: true });
          continue;
        }
        // no live dispatcher entry — a boot-recovered crashed orphan:
        // fall through to the matrix row so the member is never wedged
        // (the crashed run row stays untouched), mirroring nova_task_abort
      }
      try {
        applyTransition(deps.db, m.id, trigger, { triggerType: surface, actor });
        outcomes.push({ task_id: m.id, key: m.key, from_state: m.state, outcome: "cancelled", live_run: false });
      } catch (err) {
        // a surface moved the member between read and apply — reported,
        // never a wedge for the rest of the abort loop
        outcomes.push({ task_id: m.id, key: m.key, from_state: m.state, outcome: `refused: ${(err as Error).message}` });
      }
    }
    // the guarded terminal move (a terminal chain never moves again) -
    // the chain module owns every chain_runs write (write discipline)
    const moved = setChainRunAborted(deps.db, chainRunId);
    return {
      chain_run_id: chainRunId,
      state: moved ? "aborted" : getChainRun(deps.db, chainRunId)?.state ?? "aborted",
      members: outcomes,
    };
  });

  /**
   * `nova chain pause <chain-run-id>` (FR-TSK-08 — scheduler-level:
   * NO paused task state, the chain_runs row stays 'active'). The
   * in-memory flag withholds readiness propagation and makes dispatch
   * skip the chain's queued members. Idempotent; an active-chain
   * control (a terminal chain refuses invalid_transition). A daemon
   * restart unpauses (same lifecycle as the daemon-level pause —
   * documented).
   */
  ops.set("nova_chain_pause", (args, { deps }) => {
    const chainRunId = reqString(args, "chain_run_id");
    const chain = getChainRun(deps.db, chainRunId);
    if (chain === undefined) throw new OpError("not_found", `no such chain run: ${chainRunId}`);
    if (chain.state !== "active") {
      throw new OpError(
        "invalid_transition",
        `chain run ${chainRunId} is ${chain.state} — pause is an active-chain control (FR-TSK-08)`,
      );
    }
    deps.pausedChains.add(chainRunId);
    return { chain_run_id: chainRunId, paused: true };
  });

  /**
   * `nova chain resume <chain-run-id>` (FR-TSK-08): clears the flag and
   * evaluates readiness IMMEDIATELY — a paused chain withheld
   * propagation, so the ready members enqueue now (probe-bounded).
   * Idempotent (resuming an unpaused chain is a no-op success).
   */
  ops.set("nova_chain_resume", async (args, { deps }) => {
    const chainRunId = reqString(args, "chain_run_id");
    const chain = getChainRun(deps.db, chainRunId);
    if (chain === undefined) throw new OpError("not_found", `no such chain run: ${chainRunId}`);
    if (chain.state !== "active") {
      throw new OpError(
        "invalid_transition",
        `chain run ${chainRunId} is ${chain.state} — resume is an active-chain control (FR-TSK-08)`,
      );
    }
    deps.pausedChains.delete(chainRunId);
    const propagation = await deps.chains.propagateChain(chainRunId);
    return { chain_run_id: chainRunId, paused: false, enqueued: propagation.enqueued };
  });

  /**
   * `nova chain clean <chain-run-id> [--force]` (srs 4.1.1 "Chain clean";
   * novaflow-v030 amendments row 2) — the operator confirmation `data` 3.x
   * presupposes for worktree cleanup.
   *
   * RULES (the contract, verbatim): refuses a chain whose row is not
   * terminal (naming the state); refuses a member run whose worktree has
   * uncommitted changes unless `--force`, NAMING THE RUN; removes the
   * worktrees and prunes; reports every removed tree; NEVER deletes a run
   * row or its artifacts — `task_runs.worktree_root` is history.
   *
   * The refusal is planned BEFORE anything is removed, so a refused clean
   * leaves every tree exactly as it was.
   */
  ops.set("nova_chain_clean", (args, { deps }) => {
    const chainRunId = reqString(args, "chain_run_id");
    const force = optBoolean(args, "force") === true;
    const chain = getChainRun(deps.db, chainRunId);
    if (chain === undefined) throw new OpError("not_found", `no such chain run: ${chainRunId}`);
    if (chain.state === "active") {
      throw new OpError(
        "invalid_transition",
        `chain run ${chainRunId} is active — worktree cleanup is the post-terminal confirmation (data §3): wait for completed/failed/aborted, or abort the chain first`,
      );
    }
    const rows = deps.db
      .prepare(
        `SELECT r.id AS run_id, r.task_id, r.worktree_root, t.key
           FROM task_runs r JOIN tasks t ON t.id = r.task_id
          WHERE t.chain_run_id = ? AND r.worktree_root IS NOT NULL
          ORDER BY r.started_at, r.id`,
      )
      .all(chainRunId) as Array<{
      run_id: string;
      task_id: string;
      worktree_root: string;
      key: string;
    }>;

    type Removal = { run_id: string; task_id: string; key: string; path: string; repoRoot: string; dirty: boolean; exists: boolean; error: string | null };
    const planned: Removal[] = [];
    for (const row of rows) {
      for (const target of runWorktreeTargets(deps.db, row.task_id, row.worktree_root)) {
        const exists = existsSync(target.path);
        const state = exists ? worktreeIsDirty(target.path) : { dirty: false, error: null };
        planned.push({
          run_id: row.run_id,
          task_id: row.task_id,
          key: row.key,
          path: target.path,
          repoRoot: target.repoRoot,
          dirty: state.dirty,
          exists,
          error: exists ? state.error : null,
        });
      }
    }

    const dirty = planned.filter((p) => p.exists && p.dirty);
    // FAIL CLOSED (must-fix): a worktree whose dirtiness CANNOT be assessed
    // (broken .git, missing main repo) is treated as holding work — an
    // unassessable tree must never be silently removed as "clean"
    const unassessable = planned.filter((p) => p.exists && p.error !== null);
    if ((dirty.length > 0 || unassessable.length > 0) && !force) {
      const first = dirty[0] ?? unassessable[0]!;
      const why =
        dirty.length > 0
          ? `has uncommitted changes in ${first.path}`
          : `could not be assessed in ${first.path} — ${first.error}`;
      throw new OpError(
        "invalid_transition",
        `chain run ${chainRunId}: run ${first.run_id} (task ${first.key}) ${why}` +
          `${dirty.length + unassessable.length > 1 ? ` (+${dirty.length + unassessable.length - 1} more)` : ""} — refusing to remove a worktree that holds (or may hold) work; commit or discard it, or re-run with --force`,
      );
    }

    const removed: Array<{ run_id: string; task_id: string; key: string; path: string; forced: boolean }> = [];
    const missing: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const repos = new Set<string>();
    for (const item of planned) {
      if (!item.exists) {
        missing.push(item.path);
        if (existsSync(item.repoRoot)) repos.add(item.repoRoot);
        continue;
      }
      const res = removeWorktree(item.repoRoot, item.path, force && (item.dirty || item.error !== null));
      if (!res.ok) {
        failed.push({ path: item.path, error: res.error ?? "git worktree remove failed" });
        continue;
      }
      removed.push({
        run_id: item.run_id,
        task_id: item.task_id,
        key: item.key,
        path: item.path,
        forced: force && (item.dirty || item.error !== null),
      });
      repos.add(item.repoRoot);
    }
    // the run's ROOT is the engine's own container: when its last subdirectory
    // is gone it is removed too (rmdir only — an occupied directory is never
    // touched, so nothing outside the root can be lost)
    for (const row of rows) {
      try {
        if (existsSync(row.worktree_root) && readdirSync(row.worktree_root).length === 0) {
          rmdirSync(row.worktree_root);
        }
      } catch {
        // a concurrently written entry wins: leave the root alone
      }
    }
    const pruned: string[] = [];
    for (const repoRoot of repos) {
      const res = pruneWorktrees(repoRoot);
      if (res.ok) pruned.push(repoRoot);
      else failed.push({ path: repoRoot, error: res.error ?? "git worktree prune failed" });
    }

    return {
      chain_run_id: chainRunId,
      state: chain.state,
      forced: force,
      removed,
      missing,
      pruned,
      failed,
      // the rows and their artifacts are history: reported, never touched
      runs_kept: rows.length,
    };
  });

  /* ------------------------ schedule ops (FR-SCH-01/03) ----------------------- */

  /**
   * `nova schedule attach` (srs 4.1.1; FR-SCH-01): attach ONE schedule
   * — a 5-field cron or a single ISO-8601 instant — to a TASK (the
   * DDL's target_type CHECK is ('task') only; project-level
   * scheduling is deferred). Documented rulings:
   *   - exactly one of cron_expr | run_at (the DDL CHECK, enforced at
   *     the wire — both/neither is schema_invalid naming the rule);
   *   - the task must exist (a dangling target_id is a DDL tolerance
   *     the evaluator survives, never an attach feature — not_found)
   *     and its workspace must be ACTIVE (the SAME requireActiveWorkspace
   *     gate as run/retry — FR-WS-03);
   *   - missed_policy defaults from the workspace config's
   *     missed_run_policy (data 4.4); an explicit value wins; a broken
   *     config file falls back to the documented default 'skip' (the
   *     never-crash rule — the loader's error is surfaced elsewhere);
   *   - timezone is UTC-ONLY in v1 (spec-silent column; documented
   *     limitation: the evaluator does all math in UTC) — any other
   *     value is refused with schema_invalid;
   *   - next_run_at is computed and stored at attach; a run_at already
   *     past fires at the next evaluation pass (its designated time
   *     has arrived), a cron that can never match a calendar date is
   *     refused (a dead schedule is not a schedule);
   *   - multiple schedules per task are schema-legal (no UNIQUE) —
   *     each fires independently.
   */
  ops.set("nova_schedule_attach", (args, { deps }) => {
    const taskId = reqString(args, "task_id");
    const hasCron = args["cron_expr"] !== undefined;
    const hasRunAt = args["run_at"] !== undefined;
    if (hasCron === hasRunAt) {
      throw new OpError(
        "schema_invalid",
        `exactly one of cron_expr or run_at is required (the schedules DDL CHECK is cron_expr XOR run_at) — got ${hasCron ? "both" : "neither"}`,
      );
    }
    let cronExpr: string | null = null;
    let runAt: string | null = null;
    let nextRunAt: string;
    if (hasCron) {
      const expr = reqString(args, "cron_expr");
      const parsed = parseCron(expr);
      if (!parsed.ok) throw new OpError("schema_invalid", parsed.error);
      const next = nextRun(expr, Date.now());
      if (next === null) {
        throw new OpError(
          "schema_invalid",
          `cron expression "${expr}" never matches a calendar date — refusing to attach a schedule that can never fire`,
        );
      }
      cronExpr = expr;
      nextRunAt = canonicalTimestamp(next);
    } else {
      const iso = reqString(args, "run_at");
      const parsed = parseIsoRunAt(iso);
      if (!parsed.ok) throw new OpError("schema_invalid", parsed.error);
      runAt = canonicalTimestamp(parsed.ms);
      nextRunAt = runAt; // the one-shot's only moment, even if already past
    }
    if (args["timezone"] !== undefined && args["timezone"] !== "UTC") {
      throw new OpError(
        "schema_invalid",
        `timezone must be "UTC" in v1 — schedules are evaluated in UTC only (got ${JSON.stringify(args["timezone"])})`,
      );
    }
    // the task must exist AND live in an ACTIVE workspace (the run/retry gate)
    requireActiveWorkspace(deps.db, taskId);
    const scope = deps.db
      .prepare(
        `SELECT p.workspace_id AS ws_id, w.root_path AS ws_root
           FROM tasks t JOIN projects p ON p.id = t.project_id
           JOIN workspaces w ON w.id = p.workspace_id WHERE t.id = ?`,
      )
      .get(taskId) as { ws_id: string; ws_root: string };
    let missedPolicy: "skip" | "run_immediately";
    if (args["missed_policy"] !== undefined) {
      if (args["missed_policy"] !== "skip" && args["missed_policy"] !== "run_immediately") {
        throw new OpError(
          "schema_invalid",
          `args.missed_policy must be "skip" or "run_immediately" (got ${JSON.stringify(args["missed_policy"])})`,
        );
      }
      missedPolicy = args["missed_policy"];
    } else {
      // the workspace config's missed_run_policy is the default
      // (data 4.4); a broken file falls back to the documented default
      const load = loadWorkspaceConfig(scope.ws_root);
      missedPolicy = load.ok ? load.config.missedRunPolicy : DEFAULT_MISSED_RUN_POLICY;
    }
    // No wire `enabled` arg (review finding): the srs verb table covers the
    // lifecycle with pause/resume — attach always creates an enabled row.
    const enabled = 1;
    const id = ulid();
    deps.db
      .prepare(
        `INSERT INTO schedules
           (id, workspace_id, target_type, target_id, cron_expr, run_at, timezone,
            missed_policy, enabled, last_run_at, next_run_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'UTC', ?, ?, NULL, ?)`,
      )
      .run(id, scope.ws_id, taskId, cronExpr, runAt, missedPolicy, enabled, nextRunAt);
    const schedule = deps.db
      .prepare(
        "SELECT id, workspace_id, target_type, target_id AS task_id, cron_expr, run_at, timezone, missed_policy, enabled, last_run_at, next_run_at FROM schedules WHERE id = ?",
      )
      .get(id);
    // FR-SCH-01: the id is the report surface (bare ULID, data 5.1)
    return { id, schedule };
  });

  /**
   * `nova schedule list` (srs 4.1.1): schedule rows with the computed
   * fields. Filters: workspace_id (validated) and task_id (validated —
   * the CLI's --task); with neither, every workspace's schedules.
   */
  ops.set("nova_schedule_list", (args, { deps }) => {
    const workspaceId =
      args["workspace_id"] === undefined ? undefined : reqString(args, "workspace_id");
    const taskId = args["task_id"] === undefined ? undefined : reqString(args, "task_id");
    if (workspaceId !== undefined) requireWorkspaceById(deps.db, workspaceId);
    if (taskId !== undefined) requireTask(deps.db, taskId);
    // wire shape (documented): target_id is projected as task_id
    const COLUMNS =
      "id, workspace_id, target_type, target_id AS task_id, cron_expr, run_at, timezone, missed_policy, enabled, last_run_at, next_run_at";
    const schedules =
      taskId !== undefined
        ? deps.db.prepare(`SELECT ${COLUMNS} FROM schedules WHERE target_id = ? ORDER BY id`).all(taskId)
        : workspaceId !== undefined
          ? deps.db.prepare(`SELECT ${COLUMNS} FROM schedules WHERE workspace_id = ? ORDER BY id`).all(workspaceId)
          : deps.db.prepare(`SELECT ${COLUMNS} FROM schedules ORDER BY id`).all();
    return { schedules };
  });

  /**
   * `nova schedule pause` (srs 4.1.1; FR-TSK-08's scheduler-level pause
   * applies to schedules the same way): enabled=0. Documented ruling —
   * next_run_at is KEPT (not nulled): the evaluator only considers
   * enabled=1 rows (the partial index idx_schedules_next_run WHERE
   * enabled=1 mirrors exactly this), and a paused schedule does not
   * accumulate missed runs — resume recomputes from now. Idempotent.
   */
  ops.set("nova_schedule_pause", (args, { deps }) => {
    const id = reqString(args, "schedule_id");
    const row = deps.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as ScheduleRow | undefined;
    if (!row) throw new OpError("not_found", `no such schedule: ${id}`);
    deps.db.prepare("UPDATE schedules SET enabled = 0 WHERE id = ?").run(id);
    const schedule = deps.db
      .prepare(
        "SELECT id, workspace_id, target_type, target_id AS task_id, cron_expr, run_at, timezone, missed_policy, enabled, last_run_at, next_run_at FROM schedules WHERE id = ?",
      )
      .get(id);
    return { schedule_id: id, schedule };
  });

  /**
   * `nova schedule resume` (srs 4.1.1): enabled=1 + next_run_at
   * recomputed from NOW (documented ruling: a paused schedule does
   * not accumulate missed runs — a cron fires its next occurrence
   * after resume; a one-shot's only moment counts only while it is
   * still ahead, so a resumed expired one-shot stays expired). The
   * recomputed next run is part of the response (the CLI states it).
   */
  ops.set("nova_schedule_resume", (args, { deps }) => {
    const id = reqString(args, "schedule_id");
    const row = deps.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as ScheduleRow | undefined;
    if (!row) throw new OpError("not_found", `no such schedule: ${id}`);
    const now = Date.now();
    const next = nextOccurrenceAt(row, now);
    if (row.cron_expr !== null && next === null) {
      // a cron validated at attach cannot go dead, but never store a
      // live row that can never fire — refuse truthfully instead
      throw new OpError(
        "schema_invalid",
        `cron "${row.cron_expr}" matches no future date — refusing to resume a dead schedule`,
      );
    }
    deps.db
      .prepare("UPDATE schedules SET enabled = 1, next_run_at = ? WHERE id = ?")
      .run(next === null ? null : canonicalTimestamp(next), id);
    const schedule = deps.db
      .prepare(
        "SELECT id, workspace_id, target_type, target_id AS task_id, cron_expr, run_at, timezone, missed_policy, enabled, last_run_at, next_run_at FROM schedules WHERE id = ?",
      )
      .get(id);
    return { schedule_id: id, schedule };
  });

  ops.set("nova_daemon_pause", (_args, { deps }) => {
    deps.dispatcher.pause();
    return { paused: true };
  });

  ops.set("nova_daemon_resume", (_args, { deps }) => {
    deps.dispatcher.resume();
    return { paused: false };
  });

  ops.set("nova_kill_all", async (_args, { deps, surface }) => {
    // the spec's kill switch: all workspaces, pauses the scheduler,
    // SIGTERM → 3 s grace → SIGKILL every live child tree
    deps.dispatcher.pause();
    const aborted: string[] = [];
    for (const taskId of deps.dispatcher.liveTasks()) {
      const res = await deps.dispatcher.abortTask(taskId, {
        triggerType: surface,
        actor: "kill-all",
      });
      if (res.aborted) aborted.push(taskId);
    }
    return { paused: true, aborted };
  });

  ops.set("nova_daemon_stop", (_args) => {
    // the response must flush BEFORE the lifecycle stops the socket —
    // handleLine wires the stop callback onto the write itself
    return { stopping: true };
  });

  return ops;
}

/* ------------------------------ error mapping ------------------------------ */

export function toErrorPayload(err: unknown): { code: TaxonomyCode; message: string } {
  if (err instanceof OpError) return { code: err.code, message: err.message };
  if (err instanceof YamlParseError) {
    return {
      code: "schema_invalid",
      message: `chain.yaml parse error at line ${err.line}: ${err.message}`,
    };
  }
  if (err instanceof ChainValidationError) {
    // the validator's code IS the taxonomy row (schema_invalid /
    // not_found / duplicate / profile_unresolved — the documented
    // ambiguity mapping lives in src/chain/graph.ts)
    return { code: err.code, message: err.message };
  }
  if (err instanceof InvalidTransitionError) {
    return { code: "invalid_transition", message: err.message };
  }
  if (err instanceof RetryBudgetExhaustedError) {
    return { code: "invalid_transition", message: err.message };
  }
  if (err instanceof GateError) {
    if (err.code === "not_found") return { code: "not_found", message: err.message };
    if (err.code === "missing_field") return { code: "schema_invalid", message: err.message };
    // wrong_state / stale_run: not legal in the current run context
    return { code: "invalid_transition", message: err.message };
  }
  if (err instanceof ProfileUnresolvedError) {
    return { code: "profile_unresolved", message: err.message };
  }
  if (err instanceof ProfileValidationError) {
    return { code: "schema_invalid", message: err.message };
  }
  if (err instanceof DocReferenceError) {
    // FR-WS-04: an unresolvable doc reference is a payload violation — the
    // caller named a document the workspace does not index
    return { code: "schema_invalid", message: err.message };
  }
  if (
    err instanceof Error &&
    (/UNIQUE constraint failed/i.test(err.message) || err.message.includes("SQLITE_CONSTRAINT_UNIQUE"))
  ) {
    return { code: "duplicate", message: err.message };
  }
  // unexpected internal failure: the operation did not complete
  return {
    code: "aborted",
    message: err instanceof Error ? err.message : String(err),
  };
}

/* --------------------------------- the server -------------------------------- */

const STALE_PROBE_TIMEOUT_MS = 500;

/**
 * Probe whether a live daemon answers on the socket path. Resolves
 * true when a response frame arrives within the deadline.
 */
async function liveDaemonAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = connect(socketPath, () => {
      sock.write(JSON.stringify({ id: "probe", op: "nova_daemon_status", args: {} }) + "\n");
    });
    sock.setEncoding("utf8");
    sock.on("data", () => done(true)); // any answer frame = live
    sock.on("error", () => done(false)); // ECONNREFUSED etc: stale file
    const timer = setTimeout(() => done(true), STALE_PROBE_TIMEOUT_MS); // silent-but-accepting = live
    timer.unref?.();
  });
}

export async function bindControlServer(
  deps: ServerDeps,
  socketPath: string,
): Promise<ControlServer> {
  const ops = buildOpTable();
  mkdirSync(dirname(socketPath), { recursive: true });

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

  const server = createServer();
  server.on("error", () => {}); // post-bind errors must not crash the daemon

  try {
    await listen();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw err;
    // stale-socket handling (documented): live daemon → refuse; dead
    // socket file → unlink and rebind
    if (await liveDaemonAnswers(socketPath)) {
      throw new Error(
        `a live daemon already owns ${socketPath} — refusing to steal the socket`,
      );
    }
    unlinkSync(socketPath);
    await listen();
  }

  // TB-1: the socket file is operator-only from the first connection.
  // Known race window (documented): between bind and this chmod the
  // socket file briefly carries the umask default permissions. The
  // chmod runs synchronously on the same tick as the resolved bind, so
  // the exposure is only the connect backlog of that instant; v1
  // accepts it (loopback transport + single-operator host, TB-1's threat
  // model) rather than pre-creating the file with 0600 — pre-creation
  // would collide with the stale-socket probe's unlink-and-rebind rule.
  chmodSync(socketPath, 0o600);

  const sockets = new Set<Socket>();
  server.on("connection", (sock: Socket) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let buf = "";
    // per-connection serialization: one op at a time, responses in order
    let queue: Promise<void> = Promise.resolve();
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const request = line;
        queue = queue.then(() =>
          handleLine(deps, ops, sock, request).catch(() => {}),
        );
      }
    });
    sock.on("error", () => sock.destroy());
  });

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath);
        } catch {
          // best effort: a removed socket file is not a stop-blocker
        }
      }),
  };
}

async function handleLine(
  deps: ServerDeps,
  ops: Map<string, OpHandler>,
  sock: Socket,
  request: string,
): Promise<void> {
  const write = (payload: unknown): void => {
    if (!sock.destroyed) sock.write(JSON.stringify(payload) + "\n");
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    write({ id: null, ok: false, error: { code: "schema_invalid", message: "request is not valid JSON" } });
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    write({ id: null, ok: false, error: { code: "schema_invalid", message: "request must be a JSON object" } });
    return;
  }
  const req = parsed as Record<string, unknown>;
  const id = req["id"] ?? null;

  let surface: SocketSurface | null;
  if (req["surface"] === undefined || req["surface"] === "human") surface = "human";
  else if (req["surface"] === "mcp") surface = "mcp";
  else surface = null;
  if (surface === null) {
    write({ id, ok: false, error: { code: "schema_invalid", message: 'surface must be "human" or "mcp"' } });
    return;
  }
  const opName = req["op"];
  if (typeof opName !== "string" || opName === "") {
    write({ id, ok: false, error: { code: "schema_invalid", message: 'request requires a non-empty string "op"' } });
    return;
  }
  const handler = ops.get(opName);
  if (handler === undefined) {
    write({ id, ok: false, error: { code: "not_found", message: `unknown op "${opName}"` } });
    return;
  }
  let args: Record<string, unknown>;
  if (req["args"] === undefined) {
    args = {};
  } else if (typeof req["args"] === "object" && req["args"] !== null && !Array.isArray(req["args"])) {
    args = req["args"] as Record<string, unknown>;
  } else {
    write({ id, ok: false, error: { code: "schema_invalid", message: "args must be a JSON object" } });
    return;
  }

  try {
    const data = await handler(args, { surface, deps });
    if (opName === "nova_daemon_stop") {
      // write, and only after the bytes flush, begin the shutdown
      if (!sock.destroyed) {
        sock.write(JSON.stringify({ id, ok: true, data }) + "\n", () => {
          void deps.requestStop();
        });
      } else {
        void deps.requestStop();
      }
      return;
    }
    write({ id, ok: true, data });
  } catch (err) {
    write({ id, ok: false, error: toErrorPayload(err) });
  }
}
