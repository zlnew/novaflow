import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specFile } from "../helpers/spec.ts";
import {
  loadWorkspaceConfig,
  parseWorkspaceConfig,
  workspaceConfigPath,
  type WorkspaceConfig,
} from "../../src/config.ts";

/**
 * data.md 4.4 — the workspace config.yaml schema block is the golden
 * source: the parser's accepted key set is pinned against the block's
 * live-parsed properties, and every documented default is enforced.
 */

function extractConfigSchema(): Record<string, unknown> {
  const text = specFile("data.md");
  const start = text.indexOf("### 4.4 Workspace Configuration Schema (config.yaml)");
  if (start < 0) throw new Error("config schema section (§4.4) not found in data.md");
  const m = text.slice(start).match(/```json\n([\s\S]*?)```/);
  if (!m || !m[1]) throw new Error("no ```json block found in data.md §4.4");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

const DEFAULTS: WorkspaceConfig = {
  budgets: { dailyUsd: null, monthlyUsd: null },
  concurrency: { workspace: 2 },
  missedRunPolicy: "skip",
  alerts: { ntfyTopic: null },
  container: { enabled: false },
};

/* ------------------------------------ defaults ----------------------------------- */

test("a missing config file = all defaults (concurrency 2, unlimited budgets, skip, container off)", () => {
  const root = mkdtempSync(join(tmpdir(), "novaflow-cfg-"));
  try {
    const res = loadWorkspaceConfig(root);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.source, "defaults");
    if (res.ok) assert.deepEqual(res.config, DEFAULTS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspaceConfigPath is <workspace_root>/.novaflow/config.yaml (data.md 5.2)", () => {
  assert.equal(workspaceConfigPath("/ws"), join("/ws", ".novaflow", "config.yaml"));
});

/* ------------------------------------ parsing ------------------------------------ */

test("a complete valid file parses every documented key", () => {
  const res = parseWorkspaceConfig(
    [
      "# NovaFlow workspace config",
      "budgets:",
      "  daily_usd: 5.0",
      "  monthly_usd: 100.5",
      "",
      "concurrency:",
      "  workspace: 4",
      "missed_run_policy: run_immediately",
      "alerts:",
      "  ntfy_topic: ops-halts",
      "container:",
      "  enabled: true",
    ].join("\n") + "\n",
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.config, {
      budgets: { dailyUsd: 5.0, monthlyUsd: 100.5 },
      concurrency: { workspace: 4 },
      missedRunPolicy: "run_immediately",
      alerts: { ntfyTopic: "ops-halts" },
      container: { enabled: true },
    });
  }
});

test("partial files are legal: absent sections keep their defaults", () => {
  const res = parseWorkspaceConfig("concurrency:\n  workspace: 7\n");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.config, {
      ...DEFAULTS,
      concurrency: { workspace: 7 },
    });
  }
});

test("quoted scalar values are accepted (single or double quotes)", () => {
  const res = parseWorkspaceConfig('alerts:\n  ntfy_topic: "my topic"\n');
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.config.alerts.ntfyTopic, "my topic");
});

/* ------------------------------------ rejections --------------------------------- */

function err(res: { ok: boolean; error?: string }): string {
  assert.equal(res.ok, false, "expected a parse rejection");
  return (res as { error: string }).error;
}

test("an unknown top-level key is rejected with its line number", () => {
  const res = parseWorkspaceConfig("budgets:\n  daily_usd: 1\nbogus: 1\n");
  assert.match(err(res), /line 3/);
  assert.match(err(res), /bogus/);
});

test("an unknown nested key is rejected", () => {
  const res = parseWorkspaceConfig("concurrency:\n  global: 4\n");
  assert.match(err(res), /line 2/);
  assert.match(err(res), /"global"/);
});

test("a bad missed_run_policy value is rejected", () => {
  const res = parseWorkspaceConfig("missed_run_policy: sometimes\n");
  assert.match(err(res), /skip or run_immediately/);
});

test("bad scalar types are rejected: negative budget, non-integer concurrency, non-boolean enabled", () => {
  assert.match(err(parseWorkspaceConfig("budgets:\n  daily_usd: -1\n")), /daily_usd/);
  assert.match(err(parseWorkspaceConfig("concurrency:\n  workspace: two\n")), /workspace/);
  assert.match(err(parseWorkspaceConfig("concurrency:\n  workspace: 0\n")), /workspace/);
  assert.match(err(parseWorkspaceConfig("container:\n  enabled: yes\n")), /enabled/);
});

test("deeper nesting is rejected — the parser supports exactly one level", () => {
  const res = parseWorkspaceConfig("budgets:\n  daily_usd: 1\n    deeper: 2\n");
  assert.ok(!res.ok);
});

test("a value on a section header line is rejected", () => {
  assert.match(err(parseWorkspaceConfig("budgets: 5\n")), /section/);
});

test("duplicate keys are rejected", () => {
  assert.match(err(parseWorkspaceConfig("missed_run_policy: skip\nmissed_run_policy: skip\n")), /duplicate/);
  assert.match(err(parseWorkspaceConfig("alerts:\n  ntfy_topic: a\n  ntfy_topic: b\n")), /duplicate/);
});

test("a line without a colon is rejected", () => {
  assert.match(err(parseWorkspaceConfig("just some prose\n")), /line 1/);
});

test("full-line comments and blank lines are ignored (documented subset: no inline trailing comments)", () => {
  const res = parseWorkspaceConfig("# header comment\n\nconcurrency:\n  # workspace note\n  workspace: 3\n");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.config.concurrency.workspace, 3);
});

/* ------------------------------- golden key-set pin ------------------------------ */

test("golden: the parser's top-level key set equals the 4.4 block's property names", () => {
  const block = extractConfigSchema();
  const props = block["properties"] as Record<string, Record<string, unknown>>;
  const blockKeys = [...Object.keys(props)].sort();
  // the block's own keys all parse — sections as bare headers, the one
  // scalar top key with a legal value
  const good = blockKeys
    .map((k) => (k === "missed_run_policy" ? `${k}: skip` : `${k}:`))
    .join("\n");
  assert.ok(parseWorkspaceConfig(good).ok, `the block's own keys must parse: ${good}`);
  // alien top keys do not
  assert.ok(!parseWorkspaceConfig("alerts2:\n").ok);
  assert.ok(
    !parseWorkspaceConfig("retry:\n  delay_sec: 1\n").ok,
    "daemon-scope keys are NOT workspace keys",
  );
});

test("golden: each section's nested key set equals the block's sub-properties", () => {
  const block = extractConfigSchema();
  const props = block["properties"] as Record<string, { properties?: Record<string, unknown> }>;
  // a valid value per section, so the whole-section probe parses cleanly
  const validValue: Record<string, string> = {
    budgets: "1",
    concurrency: "1",
    alerts: "topic-name",
    container: "true",
  };
  for (const section of ["budgets", "concurrency", "alerts", "container"]) {
    const sub = props[section]?.properties;
    assert.ok(sub, `block section ${section} must carry properties`);
    const keys = Object.keys(sub!);
    const text = [`${section}:`, ...keys.map((k) => `  ${k}: ${validValue[section]}`)].join("\n");
    const res = parseWorkspaceConfig(text);
    assert.ok(res.ok, `the block's own nested keys must parse:\n${text}\n-> ${res.ok ? "" : res.error}`);
    // every alien nested key must be rejected
    const alien = `${section}:\n  no_such_key: 1\n`;
    assert.ok(!parseWorkspaceConfig(alien).ok, `alien nested key in ${section} must be rejected`);
  }
  // spot-pin the concrete nested key names
  assert.deepEqual(Object.keys(props["budgets"]!.properties!), ["daily_usd", "monthly_usd"]);
  assert.deepEqual(Object.keys(props["concurrency"]!.properties!), ["workspace"]);
  assert.deepEqual(Object.keys(props["alerts"]!.properties!), ["ntfy_topic"]);
  assert.deepEqual(Object.keys(props["container"]!.properties!), ["enabled"]);
});

test("golden: the block's own defaults match our documented defaults (workspace 2, skip, container false)", () => {
  const block = extractConfigSchema();
  const props = block["properties"] as Record<string, Record<string, unknown>>;
  const ws = props["concurrency"]?.["properties"] as Record<string, { default?: number }>;
  assert.equal(ws["workspace"]?.default, 2);
  assert.equal(props["missed_run_policy"]?.["default"], "skip");
  const cont = props["container"]?.["properties"] as Record<string, { default?: boolean }>;
  assert.equal(cont["enabled"]?.default, false);
});

/* -------------------------------- loadWorkspaceConfig ---------------------------- */

test("loadWorkspaceConfig reads the real file from <root>/.novaflow/config.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "novaflow-cfg-"));
  try {
    mkdirSync(join(root, ".novaflow"), { recursive: true });
    writeFileSync(
      join(root, ".novaflow", "config.yaml"),
      "budgets:\n  daily_usd: 2\nconcurrency:\n  workspace: 9\n",
    );
    const res = loadWorkspaceConfig(root);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, "file");
      assert.equal(res.config.concurrency.workspace, 9);
      assert.equal(res.config.budgets.dailyUsd, 2);
      assert.equal(res.config.budgets.monthlyUsd, null);
      assert.equal(res.config.missedRunPolicy, "skip");
      assert.equal(res.config.container.enabled, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspaceConfig surfaces a parse error without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "novaflow-cfg-"));
  try {
    mkdirSync(join(root, ".novaflow"), { recursive: true });
    writeFileSync(join(root, ".novaflow", "config.yaml"), "what is this line\n");
    const res = loadWorkspaceConfig(root);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /line 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
