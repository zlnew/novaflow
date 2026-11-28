/**
 * In-memory MCP harness (`novaflow-v100/testing` §2 "MCP Parity").
 *
 * Every test drives the real `src/mcp/` server through the official SDK client
 * over a linked in-memory transport pair, so the JSON-RPC framing, tool listing,
 * and `CallToolResult` shapes are the ones an agent actually receives. Isolation
 * comes from `test/store/helpers.ts#sandbox`: a throwaway `NOVAFLOW_HOME` per
 * test, never `~/.config/novaflow`.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovaflowServer, type NovaflowServerOptions } from '../../src/mcp/index.js';
import { sandbox, type Sandbox } from '../store/helpers.js';

/** The 30 tools pinned by `novaflow-v100/mcp` §2, in documented order. */
export const TOOL_NAMES = [
  'novaflow_workspace_create',
  'novaflow_workspace_list',
  'novaflow_workspace_show',
  'novaflow_workspace_update',
  'novaflow_status',
  'novaflow_project_create',
  'novaflow_project_list',
  'novaflow_project_show',
  'novaflow_project_update',
  'novaflow_project_archive',
  'novaflow_task_create',
  'novaflow_task_list',
  'novaflow_task_next',
  'novaflow_task_status',
  'novaflow_task_context',
  'novaflow_task_update',
  'novaflow_task_start',
  'novaflow_task_complete',
  'novaflow_task_block',
  'novaflow_task_unblock',
  'novaflow_task_cancel',
  'novaflow_task_reopen',
  'novaflow_task_claim',
  'novaflow_task_release',
  'novaflow_task_depend',
  'novaflow_task_undepend',
  'novaflow_task_note',
  'novaflow_task_attach',
  'novaflow_events_list',
  'novaflow_export',
] as const;

/** Machine-local setup that must stay CLI-only (`novaflow-v100/mcp` §2). */
export const CLI_ONLY_TOOL_NAMES = [
  'novaflow_workspace_register',
  'novaflow_workspace_unregister',
  'novaflow_skill_install',
  'novaflow_skill_status',
  'novaflow_skill_uninstall',
] as const;

export interface McpNextAction {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

export interface ToolSuccess {
  ok: true;
  data: any;
  next_actions: McpNextAction[];
}

export interface ToolFailure {
  ok: false;
  error: { code: string; message: string; hint: string };
}

export interface ToolOutcome {
  isError: boolean;
  /** Parsed JSON of the single text content block. */
  payload: ToolSuccess | ToolFailure;
  contentBlocks: number;
  raw: unknown;
}

export interface McpHarness {
  readonly box: Sandbox;
  /** Tool names called through this harness, in call order. */
  readonly calls: string[];
  tools(): Promise<Array<{ name: string; description?: string; inputSchema: { type: string } }>>;
  /** Raw call: no assertions beyond the single-text-block contract. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Asserts `isError: false` and returns `data`. */
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Asserts `isError: true` with the given canonical code; returns the error. */
  fail(name: string, args: Record<string, unknown> | undefined, code: string): Promise<ToolFailure['error']>;
  /** Asserts a success envelope whose `next_actions` are valid MCP tool calls. */
  nextActions(name: string, args?: Record<string, unknown>): Promise<McpNextAction[]>;
  close(): Promise<void>;
}

/**
 * Starts a `src/mcp/` server over an in-memory transport pair, wired to the
 * sandbox environment so no test can read or write the real registry.
 */
export async function createHarness(
  box: Sandbox,
  options: Partial<NovaflowServerOptions> = {},
): Promise<McpHarness> {
  const server = createNovaflowServer({ env: box.env, cwd: box.cwd, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'novaflow-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const calls: string[] = [];

  const call: McpHarness['call'] = async (name, args = {}) => {
    calls.push(name);
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const textBlocks = raw.content.filter((block) => block.type === 'text');
    assert.equal(textBlocks.length, 1, `expected exactly one text content block, got ${JSON.stringify(raw.content)}`);
    const text = textBlocks[0]?.text as string;
    assert.equal(typeof text, 'string', 'text content block must carry a string');
    return {
      isError: raw.isError === true,
      payload: JSON.parse(text),
      contentBlocks: raw.content.length,
      raw,
    };
  };

  return {
    box,
    calls,
    tools: async () => {
      const result = await client.listTools();
      return result.tools as Array<{ name: string; description?: string; inputSchema: { type: string } }>;
    },
    call,
    ok: async (name, args) => {
      const outcome = await call(name, args);
      assert.equal(outcome.isError, false, `${name} failed: ${JSON.stringify(outcome.payload)}`);
      const payload = outcome.payload;
      assert.equal(payload.ok, true);
      return (payload as ToolSuccess).data;
    },
    fail: async (name, args, code) => {
      const outcome = await call(name, args);
      assert.equal(outcome.isError, true, `${name} should have failed with ${code}, got ${JSON.stringify(outcome.payload)}`);
      const payload = outcome.payload;
      assert.equal(payload.ok, false);
      const failure = payload as ToolFailure;
      assert.equal(failure.error.code, code);
      assert.equal(typeof failure.error.message, 'string');
      assert.equal(typeof failure.error.hint, 'string', 'every MCP error carries a hint string');
      return failure.error;
    },
    nextActions: async (name, args) => {
      const outcome = await call(name, args);
      assert.equal(outcome.isError, false, `${name} failed: ${JSON.stringify(outcome.payload)}`);
      const payload = outcome.payload as ToolSuccess;
      assert.ok(Array.isArray(payload.next_actions), 'next_actions must always be an array');
      return payload.next_actions;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Creates a sandbox plus a harness already wired to it. */
export async function harness(options: Partial<NovaflowServerOptions> = {}): Promise<McpHarness> {
  const box = sandbox();
  const created = await createHarness(box, options);
  return {
    ...created,
    close: async () => {
      await created.close();
      box.dispose();
    },
  };
}
