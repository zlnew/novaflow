import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specFile } from "../helpers/spec.ts";
import {
  DAEMON_CONFIG_SECTION_KEYS,
  DEFAULT_CONCURRENCY_GLOBAL,
  DEFAULT_RETRY_DELAY_SEC,
  defaultDaemonConfig,
  loadDaemonConfig,
  parseDaemonConfig,
} from "../../src/daemonconfig.ts";

/**
 * The daemon's own config file, ~/.novaflow/config.yaml (novaflow-v1/data
 * 4.4 prose: "The daemon reads its own file, `~/.novaflow/config.yaml`,
 * for global scope — global budgets, `concurrency.global` (default 4),
 * and `retry: {delay_sec: 300}`"). Same strict hand-parser discipline as
 * the workspace loader (src/config.ts): no new deps, one nesting level,
 * unknown keys rejected with line numbers, missing file = defaults.
 */

function configDir(): string {
  return mkdtempSync(join(tmpdir(), "novaflow-dcfg-"));
}

test("missing file → all defaults, source defaults", () => {
  const dir = configDir();
  try {
    const res = loadDaemonConfig(join(dir, "config.yaml"));
    assert.ok(res.ok);
    assert.equal(res.source, "defaults");
    assert.deepEqual(res.config, defaultDaemonConfig());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden pin: the documented defaults (global 4, delay_sec 300) come from the live data.md prose", () => {
  const text = specFile("data.md");
  // the spec prose wraps mid-phrase — allow whitespace where it breaks
  assert.match(text, /`concurrency\.global`\s*\(default 4\)/);
  assert.match(text, /`retry: \{delay_sec: 300\}`/);
  assert.equal(DEFAULT_CONCURRENCY_GLOBAL, 4);
  assert.equal(DEFAULT_RETRY_DELAY_SEC, 300);
});

test("golden pin: the key set is exactly the data.md 4.4 global-scope keys", () => {
  assert.deepEqual(Object.keys(DAEMON_CONFIG_SECTION_KEYS).sort(), [
    "budgets",
    "concurrency",
    "retry",
  ]);
  assert.deepEqual(
    [...DAEMON_CONFIG_SECTION_KEYS["budgets"]!].sort(),
    ["daily_usd", "monthly_usd"],
  );
  assert.deepEqual(
    [...DAEMON_CONFIG_SECTION_KEYS["concurrency"]!].sort(),
    ["global"],
  );
  assert.deepEqual([...DAEMON_CONFIG_SECTION_KEYS["retry"]!].sort(), [
    "delay_sec",
  ]);
});

test("a complete valid file parses every key", () => {
  const res = parseDaemonConfig(
    [
      "# daemon global scope (data.md 4.4)",
      "budgets:",
      "  daily_usd: 12.5",
      "  monthly_usd: 300",
      "",
      "concurrency:",
      "  global: 8",
      "retry:",
      "  delay_sec: 60",
    ].join("\n"),
  );
  assert.ok(res.ok);
  assert.deepEqual(res.config, {
    budgets: { dailyUsd: 12.5, monthlyUsd: 300 },
    concurrency: { global: 8 },
    retry: { delaySec: 60 },
  });
});

test("a partial file keeps defaults for absent keys", () => {
  const res = parseDaemonConfig("retry:\n  delay_sec: 10\n");
  assert.ok(res.ok);
  assert.equal(res.config.concurrency.global, 4);
  assert.equal(res.config.budgets.dailyUsd, null);
  assert.equal(res.config.budgets.monthlyUsd, null);
  assert.equal(res.config.retry.delaySec, 10);
});

test("unknown top-level key → error naming the line and the allowed set", () => {
  const res = parseDaemonConfig("budgets:\n  daily_usd: 1\nalerts:\n  ntfy_topic: ops\n");
  assert.ok(!res.ok);
  assert.match(res.error, /line 3/);
  assert.match(res.error, /unknown top-level key "alerts"/);
  assert.match(res.error, /budgets, concurrency, retry/);
});

test("unknown nested key → error naming the line and the section", () => {
  const res = parseDaemonConfig("retry:\n  delay_sec: 5\n  backoff: exp\n");
  assert.ok(!res.ok);
  assert.match(res.error, /line 3/);
  assert.match(res.error, /unknown key "backoff" in "retry"/);
  assert.match(res.error, /delay_sec/);
});

test("unbalanced quote is rejected (workspace parser discipline)", () => {
  const res = parseDaemonConfig("retry:\n  delay_sec: \"oops\n");
  assert.ok(!res.ok);
  assert.match(res.error, /line 2/);
  assert.match(res.error, /unbalanced quote/);
});

test("duplicate keys are hard errors", () => {
  const res = parseDaemonConfig(
    "concurrency:\n  global: 4\n  global: 5\n",
  );
  assert.ok(!res.ok);
  assert.match(res.error, /line 3/);
  assert.match(res.error, /duplicate key "concurrency\.global"/);
});

test("wrong scalar types are hard errors with line numbers", () => {
  const bad = (text: string, needle: string) => {
    const res = parseDaemonConfig(text);
    assert.ok(!res.ok, text);
    assert.match(res.error, needle);
  };
  bad("concurrency:\n  global: four\n", /line 2.*"global" must be an integer >= 1/);
  bad("concurrency:\n  global: 0\n", /line 2.*"global" must be an integer >= 1/);
  bad("budgets:\n  daily_usd: -1\n", /line 2.*"daily_usd" must be a number >= 0/);
  bad("budgets:\n  daily_usd: soon\n", /line 2.*"daily_usd" must be a number >= 0/);
  bad("retry:\n  delay_sec: -5\n", /line 2.*"delay_sec" must be a number >= 0/);
  bad("budgets:\n  daily_usd: [1, 2]\n", /line 2.*must be a scalar/);
  bad("concurrency: 4\n", /line 1.*opens a section/);
  bad("  global: 4\n", /line 1.*before any section/);
});

test("loadDaemonConfig: file present + valid → source file; unreadable file → error", () => {
  const dir = configDir();
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "concurrency:\n  global: 6\n");
    const res = loadDaemonConfig(p);
    assert.ok(res.ok);
    assert.equal(res.source, "file");
    assert.equal(res.config.concurrency.global, 6);

    const badRes = loadDaemonConfig(join(dir, "sub")); // a directory: unreadable
    assert.ok(!badRes.ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
