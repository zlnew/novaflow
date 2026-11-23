import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Daemon configuration loader — the daemon's OWN file
 * `~/.novaflow/config.yaml`, global scope (novaflow-v1/data 4.4:
 * "The daemon reads its own file, `~/.novaflow/config.yaml`, for global
 * scope — global budgets, `concurrency.global` (default 4), and
 * `retry: {delay_sec: 300}`").
 *
 * NO new dependencies: the file is flat/scalar (sections of scalar
 * keys), so a strict hand parser in the exact discipline of the
 * workspace loader (src/config.ts) is the honest implementation:
 *   - `key:` alone opens a section (one nesting level ONLY)
 *   - `key: value` assigns a scalar (number or plain/single/double-quoted
 *     string — v1 keys are all numeric, but the scalar grammar matches
 *     src/config.ts so both files parse by one rule)
 *   - full-line `#` comments and blank lines are ignored; INLINE trailing
 *     comments are NOT supported
 *   - anything > 0 indent counts as "inside the current section"
 * Unknown keys, wrong types, duplicates, deeper nesting, lists/maps, and
 * unbalanced quotes are hard errors WITH LINE NUMBERS. A missing file is
 * all defaults (the same leniency rule as the workspace loader).
 */

export type DaemonConfig = {
  /**
   * Global budgets. `null` = unlimited (the budgets section is absent) —
   * the workspace-level budgets (src/config.ts) then govern alone. When
   * BOTH are set, the workspace value wins for its own workspace
   * (documented precedence, FR-TSK-10 AC4).
   */
  budgets: { dailyUsd: number | null; monthlyUsd: number | null };
  /** FR-SCH-02 AC1: global concurrent running-task limit. */
  concurrency: { global: number };
  /** wake.md: the extension reads this; the daemon validates the scalars. */
  wake: { enabled: boolean; workspace: string | null };
  /**
   * The auto-retry timer (the 8.1 matrix's failed→queued row names
   * `retry.delay_sec`, default 300 s). Fractional values are accepted so
   * tests can inject short delays; the stored unit is seconds.
   */
  retry: { delaySec: number };
};

/** data.md 4.4: `concurrency.global` (default 4). */
export const DEFAULT_CONCURRENCY_GLOBAL = 4;
/** data.md 4.4: `retry: {delay_sec: 300}`. */
export const DEFAULT_RETRY_DELAY_SEC = 300;

export function defaultDaemonConfig(): DaemonConfig {
  return {
    budgets: { dailyUsd: null, monthlyUsd: null },
    concurrency: { global: DEFAULT_CONCURRENCY_GLOBAL },
    wake: { enabled: true, workspace: null },
    retry: { delaySec: DEFAULT_RETRY_DELAY_SEC },
  };
}

/** The spec's daemon config location: `~/.novaflow/config.yaml`. */
export function defaultDaemonConfigPath(): string {
  return join(homedir(), ".novaflow", "config.yaml");
}

export type DaemonConfigLoad =
  | { ok: true; config: DaemonConfig; source: "file" | "defaults" }
  | { ok: false; error: string };

export type DaemonConfigParse =
  | { ok: true; config: DaemonConfig }
  | { ok: false; error: string };

/**
 * The data.md 4.4 global-scope key set, mirrored for rejection
 * messages and golden-pinned by tests against the live spec prose.
 * Never widen it by hand.
 */
export const DAEMON_CONFIG_SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  budgets: new Set(["daily_usd", "monthly_usd"]),
  concurrency: new Set(["global"]),
  retry: new Set(["delay_sec"]),
  // v0.2.0 P4 (novaflow-v02/wake.md): the extension's watcher reads this
  // section itself; the daemon only VALIDATES it, so an operator's config
  // with a wake block boots instead of being refused as an unknown key.
  wake: new Set(["enabled", "workspace"]),
};

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fail(lineNo: number, message: string): { ok: false; error: string } {
  return { ok: false, error: `config.yaml line ${lineNo}: ${message}` };
}

export function parseDaemonConfig(text: string): DaemonConfigParse {
  const cfg = defaultDaemonConfig();
  const seenTop = new Set<string>();
  const seenNested = new Set<string>();
  let section: string | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      return fail(i + 1, "expected `key:` (section) or `key: value` (scalar)");
    }
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
      return fail(
        i + 1,
        `lists/maps are not supported by the documented subset — "${key}" must be a scalar (number, boolean, or string)`,
      );
    }
    // a value that OPENS with a quote but does not close it is an error,
    // not a literal — the workspace parser's discipline
    const opener = rawValue[0];
    if ((opener === '"' || opener === "'") && (rawValue.length < 2 || !rawValue.endsWith(opener))) {
      return fail(i + 1, `unbalanced quote in value ${JSON.stringify(rawValue)} — a quoted scalar must close its quote`);
    }
    const value = unquote(rawValue);
    const where = i + 1;

    if (indent > 0) {
      if (section === null) {
        return fail(where, `indented entry "${key}" appears before any section`);
      }
      const allowed = DAEMON_CONFIG_SECTION_KEYS[section]!;
      if (!allowed.has(key)) {
        return fail(
          where,
          `unknown key "${key}" in "${section}" (data.md 4.4 global scope allows: ${[...allowed].join(", ")})`,
        );
      }
      if (value === "") {
        return fail(where, `"${section}.${key}" requires a scalar value — deeper nesting is not supported`);
      }
      const seenKey = `${section}.${key}`;
      if (seenNested.has(seenKey)) return fail(where, `duplicate key "${seenKey}"`);
      seenNested.add(seenKey);

      if (section === "budgets") {
        const n = parseNumber(value);
        if (n === null || n < 0) {
          return fail(where, `"${key}" must be a number >= 0 (got ${JSON.stringify(value)})`);
        }
        if (key === "daily_usd") cfg.budgets.dailyUsd = n;
        else cfg.budgets.monthlyUsd = n;
      } else if (section === "concurrency") {
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          return fail(where, `"global" must be an integer >= 1 (got ${JSON.stringify(value)})`);
        }
        cfg.concurrency.global = Number(value);
      } else if (section === "retry") {
        const n = parseNumber(value);
        if (n === null || n < 0) {
          return fail(where, `"delay_sec" must be a number >= 0 (got ${JSON.stringify(value)})`);
        }
        cfg.retry.delaySec = n;
      } else if (section === "wake") {
        if (key === "enabled") {
          if (value !== "true" && value !== "false") {
            return fail(where, `"enabled" must be true or false (got ${JSON.stringify(value)})`);
          }
          cfg.wake.enabled = value === "true";
        } else if (key === "workspace") {
          // `workspace: null` / empty → every workspace
          cfg.wake.workspace = value === "" || value === "null" || value === "~" ? null : value;
        }
      }
      continue;
    }

    // top level
    section = null;
    if (!(key in DAEMON_CONFIG_SECTION_KEYS)) {
      return fail(where, `unknown top-level key "${key}" (data.md 4.4 global scope allows: ${Object.keys(DAEMON_CONFIG_SECTION_KEYS).join(", ")})`);
    }
    if (value !== "") {
      return fail(where, `"${key}" opens a section — no value may follow the colon`);
    }
    if (seenTop.has(key)) return fail(where, `duplicate key "${key}"`);
    seenTop.add(key);
    section = key;
  }
  return { ok: true, config: cfg };
}

/**
 * Load the daemon config. Missing file = all defaults (source
 * "defaults"); a present but invalid file is an error result — callers
 * decide policy (the daemon refuses to boot on a broken config: the
 * concurrency/retry semantics it governs must never run on guesses).
 */
export function loadDaemonConfig(path: string): DaemonConfigLoad {
  if (!existsSync(path)) {
    return { ok: true, config: defaultDaemonConfig(), source: "defaults" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `config.yaml unreadable: ${(err as Error).message}` };
  }
  const res = parseDaemonConfig(text);
  if (!res.ok) return res;
  return { ok: true, config: res.config, source: "file" };
}
