/**
 * Command taxonomy shared by the CLI modules (`novaflow-v100/cli` §1, §3).
 *
 * A module is one noun (`workspace`, `project`, `task`, ...); a verb is one
 * dispatchable command with its own flags. Adding a noun — `mcp`, `skill` — means
 * adding a module file, never editing the other commands' handlers.
 */
import type { BoundArgs, FlagDef } from './args.js';
import type { Env } from '../store/registry.js';

/** Actionable follow-up advertised in `next_actions` (`novaflow-v100/cli` §2.2). */
export interface NextAction {
  command: string;
  description: string;
}

/** What one command produced, before stream selection. */
export interface CommandResult {
  /** Payload of the `--json` success envelope. */
  data: unknown;
  /** Human-mode stdout (tables, detail blocks). */
  human?: string;
  /** `--quiet` stdout: minimal identifiers, one per line. */
  quiet?: string;
  /** Actionable follow-ups; always emitted, as `[]` when there are none. */
  next_actions?: NextAction[];
  /**
   * The command owns `stdout` for the rest of the invocation (`mcp`), so the
   * dispatcher writes no envelope, identifiers, or human rendering for it.
   */
  silent?: boolean;
}

/** Global options every command receives (`novaflow-v100/cli` §2). */
export interface GlobalOptions {
  /** `--workspace` / `-w`. */
  workspace: string | undefined;
  /** `--project` / `-p`. */
  project: string | undefined;
  json: boolean;
  quiet: boolean;
  dryRun: boolean;
}

/** Everything a verb's `run` may use. */
export interface CliContext {
  /** Dotted command id, e.g. `task.start`. */
  command: string;
  args: BoundArgs;
  options: GlobalOptions;
  env: Env;
  cwd: string;
  /** One clock reading per invocation, so a command is internally consistent. */
  now: Date;
}

export interface VerbSpec {
  /** Verb word, or `null` for a single-verb top-level command (`status`, `mcp`). */
  verb: string | null;
  /** Dotted command id used in envelopes and help (`task.start`). */
  command: string;
  summary: string;
  usage: string;
  /** Positional names, in order; length is the maximum accepted count. */
  positionals: readonly string[];
  /** Minimum accepted positional count; defaults to `positionals.length`. */
  minPositionals?: number;
  /** Flags specific to this verb; global flags are merged by the dispatcher. */
  flags: readonly FlagDef[];
  examples?: readonly string[];
  /**
   * Runs the command. A long-lived command (`mcp`) returns a promise that settles
   * when its stream ends; every other command returns its result synchronously.
   */
  run(context: CliContext): CommandResult | Promise<CommandResult>;
}

export interface CommandModule {
  /** Noun used on the command line. */
  name: string;
  summary: string;
  verbs: readonly VerbSpec[];
  /** Verb used when the noun is given alone (`events` == `events list`). */
  defaultVerb?: string;
}
