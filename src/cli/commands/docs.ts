import { daemonRequest } from "../client.ts";
import { parseArgs, UsageError, type ArgSpec } from "../args.ts";
import { renderTable } from "../format.ts";
import { EXIT_OK } from "../exitcode.ts";
import type { CommandOpts } from "../opts.ts";

/**
 * `nova docs list [<workspace>]` — the FR-WS-04 AC2 read verb (srs 4.1.1
 * amendment; the daemon op is `nova_docs_list`).
 *
 * The comment on that op matters here: there is NO index state to read.
 * Each call is a fresh scan of `<workspace_root>/docs/` in the DAEMON
 * (which knows the root from the store; the CLI never opens the store),
 * filtered to `.md`/`.txt`/`.rst` — the exact FR-WS-04 AC1 extension list.
 * The printed rows are the "selectable prompt injection options": any
 * `path` here can be handed to `nova task create --context <path>`.
 */

const SPEC: ArgSpec = {
  valueFlags: ["workspace"],
};

export async function docsCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, SPEC);
  const sub = p.positionals[0];
  switch (sub) {
    case "list":
      return list(p, opts);
    default:
      throw new UsageError(`nova docs [list]${sub === undefined ? "" : ` — unknown subcommand "${sub}"`}`);
  }
}

async function list(p: ReturnType<typeof parseArgs>, opts: CommandOpts): Promise<number> {
  // the workspace is the positional (--workspace also accepts it)
  const ident = p.positionals[1] ?? p.values.get("workspace") ?? opts.workspace;
  const args: Record<string, unknown> = {};
  if (ident !== undefined) {
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ident)) args["workspace_id"] = ident;
    else args["slug"] = ident;
  }
  const data = (await daemonRequest("nova_docs_list", args)) as {
    workspace: string;
    workspace_id: string;
    docs_dir: string;
    docs: Array<{ path: string; absolute_path: string; extension: string; size_bytes: number }>;
  };
  if (opts.json) {
    console.log(JSON.stringify(data));
    return EXIT_OK;
  }
  if (data.docs.length === 0) {
    console.log(`no indexed documents under ${data.docs_dir}`);
    console.log("  index: .md, .txt, .rst (FR-WS-04)");
    return EXIT_OK;
  }
  console.log(`${data.docs.length} indexed document${data.docs.length === 1 ? "" : "s"} under ${data.docs_dir}`);
  console.log(
    renderTable(data.docs, [
      { key: "path", header: "DOCUMENT" },
      { key: "extension", header: "TYPE" },
      { key: "size_bytes", header: "BYTES" },
    ]),
  );
  console.log(`inject one with: nova task create … --context ${data.docs[0]!.path}`);
  return EXIT_OK;
}
