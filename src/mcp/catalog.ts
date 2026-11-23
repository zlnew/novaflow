/**
 * THE MCP TOOL CATALOG (novaflow-v1/mcp §3), as data.
 *
 * One row per spec tool: the wire name the client sees, the daemon op it
 * translates to (they are the same string for every tool in v1 — the
 * catalog was designed as the socket surface's twin), the JSON Schema the
 * SDK advertises, and the kind that decides the daemon-down rule.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. One source. test/golden/mcp-catalog.test.ts re-parses §3.1/§3.2 from
 *    the LIVE spec and compares row for row. A renamed, added, dropped or
 *    re-classified tool fails the build.
 *
 * 2. The engine is the arbiter (card Risk #1). The input schemas here are
 *    ADVERTISEMENTS, not gates: no `required` array, never
 *    `additionalProperties: false`. If the SDK rejected early what the
 *    engine would accept, MCP would be a second validation model — and
 *    mcp.md §4 says there is exactly one ("Idempotency by FSM, not by tool
 *    logic … the FSM is the arbiter"). The SDK's tool dispatch does NOT
 *    validate against this schema (it validates only against a Zod
 *    schema, and these are plain JSON Schema), so the daemon's own
 *    validators stay the single rejection surface. Verified by
 *    test/mcp/server.test.ts, which sends keys no schema models and
 *    expects them to reach the socket.
 *
 * 3. Nothing is silently renamed. Where the spec's input name differs from
 *    the op's validated arg, `toOpArgs` performs an explicit, documented
 *    rename instead of hiding it (see WORKSPACE_CREATE below).
 */

/** The two halves of mcp.md §3 — they decide the daemon-down behavior. */
export type ToolKind = "read" | "mutate";

/** The JSON Schema shape the SDK advertises (a JSON Schema object). */
export type JsonObjectSchema = {
  type: "object";
  properties: Record<string, object>;
  description?: string;
};

export type McpTool = {
  /** The MCP tool name (mcp.md §3: `nova_` prefix, verbatim). */
  name: string;
  /** The daemon op the tool translates to (src/daemon/server.ts op table). */
  op: string;
  kind: ToolKind;
  description: string;
  inputSchema: JsonObjectSchema;
  /**
   * Spec-input-name → op-arg-name renames. Absent means identity, which
   * is the case for every tool in the catalog.
   */
  argRenames?: Record<string, string>;
};

const str = (description: string): object => ({ type: "string", description });
const int = (description: string): object => ({ type: "integer", description });
const bool = (description: string): object => ({ type: "boolean", description });
const strArray = (description: string): object => ({
  type: "array",
  items: { type: "string" },
  description,
});

/**
 * mcp.md §3.1 — read-only tools. These may serve from the SQLite store
 * directly when the daemon is unreachable (§4), with TWO documented
 * exceptions: `nova_daemon_status`, whose payload is live daemon state
 * that no store table holds, and `nova_events_since`, which
 * novaflow-v02/events.md rule 6 pins to `daemon_unreachable` with no
 * SQLite fallback (a liveness feed served from a store whose writer just
 * died would report a frozen world as current). See src/mcp/server.ts.
 */
const READ_TOOLS: McpTool[] = [
  {
    name: "nova_workspace_list",
    op: "nova_workspace_list",
    kind: "read",
    description:
      "List registered workspaces (id, name, root path, state). Read-only; served from the store when the daemon is down.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nova_project_list",
    op: "nova_project_list",
    kind: "read",
    description:
      "List a workspace's projects with their FSM summary. Read-only; served from the store when the daemon is down.",
    inputSchema: {
      type: "object",
      properties: { workspace_id: str("the workspace id (bare ULID)") },
    },
  },
  {
    name: "nova_task_list",
    op: "nova_task_list",
    kind: "read",
    description:
      "List tasks with their current state, last run and cost, optionally scoped to a project and filtered by state. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: str("the project id (bare ULID) — omit for every project"),
        state: str(
          "canonical FSM state filter: draft | queued | running | awaiting_gate | validating | completed | changes_requested | failed | cancelled",
        ),
      },
    },
  },
  {
    name: "nova_task_status",
    op: "nova_task_status",
    kind: "read",
    description:
      "Full task record, current run, elapsed time, and the owning workspace's status. Poll this for progress (v1 has no push notifications).",
    inputSchema: {
      type: "object",
      properties: { task_id: str("the task id (bare ULID)") },
    },
  },
  {
    name: "nova_run_logs",
    op: "nova_run_logs",
    kind: "read",
    description:
      "Tail of a run's redacted events.jsonl (NFR-SE-04: the raw stream is never served). Defaults to the task's latest run.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("the task id (bare ULID)"),
        run_id: str("the run id — omit for the task's latest run"),
        tail_lines: int("how many trailing lines to return (1..1000, default 100)"),
      },
    },
  },
  {
    name: "nova_result_get",
    op: "nova_result_get",
    kind: "read",
    description:
      "The validated result.json handoff artifact of a run (data.md §4.1). Defaults to the task's latest run.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("the task id (bare ULID)"),
        run_id: str("the run id"),
      },
    },
  },
  {
    name: "nova_daemon_status",
    op: "nova_daemon_status",
    kind: "read",
    description:
      "Scheduler state, active/queued run counts, recovery summary and budget counters. LIVE daemon state — unavailable when the daemon is down.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nova_events_since",
    op: "nova_transitions_since",
    kind: "read",
    description:
      "Poll the engine's transition stream (novaflow-v02/events.md): pass the last cursor seen and re-poll with next_cursor while has_more. cursor 0 starts at head (the most recent `limit` rows, ascending) — older history is not offered by design; read `nova_task_status` for that. Read-only, but DAEMON-REQUIRED: a dead socket answers daemon_unreachable, never a store snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: int("the last rowid the caller has seen (default 0 = start at head)"),
        workspace_id: str("the workspace id (bare ULID) — omit for every workspace"),
        project_id: str("an optional narrower project scope (bare ULID)"),
        limit: int("batch bound (1..1000, default 100)"),
      },
    },
  },
];

/**
 * mcp.md §3.2 — mutating tools. Every one goes through the daemon's engine
 * command layer (never the store); with the socket down they return the
 * structured error `daemon_unreachable` and never cold-start the daemon.
 */
const MUTATING_TOOLS: McpTool[] = [
  {
    name: "nova_workspace_create",
    op: "nova_workspace_create",
    kind: "mutate",
    description:
      "Create and register a workspace (FR-WS-01). The spec's `path` is the engine op's `root_path` (the rename is performed by toOpArgs).",
    inputSchema: {
      type: "object",
      properties: {
        name: str("workspace slug — lower-case kebab-case"),
        path: str("the existing writable directory to register as the workspace root"),
      },
    },
    argRenames: { path: "root_path" },
  },
  {
    name: "nova_task_create",
    op: "nova_task_create",
    kind: "mutate",
    description:
      "Create a task in DRAFT (FR-TSK-01). A duplicate key is the engine's `duplicate` refusal.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: str("the project id (bare ULID)"),
        key: str("the human-readable task key, unique per project"),
        title: str("the task title"),
        objective: str("the task objective — the agent's brief"),
        profile_name: str("the agent profile name resolvable in the project's workspace"),
        requires_human_gate: bool("stop at awaiting_gate for operator approval"),
        context_files: strArray("workspace-relative context file paths"),
        overrides: {
          type: "object",
          description:
            "task-level overrides (FR-AGT-03): timeout_sec (integer >= 1), max_cost_usd (number >= 0), thinking_level (non-empty string)",
          properties: {
            timeout_sec: int("run timeout in seconds"),
            max_cost_usd: { type: "number", description: "run cost ceiling in USD" },
            thinking_level: str("the thinking level for this task"),
          },
        },
        target_scopes: {
          type: "array",
          description:
            "per-target scope rows: { repo_alias, access_mode, write_scope_globs?, protected_test_globs?, verification_commands? }",
          items: { type: "object" },
        },
        output_schema_version: str("the expected result.json schema version (default 1.0.0)"),
      },
    },
  },
  {
    name: "nova_task_run",
    op: "nova_task_run",
    kind: "mutate",
    description:
      "Enqueue a DRAFT task (draft → queued; the catalog probe is the engine's admission gate). Any other source state is the engine's invalid_transition refusal.",
    inputSchema: {
      type: "object",
      properties: { task_id: str("the task id (bare ULID)") },
    },
  },
  {
    name: "nova_task_steer",
    op: "nova_task_steer",
    kind: "mutate",
    description: "Send a steer message to a RUNNING task's live subprocess (api.md §3).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("the task id (bare ULID)"),
        message: str("the steer message delivered to the running agent"),
      },
    },
  },
  {
    name: "nova_task_abort",
    op: "nova_task_abort",
    kind: "mutate",
    description:
      "Abort a task: abort_bash, then SIGTERM → 3 s grace → SIGKILL over the run's process group (FR-TSK-08).",
    inputSchema: {
      type: "object",
      properties: { task_id: str("the task id (bare ULID)") },
    },
  },
  {
    name: "nova_gate_approve",
    op: "nova_gate_approve",
    kind: "mutate",
    description:
      "Approve a human gate: awaiting_gate → validating, with the approval payload recorded. The engine verifies the payload and the live run id; the surface is not the authority.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("the task id (bare ULID)"),
        run_id: str("the live run id being approved"),
        approved_by: str("who approved (recorded in the transition log)"),
        note: str("the approval note (recorded in the transition log)"),
      },
    },
  },
  {
    name: "nova_gate_reject",
    op: "nova_gate_reject",
    kind: "mutate",
    description:
      "Reject a gate with corrective feedback: awaiting_gate → changes_requested; a rejection with remaining budget re-queues itself with the feedback artifact.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("the task id (bare ULID)"),
        feedback: str("the corrective feedback for the next attempt"),
      },
    },
  },
  {
    name: "nova_chain_abort",
    op: "nova_chain_abort",
    kind: "mutate",
    description:
      "Abort a chain run: every still-active member aborts per the 8.1 matrix rows, then the chain run moves to aborted.",
    inputSchema: {
      type: "object",
      properties: { chain_run_id: str("the chain run id (bare ULID)") },
    },
  },
  {
    name: "nova_kill_all",
    op: "nova_kill_all",
    kind: "mutate",
    description:
      "Emergency kill switch (ASI10): SIGTERM → 3 s grace → SIGKILL every live child process tree across all workspaces, and pause the scheduler.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** The catalog in spec order: §3.1 read-only rows, then §3.2 mutating rows. */
export const MCP_TOOLS: readonly McpTool[] = [...READ_TOOLS, ...MUTATING_TOOLS];

export const READ_ONLY_TOOL_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);
export const MUTATING_TOOL_NAMES: readonly string[] = MUTATING_TOOLS.map((t) => t.name);

const BY_NAME: ReadonlyMap<string, McpTool> = new Map(MCP_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): McpTool | undefined {
  return BY_NAME.get(name);
}

/**
 * Translate MCP tool arguments into the daemon op's arg object.
 *
 * Pass-through by design — unknown keys survive, because the engine's
 * validators are the only rejection surface (rule 2 in the header). The
 * only transform is the documented spec→op rename (`nova_workspace_create`'s
 * `path` → `root_path`).
 */
export function toOpArgs(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
  if (tool.argRenames === undefined) return { ...args };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const renamed = tool.argRenames[key];
    out[renamed ?? key] = value;
  }
  return out;
}
