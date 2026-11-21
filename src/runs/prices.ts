import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Cost attribution per novaflow-v1/data 4.4: `task_runs.cost_usd` is
 * computed from a local price table `~/.novaflow/prices.json`
 * (model → USD per 1M input/output tokens) applied to the run's usage
 * fields (api.md §4 top-level usage.input / usage.output).
 *
 * A missing file (and, by the same never-crash rule, an unparseable one)
 * is all-zero pricing: pricing must never take a run down.
 */

export type PriceEntry = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
};

/** model → USD per 1M input/output tokens. */
export type PriceTable = Record<string, PriceEntry>;

/** The spec's price-table location (novaflow-v1/data 4.4). */
export function defaultPricesPath(): string {
  return join(homedir(), ".novaflow", "prices.json");
}

/** One-line finalization note when the cost breaker is running inert. */
export const PRICES_INERT_NOTE = "prices.json missing — cost budget enforcement inert";

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
    out[model] = { input: e["input"], output: e["output"] };
  }
  return { table: out, source: "file" };
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
 * separately, summed. Unknown models price at zero.
 */
export function costUsd(
  table: PriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const entry = table[model];
  if (!entry) return 0;
  return (inputTokens / 1e6) * entry.input + (outputTokens / 1e6) * entry.output;
}
