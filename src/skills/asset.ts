/**
 * Locating the bundled skill package (`novaflow-v100/skills` §1).
 *
 * The skill ships inside the npm package at `skills/novaflow/`, one level above
 * `package.json`. Resolving it from `import.meta.url` instead of `cwd` means the
 * same code finds the asset from `src/skills/` under `tsx`, from
 * `dist/skills/` after a build, and from a global npm install — the caller's
 * working directory never matters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VERSION } from '../cli/version.js';
import { NovaError } from '../store/errors.js';

/** Files the installer copies from the package into a canonical store. */
export const SKILL_ENTRY = 'SKILL.md';
/** Optional deep reference directory, copied only when present. */
export const SKILL_REFERENCES = 'references';

/**
 * Absolute path of `skills/novaflow/` next to the package root.
 *
 * `src/skills/asset.ts` and `dist/skills/asset.js` are both two levels below the
 * package root, so `../../skills/novaflow` resolves in dev and in production.
 */
export function bundledSkillDir(): string {
  return fileURLToPath(new URL('../../skills/novaflow/', import.meta.url)).replace(/\/$/, '');
}

/** Version the bundled skill advertises; always the CLI version (`skills.md` §1.1). */
export function bundledSkillVersion(): string {
  return VERSION;
}

/** Fails loudly (exit 1) when a tampered or partially installed package lacks the asset. */
export function requireBundledSkill(): { dir: string; version: string } {
  const dir = bundledSkillDir();
  if (!existsSync(join(dir, SKILL_ENTRY))) {
    throw new NovaError('INTERNAL_ERROR', `Bundled skill asset is missing: ${join(dir, SKILL_ENTRY)}`, {
      hint: 'Reinstall the novaflow package; "skills/" is shipped with it.',
    });
  }
  return { dir, version: bundledSkillVersion() };
}

/** Reads the bundled `SKILL.md` (used by tests and by `skill status` sanity checks). */
export function readBundledSkill(): string {
  const { dir } = requireBundledSkill();
  return readFileSync(join(dir, SKILL_ENTRY), 'utf8');
}
