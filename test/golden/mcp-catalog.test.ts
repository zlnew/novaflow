import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specFile } from "../helpers/spec.ts";
import {
  MCP_TOOLS,
  toOpArgs,
  type McpTool,
} from "../../src/mcp/catalog.ts";

/**
 * Golden, one source: the registered MCP tool set is re-parsed LIVE from
 * mcp.md §3 and compared to the shipped catalog. Spec drift (a renamed
 * tool, a new/removed row, a changed input field, a tool that wanders
 * across the read-only/mutating divider) fails the build.
 *
 * Pattern: test/golden/chain-schema.test.ts — the spec is truth, the
 * constants are the implementation, and nothing is hand-maintained twice.
 */

type SpecRow = { name: string; input: string; kind: "read" | "mutate" };

/** Parse every catalog row of mcp.md §3.1 (read-only) and §3.2 (mutating). */
export function parseCatalogRows(): SpecRow[] {
  const text = specFile("mcp.md");
  const rows: SpecRow[] = [];
  let kind: "read" | "mutate" | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("### 3.1")) kind = "read";
    else if (line.startsWith("### 3.2")) kind = "mutate";
    else if (line.startsWith("## 4")) kind = null;
    if (kind === null) continue;
    // table rows: | `nova_tool` | `{ … }` | returns |
    const m = line.match(/^\|\s*`(nova_[a-z_]+)`\s*\|\s*`([^`]+)`\s*\|/);
    if (m === null) continue;
    rows.push({ name: m[1]!, input: m[2]!, kind });
  }
  return rows;
}

/** Parse the spec's `{ a, b?, c }` input notation into field names. */
function specFields(input: string): string[] {
  const inner = input.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((f) => f.trim().replace(/\?$/, ""))
    .filter((f) => f !== "");
}

test("the mcp.md §3 catalog parses to exactly 17 rows (8 read-only + 9 mutating)", () => {
  const rows = parseCatalogRows();
  assert.equal(rows.filter((r) => r.kind === "read").length, 8);
  assert.equal(rows.filter((r) => r.kind === "mutate").length, 9);
  assert.equal(rows.length, 17);
  for (const row of rows) {
    assert.notEqual(row.input, "", `${row.name}: the spec row must carry an input schema`);
  }
});

test("the registered tool set equals the live mcp.md §3 catalog row for row", () => {
  const rows = parseCatalogRows();
  assert.deepEqual(
    MCP_TOOLS.map((t) => t.name),
    rows.map((r) => r.name),
    "registered tools must be the catalog rows, in spec order (drift fails)",
  );
  for (const row of rows) {
    const tool = MCP_TOOLS.find((t) => t.name === row.name) as McpTool;
    assert.equal(
      tool.kind,
      row.kind,
      `${row.name}: the read-only/mutating divider must follow the spec's table`,
    );
  }
});

test("every registered tool's inputSchema properties are exactly the spec's input fields", () => {
  for (const row of parseCatalogRows()) {
    const tool = MCP_TOOLS.find((t) => t.name === row.name) as McpTool;
    const spec = specFields(row.input);
    const shipped = Object.keys(tool.inputSchema.properties);
    if (row.name === "nova_workspace_create") {
      // the documented rename (card step 1): the spec says `path`, the
      // engine op validates `root_path`; the SCHEMA keeps the spec's name
      // because the spec is the client-facing contract — see the
      // translation test in test/mcp/catalog.test.ts
      assert.deepEqual([...shipped].sort(), [...spec].sort(), "nova_workspace_create fields");
      continue;
    }
    assert.deepEqual([...shipped].sort(), [...spec].sort(), `${row.name}: input fields`);
  }
});

test("no spec field is dropped by the shipped schema (nothing the engine accepts is unreachable)", () => {
  const text = specFile("mcp.md");
  // the §3.2 prose explicitly enumerates nova_task_create's optional parts;
  // pin that the schema accepts every one of them
  assert.match(text, /\{ project_id, key, title, objective, profile_name,\s*\n?\s*requires_human_gate\?/);
  const create = MCP_TOOLS.find((t) => t.name === "nova_task_create") as McpTool;
  for (const field of [
    "project_id",
    "key",
    "title",
    "objective",
    "profile_name",
    "requires_human_gate",
    "context_files",
    "overrides",
    "target_scopes",
    "output_schema_version",
  ]) {
    assert.ok(field in create.inputSchema.properties, `nova_task_create must declare ${field}`);
  }
});

test("the goldens are parsed, not hand-copied: the source file is the live spec", () => {
  // a canary: if the parser stops seeing the section headers it would
  // silently pass on an empty list — this pins the mechanism itself
  const parsed = parseCatalogRows();
  assert.ok(parsed.length > 0);
  assert.equal(parsed[0]!.name, "nova_workspace_list");
  assert.equal(parsed[parsed.length - 1]!.name, "nova_kill_all");
});

test("write discipline: src/mcp never writes the store and never opens a writer connection", () => {
  const repo = join(import.meta.dirname, "..", "..");
  const files = [
    "src/mcp/catalog.ts",
    "src/mcp/server.ts",
    "src/mcp/read.ts",
    "src/mcp/errors.ts",
    "src/mcp/version.ts",
    "src/store/readonly.ts",
    "src/daemon/readops.ts",
  ];
  for (const f of files) {
    const src = stripComments(readFileSync(join(repo, f), "utf8"));
    assert.doesNotMatch(src, /UPDATE\s+tasks\b/i, `${f} must not UPDATE tasks`);
    assert.doesNotMatch(src, /SET\s+state\s*=/i, `${f} must not write state columns`);
    assert.doesNotMatch(src, /\bINSERT\s+INTO\b/i, `${f} must not INSERT`);
    assert.doesNotMatch(src, /\bDELETE\s+FROM\b/i, `${f} must not DELETE`);
    // the read-only tools open the store read-only through the one db module
    assert.doesNotMatch(src, /\bopenDb\b/, `${f} must use the read-only opener, not openDb`);
    if (f !== "src/store/readonly.ts") {
      // readonly.ts IS the one sanctioned opener (readonly + fileMustExist);
      // every other MCP-path file must go through it
      assert.doesNotMatch(
        src,
        /\bnew\s+Database\s*\(/,
        `${f} must open its store through src/store/readonly.ts`,
      );
    } else {
      assert.match(
        src,
        /readonly:\s*true/,
        "src/store/readonly.ts must open the store read-only",
      );
      assert.match(
        src,
        /fileMustExist:\s*true/,
        "src/store/readonly.ts must never create a store",
      );
    }
  }
});

/**
 * Strip comments before the bans are applied: the pins ban CODE, not
 * prose. Without this, documenting "why we do not call openDb here"
 * would itself trip the openDb ban — and a doc line is not a write.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("the catalog's translation keeps unknown input keys (the engine, not the SDK, is the arbiter)", () => {
  for (const tool of MCP_TOOLS) {
    const translated = toOpArgs(tool, {
      an_unmodelled_key_the_engine_accepts: 1,
    });
    assert.equal(
      translated["an_unmodelled_key_the_engine_accepts"],
      1,
      `${tool.name}: translation must not strip keys the SDK did not model`,
    );
  }
});
