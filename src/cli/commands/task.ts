import { daemonRequest, OpFailureError } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderKv, renderTable } from "../format.ts";
import { operatorActor, resolveTaskIdent, workspaceContext } from "../context.ts";
import { EXIT_OK, EXIT_OPERATION_FAILED } from "../exitcode.ts";
import { drainTransitions, FOLLOW_INTERVAL_MS, isTerminalState, pollIntervalMs, sleep } from "../watch.ts";
import type { CommandOpts } from "../opts.ts";
import { withFixHint } from "../../fixhint.ts";

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
 * `--watch` (run/status) was v1 SNAPSHOT POLLING: no stream op existed on
 * the wire, so the client polled nova_task_status at a documented interval
 * (default 1000 ms, NOVAFLOW_WATCH_MS override) until a terminal state. The
 * three live surfaces are now SPLIT (novaflow-v02/watch.md, v0.2.0 P3):
 *   - `status --watch` AMENDS the v1 semantics — one line per transition
 *     from `nova_transitions_since` (task-filtered, cursor held here) until
 *     the task is terminal, then the unchanged v1 status block. It no longer
 *     polls whole snapshots for output (it reads the status op only to learn
 *     terminality and to render that final block).
 *   - `logs --follow` is NEW — the fixed-1 s `nova_run_logs_since` poll of the
 *     run's REDACTED events.jsonl, following the CURRENT run only (a retry is
 *     a NEW run: the follow says so and exits rather than switching).
 *   - `run --watch` keeps the v1 snapshot poll verbatim: watch.md's table
 *     names `task status --watch`, not `run --watch` (reported, not guessed).
 *
 * Exit codes for a watch: completed → 0; failed/cancelled → 1 (operation
 * failure — the srs's "task failed" row; budget/preflight failures land here
 * through the run record).
 */

const SPEC: ArgSpec = {
  booleanFlags: ["gate", "follow"],
  valueFlags: ["title", "objective", "profile", "project", "workspace", "run", "by", "note", "lines", "state"],
  repeatableFlags: ["context", "scope"],
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
      "nova task create <key> --title <t> --objective <o> --profile <name> --project <slug|id> [--gate] [--context <path>]... [--scope <repo_alias>[:read_only|read_write]]...",
    );
  }
  /**
   * DEBT-010: `--scope <repo_alias>[:access_mode]` (repeatable) — the
   * guarded draft→queued row refuses a task with zero target_scopes, so
   * the CLI's create must be able to scope the task it creates. Syntax
   * mirrors `project create --target alias=path[:type]`; access_mode
   * defaults to read_write.
   */
  const scopeArgs = p.lists.get("scope") ?? [];
  const targetScopes = scopeArgs.map((v) => {
    const [alias, mode] = v.split(":", 2);
    if (alias === undefined || alias.trim() === "") {
      throw new UsageError(`--scope #${scopeArgs.indexOf(v) + 1} must be <repo_alias>[:read_only|read_write], got "${v}"`);
    }
    if (mode !== undefined && mode !== "read_only" && mode !== "read_write") {
      throw new UsageError(
        `--scope #${scopeArgs.indexOf(v) + 1} access mode must be read_only or read_write, got "${mode}"`,
      );
    }
    return { repo_alias: alias, access_mode: mode ?? "read_write" };
  });
  const ctx = await workspaceContext(workspaceOverride(p, opts));
  const projectId = await resolveProjectIdent(projectIdent, ctx.id);
  /**
   * FR-WS-04 AC2: `--context` values in the docs-index spelling (`docs/…`,
   * exactly what `nova docs list` prints in its path column) are DOC
   * REFERENCES, resolved by the daemon against the workspace docs index and
   * written to the same `tasks.context_files_json` the run loop injects
   * from. EVERYTHING ELSE — including plain `.md`/`.txt`/`.rst` paths
   * outside docs/ — stays the plain workspace-relative context file it has
   * always been (FR-TSK-04): routing by extension broke previously-valid
   * inputs (judge B finding 2), and the srs names the selection surface as
   * the docs-list printed path, which is always `docs/…`. The daemon does
   * the resolution because only it knows the workspace root.
   */
  const contextArgs = p.lists.get("context") ?? [];
  const isDocReference = (v: string): boolean => v.replace(/^\.\//, "").startsWith("docs/");
  const docReferences = contextArgs.filter(isDocReference);
  const plainContextFiles = contextArgs.filter((v) => !isDocReference(v));
  const data = (await daemonRequest("nova_task_create", {
    project_id: projectId,
    key,
    title,
    objective,
    profile_name: profileName,
    ...(p.flags.has("gate") ? { requires_human_gate: true } : {}),
    ...(plainContextFiles.length > 0 ? { context_files: plainContextFiles } : {}),
    ...(docReferences.length > 0 ? { doc_references: docReferences } : {}),
    ...(targetScopes.length > 0 ? { target_scopes: targetScopes } : {}),
  })) as { task: { id: string; key: string; state: string } };
  if (opts.json) console.log(JSON.stringify(data));
  else console.log(`created task ${data.task.key} (tsk_${data.task.id}) — ${data.task.state}`);
  return 0;
}

async function resolveProjectIdent(ident: string, workspaceId: string): Promise<string> {
  // bare ULIDs are verified within the active workspace too — a syntactically
  // valid id from ANOTHER workspace must not act silently (review finding 6)
  const data = (await daemonRequest("nova_project_list", { workspace_id: workspaceId })) as {
    projects: Array<{ id: string; slug: string }>;
  };
  const row = data.projects.find((x) => x.slug === ident || x.id === ident);
  if (row === undefined) {
    throw new OpFailureError(
      "not_found",
      withFixHint(
        `no project "${ident}" in the active workspace`,
        "list projects with `nova project list` and pass the exact slug",
      ),
    );
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
  if (opts.watch) return watchTaskTransitions(taskId, opts.json);
  const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as TaskStatusData;
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  console.log(statusBlock(data));
  return EXIT_OK;
}

/** The `nova_task_status` envelope the status surfaces read. */
type TaskStatusData = {
  task: Record<string, unknown>;
  current_run: Record<string, unknown> | null;
  elapsed_ms: number | null;
  workspace?: { status: string; slug: string };
};

/**
 * The v1 status block — ONE renderer for `status` and for every watch's
 * closing output, so `--watch` can never print a different "final status"
 * than the plain verb (watch.md: "the v1 final status block unchanged").
 */
function statusBlock(data: TaskStatusData): string {
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
  return renderKv(lines);
}

/**
 * `nova task status --watch` (watch.md, frozen 2026-11-23 — AMENDS v1): print
 * ONE line per transition, task-filtered, until the task is terminal, then the
 * unchanged v1 status block.
 *
 * The cursor is process-local and starts at 0 = "head" (events.md rule 2): a
 * watch is a liveness view of the live edge, and the audit history beyond that
 * page stays reachable through the plain `status`/store reads. State is read
 * from the status op only to decide terminality (and for the FR-WS-03
 * workspace guard) — the OUTPUT is transitions, never snapshots.
 */
async function watchTaskTransitions(taskId: string, json: boolean): Promise<number> {
  const intervalMs = pollIntervalMs();
  let cursor = 0;
  for (;;) {
    const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as TaskStatusData;
    // FR-WS-03 (v1 rule, carried over): a task in a non-active workspace never
    // reaches a terminal state — poll forever would be a silent hang.
    if (data.workspace !== undefined && data.workspace.status !== "active") {
      if (json) console.log(JSON.stringify({ task_id: taskId, error: "workspace_not_active", workspace: data.workspace }));
      else console.error(`workspace ${data.workspace.slug} is ${data.workspace.status} — this task will never dispatch (exit 1)`);
      return EXIT_OPERATION_FAILED;
    }
    cursor = await drainTransitions(cursor, { task_id: taskId }, json);
    if (isTerminalState(String(data.task["state"]))) break;
    await sleep(intervalMs);
  }
  return finishWatch(taskId, json);
}

/** The watch's closing output: the v1 status block plus v1's exit line. */
async function finishWatch(taskId: string, json: boolean): Promise<number> {
  const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as TaskStatusData;
  const state = String(data.task["state"]);
  if (json) {
    console.log(JSON.stringify(data));
    return state === "completed" ? EXIT_OK : EXIT_OPERATION_FAILED;
  }
  console.log(statusBlock(data));
  if (state === "completed") {
    console.log("SUCCESS task completed");
    return EXIT_OK;
  }
  console.log(`task ended in ${state} (exit 1)`);
  // surface the run's recorded failure detail (preflight/budget messages live
  // here — the v1 review-round behaviour, unchanged)
  const summary = data.current_run === null ? null : data.current_run["error_summary"];
  if (typeof summary === "string" && summary !== "") console.log(`  detail: ${summary}`);
  return EXIT_OPERATION_FAILED;
}

/** The --watch loop: poll nova_task_status until a terminal state. */
async function watchTask(taskId: string, json: boolean): Promise<number> {
  const intervalMs = Number(process.env["NOVAFLOW_WATCH_MS"] ?? 1000);
  let lastState: string | undefined;
  for (;;) {
    const data = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
      task: { state: string };
      workspace?: { status: string; slug: string };
      current_run?: { error_summary: string | null } | null;
    };
    // FR-WS-03: a task in a non-active workspace never reaches a terminal
    // state — poll forever would be a silent hang (review round finding).
    if (data.workspace !== undefined && data.workspace.status !== "active") {
      if (json) console.log(JSON.stringify({ task_id: taskId, error: "workspace_not_active", workspace: data.workspace }));
      else console.error(`workspace ${data.workspace.slug} is ${data.workspace.status} — this task will never dispatch (exit 1)`);
      return EXIT_OPERATION_FAILED;
    }
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
      const failureSummary =
        data.current_run !== null && data.current_run !== undefined
          ? data.current_run.error_summary
          : null;
      if (!json) {
        console.log(
          state === "completed"
            ? "SUCCESS task completed"
            : `task ended in ${state} (exit 1)`,
        );
        // surface the run's recorded failure detail (preflight/budget
        // messages live here — review round finding 7)
        if (state !== "completed" && failureSummary !== null && failureSummary !== "") {
          console.log(`  detail: ${failureSummary}`);
        }
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
  let tailLines: number | undefined;
  const linesFlag = p.values.get("lines");
  if (linesFlag !== undefined) {
    const n = Number(linesFlag);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new UsageError(
        withFixHint(
          "--lines must be an integer 1..1000",
          "pass an integer between 1 and 1000, e.g. `--lines 100`",
        ),
      );
    }
    tailLines = n;
  }
  // --follow: the v0.2 live tail (watch.md), not a bigger `--lines`
  if (p.flags.has("follow")) return followLogs(taskId, opts.json, tailLines);
  const args: Record<string, unknown> = { task_id: taskId };
  if (tailLines !== undefined) args["tail_lines"] = tailLines;
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

/**
 * `nova task logs <id> --follow` (watch.md, NEW in v0.2.0): poll
 * `nova_run_logs_since` on the pinned FIXED 1 s interval and print each new
 * line of the run's REDACTED events.jsonl.
 *
 * WHY THE RUN IS PINNED: a retry attempt is a NEW run with its own directory
 * and its own line offsets. Re-resolving "the task's latest run" every poll
 * would interleave two logs under one offset and silently switch what the
 * operator is watching. So the first poll fixes `run_id`; when THAT run's log
 * closes the follow says so and exits.
 *
 * `--lines <n>` is the way to start at the tail (watch.md: "a caller that
 * wants the tail asks tail_lines"); without it the follow starts at the head
 * of the file, which is what an operator watching a run from its start wants.
 *
 * Exit: 0 when the followed run's log closes (a read verb — the TASK's
 * outcome is `status`/`result`'s business), Ctrl-C at any time.
 */
async function followLogs(
  taskId: string,
  json: boolean,
  tailLines: number | undefined,
): Promise<number> {
  let runId: string | undefined;
  let offset = 0;
  let firstPoll = true;
  for (;;) {
    const args: Record<string, unknown> = { task_id: taskId };
    if (runId !== undefined) args["run_id"] = runId;
    if (firstPoll && tailLines !== undefined) args["tail_lines"] = tailLines;
    else if (!firstPoll) args["offset"] = offset;
    const page = (await daemonRequest("nova_run_logs_since", args)) as {
      run_id: string;
      lines: string[];
      offset: number;
      has_more: boolean;
      done: boolean;
    };
    runId = page.run_id;
    firstPoll = false;
    if (json) {
      // the raw rows, one page per line — and nothing at all on a silent poll
      if (page.lines.length > 0 || page.done) console.log(JSON.stringify(page));
    } else {
      for (const line of page.lines) console.log(line);
    }
    // the op's offset is the window START, so offset + len is the next window
    offset = page.offset + page.lines.length;
    if (page.has_more) continue; // a backlog drains immediately, never 1 s/line
    if (page.done) {
      await announceFollowEnd(taskId, runId, json);
      return EXIT_OK;
    }
    await sleep(FOLLOW_INTERVAL_MS);
  }
}

/**
 * Say why the follow stopped. On stderr: stdout is the log pipe and must stay
 * greppable/redirectable. Best-effort by design — the follow's job is done, so
 * a status probe that fails never turns this into an error.
 */
async function announceFollowEnd(taskId: string, runId: string, json: boolean): Promise<void> {
  if (json) return; // the final JSON page already carried done: true
  let notice = `run ${runId} is closed — no further lines will arrive (follow ends here)`;
  try {
    const st = (await daemonRequest("nova_task_status", { task_id: taskId })) as {
      current_run: { id: string } | null;
    };
    const live = st.current_run;
    if (live !== null && live.id !== runId) {
      notice = `run ${runId} is closed — resolution: a retry is a NEW run (now ${live.id}); run \`nova task logs ${taskId} --follow\` again to follow it`;
    }
  } catch {
    // the notice is best-effort: the follow's job is done already
  }
  console.error(notice);
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
