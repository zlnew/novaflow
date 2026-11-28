/**
 * `novaflow mcp` — stateless stdio MCP server (`novaflow-v100/mcp`).
 *
 * P3 owns the dispatch only; the tool adapter lands in P4a. Until then the
 * command fails cleanly with a `VALIDATION_ERROR` (exit 2) instead of hanging on
 * `stdin`.
 */
import type { CommandModule, VerbSpec } from '../types.js';
import { notImplemented } from './not-implemented.js';

const mcpVerb: VerbSpec = {
  verb: null,
  command: 'mcp',
  summary: 'Start the stateless stdio MCP server (wired in P4a)',
  usage: 'novaflow mcp',
  positionals: [],
  flags: [],
  examples: ['novaflow mcp'],
  run: () => {
    throw notImplemented('mcp', 'P4a', 'novaflow-v100/mcp');
  },
};

export const mcpModule: CommandModule = {
  name: 'mcp',
  summary: 'Stateless stdio MCP server for the same core operations.',
  verbs: [mcpVerb],
};
