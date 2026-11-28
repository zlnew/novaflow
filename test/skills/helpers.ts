import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cliBox, type CliBox } from '../cli/helpers.js';

/** Harness ids from `novaflow-v100/skills` §2.2, canonical store included. */
export const HARNESS_IDS = ['claude', 'codex', 'hermes', 'pi', 'opencode', 'cursor'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** Installer marker file written inside every managed skill directory. */
export const MARKER = '.novaflow-managed.json';

export interface SkillPaths {
  /** `<home>/.agents`, the global canonical root. */
  agentsHome: string;
  /** `<home>/.agents/skills/novaflow`. */
  canonical: string;
  /** Target skill path for one harness, inside the fake home. */
  harness(id: HarnessId): string;
  /** Parent config directory an auto-detect run must find, e.g. `~/.claude`. */
  configDir(id: HarnessId): string;
}

export interface SkillBox extends CliBox {
  paths: SkillPaths;
  /** Creates a harness config directory so auto-detection sees that tool. */
  seed(id: HarnessId): void;
  /** Prints `state` of a canonical or harness skill path. */
  state(path: string): 'missing' | 'symlink' | 'dir' | 'file';
  marker(path: string): { package: string; version: string; installed_at: string } | null;
}

/**
 * Isolated skill sandbox. Every path lives under the `cliBox` temp root, so no
 * test can reach the real `~/.agents`, `~/.claude`, `~/.pi`, or `~/.config`
 * (`novaflow-v100/testing` §1).
 */
export function skillBox(options: { env?: Record<string, string> } = {}): SkillBox {
  const box = cliBox();
  const home = box.box.home;
  const xdg = box.box.xdg;

  const paths: SkillPaths = {
    agentsHome: join(home, '.agents'),
    canonical: join(home, '.agents', 'skills', 'novaflow'),
    configDir: (id) => {
      switch (id) {
        case 'claude':
          return join(home, '.claude');
        case 'codex':
          return join(home, '.codex');
        case 'hermes':
          return join(home, '.hermes');
        case 'pi':
          return join(home, '.pi', 'agent');
        case 'opencode':
          return join(xdg, 'opencode');
        case 'cursor':
          return join(home, '.cursor');
      }
    },
    harness: (id) => join(paths.configDir(id), 'skills', 'novaflow'),
  };

  const state: SkillBox['state'] = (path) => {
    if (!existsSync(path)) return 'missing';
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'symlink';
    return stats.isDirectory() ? 'dir' : 'file';
  };

  return {
    ...box,
    paths,
    run: (args, runOptions) => box.run(args, { ...runOptions, env: { ...(options.env ?? {}), ...(runOptions?.env ?? {}) } }),
    json: (args, runOptions) => box.json(args, { ...runOptions, env: { ...(options.env ?? {}), ...(runOptions?.env ?? {}) } }),
    jsonError: (args, runOptions) =>
      box.jsonError(args, { ...runOptions, env: { ...(options.env ?? {}), ...(runOptions?.env ?? {}) } }),
    seed: (id) => {
      mkdirSync(paths.configDir(id), { recursive: true });
    },
    state,
    marker: (path) => {
      const file = join(path, MARKER);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as { package: string; version: string; installed_at: string };
    },
  };
}

/** Writes a user-authored (unmanaged) skill directory. */
export function seedUnmanaged(dir: string, body = '# hand written skill\n'): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
  return dir;
}

/** Writes a managed marker with an arbitrary version, for `stale` fixtures. */
export function seedMarker(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, MARKER),
    `${JSON.stringify({ package: 'novaflow', version, installed_at: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
}

/** Creates `<root>/.git` so git-root discovery has something to find. */
export function seedGitRoot(root: string): string {
  const dir = join(root, '.git');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return root;
}

/** Asserts every written path stays inside the sandbox root. */
export function assertInside(root: string, target: string): void {
  const base = resolve(root);
  const path = resolve(target);
  assert.ok(path === base || path.startsWith(`${base}/`), `${path} escapes sandbox ${base}`);
}

/** `dirname` re-export so tests do not import `node:path` twice. */
export const parentOf = dirname;
