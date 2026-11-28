/**
 * MCP `CallToolResult` construction (`novaflow-v100/mcp` §3).
 *
 * Every reply is exactly one text content block holding JSON: `{ ok: true, data,
 * next_actions }` on success, `{ ok: false, error: { code, message, hint } }` on
 * failure. Failures are returned as `isError: true` results, never thrown, so an
 * orchestrator can read the reason and correct itself instead of losing the
 * session to a dead stream.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toNovaError } from '../core/errors.js';

/** Follow-up advertised in `next_actions`, as an MCP call rather than a shell line. */
export interface McpNextAction {
  /** `novaflow_*` tool name. */
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

/** Success envelope payload (`novaflow-v100/mcp` §3). */
export interface McpSuccessEnvelope {
  ok: true;
  data: unknown;
  next_actions: McpNextAction[];
}

/** Failure envelope payload (`novaflow-v100/mcp` §3). */
export interface McpErrorEnvelope {
  ok: false;
  error: { code: string; message: string; hint: string };
}

/** Builds the success `CallToolResult`. */
export function successResult(data: unknown, next_actions: readonly McpNextAction[] = []): CallToolResult {
  const envelope: McpSuccessEnvelope = { ok: true, data: data ?? null, next_actions: [...next_actions] };
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
  };
}

/**
 * Builds the error `CallToolResult` from any thrown value.
 *
 * The code is the canonical `NovaError` domain code (`VALIDATION_ERROR`,
 * `NOT_FOUND`, `WORKSPACE_NOT_FOUND`, `STATE_CONFLICT`, `ALREADY_CLAIMED`,
 * `UNMET_DEPENDENCIES`, `CYCLE_DETECTED`, `INTERNAL_ERROR`). `hint` is always a
 * string, empty when the domain offered no remediation.
 */
export function errorResult(error: unknown): CallToolResult {
  const nova = toNovaError(error);
  const envelope: McpErrorEnvelope = {
    ok: false,
    error: { code: nova.code, message: nova.message, hint: nova.hint ?? '' },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
  };
}
