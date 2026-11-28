/**
 * Harness detection matrix (`novaflow-v100/skills` §2.2).
 *
 * The canonical store is always active; every other harness is optional and is
 * only touched when its parent config directory already exists (auto mode) or
 * the operator names it explicitly. That is what keeps `skill install` from
 * littering a home directory with folders for tools nobody uses.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validationError } from '../core/errors.js';
import type { SkillRoot } from './root.js';

/** Harness ids accepted by `--agent`, canonical store included. */
export const HARNESS_IDS = ['agents', 'claude', 'codex', 'hermes', 'pi', 'opencode', 'cursor'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** Harnesses that receive a link/copy of the canonical store. */
export const LINK_HARNESS_IDS = ['claude', 'codex', 'hermes', 'pi', 'opencode', 'cursor'] as const;

export type LinkHarnessId = (typeof LINK_HARNESS_IDS)[number];

/** Where one harness keeps its skills, derived from the install root. */
export interface HarnessLayout {
  /** Parent config directory; its existence is the auto-detect signal. */
  configDir: string;
  /** `<configDir>/skills/novaflow`, the path the installer owns. */
  skillDir: string;
}

export function layoutFor(id: HarnessId, root: SkillRoot): HarnessLayout {
  const mk = (configDir: string): HarnessLayout => ({ configDir, skillDir: join(configDir, 'skills', 'novaflow') });
  switch (id) {
    case 'agents':
      return { configDir: root.agentsHome, skillDir: root.canonical };
    case 'claude':
      return mk(join(root.home, '.claude'));
    case 'codex':
      return mk(join(root.home, '.codex'));
    case 'hermes':
      return mk(join(root.home, '.hermes'));
    case 'pi':
      return mk(join(root.home, '.pi', 'agent'));
    case 'opencode':
      return mk(join(root.configHome, 'opencode'));
    case 'cursor':
      return mk(join(root.home, '.cursor'));
  }
}

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/** Parses one `--agent` value into harness ids, rejecting unknown names exit 2. */
export function parseAgentList(value: string): HarnessId[] {
  const ids: HarnessId[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (name === 'auto') return [];
    if (!isHarnessId(name)) {
      throw validationError(
        `Unknown agent harness "${name}".`,
        `Use --agent auto or a comma-separated subset of: ${HARNESS_IDS.join(', ')}.`,
      );
    }
    if (!ids.includes(name)) ids.push(name);
  }
  return ids;
}

/** Auto detection: only harnesses whose parent config directory already exists. */
export function detectHarnesses(root: SkillRoot): LinkHarnessId[] {
  return LINK_HARNESS_IDS.filter((id) => existsSync(layoutFor(id, root).configDir));
}

export interface SelectedHarnesses {
  /** Harnesses the caller asked for or auto-detection found. */
  ids: LinkHarnessId[];
  /** True when `--agent` named them, so missing config dirs may be created. */
  explicit: boolean;
}

/**
 * Resolves `--agent` into concrete harness ids. `--agent auto` (and no flag)
 * only reports present harnesses; an explicit list is taken literally.
 */
export function selectHarnesses(root: SkillRoot, agent: string | undefined): SelectedHarnesses {
  const wanted = agent === undefined ? [] : parseAgentList(agent);
  if (wanted.length === 0) return { ids: detectHarnesses(root), explicit: false };
  return { ids: wanted.filter((id): id is LinkHarnessId => id !== 'agents'), explicit: true };
}
