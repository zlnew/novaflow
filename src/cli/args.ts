/**
 * The hand-rolled argv parser (srs 4.1.1's `nova <noun> <sub> [args]
 * [flags]`; NO dependencies by design). Supported syntax:
 *   - positionals: any token that is not a flag
 *   - `--flag value` and `--flag=value` for single-value flags
 *   - boolean flags (`--gate`), repeatable flags (`--target a --target b`)
 *   - the common options `--json` and `--watch` are always boolean flags
 *   - a bare `--` ends flag parsing; everything after is positional
 *
 * Usage violations throw UsageError — the CLI's exit-2 source. One
 * parser, one shape; no command hand-rolls its own splitting.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ArgSpec = {
  /** Boolean flags this command accepts (besides --json / --watch). */
  booleanFlags?: string[];
  /** Single-value flags: `--name value` or `--name=value`. */
  valueFlags?: string[];
  /** Repeatable flags: every occurrence appends, order preserved. */
  repeatableFlags?: string[];
};

export type ParsedArgs = {
  positionals: string[];
  /** Boolean flags present (always includes --json / --watch semantics). */
  flags: Set<string>;
  /** Single-value flags. */
  values: Map<string, string>;
  /** Repeatable flags in occurrence order. */
  lists: Map<string, string[]>;
  /** The common option --json (machine-readable stdout). */
  json: boolean;
  /** The common option --watch (poll status until a terminal state). */
  watch: boolean;
};

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const booleans = new Set([...(spec.booleanFlags ?? []), "json", "watch"]);
  const valueFlags = new Set(spec.valueFlags ?? []);
  const repeatable = new Set(spec.repeatableFlags ?? []);

  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = (eq < 0 ? token : token.slice(0, eq)).slice(2);
    const inlineValue = eq < 0 ? undefined : token.slice(eq + 1);
    if (name === "") {
      throw new UsageError(`invalid flag "${token}"`);
    }
    if (booleans.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} is a boolean flag — use --${name}, not --${name}=…`);
      }
      flags.add(name);
      continue;
    }
    if (valueFlags.has(name)) {
      const value =
        inlineValue !== undefined
          ? inlineValue
          : (() => {
              const next = argv[i + 1];
              if (next === undefined || next.startsWith("--")) {
                throw new UsageError(`--${name} requires a value`);
              }
              i += 1;
              return next;
            })();
      values.set(name, value);
      continue;
    }
    if (repeatable.has(name)) {
      const value =
        inlineValue !== undefined
          ? inlineValue
          : (() => {
              const next = argv[i + 1];
              if (next === undefined || next.startsWith("--")) {
                throw new UsageError(`--${name} requires a value`);
              }
              i += 1;
              return next;
            })();
      const list = lists.get(name) ?? [];
      list.push(value);
      lists.set(name, list);
      continue;
    }
    throw new UsageError(`unknown flag --${name}`);
  }

  return {
    positionals,
    flags,
    values,
    lists,
    json: flags.has("json"),
    watch: flags.has("watch"),
  };
}
