import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, UsageError } from "./args.ts";
import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  exitCodeForTaxonomy,
} from "./exitcode.ts";
import { DaemonUnreachableError, OpFailureError } from "./client.ts";
import { findVerb, renderNounHelp, renderOverview, renderVerbHelp } from "./help.ts";
import { verbsOf } from "./verbs.ts";
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
 * DISPATCH IS THE VERB TABLE (src/cli/verbs.ts), and help is intercepted
 * HERE, once, for every verb (W4 R4.1):
 *
 *   - `nova <noun> <verb> --help` / `-h` → that verb's usage, flags and one
 *     example, exit 0. Never the whole manual: the intercepted request never
 *     reaches a noun module, so `--help` can never be parsed as an unknown
 *     flag (the observed defect: `nova chain create --help` answered
 *     `unknown flag --help` and dumped everything).
 *   - a UsageError from a KNOWN verb (unknown flag, bad positional shape)
 *     prints THAT verb's usage and exits 2 — the whole-program dump is only
 *     for an unknown noun/subcommand, which is still a usage error (exit 2)
 *     per the v1 map.
 *   - `nova help <noun>` lists the noun's verbs; bare `nova help` prints the
 *     overview and exits 0; bare `nova` prints it on stderr and exits 2.
 *
 * `nova mcp` (p5) starts the MCP control surface on stdio (novaflow-v1/mcp):
 * it is a SERVER, so it runs until its client disconnects and exits 0 — see
 * src/cli/commands/mcp.ts for why the srs exit map does not apply to it.
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

type NounCommand = (argv: string[], opts: CommandOpts) => Promise<number>;

/**
 * The dispatch table: one entry per srs 4.1.1 noun. `VERBS` (src/cli/verbs.ts)
 * carries the verbs each entry must answer; the dispatcher refuses a verb the
 * table does not carry, so the two can never disagree at runtime.
 */
export const NOUN_COMMANDS: Record<string, NounCommand> = {
  workspace: workspaceCommand,
  project: projectCommand,
  profile: profileCommand,
  task: taskCommand,
  schedule: scheduleCommand,
  daemon: daemonCommand,
  status: statusCommand,
  web: webCommand,
  version: async (argv) => {
    // the one noun-level verb with no module: validate its flags HERE so an
    // unknown flag is a usage error with the verb's usage (R4.1), never a
    // silent success
    const p = parseArgs(argv, {});
    if (p.positionals.length > 0) {
      throw new UsageError(`nova version takes no arguments (got "${p.positionals.join(" ")}")`);
    }
    return version(p.json);
  },
  chain: chainCommand,
  mcp: mcpCommand,
  docs: docsCommand,
};

/** The verb list the dispatcher answers to (re-exported for the generated tests). */
export { VERBS } from "./verbs.ts";

/** Where the failing invocation was, so a usage error can name the right verb. */
type DispatchContext = { noun?: string; sub?: string | undefined };

/**
 * Run one CLI invocation; returns the process exit code (0–5, the srs
 * 4.1.1 map). Never throws.
 */
export async function main(argv: string[]): Promise<number> {
  const ctx: DispatchContext = {};
  try {
    return await dispatch(argv, ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`nova: ${err.message}`);
      // a known verb answers with ITS usage; anything unknown gets the manual
      const verb = ctx.noun === undefined ? undefined : findVerb(ctx.noun, ctx.sub);
      console.error(verb === undefined ? renderOverview() : renderVerbHelp(verb));
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

async function dispatch(argv: string[], ctx: DispatchContext): Promise<number> {
  let [noun, ...rest] = argv;
  // conventional alias: --version / -V is `nova version` (review finding)
  if (noun === "--version" || noun === "-V") {
    noun = "version";
    rest = [];
  }

  // a help request is intercepted BEFORE any module parses flags (R4.1)
  if (wantsHelp(rest)) return helpRequest(noun, rest);

  if (noun === "help") {
    const [topic, ...more] = rest;
    if (topic === undefined) {
      console.log(renderOverview());
      return EXIT_OK;
    }
    if (!isNoun(topic)) {
      console.error(`nova: unknown noun "${topic}"`);
      console.error(renderOverview());
      return EXIT_USAGE;
    }
    const sub = more.find((token) => !token.startsWith("-"));
    ctx.noun = topic;
    if (sub !== undefined) {
      const verb = findVerb(topic, sub);
      ctx.sub = verb?.sub ?? undefined;
      if (verb === undefined) {
        console.error(`nova: unknown verb "nova ${topic} ${sub}"`);
        console.error(renderNounHelp(topic));
        return EXIT_USAGE;
      }
      console.log(renderVerbHelp(verb));
      return EXIT_OK;
    }
    const only = verbsOf(topic);
    console.log(only.length === 1 ? renderVerbHelp(only[0]!) : renderNounHelp(topic));
    return EXIT_OK;
  }

  if (noun === undefined || noun === "") {
    console.error(renderOverview());
    return EXIT_USAGE;
  }
  if (!isNoun(noun)) {
    ctx.noun = noun;
    throw new UsageError(`unknown command "${noun}" — run \`nova help\` for the verb list`);
  }

  // a one-verb noun (status/version/mcp) owns its own positional rule; the
  // module's own UsageError then renders that verb's usage block
  if (verbsOf(noun).every((verb) => verb.sub === null)) {
    ctx.noun = noun;
    ctx.sub = undefined;
    return NOUN_COMMANDS[noun]!(rest, commandOpts(rest));
  }

  const sub = subOf(noun, rest);
  const verb = findVerb(noun, sub);
  ctx.noun = noun;
  ctx.sub = verb?.sub ?? undefined;
  if (verb === undefined) {
    // unchanged v1 behaviour for an unknown SUBCOMMAND: a usage error (exit
    // 2) carrying the noun's own verb list, never a silent no-op.
    throw new UsageError(unknownSubMessage(noun, sub));
  }

  // The common flags are parsed by each noun module's spec; dispatch
  // hands the raw argv through and threads the resolved opts.
  const opts = commandOpts(rest);
  return NOUN_COMMANDS[noun]!(rest, opts);
}

function isNoun(noun: string): boolean {
  return Object.hasOwn(NOUN_COMMANDS, noun);
}

/** True when `-h`/`--help` appears before the `--` end-of-flags marker. */
function wantsHelp(rest: readonly string[]): boolean {
  for (const token of rest) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}

/** The sub-verb an invocation names: the first token that IS one of the noun's verbs. */
function subOf(noun: string, rest: readonly string[]): string | undefined {
  const known = new Set(
    verbsOf(noun)
      .map((verb) => verb.sub)
      .filter((sub): sub is string => sub !== null),
  );
  let firstPlain: string | undefined;
  for (const token of rest) {
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    if (firstPlain === undefined) firstPlain = token;
    if (known.has(token)) return token;
  }
  return firstPlain;
}

function unknownSubMessage(noun: string, sub: string | undefined): string {
  const subs = verbsOf(noun)
    .map((verb) => verb.sub)
    .filter((s): s is string => s !== null);
  const got = sub === undefined ? "" : ` — got "${sub}"`;
  return `nova ${noun} [${subs.join("|")}]${got}`;
}

/** `--help` / `-h` / `nova help <noun> [<verb>]` — verb-scoped, exit 0. */
function helpRequest(noun: string | undefined, rest: readonly string[]): number {
  if (noun === undefined || noun === "" || noun === "help") {
    console.log(renderOverview());
    return EXIT_OK;
  }
  if (!isNoun(noun)) {
    console.error(`nova: unknown command "${noun}"`);
    console.error(renderOverview());
    return EXIT_USAGE;
  }
  const sub = subOf(noun, rest);
  if (sub !== undefined) {
    const verb = findVerb(noun, sub);
    if (verb === undefined) {
      console.error(`nova: unknown verb "nova ${noun} ${sub}"`);
      console.error(renderNounHelp(noun));
      return EXIT_USAGE;
    }
    console.log(renderVerbHelp(verb));
    return EXIT_OK;
  }
  const only = verbsOf(noun);
  console.log(only.length === 1 ? renderVerbHelp(only[0]!) : renderNounHelp(noun));
  return EXIT_OK;
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
