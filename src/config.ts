import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace configuration loader (novaflow-v1/data 4.4, the
 * WorkspaceConfiguration schema block for `.novaflow/config.yaml`).
 *
 * NO new dependencies: the block is flat/scalar (sections of scalar
 * keys plus one top-level scalar enum), so a strict hand parser is the
 * honest implementation. Supported syntax — a documented, minimal
 * subset of YAML:
 *   - `key:` alone opens a section (one nesting level ONLY)
 *   - `key: value` assigns a scalar (number, boolean, or plain/
 *     single/double-quoted string)
 *   - full-line `#` comments and blank lines are ignored; INLINE
 *     trailing comments are NOT supported (a `#` inside a value — e.g.
 *     a topic name — would be taken literally)
 *   - exactly one space of indent is enough; anything > 0 counts as
 *     "inside the current section", and a deeper indent inside a
 *     section is still just a nested key (which must be a known one)
 *
 * Leniency rule (matches the missing-file rule): absent sections keep
 * their documented defaults — concurrency.workspace 2 (the block's own
 * default), missed_run_policy "skip" (block default), container.enabled
 * false (block default), budgets absent = unlimited at workspace level.
 * The block's `required` list marks what a COMPLETE config carries; the
 * engine treats omissions as defaults so a sparse file stays legal.
 * Unknown keys, wrong types, duplicates, and deeper nesting are hard
 * errors (the block is `additionalProperties: false`).
 */

export type WorkspaceConfig = {
  /** `null` = unlimited at workspace level (budgets section absent). */
  budgets: { dailyUsd: number | null; monthlyUsd: number | null };
  concurrency: { workspace: number };
  missedRunPolicy: "skip" | "run_immediately";
  alerts: { ntfyTopic: string | null };
  container: { enabled: boolean };
};

export const DEFAULT_CONCURRENCY_WORKSPACE = 2;
export const DEFAULT_MISSED_RUN_POLICY: "skip" | "run_immediately" = "skip";

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    budgets: { dailyUsd: null, monthlyUsd: null },
    concurrency: { workspace: DEFAULT_CONCURRENCY_WORKSPACE },
    missedRunPolicy: DEFAULT_MISSED_RUN_POLICY,
    alerts: { ntfyTopic: null },
    container: { enabled: false },
  };
}

/** `<workspace_root>/.novaflow/config.yaml` (data.md 5.2 layout). */
export function workspaceConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".novaflow", "config.yaml");
}

export type ConfigLoad =
  | { ok: true; config: WorkspaceConfig; source: "file" | "defaults" }
  | { ok: false; error: string };

export type ConfigParse =
  | { ok: true; config: WorkspaceConfig }
  | { ok: false; error: string };

/**
 * The 4.4 block's key set, mirrored for rejection messages:
 * top-level {budgets, concurrency, missed_run_policy, alerts, container}
 * and their sub-properties. Golden tests re-parse the live spec block
 * and pin this set; never widen it by hand.
 */
const SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  budgets: new Set(["daily_usd", "monthly_usd"]),
  concurrency: new Set(["workspace"]),
  alerts: new Set(["ntfy_topic"]),
  container: new Set(["enabled"]),
};
const SCALAR_TOP_KEYS = new Set(["missed_run_policy"]);

/** Strip a matching pair of surrounding quotes, if present. */
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

export function parseWorkspaceConfig(text: string): ConfigParse {
  const cfg = defaultWorkspaceConfig();
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
    const value = unquote(rawValue);
    const where = i + 1;

    if (indent > 0) {
      if (section === null) {
        return fail(where, `indented entry "${key}" appears before any section`);
      }
      const allowed = SECTION_KEYS[section]!;
      if (!allowed.has(key)) {
        return fail(
          where,
          `unknown key "${key}" in "${section}" (data.md 4.4 allows: ${[...allowed].join(", ")})`,
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
          return fail(where, `"workspace" must be an integer >= 1 (got ${JSON.stringify(value)})`);
        }
        cfg.concurrency.workspace = Number(value);
      } else if (section === "alerts") {
        if (value === "") {
          return fail(where, `"ntfy_topic" must be a non-empty string`);
        }
        cfg.alerts.ntfyTopic = value;
      } else if (section === "container") {
        if (value !== "true" && value !== "false") {
          return fail(where, `"enabled" must be true or false (got ${JSON.stringify(value)})`);
        }
        cfg.container.enabled = value === "true";
      }
      continue;
    }

    // top level
    section = null;
    if (SCALAR_TOP_KEYS.has(key)) {
      if (value === "") return fail(where, `"${key}" requires a value`);
      if (seenTop.has(key)) return fail(where, `duplicate key "${key}"`);
      seenTop.add(key);
      if (key === "missed_run_policy") {
        if (value !== "skip" && value !== "run_immediately") {
          return fail(where, `"missed_run_policy" must be skip or run_immediately (got ${JSON.stringify(value)})`);
        }
        cfg.missedRunPolicy = value;
      }
      continue;
    }
    if (!(key in SECTION_KEYS)) {
      return fail(where, `unknown top-level key "${key}" (data.md 4.4 allows: ${[...Object.keys(SECTION_KEYS), ...SCALAR_TOP_KEYS].join(", ")})`);
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
 * Load `<workspace_root>/.novaflow/config.yaml`. Missing file = all
 * defaults (source "defaults"); a present but invalid file is an error
 * result — callers decide policy (alerts are best-effort; preflight
 * may treat it as fatal).
 */
export function loadWorkspaceConfig(workspaceRoot: string): ConfigLoad {
  const path = workspaceConfigPath(workspaceRoot);
  if (!existsSync(path)) {
    return { ok: true, config: defaultWorkspaceConfig(), source: "defaults" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `config.yaml unreadable: ${(err as Error).message}` };
  }
  const res = parseWorkspaceConfig(text);
  if (!res.ok) return res;
  return { ok: true, config: res.config, source: "file" };
}
