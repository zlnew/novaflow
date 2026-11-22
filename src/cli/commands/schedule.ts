import { daemonRequest } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderTable } from "../format.ts";
import { resolveTaskIdent, workspaceContext } from "../context.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova schedule …` (srs 4.1.1; FR-SCH-01/03): attach/list/pause/resume
 * — thin translators over the daemon's schedule ops. The schedule id is
 * a BARE ULID on every surface (data 5.1; no invented prefix).
 *
 * Identifier rule: the task id (bare/tsk_ ULID) or the human key within
 * the active workspace — the same rule as the task noun (resolveTaskIdent).
 *
 * Exit codes (the srs 4.1.1 map): cron/ISO validation failures and the
 * DDL XOR rule arrive from the daemon as schema_invalid → 3; unknown
 * task/schedule → not_found → 4; usage shape errors → 2. Attach does
 * NOT pre-validate the payload client-side: the daemon is the single
 * validation source (a client-side copy would drift).
 *
 * `--missed` sets the per-schedule missed_policy (skip |
 * run_immediately; default: the workspace config's
 * missed_run_policy). Documented: `list --task <id|key>` scopes to one
 * task; `--workspace` scopes the unfiltered list; without either,
 * every workspace's schedules are listed (mirrors `task list`).
 */

const SPEC: ArgSpec = {
  booleanFlags: [],
  valueFlags: ["cron", "at", "missed", "task", "workspace"],
};

type ScheduleView = {
  id: string;
  task_id: string;
  cron_expr: string | null;
  run_at: string | null;
  next_run_at: string | null;
  enabled: number;
  missed_policy: string;
  last_run_at: string | null;
};

export async function scheduleCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "attach":
      return attach(p, opts);
    case "list":
      return list(p, opts);
    case "pause":
      return pause(p, opts);
    case "resume":
      return resume(p, opts);
    default:
      throw new UsageError(
        `nova schedule [attach|list|pause|resume]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`,
      );
  }
}

function workspaceOverride(p: ReturnType<typeof parseArgs>, opts: CommandOpts): string | undefined {
  return p.values.get("workspace") ?? opts.workspace;
}

async function attach(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const ident = p.positionals[1];
  if (ident === undefined) {
    throw new UsageError(
      "nova schedule attach <id|key> [--cron '<expr>' | --at <iso>] [--missed skip|run_immediately]",
    );
  }
  const task = await resolveTaskIdent(ident, workspaceOverride(p, opts));
  const data = (await daemonRequest("nova_schedule_attach", {
    task_id: task.id,
    ...(p.values.has("cron") ? { cron_expr: p.values.get("cron") } : {}),
    ...(p.values.has("at") ? { run_at: p.values.get("at") } : {}),
    ...(p.values.has("missed") ? { missed_policy: p.values.get("missed") } : {}),
  })) as { id: string; schedule: ScheduleView };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  const kind =
    data.schedule.cron_expr !== null
      ? `cron "${data.schedule.cron_expr}"`
      : `at ${data.schedule.run_at}`;
  console.log(`attached schedule ${data.id} (${kind}) — next run ${data.schedule.next_run_at}`);
  return 0;
}

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const args: Record<string, unknown> = {};
  const taskIdent = p.values.get("task");
  if (taskIdent !== undefined) {
    const task = await resolveTaskIdent(taskIdent, workspaceOverride(p, opts));
    args["task_id"] = task.id;
  } else {
    // --workspace scopes; without it every workspace's schedules
    // (documented — mirrors `task list` without --project)
    const wsFlag = workspaceOverride(p, opts);
    if (wsFlag !== undefined) {
      const ctx = await workspaceContext(wsFlag);
      args["workspace_id"] = ctx.id;
    }
  }
  const data = (await daemonRequest("nova_schedule_list", args)) as { schedules: ScheduleView[] };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  const rows = data.schedules.map((s) => ({
    ...s,
    schedule: s.cron_expr !== null ? `cron ${s.cron_expr}` : `at ${s.run_at}`,
    state: s.enabled === 1 ? "enabled" : "paused",
  }));
  console.log(
    renderTable(rows, [
      { key: "id", header: "ID" },
      { key: "task_id", header: "TASK" },
      { key: "schedule", header: "SCHEDULE" },
      { key: "next_run_at", header: "NEXT_RUN_AT" },
      { key: "state", header: "STATE" },
      { key: "missed_policy", header: "MISSED" },
    ]),
  );
  return 0;
}

async function pause(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const id = scheduleIdArg(p);
  const data = (await daemonRequest("nova_schedule_pause", { schedule_id: id })) as {
    schedule_id: string;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(`schedule ${id} paused — no runs fire while paused; resume recomputes the next run`);
  return 0;
}

async function resume(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const id = scheduleIdArg(p);
  const data = (await daemonRequest("nova_schedule_resume", { schedule_id: id })) as {
    schedule_id: string;
    schedule: ScheduleView;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(`schedule ${id} resumed — next run ${data.schedule.next_run_at}`);
  return 0;
}

function scheduleIdArg(p: ReturnType<typeof parseArgs>): string {
  const id = p.positionals[1];
  if (id === undefined) {
    throw new UsageError("nova schedule pause|resume <schedule-id>");
  }
  return id;
}
