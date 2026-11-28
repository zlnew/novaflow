import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, type Sandbox } from '../store/helpers.js';

/** Repository root of the checkout under test. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Live package version read from `package.json`. */
export const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
/** The published entry point (`novaflow-v100/cli` §1). */
export const BIN = join(REPO_ROOT, 'bin', 'novaflow');
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

/** Compiles once if `dist/` is missing, so `npm test` alone is still meaningful. */
export function ensureBuild(): void {
  if (existsSync(DIST_ENTRY)) return;
  execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO_ROOT, 'tsconfig.json')],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NextAction {
  command: string;
  description: string;
}

export interface SuccessEnvelope {
  ok: true;
  command: string;
  data: any;
  next_actions: NextAction[];
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: { code: string; message: string; hint?: string };
}

export interface CliBox {
  readonly box: Sandbox;
  /** Working directory for commands that do not pass one. */
  readonly cwd: string;
  run(args: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): CliResult;
  /** Runs with `--json`, asserting a clean success envelope on `stdout`. */
  json(args: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): SuccessEnvelope;
  /** Runs with `--json`, asserting a clean error envelope on `stderr`. */
  jsonError(args: readonly string[], options?: { cwd?: string; env?: Record<string, string> }): ErrorEnvelope['error'];
  dispose(): void;
}

/**
 * Isolated CLI sandbox: fresh `mkdtemp` root, fake `NOVAFLOW_HOME`,
 * `XDG_CONFIG_HOME`, and `HOME`, and `stdin` always ignored so a prompt would
 * hang or fail the test instead of silently succeeding (`novaflow-v100/testing` §1).
 */
export function cliBox(): CliBox {
  ensureBuild();
  const box = sandbox();
  const baseEnv: Record<string, string> = {
    HOME: box.home,
    XDG_CONFIG_HOME: box.xdg,
    NOVAFLOW_HOME: box.env.NOVAFLOW_HOME as string,
    TZ: 'UTC',
    LANG: 'C',
  };
  if (process.env.PATH !== undefined) baseEnv.PATH = process.env.PATH;

  const run: CliBox['run'] = (args, options = {}) => {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? box.cwd,
      env: { ...baseEnv, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    return {
      code: result.status === null ? -1 : result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };

  const json: CliBox['json'] = (args, options) => {
    const result = run([...args, '--json'], options);
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}${result.stdout}`);
    assert.equal(result.stderr, '', `expected empty stderr, got: ${result.stderr}`);
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(result.stdout)}`);
    const envelope = JSON.parse(lines[0] as string) as SuccessEnvelope;
    assert.equal(envelope.ok, true);
    assert.equal(typeof envelope.command, 'string');
    assert.ok(Array.isArray(envelope.next_actions), 'next_actions must always be an array');
    return envelope;
  };

  const jsonError: CliBox['jsonError'] = (args, options) => {
    const result = run([...args, '--json'], options);
    assert.notEqual(result.code, 0, 'expected a failing exit code');
    assert.equal(result.stdout, '', `expected empty stdout on error, got: ${result.stdout}`);
    const lines = result.stderr.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(result.stderr)}`);
    const envelope = JSON.parse(lines[0] as string) as ErrorEnvelope;
    assert.equal(envelope.ok, false);
    assert.equal(typeof envelope.command, 'string');
    return envelope.error;
  };

  return { box, cwd: box.cwd, run, json, jsonError, dispose: () => box.dispose() };
}

/** Creates a workspace through the CLI and returns its root path. */
export function createWorkspace(box: CliBox, name: string, options: { cwd?: string } = {}): { root: string; name: string } {
  const root = box.box.mkdir('ws', name);
  const envelope = box.json(['workspace', 'create', '--name', name, '--path', root], options);
  return { root: envelope.data.workspace.root as string, name };
}

/** Creates a project inside a workspace through the CLI. */
export function createProject(
  box: CliBox,
  workspace: { root: string },
  title: string,
  extra: readonly string[] = [],
): { slug: string; prefix: string; id: string } {
  const envelope = box.json(['project', 'create', '--title', title, '-w', workspace.root, ...extra]);
  return envelope.data.project as { slug: string; prefix: string; id: string };
}

/** Creates a task inside a project through the CLI. */
export function createTask(
  box: CliBox,
  workspace: { root: string },
  project: { slug: string },
  title: string,
  extra: readonly string[] = [],
): any {
  const envelope = box.json(['task', 'create', '--title', title, '-w', workspace.root, '-p', project.slug, ...extra]);
  return envelope.data.task;
}
