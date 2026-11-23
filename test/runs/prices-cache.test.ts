import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costUsd,
  costUsdTokens,
  isModelPriced,
  loadPrices,
  type PriceTable,
} from "../../src/runs/prices.ts";

/**
 * novaflow-v02/spend.md (run costing): "The price table gains `cacheRead` and
 * `cacheWrite` rates per model; a model with no entry stays inert (the v1
 * rule: an inert table reports inert, never zero)."
 *
 * Pinned reading of the spec-silent half (an entry that predates the cache
 * amendment: `input`/`output` only):
 *   - the loader keeps the entry (existing tables never take a run down),
 *   - its cache tokens are priced at zero by `costUsdTokens`,
 *   - but `isModelPriced` is FALSE, so the spend block reports the model
 *     inert (`prices_armed: false` + `inert_models`) instead of presenting a
 *     zero cache charge as if the cache were free.
 */

function pricesFixture(dir: string, table: unknown): string {
  const p = join(dir, "prices.json");
  writeFileSync(p, JSON.stringify(table));
  return p;
}

const FULL: PriceTable = {
  m: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
};

test("the price loader parses all four rates per model", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-cache-"));
  try {
    assert.deepEqual(loadPrices(pricesFixture(dir, FULL)), FULL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry without cacheRead/cacheWrite stays usable but does NOT arm the breaker (inert, never a silent zero)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-cache-"));
  try {
    const table = loadPrices(pricesFixture(dir, { m: { input: 3, output: 15 } }));
    // the run still prices what the entry declares (v1 behavior preserved)
    assert.deepEqual(table, { m: { input: 3, output: 15 } });
    assert.ok(Math.abs(costUsd(table, "m", 4500, 620) - 0.0228) < 1e-12);
    // …but cache tokens are not silently free: the model counts as unpriced
    assert.equal(isModelPriced(table, "m"), false);
    assert.equal(costUsdTokens(table, "m", {
      input: 0,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 0,
    }), 0);
    // a complete row is priced; an unknown model is not
    assert.equal(isModelPriced(FULL, "m"), true);
    assert.equal(isModelPriced(FULL, "other"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed cache rate drops the entry (the v1 never-crash validation rule)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-cache-"));
  try {
    for (const bad of [
      { input: 3, output: 15, cacheRead: "0.3" },
      { input: 3, output: 15, cacheRead: -0.3 },
      { input: 3, output: 15, cacheWrite: Number.NaN },
      { input: 3, output: 15, cacheWrite: -1 },
    ]) {
      assert.deepEqual(
        loadPrices(pricesFixture(dir, { m: bad })),
        {},
        `entry must be dropped: ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("costUsdTokens prices fresh input, cache read, cache write and output at their own rates", () => {
  // 10,000 fresh × $3 + 500,000 cacheRead × $0.30 + 80,000 cacheWrite × $3.75
  // + 2,000 output × $15, all per 1M tokens
  // = 0.03 + 0.15 + 0.30 + 0.03 = $0.51
  const cost = costUsdTokens(FULL, "m", {
    input: 10_000,
    cacheRead: 500_000,
    cacheWrite: 80_000,
    output: 2_000,
  });
  assert.equal(cost.toFixed(2), "0.51"); // to the cent
  assert.ok(Math.abs(cost - 0.51) < 1e-9, `exact cost ${cost}`);
});

test("the same usage with zero cache rates prices lower — the cache terms are not decorative", () => {
  const freeCache: PriceTable = { m: { input: 3, cacheRead: 0, cacheWrite: 0, output: 15 } };
  const usage = {
    input: 10_000,
    cacheRead: 500_000,
    cacheWrite: 80_000,
    output: 2_000,
  };
  const priced = costUsdTokens(FULL, "m", usage);
  const withoutCache = costUsdTokens(freeCache, "m", usage);
  // without the cache rates only the fresh prompt + output sides remain: $0.06
  assert.ok(Math.abs(withoutCache - 0.06) < 1e-9, `no-cache cost ${withoutCache}`);
  assert.ok(priced > withoutCache, "cache tokens must raise the price");
  assert.ok(Math.abs(priced - withoutCache - 0.45) < 1e-9);
});

test("PRESERVE: costUsd keeps its input+output-only contract (cache terms default to zero)", () => {
  assert.ok(Math.abs(costUsd(FULL, "m", 4500, 620) - 0.0228) < 1e-12);
  assert.equal(costUsd(FULL, "m", 0, 0), 0);
  assert.equal(costUsd(FULL, "absent", 1_000_000, 1_000_000), 0);
  assert.equal(costUsd(FULL, "m", 1_000_000, 0), 3);
  assert.equal(costUsd(FULL, "m", 0, 1_000_000), 15);
});
