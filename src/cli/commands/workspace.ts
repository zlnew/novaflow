import { daemonRequest } from "../client.ts";
import { parseArgs, UsageError, type ParsedArgs, type ArgSpec } from "../args.ts";
import { renderTable } from "../format.ts";
import { writeActiveWorkspace } from "../active.ts";
import { workspaceContext } from "../context.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova workspace …` (srs 4.1.1): create/list/switch/archive/unregister.
 * Thin translators over the daemon ops — every write goes through the
 * socket (single-writer rule, architecture 8.1). `--json` prints the
 * op's data envelope, single-line.
 *
 * switch is CLI-local state by ruling (documented in src/cli/active.ts):
 * the marker is validated against the daemon's registry and written to
 * <NOVAFLOW_HOME>/active-workspace; the daemon has no switch op.
 */

/** Every command accepts the common flags --workspace/--json/--watch. */
const SPEC: ArgSpec = {
  valueFlags: ["path", "default-branch", "workspace"],
};

export async function workspaceCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "create":
      return create(p, opts.json);
    case "list":
      return list(p, opts.json);
    case "switch":
      return switchTo(p, opts.json);
    case "archive":
      return archive(p, opts.json);
    case "unregister":
      return unregister(p, opts.json);
    default:
      throw new UsageError(`nova workspace [create|list|switch|archive|unregister]${unknown(sub)}`);
  }
}

function unknown(sub: string | undefined): string {
  return sub === undefined ? "" : ` — unknown subcommand "${sub}"`;
}

async function create(p: ParsedArgs, json: boolean): Promise<number> {
  const name = p.positionals[1];
  const path = p.values.get("path");
  if (name === undefined || path === undefined) {
    throw new UsageError("nova workspace create <name> --path <dir> [--default-branch b]");
  }
  const args: Record<string, unknown> = { name, root_path: path };
  const branch = p.values.get("default-branch");
  if (branch !== undefined) args["default_branch"] = branch;
  const data = (await daemonRequest("nova_workspace_create", args)) as {
    id: string;
    workspace: { slug: string; root_path: string; status: string; created_at: string };
  };
  if (json) console.log(JSON.stringify(data));
  else {
    console.log(`created workspace ${data.workspace.slug} (id ${data.id})`);
    console.log(`  root: ${data.workspace.root_path}`);
  }
  return 0;
}

async function list(p: ParsedArgs, json: boolean): Promise<number> {
  void p;
  const data = (await daemonRequest("nova_workspace_list")) as {
    workspaces: Array<Record<string, unknown>>;
  };
  if (json) {
    console.log(JSON.stringify(data));
    return 0;
  }
  console.log(
    renderTable(data.workspaces, [
      { key: "slug", header: "SLUG" },
      { key: "status", header: "STATUS" },
      { key: "root_path", header: "ROOT" },
      { key: "id", header: "ID" },
    ]),
  );
  return 0;
}

async function switchTo(p: ParsedArgs, json: boolean): Promise<number> {
  const slug = p.positionals[1];
  if (slug === undefined) {
    throw new UsageError("nova workspace switch <slug>");
  }
  const ctx = await workspaceContext(slug); // not_found when the slug is unknown
  writeActiveWorkspace(ctx.slug);
  if (json) console.log(JSON.stringify({ active: ctx.slug, id: ctx.id }));
  else console.log(`active workspace: ${ctx.slug} (${ctx.id})`);
  return 0;
}

function identArg(slugOrId: string): Record<string, string> {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(slugOrId) ? { workspace_id: slugOrId } : { slug: slugOrId };
}

async function archive(p: ParsedArgs, json: boolean): Promise<number> {
  const slug = p.positionals[1];
  if (slug === undefined) {
    throw new UsageError("nova workspace archive <slug>");
  }
  const data = (await daemonRequest("nova_workspace_archive", identArg(slug))) as {
    slug: string;
    status: string;
  };
  if (json) console.log(JSON.stringify(data));
  else console.log(`workspace ${data.slug}: ${data.status} (task execution disabled; logs stay read-only)`);
  return 0;
}

async function unregister(p: ParsedArgs, json: boolean): Promise<number> {
  const slug = p.positionals[1];
  if (slug === undefined) {
    throw new UsageError("nova workspace unregister <slug>");
  }
  const data = (await daemonRequest("nova_workspace_unregister", identArg(slug))) as {
    unregistered: string;
  };
  if (json) console.log(JSON.stringify(data));
  else {
    console.log(`unregistered workspace ${data.unregistered}`);
    console.log("  the registry entry was removed; files on disk were NOT touched");
  }
  return 0;
}
