import { daemonRequest, OpFailureError } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderKv, renderTable } from "../format.ts";
import { operatorActor, resolveTaskIdent, workspaceContext } from "../context.ts";
import { EXIT_OK, EXIT_OPERATION_FAILED } from "../exitcode.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova task …` (srs 4.1.1): create/list/run/status/result/logs/abort/
 * retry/steer/gate-approve/gate-reject — thin translators over the
 * daemon's task ops.
 *
 * Identifier rule (srs 4.1.1, implemented in src/cli/context.ts): the
 * ULID id (bare or tsk_ display form) resolves directly; the human key
 * resolves within the active workspace context. `--project <slug|id>`
 * is REQUIRED on create (spec-silent, documented: there is no active-
 * project marker in v1).
 *
 * `--watch` (run/status): v1 POLLING — no stream op exists on the wire,
 * so the client polls nova_task_status at a documented interval
 * (default 1000 ms, NOVAFLOW_WATCH_MS override) until a terminal
 * state, printing each observed transition. Exit: completed → 0;
 * failed/cancelled → 1 (operation failure — the srs's "task failed"
 * row; budget/preflight failures land here through the run record).
 */

const SPEC: ArgSpec = {
  booleanFlags: ["gate"],
  valueFlags: ["title", "objective", "profile", "project", "workspace", "run", "by", "note", "lines", "state"],
  repeatableFlags: ["context"],
};

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function taskCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "create":
      return create(p, opts);
    case "list":
      return list(p, opts);
    case "run":
      return run(p, opts);
    case "status":
      return status(p, opts);
    case "result":
      return result(p, opts);
    case "logs":
      return logs(p, opts);
    case "abort":
      return abort(p, opts);
    case "retry":
      return retry(p, opts);
    case "steer":
      return steer(p, opts);
    case "gate-approve":
      return gateApprove(p, opts);
    case "gate-reject":
      return gateReject(p, opts);
    default:
      throw new UsageError(`nova task [create|list|run|status|result|logs|abort|retry|steer|gate-approve|gate-reject]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

function workspaceOverride(p: ReturnType<typeof parseArgs>, opts: CommandOpts): string | undefined {
  return p.values.get("workspace") ?? opts.workspace;
}

async function identOrThrow(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<string> {
  const ident = p.positionals[1];
  if (ident === undefined) {
    throw new UsageError(`nova task ${p.positionals[0]} <id|key>`);
  }
  const task = await resolveTaskIdent(ident, workspaceOverride(p, opts));
  return task.id;
}

async function create(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const key = p.positionals[1];
  const title = p.values.get("title");
  const objective = p.values.get("objective");
  const profileName = p.values.get("profile");
  const projectIdent = p.values.get("project");
  if (key === undefined || title === undefined || objective === undefined || profileName === undefined || projectIdent === undefined) {
    throw new UsageError(
      "nova task create <key> --title <t> --objective <o> --profile <name> --project <slug|id> [--gate] [--context <path>]...",
    );
  }
  const ctx = await workspaceContext(workspaceOverride(p, opts));
  const projectId = await resolveProjectIdent(projectIdent, ctx.id);
  const data = (await daemonRequest("nova_task_create", {
    project_id: projectId,
    key,
    title,
    objective,
    profile_name: profileName,
    ...(p.flags.has("gate") ? { requires_human_gate: true } : {}),
    ...(p.lists.has("context") ? { context_files: p.lists.get("context") } : {}),
  })) as { task: { id: string; key: string; state: string } };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`created task ${data.task.key} (tsk_${data.task.id}) — ${data.task.state}`);
  return 0;
}

async function resolveProjectIdent(ident: string, workspaceId: string): Promise<string> {
  if (ULID_RE.test(ident)) return ident;
  const data = (await daemonRequest("nova_project_list", { workspace_id: workspaceId })) as {
    projects: Array<{ id: string; slug: string }>;
  };
  const row = data.projects.find((x) => x.slug === ident || x.id === ident);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no project "${ident}" in the active workspace`);
  }
  return row.id;
}

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  // --project scopes; without it the op lists every task (documented)
  const args: Record<string, unknown> = {};
  const projectIdent = p.values.get("project");
  if (projectIdent !== undefined) {
    const ctx = await workspaceContext(workspaceOverride(p, opts));
    args["project_id"] = await resolveProjectIdent(projectIdent, ctx.id);
  }
  const state = p.values.get("state");
  if (state !== undefined) args["state"] = state;
  const data = (await daemonRequest("nova_task_list", args)) as {
    tasks: Array<Record<string, unknown>>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(
    renderTable(data.tasks, [
      { key: "key", header: "KEY" },
      { key: "state", header: "STATE" },
      { key: "title", header: "TITLE" },
      { key: "id", header: "ID" },
    ]),
  );
  return 0;
}

async function run(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const data = (await daemonRequest("nova_task_run", {
    task_id: taskId,
    actor: operatorActor(),
  })) as { task: { state: string } };
  if (!opts.watch) {
    if (opts.json) console.log(JSON.stringify(data));
    else console.log(`task tsk_${taskId}: ${data.task.state}`);
    return EXIT_OK;
  }
  return watchTask(taskId, opts.json);
}

async function status(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  if (opts.watch) return watchTask(taskId, opts.json);
  const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
    task: Record<string, unknown>;
    current_run: Record<string, unknown> | null;
    elapsed_ms: number | null;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  const lines: Array<[string, string]> = [
    ["id", `tsk_${String(data.task["id"])}`],
    ["key", String(data.task["key"])],
    ["title", String(data.task["title"])],
    ["state", String(data.task["state"])],
    ["retry_count", String(data.task["retry_count"])],
  ];
  if (data.current_run !== null) {
    lines.push(["run", String(data.current_run["id"])]);
    lines.push(["run_status", String(data.current_run["status"])]);
    lines.push(["verification", String(data.current_run["engine_verification_passed"]) === "1" ? "passed" : "not passed"]);
  }
  if (data.elapsed_ms !== null) lines.push(["elapsed_ms", String(data.elapsed_ms)]);
  console.log(renderKv(lines));
  return EXIT_OK;
}

/** The --watch loop: poll nova_task_status until a terminal state. */
async function watchTask(taskId: string, json: boolean): Promise<number> {
  const intervalMs = Number(process.env["NOVAFLOW_WATCH_MS"] ?? 1000);
  let lastState: string | undefined;
  for (;;) {
    const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
      task: { state: string };
    };
    const state = data.task.state;
    if (state !== lastState) {
      lastState = state;
      if (json) {
        console.log(JSON.stringify({ task_id: taskId, state, at: new Date().toISOString() }));
      } else {
        const clock = new Date().toISOString().slice(11, 19);
        console.log(`[${clock}] tsk_${taskId} ${state}`);
      }
    }
    if (TERMINAL_STATES.has(state)) {
      if (!json) {
        console.log(
          state === "completed"
            ? "SUCCESS task completed"
            : `task ended in ${state} (exit 1)`,
        );
      }
      return state === "completed" ? EXIT_OK : EXIT_OPERATION_FAILED;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function result(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const data = (await daemonRequest("nova_result_get", { task_id: taskId })) as {
    run_id: string;
    artifact: Record<string, unknown>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(`run ${data.run_id} — result.json:`);
  console.log(JSON.stringify(data.artifact, null, 2));
  return 0;
}

async function logs(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const args: Record<string, unknown> = { task_id: taskId };
  const linesFlag = p.values.get("lines");
  if (linesFlag !== undefined) {
    const n = Number(linesFlag);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new UsageError("--lines must be an integer 1..1000");
    }
    args["tail_lines"] = n;
  }
  const data = (await daemonRequest("nova_run_logs", args)) as {
    run_id: string;
    lines: string[];
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  for (const line of data.lines) console.log(line);
  return 0;
}

async function abort(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const data = (await daemonRequest("nova_task_abort", {
    task_id: taskId,
    actor: operatorActor(),
  })) as { final_state: string };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`task tsk_${taskId}: ${data.final_state}`);
  return 0;
}

async function retry(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const data = (await daemonRequest("nova_task_retry", {
    task_id: taskId,
    actor: operatorActor(),
  })) as { decision: { kind: string } };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`task tsk_${taskId}: ${data.decision.kind}`);
  return 0;
}

async function steer(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const message = p.positionals.slice(2).join(" ");
  if (message === "") {
    throw new UsageError("nova task steer <id|key> <message...>");
  }
  const data = (await daemonRequest("nova_task_steer", { task_id: taskId, message })) as {
    steered: boolean;
  };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`steered task tsk_${taskId}`);
  return 0;
}

async function gateApprove(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  // run_id: --run, else the live run (the gate approval contract)
  let runId = p.values.get("run");
  if (runId === undefined) {
    const st = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
      current_run: { id: string } | null;
    };
    if (st.current_run === null) {
      throw new OpFailureError("not_found", `task tsk_${taskId} has no run to approve`);
    }
    runId = st.current_run.id;
  }
  const data = (await daemonRequest("nova_gate_approve", {
    task_id: taskId,
    run_id: runId,
    approved_by: p.values.get("by") ?? operatorActor(),
    note: p.values.get("note") ?? "",
  })) as { final_state: string };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`task tsk_${taskId}: ${data.final_state} (gate approved)`);
  return 0;
}

async function gateReject(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const taskId = await identOrThrow(p, opts);
  const feedback = p.positionals.slice(2).join(" ");
  if (feedback === "") {
    throw new UsageError("nova task gate-reject <id|key> <feedback...>");
  }
  const data = (await daemonRequest("nova_gate_reject", {
    task_id: taskId,
    feedback,
  })) as { final_state: string; retry_count: number };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`task tsk_${taskId}: ${data.final_state} (retry ${data.retry_count})`);
  return 0;
}
