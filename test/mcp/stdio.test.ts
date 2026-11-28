/**
 * Real stdio subprocess test (`novaflow-v100/mcp` §3 stdout safety,
 * `novaflow-v100/testing` §2 "MCP Parity").
 *
 * Spawns `node bin/novaflow mcp` exactly as an orchestrator would, speaks
 * newline-delimited JSON-RPC on the pipes, and asserts that `stdout` carries
 * nothing but JSON-RPC frames and that the process exits cleanly on stdin EOF.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { BIN, ensureBuild } from '../cli/helpers.js';
import { sandbox, type Sandbox } from '../store/helpers.js';
import { TOOL_NAMES } from './helpers.js';

const TIMEOUT_MS = 20_000;

let box: Sandbox;
let root: string;

function childEnv(): Record<string, string> {
  return {
    HOME: box.home,
    XDG_CONFIG_HOME: box.xdg,
    NOVAFLOW_HOME: box.env.NOVAFLOW_HOME as string,
    TZ: 'UTC',
    LANG: 'C',
    PATH: process.env.PATH ?? '',
  };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  /** Every raw stdout line, in arrival order. */
  lines: string[];
  /** Lines that were not valid JSON-RPC frames: protocol pollution. */
  noise: string[];
  stderr: string;
  request(id: number, method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startServer(args: readonly string[]): Session {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const lines: string[] = [];
  const noise: string[] = [];
  const pending = new Map<number, (message: any) => void>();
  const state = { stderr: '' };
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      lines.push(line);
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        noise.push(line);
        continue;
      }
      if (parsed?.jsonrpc !== '2.0') {
        noise.push(line);
        continue;
      }
      const waiter = typeof parsed.id === 'number' ? pending.get(parsed.id) : undefined;
      if (waiter !== undefined) {
        pending.delete(parsed.id as number);
        waiter(parsed);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    state.stderr += chunk;
  });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const request: Session['request'] = (id, method, params) =>
    withTimeout(
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
      }),
      `response ${id} (${method})`,
    );

  const notify: Session['notify'] = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  };

  return {
    child,
    lines,
    noise,
    get stderr() {
      return state.stderr;
    },
    request,
    notify,
    closed,
  };
}

before(() => {
  ensureBuild();
  box = sandbox();
  const dir = box.mkdir('ws', 'stdio');
  const created = spawnSync(
    process.execPath,
    [BIN, 'workspace', 'create', '--name', 'stdio', '--path', dir, '--json'],
    { env: childEnv(), cwd: box.cwd, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(created.status, 0, `workspace create failed: ${created.stderr}`);
  root = JSON.parse(created.stdout.trim()).data.workspace.root;
});

after(() => {
  box.dispose();
});

describe('novaflow mcp over stdio', () => {
  it('serves initialize, tools/list, tools/call and exits cleanly on EOF', async () => {
    const session = startServer(['mcp', '--workspace', root]);

    const init = await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'novaflow-stdio-test', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'novaflow');
    assert.equal(typeof init.result.serverInfo.version, 'string');
    assert.ok(init.result.capabilities.tools, 'the server advertises the tools capability');

    session.notify('notifications/initialized');

    const listed = await session.request(2, 'tools/list', {});
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );

    const ok = await session.request(3, 'tools/call', {
      name: 'novaflow_status',
      arguments: { workspace: root },
    });
    assert.equal(ok.result.isError, false);
    const payload = JSON.parse(ok.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.workspace.root, root);
    assert.ok(Array.isArray(payload.next_actions));

    const failed = await session.request(4, 'tools/call', {
      name: 'novaflow_task_status',
      arguments: { workspace: root, id: 'NOPE-1' },
    });
    assert.equal(failed.result.isError, true);
    const failure = JSON.parse(failed.result.content[0].text);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'NOT_FOUND');

    const exited = session.closed;
    session.child.stdin.end();
    const exit = await withTimeout(exited, 'process exit after EOF');

    assert.equal(exit.code, 0, `expected a clean exit, got code ${String(exit.code)} signal ${String(exit.signal)}`);
    assert.equal(exit.signal, null);
    assert.deepEqual(session.noise, [], 'stdout carried something that is not a JSON-RPC frame');
    assert.equal(session.stderr, '', 'diagnostics must not leak onto the wire');
    assert.ok(session.lines.length >= 4);
  });

  it('resolves the workspace from --workspace without the per-call param', async () => {
    const session = startServer(['mcp', '-w', 'stdio']);
    await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'novaflow-stdio-test', version: '1.0.0' },
    });
    const call = await session.request(2, 'tools/call', {
      name: 'novaflow_workspace_show',
      arguments: {},
    });
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.root, root);

    const exited = session.closed;
    session.child.stdin.end();
    assert.equal((await withTimeout(exited, 'process exit after EOF')).code, 0);
    assert.deepEqual(session.noise, []);
  });

  it('keeps stdout clean when the CLI is invoked with --json', async () => {
    const session = startServer(['mcp', '--workspace', root, '--json']);
    await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'novaflow-stdio-test', version: '1.0.0' },
    });
    const listed = await session.request(2, 'tools/list', {});
    assert.equal(listed.result.tools.length, 30);

    const exited = session.closed;
    session.child.stdin.end();
    assert.equal((await withTimeout(exited, 'process exit after EOF')).code, 0);
    assert.deepEqual(session.noise, []);
    for (const line of session.lines) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      assert.equal('command' in (message.result ?? {}), false, 'no CLI envelope may be written to stdout');
    }
  });
});
