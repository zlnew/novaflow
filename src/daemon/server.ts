import { connect, createServer, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import { ulid } from "../store/ids.ts";
import { applyTransition, InvalidTransitionError } from "../fsm/engine.ts";
import { createTask, enqueueTask, getTask, listTasks } from "../tasks.ts";
import {
  approveGate,
  confirmFailureGate,
  rejectGate,
  GateError,
  type GatePayload,
  type GateSurface,
} from "../gates.ts";
import { validateProfile, ProfileValidationError } from "../profiles.ts";
import { ProfileUnresolvedError } from "../catalog.ts";
import { RetryBudgetExhaustedError } from "../validating.ts";
import { validateArtifact, type TaskHandoffArtifact } from "../runs/artifact.ts";
import type { DaemonConfig } from "../daemonconfig.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { RetryEvaluator } from "./retry.ts";
import { abortTriggerFor } from "./triggers.ts";

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

/** The srs 4.1.1 error-code taxonomy, verbatim. */
export type TaxonomyCode =
  | "invalid_transition"
  | "schema_invalid"
  | "preflight_failed"
  | "budget_exceeded"
  | "not_found"
  | "daemon_unreachable"
  | "duplicate"
  | "aborted"
  | "profile_unresolved";

/** A typed op failure carrying a taxonomy code. */
export class OpError extends Error {
  constructor(readonly code: TaxonomyCode, message: string) {
    super(message);
    this.name = "OpError";
  }
}

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
  daemonConfig: DaemonConfig;
  /** The full nova_daemon_status payload (lifecycle owns uptime/version/budgets). */
  daemonStatus: () => Record<string, unknown>;
  /** Invoked AFTER the nova_daemon_stop response is written. */
  requestStop: () => void | Promise<void>;
  /** Catalog-probe injection for nova_task_run (tests point at the stub). */
  enqueueOptions?: EnqueueInjection | undefined;
};

export type ControlServer = {
  socketPath: string;
  /** Stop accepting, unlink the socket file, wait for in-flight op completions. */
  close: () => Promise<void>;
};

/* ------------------------------ arg validation ------------------------------ */

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new OpError("schema_invalid", `args.${key} must be a non-empty string`);
  }
  return v;
}

function optString(args: Record<string, unknown>, key: string, fallback: string): string {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new OpError("schema_invalid", `args.${key} must be an array of strings`);
  }
  return v as string[];
}

function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new OpError("schema_invalid", `args.${key} must be a boolean`);
  }
  return v;
}

/* ------------------------------ shared queries ------------------------------ */

type RunRow = {
  id: string;
  task_id: string;
  attempt_number: number;
  status: string;
  preflight_status: string;
  model_used: string;
  pid: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  exit_code: number | null;
  artifact_path: string | null;
  events_log_path: string;
  error_summary: string | null;
  started_at: string;
  ended_at: string | null;
};

function latestRun(db: Db, taskId: string): RunRow | undefined {
  return db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as RunRow | undefined;
}

function runById(db: Db, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as RunRow | undefined;
}

function requireTask(db: Db, taskId: string) {
  const task = getTask(db, taskId);
  if (!task) throw new OpError("not_found", `no such task: ${taskId}`);
  return task;
}

/** mcp.md §3.2 payload is {project_id, key, title, objective, profile_name…}. */
function resolveProfileByName(db: Db, projectId: string, name: string): string {
  const project = db
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .get(projectId) as { workspace_id: string } | undefined;
  if (!project) throw new OpError("not_found", `no such project: ${projectId}`);
  const row = db
    .prepare(
      "SELECT id FROM agent_profiles WHERE name = ? AND (workspace_id IS NULL OR workspace_id = ?)",
    )
    .get(name, project.workspace_id) as { id: string } | undefined;
  if (!row) {
    throw new OpError("not_found", `no profile named "${name}" in the project's workspace`);
  }
  return row.id;
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

  ops.set("nova_task_status", (args, { deps }) => {
    const task = requireTask(deps.db, reqString(args, "task_id"));
    const current = latestRun(deps.db, task.id);
    const elapsedMs =
      current !== undefined && current.status === "running"
        ? Date.now() - Date.parse(current.started_at)
        : null;
    return { task, current_run: current ?? null, elapsed_ms: elapsedMs };
  });

  ops.set("nova_task_list", (args, { deps }) => {
    const projectId = args["project_id"] === undefined ? undefined : reqString(args, "project_id");
    const state = args["state"] === undefined ? undefined : reqString(args, "state");
    let rows = listTasks(deps.db, projectId);
    if (state !== undefined) rows = rows.filter((t) => t.state === state);
    return { tasks: rows };
  });

  // mcp.md §3.1 tool table: the wire name is `nova_result_get` — never
  // `nova_task_result` (one contract, no alias; the MCP server (p5) and
  // the CLI (p3b) build on exactly this name).
  ops.set("nova_result_get", (args, { deps }) => {
    const taskId = reqString(args, "task_id");
    requireTask(deps.db, taskId);
    const run =
      args["run_id"] === undefined ? latestRun(deps.db, taskId) : runById(deps.db, reqString(args, "run_id"));
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
    if (!res.ok) throw new OpError("schema_invalid", `result.json of run ${run.id} failed validation: ${res.errors.join("; ")}`);
    return { run_id: run.id, artifact: res.artifact as TaskHandoffArtifact };
  });

  ops.set("nova_run_logs", (args, { deps }) => {
    const taskId = reqString(args, "task_id");
    requireTask(deps.db, taskId);
    const run =
      args["run_id"] === undefined ? latestRun(deps.db, taskId) : runById(deps.db, reqString(args, "run_id"));
    if (!run) throw new OpError("not_found", `no run for task ${taskId}`);
    // FR-LOG-02: the run's log pointer IS the redacted read surface
    // (events_log_path = events.jsonl). The raw file is never served.
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
  });

  ops.set("nova_profile_list", (_args, { deps }) => {
    return { profiles: deps.db.prepare("SELECT * FROM agent_profiles ORDER BY name").all() };
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

  /* ------------------------------- mutating ops ------------------------------ */

  ops.set("nova_task_create", (args, { deps }) => {
    const projectId = reqString(args, "project_id");
    const key = reqString(args, "key");
    const title = reqString(args, "title");
    const objective = reqString(args, "objective");
    const profileId = resolveProfileByName(deps.db, projectId, reqString(args, "profile_name"));
    const requiresGate = optBoolean(args, "requires_human_gate");
    const contextFiles = optStringArray(args, "context_files");
    try {
      const task = createTask(deps.db, {
        projectId,
        key,
        title,
        objective,
        profileId,
        ...(requiresGate !== undefined ? { requiresHumanGate: requiresGate } : {}),
        ...(contextFiles !== undefined ? { contextFiles } : {}),
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

  ops.set("nova_task_run", async (args, { deps, surface }) => {
    const taskId = reqString(args, "task_id");
    const actor = optString(args, "actor", "operator");
    const task = await enqueueTask(deps.db, taskId, actor, {
      ...(deps.enqueueOptions?.piBin !== undefined ? { piBin: deps.enqueueOptions.piBin } : {}),
      ...(deps.enqueueOptions?.args !== undefined ? { args: deps.enqueueOptions.args } : {}),
      ...(deps.enqueueOptions?.timeoutMs !== undefined ? { timeoutMs: deps.enqueueOptions.timeoutMs } : {}),
      triggerType: surface,
    });
    deps.dispatcher.requestDispatch(); // admission changed
    return { task };
  });

  ops.set("nova_task_retry", (args, { deps, surface }) => {
    const taskId = reqString(args, "task_id");
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
    return { final_state: outcome.finalState, retry_count: outcome.retryCount };
  });

  ops.set("nova_gate_confirm_failure", (args, { deps, surface }) => {
    const payload = gatePayload(deps.db, args, {
      fillRun: true,
      approvedBy: "operator",
      note: "failure confirmed",
    });
    const outcome = confirmFailureGate(deps.db, payload, surface as GateSurface);
    return { final_state: outcome.finalState, retry_count: outcome.retryCount };
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

  // TB-1: the socket file is operator-only from the first connection
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
