import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OpError, type TaxonomyCode } from "../opcodes.ts";
import type { McpTool } from "./catalog.ts";

/**
 * ONE error taxonomy on the MCP surface (mcp.md §4: "Tool failures return
 * the engine's structured error code — the same codes the CLI prints. MCP
 * adds no second error model.").
 *
 * The presentation is deliberate:
 *   - a structured block `{code, message}` (the code is the engine's own
 *     string, verbatim — an orchestrator branches on it without parsing
 *     prose), and
 *   - the same code and message in the human-readable text block, so an
 *     agent reading content/sees exactly what a script reads from
 *     structuredContent.
 * `isError: true` is the MCP-level marker; the protocol error channel is
 * reserved for catalog mistakes (an unknown tool name), because those are
 * not failing engine operations.
 */

/** The taxonomy codes, in the srs 4.1.1 order. */
export const TAXONOMY_CODES: readonly TaxonomyCode[] = [
  "invalid_transition",
  "schema_invalid",
  "preflight_failed",
  "budget_exceeded",
  "not_found",
  "daemon_unreachable",
  "duplicate",
  "aborted",
  "profile_unresolved",
];

export function presentError(err: unknown, tool: McpTool): CallToolResult {
  const { code, message } = classify(err);
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message, tool: tool.name },
    isError: true,
  };
}

/**
 * Map any thrown value to the taxonomy. An `OpError` already carries the
 * engine's code (the daemon frame and the store bodies both raise it); an
 * unexpected throw is `aborted` — "the operation did not complete" — which
 * is the daemon's own rule for internal failures in `toErrorPayload`
 * (src/daemon/server.ts). No new code is ever invented here.
 */
export function classify(err: unknown): { code: TaxonomyCode; message: string } {
  if (err instanceof OpError) return { code: err.code, message: err.message };
  return {
    code: "aborted",
    message: err instanceof Error ? err.message : String(err),
  };
}
