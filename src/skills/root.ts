/**
 * Install-root resolution (`novaflow-v100/skills` §2.1).
 *
 * Two roots exist: the global one under `${XDG_AGENTS_HOME:-~/.agents}` and a
 * project-local one under `<dir>/.agents`. Both are pure functions of the
 * environment map plus the caller's cwd, so `--dry-run`, `status`, and
 * `uninstall` always agree with `install` about where the skill lives.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../store/registry.js';

export interface SkillRoot {
  kind: 'global' | 'local';
  /** `.agents` directory that holds `skills/novaflow`. */
  agentsHome: string;
  /** Canonical skill directory; always a real directory, never a link. */
  canonical: string;
  /** Base directory harness config dirs are derived from (`~` or the project dir). */
  home: string;
  /** XDG config base used by the `opencode` harness. */
  configHome: string;
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function userHome(env: Env): string {
  return present(env.HOME) ? env.HOME : homedir();
}

/**
 * Nearest ancestor holding `.git` or `.novaflow/`, else the start directory.
 * Used when `--local` is given without a directory.
 */
export function findProjectRoot(start: string, maxLevels = 32): string {
  let current = resolve(start);
  for (let level = 0; level < maxLevels; level += 1) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, '.novaflow'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

/**
 * Resolves the install root.
 *
 * `local` is `undefined` for a global install, `''` for `--local` without a
 * directory (nearest git/workspace root), and a path otherwise.
 */
export function resolveSkillRoot(options: { local: string | undefined; env: Env; cwd: string }): SkillRoot {
  if (options.local === undefined) {
    const home = userHome(options.env);
    const configHome = present(options.env.XDG_CONFIG_HOME) ? options.env.XDG_CONFIG_HOME : join(home, '.config');
    const agentsHome = present(options.env.XDG_AGENTS_HOME) ? options.env.XDG_AGENTS_HOME : join(home, '.agents');
    const canonical = present(options.env.NOVAFLOW_SKILL_HOME)
      ? resolve(options.env.NOVAFLOW_SKILL_HOME)
      : join(agentsHome, 'skills', 'novaflow');
    return { kind: 'global', agentsHome: dirname(dirname(canonical)), canonical, home, configHome };
  }

  const dir = options.local === '' ? findProjectRoot(options.cwd) : resolve(options.cwd, options.local);
  const agentsHome = join(dir, '.agents');
  return {
    kind: 'local',
    agentsHome,
    canonical: join(agentsHome, 'skills', 'novaflow'),
    home: dir,
    configHome: join(dir, '.config'),
  };
}
