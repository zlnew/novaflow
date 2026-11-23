import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  exitCodeForTaxonomy,
} from "./exitcode.ts";
import { DaemonUnreachableError, OpFailureError } from "./client.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { projectCommand } from "./commands/project.ts";
import { profileCommand } from "./commands/profile.ts";
import { taskCommand } from "./commands/task.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { statusCommand } from "./commands/status.ts";
import { webCommand } from "./commands/web.ts";
import { chainCommand } from "./commands/chain.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { docsCommand } from "./commands/docs.ts";
import type { CommandOpts } from "./opts.ts";

/**
 * `nova` — the CLI entry (srs 4.1.1). A thin client of the daemon's
 * JSONL socket surface: one command = one op call (single-writer rule,
 * architecture 8.1). The CLI never opens the SQLite store.
 *
 * `nova mcp` (p5) starts the MCP control surface on stdio
 * (novaflow-v1/mcp): it is a SERVER, so it runs until its client
 * disconnects and exits 0 — see src/cli/commands/mcp.ts for why the srs
 * exit map does not apply to it. `nova chain` shipped in p4a
 * (list/status/abort + FR-TSK-08's pause/resume).
 */

const VERSION = readVersion();

function readVersion(): string {
  try {
    return String(
      (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string })
        .version,
    );
  } catch {
    return "0.0.0";
  }
}

/** The srs 4.1.1 command table, with the not-in-phase nouns marked. */
const USAGE = `USAGE: nova <noun> <sub> [args] [flags]
  common flags: --workspace <slug|id>   --json   --watch

  nova workspace create <name> --path <dir> [--default-branch <b>]
  nova workspace list | switch <slug> | archive <slug> | unregister <slug>
  nova project create <name> --objective <text> [--target alias=path[:git_repo|directory]]...
  nova project list | status <id|slug> | phase <id|slug> <label...>
  nova project import-dag <file> [--project <slug>]
  nova profile create --file <path> | update <name> --file <path> | delete <name> | list | validate <name>
  nova task create <key> --title <t> --objective <o> --profile <name> --project <slug|id> [--gate] [--context <path>]...
  nova task run <id|key> [--watch] | status <id|key> [--watch] | list
  nova task result <id|key> | logs <id|key> [--lines <n>] [--follow] | abort | retry <id|key>
  nova task steer <id|key> <message...>
  nova task gate-approve <id|key> [--run <id>] [--by <name>] [--note <text>]
  nova task gate-reject <id|key> <feedback...>
  nova daemon start [--foreground] | stop | status | pause | resume | kill-all
  nova daemon backup [--out <path>] | prune [--retention-days <n>]
  nova daemon logs [--lines <n>]
  nova status [--watch] [--json]
  nova web sync [--run <id|key> | --all]
  nova web start | stop | status [--json]
  nova docs list [<workspace>]
  nova version
  nova schedule attach <id|key> [--cron '<expr>' | --at <iso>] [--missed skip|run_immediately]
  nova schedule list [--task <id|key>] [--workspace <slug|id>]
  nova schedule pause <schedule-id> | resume <schedule-id>
  nova chain list | status <chain-run-id> [--watch]
  nova chain abort | pause | resume <chain-run-id>
  nova chain verify <chain-run-id>   (configured vs executed verification commands,
                                      per member run; exit 3 when one is UNEXECUTED)
  nova chain clean <chain-run-id> [--force]
  nova mcp            (MCP server on stdio; runs until its client disconnects)`;

/**
 * Run one CLI invocation; returns the process exit code (0–5, the srs
 * 4.1.1 map). Never throws.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`nova: ${err.message}`);
      console.error(USAGE);
      return EXIT_USAGE;
    }
    if (err instanceof DaemonUnreachableError) {
      console.error(`nova: ${err.message}`);
      return EXIT_DAEMON_UNREACHABLE;
    }
    if (err instanceof OpFailureError) {
      console.error(`nova: ${err.code}: ${err.message}`);
      return exitCodeForTaxonomy(err.code);
    }
    console.error(`nova: unexpected failure: ${(err as Error).message}`);
    return EXIT_OPERATION_FAILED;
  }
}

/** Sub-usage errors thrown as plain errors by noun modules are usage too. */
async function dispatch(argv: string[]): Promise<number> {
  let [noun, ...rest] = argv;
  // conventional alias: --version / -V is `nova version` (review finding)
  if (noun === "--version" || noun === "-V") {
    noun = "version";
    rest = [];
  }
  if (noun === undefined || noun === "" || noun === "help") {
    console.error(USAGE);
    return EXIT_USAGE;
  }

  // The common flags are parsed by each noun module's spec; dispatch
  // hands the raw argv through and threads the resolved opts.
  const opts = commandOpts(rest);

  switch (noun) {
    case "workspace":
      return workspaceCommand(rest, opts);
    case "project":
      return projectCommand(rest, opts);
    case "profile":
      return profileCommand(rest, opts);
    case "task":
      return taskCommand(rest, opts);
    case "schedule":
      return scheduleCommand(rest, opts);
    case "daemon":
      return daemonCommand(rest, opts);
    case "status":
      return statusCommand(rest, opts);
    case "web":
      return webCommand(rest, opts);
    case "version":
      return version(opts.json);
    case "chain":
      return chainCommand(rest, opts);
    case "mcp":
      return mcpCommand(rest, opts);
    case "docs":
      return docsCommand(rest, opts);
    default:
      throw new UsageError(`unknown command "${noun}"`);
  }
}

/** Pre-scan ONLY for the common flags (each module re-parses its own
 *  spec strictly; this scan is tolerant of command-specific tokens). */
function commandOpts(rest: string[]): CommandOpts {
  let json = false;
  let watch = false;
  let workspace: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--") break;
    if (token === "--json") json = true;
    else if (token === "--watch") watch = true;
    else if (token === "--workspace") {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        workspace = next;
        i += 1;
      }
    } else if (token.startsWith("--workspace=")) {
      workspace = token.slice("--workspace=".length);
    }
  }
  return {
    json,
    watch,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}

function version(json: boolean): number {
  // offline by design: package.json, no daemon round-trip
  if (json) console.log(JSON.stringify({ version: VERSION }));
  else console.log(`nova ${VERSION} (novaflow)`);
  return EXIT_OK;
}
