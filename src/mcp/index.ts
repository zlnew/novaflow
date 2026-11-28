/**
 * Stateless stdio MCP server (`novaflow-v100/mcp`).
 *
 * `novaflow mcp` constructs one server, attaches the stdio transport, and serves
 * until `stdin` reaches EOF. There is no daemon and no background work: each
 * `tools/call` opens the resolved workspace's `.novaflow/state.db`, runs the same
 * `src/core/` function the CLI runs, and returns one JSON text block.
 *
 * Layer rule (`novaflow-v100/architecture` §2): this module adapts core to MCP.
 * It never re-implements validation or SQL, and it writes nothing to `stdout`
 * outside the transport.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Env } from '../store/registry.js';
import { ToolArgs } from './args.js';
import { errorResult, successResult } from './results.js';
import { TOOLS, findTool } from './tools.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type { McpNextAction, McpSuccessEnvelope, McpErrorEnvelope } from './results.js';
export type { McpTool, ToolContext, ToolInputSchema, ToolOutcome } from './tools.js';
export { TOOLS, TOOL_NAMES, findTool } from './tools.js';
export { errorResult, successResult } from './results.js';

/** How to construct the server; every field is injectable for tests. */
export interface NovaflowServerOptions {
  /** `--workspace` given to `novaflow mcp`, used when a call omits its own. */
  workspace?: string | null;
  /** Environment for registry and `NOVAFLOW_WORKSPACE` lookups. */
  env?: Env;
  /** Directory used for cwd walk-up discovery. */
  cwd?: string;
  /** Clock factory; one reading per tool call. */
  now?: () => Date;
  /** Overrides the `package.json` version in the handshake. */
  version?: string;
}

const INSTRUCTIONS =
  'NovaFlow task ledger over SQLite. Read the board with novaflow_status, dispatch with novaflow_task_next, ' +
  'load a handoff with novaflow_task_context, and record progress with novaflow_task_start / novaflow_task_complete. ' +
  'Every tool returns one JSON text block: { ok, data, next_actions } on success or { ok: false, error } on failure.';

/** Tool descriptions for `tools/list`, mapped to the SDK wire shape. */
function toolList(): Tool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Builds the MCP server without connecting a transport.
 *
 * Unknown tool names answer with a JSON-RPC `MethodNotFound` error (the MCP
 * convention for a request the server cannot route); every other failure is a
 * `CallToolResult` with `isError: true` so the agent can read and correct it.
 */
export function createNovaflowServer(options: NovaflowServerOptions = {}): Server {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const serverWorkspace = options.workspace ?? null;
  const clock = options.now ?? (() => new Date());

  const server = new Server(
    { name: SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const tool = findTool(request.params.name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool "${request.params.name}" is not available.`);
    }

    try {
      const args = new ToolArgs(request.params.arguments ?? {}, tool.name);
      const outcome = tool.handler({
        args,
        // Per-call resolution: the tool param wins over the server `--workspace`;
        // both are `undefined`-free so core can fall through to env/walk-up/default.
        workspace: args.nullableString('workspace') ?? serverWorkspace,
        env,
        cwd,
        now: clock(),
      });
      return successResult(outcome.data, outcome.next_actions ?? []);
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

/**
 * Serves until `stdin` reaches EOF, then closes cleanly.
 *
 * Diagnostics never touch `stdout`: the transport owns that stream, and anything
 * else written there corrupts the JSON-RPC framing.
 */
export async function runStdioServer(options: NovaflowServerOptions = {}): Promise<void> {
  const server = createNovaflowServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await waitForStdinEnd(server);
}

function waitForStdinEnd(server: Server): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off('end', finish);
      process.stdin.off('close', finish);
      server.close().then(
        () => resolve(),
        () => resolve(),
      );
    };

    if (process.stdin.readableEnded || process.stdin.destroyed) {
      finish();
      return;
    }
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
  });
}
