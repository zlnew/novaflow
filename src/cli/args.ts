/**
 * Declarative flag grammar and strict argv parsing (`novaflow-v100/cli` §1, §2).
 *
 * Every command declares the flags it accepts; global flags are merged in by the
 * dispatcher. Parsing is a pure function over `argv` plus that declaration, so an
 * unknown flag, a missing value, or a stray positional is a `VALIDATION_ERROR`
 * (exit 2) rather than a silent no-op.
 */
import { validationError } from '../core/errors.js';

/** Value shape of a flag. */
export type FlagKind = 'boolean' | 'string' | 'int';

export interface FlagDef {
  /** Long name without the leading `--`. */
  name: string;
  kind: FlagKind;
  /** Single-character alias without the leading `-`. */
  short?: string;
  /** Placeholder shown in help, e.g. `<name|path>`. */
  placeholder?: string;
  /** Minimum accepted value for `int` flags. */
  min?: number;
  /** Accepts repeated occurrences; without it a repeat is a usage error. */
  repeatable?: boolean;
  description: string;
}

/** Flags accepted by every command (`novaflow-v100/cli` §2). */
export const GLOBAL_FLAGS: readonly FlagDef[] = [
  {
    name: 'workspace',
    kind: 'string',
    short: 'w',
    placeholder: '<name|path>',
    description: 'Target workspace (overrides NOVAFLOW_WORKSPACE and cwd walk-up)',
  },
  {
    name: 'project',
    kind: 'string',
    short: 'p',
    placeholder: '<slug|prefix>',
    description: 'Target project (overrides NOVAFLOW_PROJECT and workspace default)',
  },
  { name: 'json', kind: 'boolean', description: 'Emit one machine-readable JSON envelope on stdout' },
  {
    name: 'quiet',
    kind: 'boolean',
    short: 'q',
    description: 'Print minimal identifiers only (one per line)',
  },
  { name: 'dry-run', kind: 'boolean', description: 'Validate inputs and state without writing' },
  { name: 'help', kind: 'boolean', short: 'h', description: 'Scoped help for this command' },
  { name: 'version', kind: 'boolean', short: 'V', description: 'Print the version and exit 0' },
];

/** Long/short lookup used while tokenizing. */
interface FlagIndex {
  long: Map<string, FlagDef>;
  short: Map<string, FlagDef>;
}

function indexFlags(defs: readonly FlagDef[]): FlagIndex {
  const long = new Map<string, FlagDef>();
  const short = new Map<string, FlagDef>();
  for (const def of defs) {
    long.set(def.name, def);
    if (def.short !== undefined) short.set(def.short, def);
  }
  return { long, short };
}

export interface RawArgs {
  /** Non-flag tokens, in argv order. */
  positionals: string[];
  /** Flag name -> every value supplied (booleans store `'true'`). */
  flags: Map<string, string[]>;
}

function pushFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing === undefined) flags.set(name, [value]);
  else existing.push(value);
}

function flagLabel(def: FlagDef): string {
  return def.placeholder === undefined ? `--${def.name}` : `--${def.name} ${def.placeholder}`;
}

function parseIntegerValue(def: FlagDef, raw: string): number {
  const minimum = def.min ?? 0;
  if (!/^-?[0-9]+$/.test(raw)) {
    throw validationError(
      `Flag ${flagLabel(def)} expects an integer, got ${JSON.stringify(raw)}.`,
      `Pass a whole number for --${def.name}.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw validationError(
      `Flag ${flagLabel(def)} must be an integer >= ${minimum}, got ${JSON.stringify(raw)}.`,
      `Pass a whole number >= ${minimum} for --${def.name}.`,
    );
  }
  return value;
}

/**
 * Splits argv into positionals and flag values.
 *
 * `defs` must be the union of every flag this binary understands; declining a
 * declaration there is the parser's only unknown-flag signal.
 */
export function tokenize(argv: readonly string[], defs: readonly FlagDef[]): RawArgs {
  const index = indexFlags(defs);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let cursor = 0; cursor < argv.length; cursor += 1) {
    const token = argv[cursor] as string;

    if (token === '--') {
      positionals.push(...argv.slice(cursor + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      const inline = equals === -1 ? undefined : body.slice(equals + 1);
      const def = index.long.get(name);
      if (def === undefined) {
        throw validationError(
          `Unknown flag "--${name}".`,
          'Run "novaflow <command> --help" to see the flags it accepts.',
        );
      }
      if (def.kind === 'boolean') {
        if (inline !== undefined) {
          throw validationError(`Flag "--${name}" does not take a value.`, `Pass "--${name}" on its own.`);
        }
        pushFlag(flags, name, 'true');
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[cursor + 1];
        if (next === undefined) {
          throw validationError(
            `Flag ${flagLabel(def)} requires a value.`,
            `Pass a value after --${def.name}.`,
          );
        }
        value = next;
        cursor += 1;
      }
      pushFlag(flags, name, def.kind === 'int' ? String(parseIntegerValue(def, value)) : value);
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const body = token.slice(1);
      const equals = body.indexOf('=');
      const name = equals === -1 ? body : body.slice(0, equals);
      const inline = equals === -1 ? undefined : body.slice(equals + 1);
      const def = name.length === 1 ? index.short.get(name) : undefined;
      if (def === undefined) {
        throw validationError(
          `Unknown flag "-${name}".`,
          'Run "novaflow <command> --help" to see the flags it accepts.',
        );
      }
      if (def.kind === 'boolean') {
        if (inline !== undefined) {
          throw validationError(`Flag "-${name}" does not take a value.`, `Pass "-${name}" on its own.`);
        }
        pushFlag(flags, def.name, 'true');
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[cursor + 1];
        if (next === undefined) {
          throw validationError(`Flag -${name} ${def.placeholder ?? '<value>'} requires a value.`, `Pass a value after -${name}.`);
        }
        value = next;
        cursor += 1;
      }
      pushFlag(flags, def.name, def.kind === 'int' ? String(parseIntegerValue(def, value)) : value);
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

/** Typed view of the flags one command actually accepts. */
export interface BoundArgs {
  readonly positionals: readonly string[];
  has(name: string): boolean;
  get(name: string): string | undefined;
  getAll(name: string): string[];
  int(name: string): number | undefined;
}

/**
 * Rejects flags that belong to another command, repeats a non-repeatable flag,
 * and returns typed accessors for the rest.
 */
export function bindArgs(
  raw: RawArgs,
  positionals: readonly string[],
  allowed: readonly FlagDef[],
  command: string,
): BoundArgs {
  const byName = new Map(allowed.map((def) => [def.name, def]));

  for (const [name, values] of raw.flags) {
    const def = byName.get(name);
    if (def === undefined) {
      throw validationError(
        `Unknown flag "--${name}" for command "${command}".`,
        `Accepted flags for ${command}: ${allowed.map((entry) => `--${entry.name}`).join(', ')}.`,
      );
    }
    if (def.repeatable !== true && values.length > 1) {
      throw validationError(
        `Flag "--${name}" was given ${values.length} times.`,
        `Pass --${name} at most once for ${command}.`,
      );
    }
  }

  const valuesOf = (name: string): string[] => raw.flags.get(name) ?? [];

  return {
    positionals,
    has: (name) => raw.flags.has(name),
    get: (name) => valuesOf(name)[0],
    getAll: (name) => valuesOf(name),
    int: (name) => {
      const value = valuesOf(name)[0];
      return value === undefined ? undefined : Number(value);
    },
  };
}

/** Fails exit 2 when a required flag is absent (`novaflow-v100/cli` §1). */
export function requireFlag(args: BoundArgs, name: string, command: string): string {
  const value = args.get(name);
  if (value === undefined) {
    throw validationError(`Missing required flag "--${name}" for ${command}.`, `Pass --${name} <value>.`);
  }
  return value;
}

/** Rejects `--clear-x` combined with `--x`, which would be ambiguous. */
export function rejectCombined(args: BoundArgs, valueFlag: string, clearFlag: string): void {
  if (args.has(valueFlag) && args.has(clearFlag)) {
    throw validationError(
      `Flags "--${valueFlag}" and "--${clearFlag}" cannot be combined.`,
      `Pass either --${valueFlag} <value> or --${clearFlag}.`,
    );
  }
}

/** Splits `a,b` / repeated values into a trimmed, non-empty list. */
export function splitList(values: readonly string[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') items.push(trimmed);
    }
  }
  return items;
}
