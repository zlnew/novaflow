/**
 * `novaflow mcp` — stateless stdio MCP server (`novaflow-v100/mcp`).
 *
 * The command's whole job is dispatch: build the server, attach stdio, and serve
 * until `stdin` closes. `--workspace` gives every tool call its fallback target;
 * a call's own `workspace` argument still wins (`novaflow-v100/mcp` §1).
 *
 * The result is marked `silent` because the transport owns `stdout`: writing a
 * success envelope here would corrupt the JSON-RPC framing.
 */
import { TOOL_NAMES, runStdioServer } from '../../mcp/index.js';
import type { CommandModule, VerbSpec } from '../types.js';

const mcpVerb: VerbSpec = {
  verb: null,
  command: 'mcp',
  summary: 'Serve the NovaFlow workspace, project, task, event, and export tools over stdio',
  usage: 'novaflow mcp [--workspace <name|path>]',
  positionals: [],
  flags: [],
  examples: ['novaflow mcp', 'novaflow mcp --workspace personal', 'novaflow mcp -w ~/www/personal'],
  run: async (ctx) => {
    await runStdioServer({
      workspace: ctx.options.workspace ?? null,
      env: ctx.env,
      cwd: ctx.cwd,
    });
    return {
      data: { transport: 'stdio', tool_count: TOOL_NAMES.length, closed: true },
      silent: true,
    };
  },
};

export const mcpModule: CommandModule = {
  name: 'mcp',
  summary: 'Stateless stdio MCP server for the same core operations.',
  verbs: [mcpVerb],
};
