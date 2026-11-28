/**
 * CLI entry point (`novaflow-v100/cli` §1, §2).
 *
 * Responsibilities, in order: honour `--version`/`--help`, tokenize argv against
 * the whole flag surface, resolve noun+verb to exactly one command, bind and
 * validate that command's flags, run it, and map the outcome to an envelope and
 * an exit code `0..4`. Nothing here reads `stdin`.
 */
import { tokenize, GLOBAL_FLAGS, bindArgs, type BoundArgs, type FlagDef, type RawArgs } from './args.js';
import { COMMAND_MODULES, findModule } from './commands/index.js';
import { renderGlobalHelp, renderModuleHelp, renderVerbHelp } from './help.js';
import { processStreams, writeFailure, writeSuccess, type Streams } from './output.js';
import { VERSION_LINE } from './version.js';
import { toNovaError, validationError, type NovaError } from '../core/errors.js';
import type { CliContext, CommandModule, GlobalOptions, VerbSpec } from './types.js';

/** Every flag the binary understands, used for the first tokenizing pass. */
const ALL_FLAGS: readonly FlagDef[] = (() => {
  const flags: FlagDef[] = [...GLOBAL_FLAGS];
  for (const module of COMMAND_MODULES) {
    for (const verb of module.verbs) {
      for (const flag of verb.flags) flags.push(flag);
    }
  }
  return flags;
})();

interface Requested {
  version: boolean;
  help: boolean;
  json: boolean;
  quiet: boolean;
  strippedArgv: string[];
}

/**
 * Reads global output/meta flags before full validation, respecting `--` and
 * skipping values consumed by value-taking flags.
 */
function requested(argv: readonly string[]): Requested {
  const long = new Map<string, FlagDef>();
  const short = new Map<string, FlagDef>();
  for (const def of ALL_FLAGS) {
    long.set(def.name, def);
    if (def.short !== undefined) short.set(def.short, def);
  }

  let version = false;
  let help = false;
  let json = false;
  let quiet = false;
  const strippedArgv: string[] = [];

  for (let cursor = 0; cursor < argv.length; cursor += 1) {
    const token = argv[cursor] as string;
    if (token === '--') {
      strippedArgv.push(...argv.slice(cursor));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      if (name === 'version') version = true;
      else if (name === 'help') {
        help = true;
        continue;
      } else if (name === 'json') json = true;
      else if (name === 'quiet') quiet = true;

      strippedArgv.push(token);
      const def = long.get(name);
      if (equals === -1 && def !== undefined && (def.kind === 'string' || def.kind === 'int')) {
        const next = argv[cursor + 1];
        if (next !== undefined) {
          strippedArgv.push(next);
          cursor += 1;
        }
      } else if (equals === -1 && def?.kind === 'optional-string') {
        const next = argv[cursor + 1];
        if (next !== undefined && next !== '--' && !next.startsWith('-')) {
          strippedArgv.push(next);
          cursor += 1;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      const body = token.slice(1);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      if (name === 'V') version = true;
      else if (name === 'h') {
        help = true;
        continue;
      } else if (name === 'q') quiet = true;

      strippedArgv.push(token);
      const def = name.length === 1 ? short.get(name) : undefined;
      if (equals === -1 && def !== undefined && (def.kind === 'string' || def.kind === 'int')) {
        const next = argv[cursor + 1];
        if (next !== undefined) {
          strippedArgv.push(next);
          cursor += 1;
        }
      } else if (equals === -1 && def?.kind === 'optional-string') {
        const next = argv[cursor + 1];
        if (next !== undefined && next !== '--' && !next.startsWith('-')) {
          strippedArgv.push(next);
          cursor += 1;
        }
      }
      continue;
    }
    strippedArgv.push(token);
  }

  return { version, help, json, quiet, strippedArgv };
}

/** Best-effort `noun.verb` label for an envelope when parsing itself failed. */
function commandLabel(argv: readonly string[]): string {
  const long = new Map<string, FlagDef>();
  const short = new Map<string, FlagDef>();
  for (const def of ALL_FLAGS) {
    long.set(def.name, def);
    if (def.short !== undefined) short.set(def.short, def);
  }

  const positionals: string[] = [];
  for (let cursor = 0; cursor < argv.length; cursor += 1) {
    const token = argv[cursor] as string;
    if (token === '--') {
      positionals.push(...argv.slice(cursor + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const def = long.get(equals === -1 ? body : body.slice(0, equals));
      if (equals === -1 && def !== undefined && def.kind !== 'boolean') cursor += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      const body = token.slice(1);
      const def = body.length === 1 ? short.get(body) : undefined;
      if (body.indexOf('=') === -1 && def !== undefined && def.kind !== 'boolean') cursor += 1;
      continue;
    }
    positionals.push(token);
  }

  if (positionals.length === 0) return 'novaflow';
  return positionals.slice(0, 2).join('.');
}

type VerbResolution = { verb: VerbSpec; rest: string[] } | { error: NovaError; command: string };

function resolveVerb(module: CommandModule, positionals: readonly string[]): VerbResolution {
  const sole = module.verbs.find((candidate) => candidate.verb === null);
  if (sole !== undefined) return { verb: sole, rest: positionals.slice(1) };

  const candidate = positionals[1];
  if (candidate === undefined) {
    const fallback =
      module.defaultVerb === undefined
        ? undefined
        : module.verbs.find((verb) => verb.verb === module.defaultVerb);
    if (fallback !== undefined) return { verb: fallback, rest: [] };
    return {
      error: validationError(
        `Missing verb for "${module.name}".`,
        `Available verbs: ${module.verbs.map((verb) => verb.verb).join(', ')}.`,
      ),
      command: module.name,
    };
  }

  const verb = module.verbs.find((entry) => entry.verb === candidate);
  if (verb === undefined) {
    return {
      error: validationError(
        `Unknown verb "${candidate}" for "${module.name}".`,
        `Available verbs: ${module.verbs.map((entry) => entry.verb).join(', ')}.`,
      ),
      command: `${module.name}.${candidate}`,
    };
  }
  return { verb, rest: positionals.slice(2) };
}

/** Enforces the declared positional arity before the command runs. */
function checkPositionals(verb: VerbSpec, rest: readonly string[]): void {
  const min = verb.minPositionals ?? verb.positionals.length;
  const max = verb.positionals.length;
  if (rest.length < min) {
    throw validationError(
      `Missing required argument ${verb.positionals[rest.length] ?? '<argument>'} for ${verb.command}.`,
      `Usage: ${verb.usage}`,
    );
  }
  if (rest.length > max) {
    throw validationError(`Unexpected argument "${rest[max]}".`, `Usage: ${verb.usage}`);
  }
}

/**
 * Runs one invocation and returns its exit code. Never throws, never reads
 * `stdin`, and writes at most one JSON envelope per stream.
 */
export function main(argv: readonly string[] = process.argv.slice(2), streams: Streams = processStreams): number {
  const wants = requested(argv);

  if (wants.version) {
    streams.stdout(`${VERSION_LINE}\n`);
    return 0;
  }

  const effectiveArgv = wants.help ? wants.strippedArgv : [...argv];

  let raw: RawArgs;
  try {
    raw = tokenize(effectiveArgv, ALL_FLAGS);
  } catch (error) {
    if (wants.help) {
      streams.stdout(renderGlobalHelp(COMMAND_MODULES));
      return 0;
    }
    return writeFailure(commandLabel(argv), error, { json: wants.json }, streams);
  }

  const positionals = raw.positionals;
  if (positionals.length === 0) {
    streams.stdout(renderGlobalHelp(COMMAND_MODULES));
    return 0;
  }

  const module = findModule(positionals[0] as string);
  if (module === undefined) {
    return writeFailure(
      commandLabel(argv),
      validationError(
        `Unknown command "${positionals[0]}".`,
        'Run "novaflow --help" to see the command tree.',
      ),
      { json: wants.json },
      streams,
    );
  }

  if (wants.help && positionals.length === 1) {
    streams.stdout(renderModuleHelp(module));
    return 0;
  }

  const resolution = resolveVerb(module, positionals);
  if ('error' in resolution) {
    if (wants.help) {
      streams.stdout(renderModuleHelp(module));
      return 0;
    }
    return writeFailure(resolution.command, resolution.error, { json: wants.json }, streams);
  }

  const { verb, rest } = resolution;
  if (wants.help) {
    streams.stdout(renderVerbHelp(verb));
    return 0;
  }

  let bound: BoundArgs;
  try {
    bound = bindArgs(raw, rest, [...GLOBAL_FLAGS, ...verb.flags], verb.command);
    checkPositionals(verb, rest);
  } catch (error) {
    return writeFailure(verb.command, error, { json: wants.json }, streams);
  }

  const options: GlobalOptions = {
    workspace: bound.get('workspace'),
    project: bound.get('project'),
    json: bound.has('json') || wants.json,
    quiet: bound.has('quiet') || wants.quiet,
    dryRun: bound.has('dry-run'),
  };

  const context: CliContext = {
    command: verb.command,
    args: bound,
    options,
    env: process.env,
    cwd: process.cwd(),
    now: new Date(),
  };

  try {
    const result = verb.run(context);
    writeSuccess(verb.command, result, options, streams);
    return 0;
  } catch (error) {
    return writeFailure(verb.command, error, { json: options.json }, streams);
  }
}

try {
  process.exitCode = main();
} catch (error) {
  const novaError = toNovaError(error);
  process.stderr.write(`novaflow: ${novaError.message}\n`);
  process.exitCode = novaError.exitCode;
}
