import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadPrices,
  costUsd,
  defaultPricesPath,
  type PriceTable,
} from "../../src/runs/prices.ts";

function pricesFixture(dir: string, table: PriceTable): string {
  const p = join(dir, "prices.json");
  writeFileSync(p, JSON.stringify(table));
  return p;
}

test("defaultPricesPath is the spec's ~/.novaflow/prices.json", () => {
  assert.equal(defaultPricesPath(), join(homedir(), ".novaflow", "prices.json"));
});

test("loadPrices reads the model → USD per 1M input/output table", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-"));
  try {
    const table: PriceTable = {
      "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
      "gpt-other": { input: 0.5, output: 1.5 },
    };
    assert.deepEqual(loadPrices(pricesFixture(dir, table)), table);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing prices.json is all-zero pricing, never a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-"));
  try {
    assert.deepEqual(loadPrices(join(dir, "nope", "prices.json")), {});
    // and the cost of anything is zero
    assert.equal(costUsd({}, "claude-3-5-sonnet-20241022", 4500, 620), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable prices.json is also all-zero pricing, never a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prices-"));
  try {
    const p = join(dir, "prices.json");
    writeFileSync(p, "{not json");
    assert.deepEqual(loadPrices(p), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("costUsd is tokens/1e6 × price, input and output separately", () => {
  const table: PriceTable = {
    "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  };
  // 4500 input tokens at $3/1M + 620 output tokens at $15/1M
  // = 0.0135 + 0.0093 = 0.0228
  assert.ok(
    Math.abs(costUsd(table, "claude-3-5-sonnet-20241022", 4500, 620) - 0.0228) <
      1e-12,
  );
  assert.equal(costUsd(table, "claude-3-5-sonnet-20241022", 0, 0), 0);
  // a model absent from the table prices at zero (missing table = zero pricing)
  assert.equal(costUsd(table, "unknown-model", 1_000_000, 1_000_000), 0);
  // exact per-1M boundary
  assert.equal(costUsd(table, "claude-3-5-sonnet-20241022", 1_000_000, 0), 3);
  assert.equal(costUsd(table, "claude-3-5-sonnet-20241022", 0, 1_000_000), 15);
});

test("costUsd accumulates across usage frames by summing tokens first", () => {
  const table: PriceTable = { "m": { input: 2, output: 4 } };
  // two message_end frames: 1000/2000 then 3000/6000 tokens
  const inTok = 1000 + 3000;
  const outTok = 2000 + 6000;
  assert.ok(Math.abs(costUsd(table, "m", inTok, outTok) - (8e-3 + 32e-3)) < 1e-12);
});
