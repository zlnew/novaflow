/**
 * `novaflow skill` — install/status/uninstall the bundled agent skill
 * (`novaflow-v100/skills`).
 *
 * P3 owns the dispatch only; the installer lands in P4b. The flags documented in
 * `novaflow-v100/cli` §3.4 are already accepted so the surface does not change
 * when the implementation arrives.
 */
import type { CommandModule, VerbSpec } from '../types.js';
import { notImplemented } from './not-implemented.js';

function stub(command: string, summary: string, usage: string, flags: VerbSpec['flags'], examples: string[]): VerbSpec {
  return {
    verb: command.slice('skill.'.length),
    command,
    summary: `${summary} (wired in P4b)`,
    usage,
    positionals: [],
    flags,
    examples,
    run: () => {
      throw notImplemented('skill', 'P4b', 'novaflow-v100/skills');
    },
  };
}

const installVerb = stub(
  'skill.install',
  'Install the canonical skill and link it into detected harnesses',
  'novaflow skill install [--agent auto|<list>] [--copy] [--force]',
  [
    { name: 'agent', kind: 'string', placeholder: '<auto|list>', description: 'Target harnesses (default: auto-detect)' },
    { name: 'local', kind: 'string', placeholder: '[dir]', description: 'Install into <dir>/.agents/skills instead of ~/.agents/skills' },
    { name: 'copy', kind: 'boolean', description: 'Copy instead of symlinking' },
    { name: 'force', kind: 'boolean', description: 'Overwrite an unmanaged skill directory' },
  ],
  ['novaflow skill install', 'novaflow skill install --agent pi,claude --copy'],
);

const statusVerb = stub(
  'skill.status',
  'Report canonical install state and per-harness link health',
  'novaflow skill status [--local [dir]]',
  [{ name: 'local', kind: 'string', placeholder: '[dir]', description: 'Inspect a local install root' }],
  ['novaflow skill status'],
);

const uninstallVerb = stub(
  'skill.uninstall',
  'Remove the skill from canon and every target harness',
  'novaflow skill uninstall [--agent auto|<list>] [--local [dir]]',
  [
    { name: 'agent', kind: 'string', placeholder: '<auto|list>', description: 'Target harnesses (default: auto-detect)' },
    { name: 'local', kind: 'string', placeholder: '[dir]', description: 'Remove from a local install root' },
  ],
  ['novaflow skill uninstall'],
);

export const skillModule: CommandModule = {
  name: 'skill',
  summary: 'Install and inspect the bundled NovaFlow agent skill.',
  verbs: [installVerb, statusVerb, uninstallVerb],
};
