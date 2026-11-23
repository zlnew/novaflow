import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFixHint } from "../fixhint.ts";

/**
 * Cost attribution per novaflow-v1/data 4.4: `task_runs.cost_usd` is
 * computed from a local price table `~/.novaflow/prices.json`
 * (model → USD per 1M input/output tokens) applied to the run's usage
 * fields (api.md §4 top-level usage.input / usage.output).
 *
 * novaflow-v02/spend.md adds the cache components: every entry gains
 * `cacheRead` and `cacheWrite` rates, and a run's cost is fresh input × input
 * + cache read × cacheRead + cache write × cacheWrite + output × output.
 * A model with no entry stays INERT (the v1 rule: an inert table reports
 * inert, never zero) — see `isModelPriced`.
 *
 * A missing file (and, by the same never-crash rule, an unparseable one)
 * is all-zero pricing: pricing must never take a run down.
 */

export type PriceEntry = {
  /** USD per 1M input tokens (FRESH prompt tokens — cache is priced apart). */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /**
   * USD per 1M cache-read tokens. ABSENT means the entry predates the
   * cache-aware contract: its declared rates still apply, but the cache side
   * is not priced, so `isModelPriced` reports the model inert rather than
   * presenting a zero cache charge as if the cache were free.
   */
  cacheRead?: number;
  /** USD per 1M cache-write tokens. See `cacheRead` for the absent rule. */
  cacheWrite?: number;
};

/** model → USD per 1M token rates (input, output, cacheRead, cacheWrite). */
export type PriceTable = Record<string, PriceEntry>;

/** The spec's price-table location (novaflow-v1/data 4.4). */
export function defaultPricesPath(): string {
  return join(homedir(), ".novaflow", "prices.json");
}

/** One-line finalization note when the cost breaker is running inert —
 *  derived from the actual failure source so an operator with a CORRUPT
 *  prices.json is not told the file is missing (re-judge finding 2).
 *
 *  W4 R4.3: an unarmed breaker names the fix, every time it is reported —
 *  the path to write and the rates an armed row needs. */
export function inertPricesNote(
  source: PricesSource,
  pricesPath: string = defaultPricesPath(),
): string {
  const why = source === "missing" ? "missing" : "unparseable";
  return withFixHint(
    `prices.json ${why} — cost budget enforcement inert`,
    `write ${pricesPath} with this model's per-1M-token rates (input, output, cacheRead, cacheWrite) — every later run re-reads it — then re-run the task (nova task retry <id|key>)`,
  );
}

export type PricesSource = "file" | "missing" | "invalid";

export type PricesLoad = {
  table: PriceTable;
  /** "file": a parseable prices.json; "missing"/"invalid": enforcement inert. */
  source: PricesSource;
};

/**
 * Load the price table plus whether it actually came from a usable
 * file — a missing or unparseable table silently disables the
 * max_cost_usd breaker, and the run record must say so (never a crash).
 */
export function loadPricesDetailed(path: string = defaultPricesPath()): PricesLoad {
  if (!existsSync(path)) return { table: {}, source: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { table: {}, source: "invalid" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { table: {}, source: "invalid" };
  }
  const out: PriceTable = {};
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["input"] !== "number" || typeof e["output"] !== "number") continue;
    if (!Number.isFinite(e["input"]) || !Number.isFinite(e["output"])) continue;
    if (e["input"] < 0 || e["output"] < 0) continue;
    // The cache rates are OPTIONAL (an older table still prices its declared
    // rates — pricing never takes a run down) but a PRESENT one must be a
    // finite, non-negative number or the entry is dropped outright: a
    // half-valid row would charge a wrong cache price rather than none.
    const cacheRead = rate(e["cacheRead"]);
    const cacheWrite = rate(e["cacheWrite"]);
    if (cacheRead === "invalid" || cacheWrite === "invalid") continue;
    out[model] = {
      input: e["input"],
      output: e["output"],
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    };
  }
  return { table: out, source: "file" };
}

/** An absent rate stays absent; a present-but-bad one invalidates the entry. */
function rate(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "invalid";
  return value;
}

/**
 * Load the price table. Missing or unparseable → `{}` (all-zero
 * pricing), never a crash.
 */
export function loadPrices(path: string = defaultPricesPath()): PriceTable {
  return loadPricesDetailed(path).table;
}

/**
 * USD cost of a usage total: tokens/1e6 × price, input and output
 * separately, summed. Cache components are NOT included (they default to
 * zero) — this is the v1 two-rate contract, kept for its call sites and its
 * artifact; `costUsdTokens` is the cache-aware form the run loop records.
 */
export function costUsd(
  table: PriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return costUsdTokens(table, model, {
    input: inputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    output: outputTokens,
  });
}

/** The run's reported usage, prompt side split into its three components. */
export type UsageTokens = {
  /** FRESH prompt tokens (pi's `usage.input`; cache is reported apart). */
  input: number;
  /** `usage.cacheRead` — prompt tokens served from the provider's cache. */
  cacheRead: number;
  /** `usage.cacheWrite` — prompt tokens written into it. */
  cacheWrite: number;
  output: number;
};

/**
 * novaflow-v02/spend.md run costing:
 *   fresh input × input + cache read × cacheRead + cache write × cacheWrite
 *   + output × output.
 * An unknown model prices at zero (the inert table); a declared-but-absent
 * cache rate contributes zero (see `PriceEntry.cacheRead`).
 */
export function costUsdTokens(table: PriceTable, model: string, usage: UsageTokens): number {
  const entry = table[model];
  if (!entry) return 0;
  return (
    (usage.input / 1e6) * entry.input +
    (usage.cacheRead / 1e6) * (entry.cacheRead ?? 0) +
    (usage.cacheWrite / 1e6) * (entry.cacheWrite ?? 0) +
    (usage.output / 1e6) * entry.output
  );
}

/**
 * Is this model ARMED for cost enforcement — i.e. does it have a price row
 * that covers the whole prompt side plus output (all four rates)? A model
 * with no entry, or with an entry that predates the cache amendment, is
 * inert: the spend block names it in `inert_models` and reports
 * `prices_armed: false` rather than showing a zero charge as if it were free.
 */
export function isModelPriced(table: PriceTable, model: string): boolean {
  const entry = table[model];
  if (!entry) return false;
  return (
    Number.isFinite(entry.input) &&
    Number.isFinite(entry.output) &&
    typeof entry.cacheRead === "number" &&
    typeof entry.cacheWrite === "number"
  );
}
