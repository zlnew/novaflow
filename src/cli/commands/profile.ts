import { daemonRequest, OpFailureError } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderTable } from "../format.ts";
import { readActiveWorkspace } from "../active.ts";
import { workspaceContext } from "../context.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova profile …` (srs 4.1.1): create/list/validate.
 *
 * create reads the profile.json file THROUGH THE DAEMON (single
 * writer): the op validates it with the §4.2 validator, inserts the
 * row, and stores the canonical copy at
 * <workspace_root>/.novaflow/profiles/<name>.json. Scoping (documented):
 * --workspace or the active marker scopes the profile to that
 * workspace; with neither, the profile is GLOBAL. validate is the
 * STRUCTURAL check only — the live catalog probe (profile_unresolved
 * on an unresolvable model) happens at enqueue (FR-AGT-01).
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
    case "list":
      return list(p, opts);
    case "validate":
      return validate(p, opts);
    default:
      throw new UsageError(`nova profile [create|list|validate]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

async function create(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const file = p.values.get("file");
  if (file === undefined) {
    throw new UsageError("nova profile create --file <path>");
  }
  const explicit = p.values.get("workspace") ?? opts.workspace;
  let workspaceId: string | undefined;
  if (explicit !== undefined) {
    workspaceId = (await workspaceContext(explicit)).id;
  } else {
    // the active marker scopes the profile when one exists (documented)
    const active = readActiveWorkspace();
    if (active !== null) workspaceId = (await workspaceContext(active)).id;
  }
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

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  const explicit = p.values.get("workspace") ?? opts.workspace;
  let workspaceId: string | undefined;
  if (explicit !== undefined) {
    workspaceId = (await workspaceContext(explicit)).id;
  } else {
    const active = readActiveWorkspace();
    if (active !== null) workspaceId = (await workspaceContext(active)).id;
  }
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
  const explicit = p.values.get("workspace") ?? opts.workspace;
  let workspaceId: string | undefined;
  if (explicit !== undefined) {
    workspaceId = (await workspaceContext(explicit)).id;
  } else {
    const active = readActiveWorkspace();
    if (active !== null) workspaceId = (await workspaceContext(active)).id;
  }
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
