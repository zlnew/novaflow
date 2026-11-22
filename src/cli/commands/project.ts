import { daemonRequest, OpFailureError } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderKv, renderTable } from "../format.ts";
import { workspaceContext } from "../context.ts";
import { operatorActor } from "../context.ts";
import { readFileSync } from "node:fs";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova project …` (srs 4.1.1): create/list/status/phase.
 * FR-PRJ-01 (targets), FR-PRJ-02 (free-text phase labels, audited),
 * FR-PRJ-03 (per-target base branch / access mode).
 *
 * Target flag syntax (documented): `--target alias=path[:type]` where
 * type is the DDL token `git_repo` or `directory`; omitted type is
 * `directory` (v1's plain-path default). Repeating --target appends
 * targets in order.
 */

const SPEC: ArgSpec = {
  valueFlags: ["objective", "workspace", "project"],
  repeatableFlags: ["target"],
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function projectCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "create":
      return create(p, opts);
    case "list":
      return list(p, opts);
    case "status":
      return status(p, opts);
    case "phase":
      return phase(p, opts);
    case "import-dag":
      return importDag(p, opts);
    default:
      throw new UsageError(`nova project [create|list|status|phase|import-dag]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

type TargetInput = {
  alias: string;
  root_path: string;
  target_type: "git_repo" | "directory";
};

function parseTargetFlag(value: string, index: number): TargetInput {
  const eq = value.indexOf("=");
  if (eq < 1) {
    throw new UsageError(`--target #${index + 1} must be alias=path[:git_repo|directory], got "${value}"`);
  }
  const alias = value.slice(0, eq);
  let rest = value.slice(eq + 1);
  let type: "git_repo" | "directory" = "directory"; // documented default
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    const suffix = rest.slice(colon + 1);
    if (suffix === "git_repo" || suffix === "directory") {
      type = suffix;
      rest = rest.slice(0, colon);
    }
  }
  if (rest === "") {
    throw new UsageError(`--target #${index + 1} has an empty path`);
  }
  return { alias, root_path: rest, target_type: type };
}

async function create(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const name = p.positionals[1];
  const objective = p.values.get("objective");
  if (name === undefined || objective === undefined) {
    throw new UsageError("nova project create <name> --objective <text> [--target alias=path[:type]]...");
  }
  const ctx = await workspaceContext(opts.workspace ?? p.values.get("workspace"));
  const targets = (p.lists.get("target") ?? []).map(parseTargetFlag);
  const data = (await daemonRequest("nova_project_create", {
    workspace_id: ctx.id,
    name,
    objective,
    ...(targets.length > 0 ? { targets } : {}),
  })) as {
    project: { id: string; slug: string; phase: string };
    targets: Array<{ alias: string }>;
  };
  if (opts.json) console.log(JSON.stringify(data));
  else {
    console.log(`created project ${data.project.slug} (id ${data.project.id}, phase ${data.project.phase})`);
    for (const t of data.targets) console.log(`  target: ${t.alias}`);
  }
  return 0;
}

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const explicit = p.values.get("workspace") ?? opts.workspace;
  // scoped to the active workspace when one exists; otherwise every
  // workspace's projects (documented — the op's no-arg behavior)
  let workspaceId: string | undefined;
  if (explicit !== undefined) {
    workspaceId = (await workspaceContext(explicit)).id;
  } else {
    try {
      workspaceId = (await workspaceContext()).id;
    } catch (err) {
      if (err instanceof OpFailureError || err instanceof UsageError) workspaceId = undefined;
      else throw err;
    }
  }
  const data = (await daemonRequest("nova_project_list",
    workspaceId !== undefined ? { workspace_id: workspaceId } : {})) as {
    projects: Array<Record<string, unknown>>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(
    renderTable(data.projects, [
      { key: "slug", header: "SLUG" },
      { key: "phase", header: "PHASE" },
      { key: "status", header: "STATUS" },
      { key: "target_count", header: "TARGETS" },
      { key: "id", header: "ID" },
    ]),
  );
  return 0;
}

/** Resolve <id|slug> to a project id within the active workspace. */
async function resolveProject(
  ident: string,
  workspaceOverride: string | undefined,
): Promise<string> {
  const ctx = await workspaceContext(workspaceOverride);
  // bare ULIDs verified within the active workspace (cross-scope ids refuse)
  const data = (await daemonRequest("nova_project_list", { workspace_id: ctx.id })) as {
    projects: Array<{ id: string; slug: string }>;
  };
  const row = data.projects.find((x) => x.slug === ident || x.id === ident);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no project "${ident}" in workspace ${ctx.slug}`);
  }
  return row.id;
}

async function status(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const ident = p.positionals[1];
  if (ident === undefined) {
    throw new UsageError("nova project status <id|slug>");
  }
  const projectId = await resolveProject(ident, opts.workspace ?? p.values.get("workspace"));
  const data = (await daemonRequest("nova_project_status", { project_id: projectId })) as {
    project: Record<string, unknown>;
    task_counts: Record<string, number>;
    targets: Array<Record<string, unknown>>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  const project = data.project;
  console.log(
    renderKv([
      ["id", String(project["id"])],
      ["slug", String(project["slug"])],
      ["objective", String(project["objective"])],
      ["phase", String(project["phase"])],
      ["status", String(project["status"])],
      ["created_at", String(project["created_at"])],
    ]),
  );
  const counts = Object.entries(data.task_counts)
    .map(([state, n]) => `${state}=${n}`)
    .join(" ");
  console.log(`tasks: ${counts === "" ? "(none)" : counts}`);
  if (data.targets.length > 0) {
    console.log(
      renderTable(data.targets, [
        { key: "alias", header: "TARGET" },
        { key: "target_type", header: "TYPE" },
        { key: "default_access", header: "ACCESS" },
        { key: "base_branch", header: "BASE" },
      ]),
    );
  }
  return 0;
}

async function phase(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const ident = p.positionals[1];
  const label = p.positionals.slice(2).join(" ");
  if (ident === undefined || label === "") {
    throw new UsageError("nova project phase <id|slug> <label...>");
  }
  const projectId = await resolveProject(ident, opts.workspace ?? p.values.get("workspace"));
  const data = (await daemonRequest("nova_project_phase_set", {
    project_id: projectId,
    phase: label,
    actor: operatorActor(),
  })) as { phase: string; changed: boolean };
  if (opts.json) console.log(JSON.stringify(data));
  else {
    console.log(
      data.changed
        ? `project phase: ${data.phase} (change audited)`
        : `project phase already: ${data.phase} (no change, nothing audited)`,
    );
  }
  return 0;
}

/**
 * `nova project import-dag <file> [--project <slug>]` (srs 4.1.1;
 * FR-PRJ-04): the CLI is a THIN CLIENT — it reads the file's RAW TEXT
 * and passes it (+ a format hint derived from the extension: .json →
 * json, .yaml/.yml → yaml, anything else → auto) to the daemon, the
 * single parse+validate+import source. `--project` is a consistency
 * pin only: the §4.3 schema CARRIES project_slug, and a mismatch
 * refuses (exit 3) — the flag never retargets the import.
 */
async function importDag(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const file = p.positionals[1];
  if (file === undefined) {
    throw new UsageError("nova project import-dag <file> [--project <slug>]");
  }
  let graphText: string;
  try {
    graphText = readFileSync(file, "utf8");
  } catch (err) {
    throw new OpFailureError("not_found", `cannot read ${file}: ${(err as Error).message}`);
  }
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const format = ext === "json" ? "json" : ext === "yaml" || ext === "yml" ? "yaml" : undefined;
  const ctx = await workspaceContext(p.values.get("workspace") ?? opts.workspace);
  const data = (await daemonRequest("nova_project_import_dag", {
    workspace_id: ctx.id,
    graph_text: graphText,
    ...(format !== undefined ? { format } : {}),
    ...(p.values.get("project") !== undefined ? { project_slug: p.values.get("project") } : {}),
  })) as {
    chain_run_id: string;
    chain_run: { state: string };
    tasks: Record<string, { id: string; key: string; state: string }>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  const members = Object.values(data.tasks);
  console.log(
    `imported chain ${data.chain_run_id} (${data.chain_run.state}) — ${members.length} member${members.length === 1 ? "" : "s"} in draft; enqueue roots with 'nova task run'`,
  );
  for (const m of members) {
    console.log(`  ${m.key} (tsk_${m.id}) — ${m.state}`);
  }
  return 0;
}
