import { readFileSync } from "node:fs";
import { daemonRequest, OpFailureError } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderTable } from "../format.ts";
import { readActiveWorkspace } from "../active.ts";
import { workspaceContext } from "../context.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova profile …` (srs 4.1.1): create/list/validate/update/delete.
 *
 * create reads the profile.json file THROUGH THE DAEMON (single
 * writer): the op validates it with the §4.2 validator, inserts the
 * row, and stores the canonical copy at
 * <workspace_root>/.novaflow/profiles/<name>.json. Scoping (documented):
 * --workspace or the active marker scopes the profile to that
 * workspace; with neither, the profile is GLOBAL. validate is the
 * STRUCTURAL check only — the live catalog probe (profile_unresolved
 * on an unresolvable model) happens at enqueue (FR-AGT-01).
 *
 * update/delete (v0.2.0 P5, DEBT-008) are thin clients of the daemon's
 * `nova_profile_update` / `nova_profile_delete` ops — the daemon owns
 * the store, the canonical file AND the FK-safe pin count. update reads
 * the operator's file HERE (a plain file read, never a store read) and
 * sends the raw JSON document; the daemon rewrites the row and the
 * canonical copy in one transaction. The daemon reports which SCOPE it
 * acted on (a workspace-scoped row wins over a global row of the same
 * name, exactly as the engine resolves a task's profile) and this
 * command prints it.
 */

const SPEC: ArgSpec = {
  valueFlags: ["file", "workspace"],
};

export async function profileCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "create":
      return create(p, opts);
    case "update":
      return update(p, opts);
    case "delete":
      return remove(p, opts);
    case "list":
      return list(p, opts);
    case "validate":
      return validate(p, opts);
    default:
      throw new UsageError(`nova profile [create|update|delete|list|validate]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

/**
 * The documented scoping rule every profile verb shares: `--workspace`
 * (or the common flag) names the workspace; otherwise the CLI-local
 * active marker scopes the call; with neither the profile is GLOBAL.
 */
async function scopeWorkspace(
  p: ReturnType<typeof parseArgs>,
  opts: CommandOpts,
): Promise<string | undefined> {
  const explicit = p.values.get("workspace") ?? opts.workspace;
  if (explicit !== undefined) return (await workspaceContext(explicit)).id;
  const active = readActiveWorkspace();
  return active === null ? undefined : (await workspaceContext(active)).id;
}

function scopeWord(scope: string): string {
  return scope === "global" ? "global" : "workspace-scoped";
}


async function create(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const file = p.values.get("file");
  if (file === undefined) {
    throw new UsageError("nova profile create --file <path>");
  }
  const workspaceId = await scopeWorkspace(p, opts);
  const data = (await daemonRequest("nova_profile_create", {
    ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    file_path: file,
  })) as {
    profile: { name: string; workspace_id: string | null };
    canonical_path: string | null;
  };
  if (opts.json) console.log(JSON.stringify(data));
  else {
    const scope = data.profile.workspace_id === null ? "global" : "workspace-scoped";
    console.log(`created profile ${data.profile.name} (${scope})`);
    if (data.canonical_path !== null) console.log(`  canonical: ${data.canonical_path}`);
  }
  return 0;
}

/**
 * `nova profile update <name> --file <path>` (DEBT-008). The file is read
 * and parsed HERE (the daemon never sees a client path for this op — it
 * receives the raw document), then the daemon owns the rest: the §4.2
 * validator, the catalog probe, the row + canonical-file rewrite, the
 * no-change refusal and the scope report.
 */
async function update(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const name = p.positionals[1];
  const file = p.values.get("file");
  if (name === undefined || file === undefined) {
    throw new UsageError("nova profile update <name> --file <path>");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // the same schema_invalid row create raises for an unreadable file
    throw new OpFailureError(
      "schema_invalid",
      `profile file unreadable or not JSON: ${file} (${(err as Error).message})`,
    );
  }
  const workspaceId = await scopeWorkspace(p, opts);
  const data = (await daemonRequest("nova_profile_update", {
    name,
    ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    profile: raw,
  })) as {
    profile: { name: string; model: string };
    scope: string;
    workspace_id: string | null;
    canonical_path: string | null;
    changed: boolean;
  };
  if (opts.json) console.log(JSON.stringify(data));
  else {
    console.log(`updated profile ${data.profile.name} (${scopeWord(data.scope)})`);
    console.log(`  model: ${data.profile.model}`);
    if (data.canonical_path !== null) console.log(`  canonical: ${data.canonical_path}`);
  }
  return 0;
}

/**
 * `nova profile delete <name>` (DEBT-008) — thin client of the daemon's
 * FK-safe delete: a profile any task pins is refused (schema_invalid,
 * naming the count) and never deleted. A canonical-file removal failure
 * after the row is gone is REPORTED on stderr, never swallowed.
 */
async function remove(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const name = p.positionals[1];
  if (name === undefined) {
    throw new UsageError("nova profile delete <name>");
  }
  const workspaceId = await scopeWorkspace(p, opts);
  const data = (await daemonRequest("nova_profile_delete", {
    name,
    ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
  })) as {
    name: string;
    scope: string;
    workspace_id: string | null;
    canonical_path: string | null;
    file_removed: boolean;
    file_removal_error: string | null;
  };
  if (opts.json) console.log(JSON.stringify(data));
  else {
    console.log(`deleted profile ${data.name} (${scopeWord(data.scope)})`);
    if (data.canonical_path !== null) {
      const note = data.file_removed ? " (removed)" : " (already absent)";
      console.log(`  canonical: ${data.canonical_path}${note}`);
    }
  }
  if (data.file_removal_error !== null) {
    console.error(
      `nova: warning: profile ${data.name} was deleted but its canonical file ${String(data.canonical_path)} could not be removed: ${data.file_removal_error}`,
    );
  }
  return 0;
}

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const workspaceId = await scopeWorkspace(p, opts);
  const data = (await daemonRequest("nova_profile_list",
    workspaceId !== undefined ? { workspace_id: workspaceId } : {})) as {
    profiles: Array<Record<string, unknown>>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(
    renderTable(data.profiles, [
      { key: "name", header: "NAME" },
      { key: "workspace_id", header: "WORKSPACE" },
      { key: "model", header: "MODEL" },
      { key: "thinking_level", header: "THINKING" },
      { key: "id", header: "ID" },
    ]),
  );
  return 0;
}

async function validate(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const name = p.positionals[1];
  if (name === undefined) {
    throw new UsageError("nova profile validate <name>");
  }
  const workspaceId = await scopeWorkspace(p, opts);
  // resolve the name within the current scope (locals + globals)
  const data = (await daemonRequest("nova_profile_list",
    workspaceId !== undefined ? { workspace_id: workspaceId } : {})) as {
    profiles: Array<{ id: string; name: string }>;
  };
  const row = data.profiles.find((x) => x.name === name);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no profile named "${name}" in the current scope`);
  }
  const result = (await daemonRequest("nova_profile_validate", { profile_id: row.id })) as {
    ok: boolean;
    name: string;
  };
  if (opts.json) {
    console.log(JSON.stringify(result));
    return 0;
  }
  console.log(`profile ${result.name}: structurally valid (catalog probe happens at enqueue)`);
  return 0;
}
