import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, YamlParseError } from "../../src/chain/yaml.ts";

/**
 * The strict hand-rolled YAML subset parser (NO dependencies; FR-PRJ-04
 * "JSON or YAML"). Two contracts, both pinned here:
 *   1. a chain.yaml written in the subset parses to the IDENTICAL
 *      object as its JSON twin;
 *   2. everything outside the subset is REFUSED with a line-numbered
 *      error — the parser never guesses (anchors, flow syntax, tabs,
 *      tags, multi-line strings, duplicate keys, bad indentation).
 */

const CHAIN_YAML = `# a chain.yaml in the strict subset (data.md §4.3 shapes)
version: "1.0.0"
project_slug: prj-graph

tasks:
  - key: PLAN                      # inline trailing comment
    title: "Plan the work"
    objective: Write the implementation plan end to end.
    profile_name: dev
    priority: 2
    requires_human_gate: true
    context_files:
      - docs/spec.md
      - "docs/arch v2.md"
    overrides:
      timeout_sec: 600
      max_cost_usd: 1.5
      thinking_level: high
  - key: WORK
    title: Do the work
    objective: 'Implement the planned feature, really.'
    profile_name: globaldev
    output_schema_version: 1.0.0
    target_scopes:
      - repo_alias: code
        access_mode: read_write
        write_scope_globs:
          - "src/**"
        protected_test_globs:
          - tests/**
edges:
  - source_key: PLAN
    target_key: WORK
    edge_type: depends_on
`;

const CHAIN_JSON_TWIN = {
  version: "1.0.0",
  project_slug: "prj-graph",
  tasks: [
    {
      key: "PLAN",
      title: "Plan the work",
      objective: "Write the implementation plan end to end.",
      profile_name: "dev",
      priority: 2,
      requires_human_gate: true,
      context_files: ["docs/spec.md", "docs/arch v2.md"],
      overrides: { timeout_sec: 600, max_cost_usd: 1.5, thinking_level: "high" },
    },
    {
      key: "WORK",
      title: "Do the work",
      objective: "Implement the planned feature, really.",
      profile_name: "globaldev",
      output_schema_version: "1.0.0",
      target_scopes: [
        {
          repo_alias: "code",
          access_mode: "read_write",
          write_scope_globs: ["src/**"],
          protected_test_globs: ["tests/**"],
        },
      ],
    },
  ],
  edges: [{ source_key: "PLAN", target_key: "WORK", edge_type: "depends_on" }],
};

test("a chain.yaml in the subset parses to the IDENTICAL object as its JSON twin", () => {
  assert.deepEqual(parseYaml(CHAIN_YAML), CHAIN_JSON_TWIN);
});

test("plain scalar typing: booleans, integers, floats become JSON types; version-like strings stay strings", () => {
  const doc = parseYaml(
    [
      "a: true",
      "b: false",
      "c: 42",
      "d: -7",
      "e: 2.5",
      'f: "quoted stays a string"', // eslint-disable-line @typescript-eslint/quotes
      "g: 1.0.0",
      "h: not-a-number-32",
      "i: True",
    ].join("\n"),
  ) as Record<string, unknown>;
  assert.equal(doc["a"], true);
  assert.equal(doc["b"], false);
  assert.equal(doc["c"], 42);
  assert.equal(doc["d"], -7);
  assert.equal(doc["e"], 2.5);
  assert.equal(doc["f"], "quoted stays a string");
  assert.equal(doc["g"], "1.0.0"); // two dots: not a number, stays a string
  assert.equal(doc["h"], "not-a-number-32");
  assert.equal(doc["i"], "True"); // only lowercase true/false are booleans
});

test("quoted scalars: single quotes with escaped quotes, double quotes with the escape set", () => {
  const doc = parseYaml(
    [
      "a: 'it''s fine'",
      'b: "line\\nbreak\\ttab\\\\slash\\"quote"',
      "c: 'plain # not a comment inside quotes'",
      "d: \"also # not a comment\"",
    ].join("\n"),
  ) as Record<string, unknown>;
  assert.equal(doc["a"], "it's fine");
  assert.equal(doc["b"], 'line\nbreak\ttab\\slash"quote');
  assert.equal(doc["c"], "plain # not a comment inside quotes");
  assert.equal(doc["d"], "also # not a comment");
});

test("a list may sit at the SAME indent as its key (standard YAML)", () => {
  const doc = parseYaml(
    [
      "edges:",
      "- source_key: A",
      "  target_key: B",
      "  edge_type: depends_on",
      "- source_key: B",
      "  target_key: A",
      "  edge_type: on_changes_requested",
    ].join("\n"),
  ) as Record<string, unknown>;
  const edges = doc["edges"] as Array<Record<string, unknown>>;
  assert.equal(edges.length, 2);
  assert.deepEqual(edges[1], {
    source_key: "B",
    target_key: "A",
    edge_type: "on_changes_requested",
  });
});

test("nested maps, lists of maps, lists of scalars, blank lines, full-line comments", () => {
  const doc = parseYaml(
    [
      "# leading comment",
      "",
      "top:",
      "  inner:",
      "    x: 1",
      "  list:",
      "    - one",
      "    - two",
      "",
      "  maps:",
      "    - k: v",
      "      n: 3",
      "    - k: w",
      "# trailing comment",
    ].join("\n"),
  ) as Record<string, unknown>;
  const top = doc["top"] as Record<string, unknown>;
  assert.deepEqual(top["inner"], { x: 1 });
  assert.deepEqual(top["list"], ["one", "two"]);
  assert.deepEqual(top["maps"], [
    { k: "v", n: 3 },
    { k: "w" },
  ]);
});

test("CRLF line endings are tolerated", () => {
  assert.deepEqual(parseYaml("a: 1\r\nb: two\r\n"), { a: 1, b: "two" });
});

/* ------------------------- the adversarial battery ------------------------- */

function expectReject(text: string, line: number, pattern: RegExp): void {
  try {
    parseYaml(text);
  } catch (err) {
    assert.ok(err instanceof YamlParseError, `expected YamlParseError, got ${String(err)}`);
    assert.equal(err.line, line, `error must name line ${line}, got ${err.line} (${err.message})`);
    assert.match(err.message, pattern);
    return;
  }
  assert.fail(`expected a line-${line} rejection, the text parsed: ${JSON.stringify(text)}`);
}

test("tabs anywhere refuse with the line", () => {
  expectReject("a: 1\n\tb: 2", 2, /tab/);
  expectReject("a:\tvalue", 1, /tab/);
});

test("flow syntax ({}, []) refuses with the line", () => {
  expectReject('overrides: { timeout_sec: 600 }', 1, /flow/);
  expectReject("context_files: [a, b]", 1, /flow/);
  expectReject("edges: [{source_key: A}]", 1, /flow/);
});

test("anchors, aliases, and tags refuse with the line", () => {
  expectReject("a: &anchor value", 1, /anchor/);
  expectReject("a: *alias", 1, /alias/);
  expectReject("a: !!str tagged", 1, /tag/);
});

test("multi-line strings (| and >) and unterminated quotes refuse with the line", () => {
  expectReject("a: |\n  folded", 1, /multi-line|block scalar/);
  expectReject("a: >\n  folded", 1, /multi-line|folded/);
  expectReject("a: 'unterminated", 1, /unterminated|multi-line/);
  expectReject('a: "unterminated', 1, /unterminated|multi-line/);
});

test("document separators and a non-map root refuse with the line", () => {
  expectReject("---\na: 1", 1, /separator/);
  expectReject("a: 1\n---\nb: 2", 2, /separator/);
  expectReject("- just\n- a list", 1, /root must be a map/i);
});

test("duplicate keys refuse with the line", () => {
  expectReject("a: 1\na: 2", 2, /duplicate/);
  expectReject("tasks:\n  - k: 1\n    k: 2", 3, /duplicate/);
});

test("indentation discipline: odd steps and stray depths refuse with the line", () => {
  expectReject("a:\n   b: 1", 2, /indent/); // 3 spaces
  expectReject("a: 1\n  b: 2", 2, /indent/); // over-indented with no parent
  expectReject("a:\n  b:\n    c: 1\n     d: 2", 4, /indent/); // 5 spaces: odd step
});

test("malformed lines refuse with the line: no colon, bare dash without block, missing value", () => {
  expectReject("just a scalar line", 1, /"key: value"/);
  expectReject("a: 1\nstray text here", 2, /"key: value"|unexpected/);
  expectReject("a:\nb: 2", 1, /no value|nested/);
  expectReject("list:\n  -", 2, /nested block|bare/);
});

test("the subset has no null literal — ~ and null refuse with the line", () => {
  expectReject("a: ~", 1, /null/);
  expectReject("a: null", 1, /null/);
});

test("empty document refuses honestly", () => {
  expectReject("", 1, /empty/);
  expectReject("# only a comment\n\n", 1, /empty/);
});

test("an over-indented line after a nested block refuses (no silent wrapping)", () => {
  expectReject("a:\n  b: 1\n      c: 2", 3, /indent/);
});
