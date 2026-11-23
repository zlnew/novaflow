import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_TOOLS,
  MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  toOpArgs,
  toolByName,
} from "../../src/mcp/catalog.ts";
import { buildOpTable } from "../../src/daemon/server.ts";

/**
 * The MCP tool catalog (mcp.md §3) as DATA: the 18 tools (16 v1 rows plus
 * v0.2.0's `nova_events_since` and `nova_run_logs_since`, amendments.md
 * rows 2/3), the two halves (9 read-only / 9 mutating), the op each one
 * translates to, and the translation itself. Golden drift against the live
 * spec is pinned separately in test/golden/mcp-catalog.test.ts; this file
 * pins the mechanics.
 */

/** mcp.md §3.1 + §3.2, table order verbatim. */
const EXPECTED_NAMES = [
  // §3.1 read-only
  "nova_workspace_list",
  "nova_project_list",
  "nova_task_list",
  "nova_task_status",
  "nova_run_logs",
  "nova_run_logs_since",
  "nova_result_get",
  "nova_daemon_status",
  "nova_events_since",
  // §3.2 mutating
  "nova_workspace_create",
  "nova_task_create",
  "nova_task_run",
  "nova_task_steer",
  "nova_task_abort",
  "nova_gate_approve",
  "nova_gate_reject",
  "nova_chain_abort",
  "nova_kill_all",
];

test("the catalog is exactly the 18 spec tools, 9 read-only + 9 mutating, in §3 order", () => {
  assert.deepEqual(
    MCP_TOOLS.map((t) => t.name),
    EXPECTED_NAMES,
  );
  assert.equal(READ_ONLY_TOOL_NAMES.length, 9);
  assert.equal(MUTATING_TOOL_NAMES.length, 9);
  assert.deepEqual([...READ_ONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES], EXPECTED_NAMES);
  for (const tool of MCP_TOOLS) {
    assert.match(tool.name, /^nova_/, "tool names carry the nova_ prefix (mcp.md §3)");
    assert.notEqual(tool.description.trim(), "", `${tool.name} needs a description`);
  }
});

test("every catalog tool targets an op the daemon actually serves", () => {
  const ops = buildOpTable();
  for (const tool of MCP_TOOLS) {
    assert.ok(ops.has(tool.op), `${tool.name} targets unknown op "${tool.op}"`);
  }
});

test("input schemas declare the spec's fields and never close the object (engine is the arbiter)", () => {
  const expectedFields: Record<string, string[]> = {
    nova_workspace_list: [],
    nova_project_list: ["workspace_id"],
    nova_task_list: ["project_id", "state"],
    nova_task_status: ["task_id"],
    nova_run_logs: ["task_id", "run_id", "tail_lines"],
    nova_run_logs_since: ["task_id", "run_id", "offset", "limit", "tail_lines"],
    nova_result_get: ["task_id", "run_id"],
    nova_daemon_status: [],
    nova_events_since: ["cursor", "workspace_id", "project_id", "limit"],
    nova_workspace_create: ["name", "path"],    nova_task_create: [
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
    ],
    nova_task_run: ["task_id"],
    nova_task_steer: ["task_id", "message"],
    nova_task_abort: ["task_id"],
    nova_gate_approve: ["task_id", "run_id", "approved_by", "note"],
    nova_gate_reject: ["task_id", "feedback"],
    nova_chain_abort: ["chain_run_id"],
    nova_kill_all: [],
  };

  for (const tool of MCP_TOOLS) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name}: input schema is an object schema`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      expectedFields[tool.name]!.sort(),
      `${tool.name}: declared properties must be the spec's input fields`,
    );
    // mcp.md §4 / card Risk #1: the ENGINE is the sole arbiter. A schema
    // `required` array or a closed object would let the SDK reject before
    // the engine sees the call, inventing a second error model.
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.equal(schema["required"], undefined, `${tool.name}: no required[] — the engine decides`);
    assert.notEqual(schema["additionalProperties"], false, `${tool.name}: inputs stay open`);
  }
});

test("translation is passthrough except where the spec name differs from the op arg", () => {
  // every tool passes unknown keys through untouched: the engine's
  // validator is the rejection surface (it ignores extras, refuses bad ones)
  for (const tool of MCP_TOOLS) {
    const translated = toOpArgs(tool, { probe_key: "probe", task_id: "X" });
    assert.equal(translated["probe_key"], "probe", `${tool.name} must not strip unknown args`);
  }
  // the one documented rename: mcp.md §3.2 nova_workspace_create is {name, path}
  // while the op's validated arg is root_path (server.ts nova_workspace_create)
  const create = toolByName("nova_workspace_create");
  assert.ok(create !== undefined);
  assert.deepEqual(
    toOpArgs(create!, { name: "ws", path: "/tmp/ws", default_branch: "dev" }),
    { name: "ws", root_path: "/tmp/ws", default_branch: "dev" },
  );
  // identity for everything else
  const status = toolByName("nova_task_status");
  assert.deepEqual(toOpArgs(status!, { task_id: "01H" }), { task_id: "01H" });
  const approve = toolByName("nova_gate_approve");
  assert.deepEqual(
    toOpArgs(approve!, { task_id: "t", run_id: "r", approved_by: "maul", note: "ok" }),
    { task_id: "t", run_id: "r", approved_by: "maul", note: "ok" },
  );
});

test("kind classification follows the spec's two tables", () => {
  const readSet = new Set(READ_ONLY_TOOL_NAMES);
  for (const tool of MCP_TOOLS) {
    assert.equal(
      tool.kind,
      readSet.has(tool.name) ? "read" : "mutate",
      `${tool.name}: kind must follow mcp.md §3.1/§3.2`,
    );
  }
});
