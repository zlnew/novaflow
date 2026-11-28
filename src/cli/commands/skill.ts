/**
 * `novaflow skill` — install, inspect, and remove the bundled agent skill
 * (`novaflow-v100/skills`, `novaflow-v100/cli` §3.4).
 *
 * The command never needs an active workspace: it only touches the canonical
 * store (`${XDG_AGENTS_HOME:-~/.agents}/skills/novaflow`, or `<dir>/.agents/...`
 * with `--local`) and the harness directories that already exist. All work is
 * delegated to `src/skills/`, so this file is only wiring plus rendering.
 */
import { resolveSkillRoot } from '../../skills/root.js';
import { installSkill, skillStatus, uninstallSkill, type TargetReport } from '../../skills/installer.js';
import { VERSION } from '../version.js';
import { table } from '../format.js';
import type { CommandModule, NextAction, VerbSpec } from '../types.js';

const AGENT_FLAG = {
  name: 'agent',
  kind: 'string',
  placeholder: '<auto|list>',
  description: 'Target harnesses (default: auto-detect)',
} as const;

const LOCAL_FLAG = {
  name: 'local',
  kind: 'optional-string',
  placeholder: '[dir]',
  description: 'Use <dir>/.agents/skills instead of ~/.agents/skills',
} as const;

function installNextActions(): NextAction[] {
  return [
    { command: 'novaflow skill status', description: 'Verify the canonical install and harness links' },
    { command: 'novaflow task next --json', description: 'Query the next ready task with the installed skill' },
  ];
}

function targetRows(targets: readonly TargetReport[]): string {
  return table(
    ['harness', 'state', 'path'],
    targets.map((target) => [target.harness, target.state, target.path]),
  );
}

const installVerb: VerbSpec = {
  verb: 'install',
  command: 'skill.install',
  summary: 'Install the canonical skill and link it into detected harnesses',
  usage: 'novaflow skill install [--agent auto|<list>] [--local [dir]] [--copy] [--force] [--dry-run]',
  positionals: [],
  flags: [
    AGENT_FLAG,
    LOCAL_FLAG,
    { name: 'copy', kind: 'boolean', description: 'Copy instead of symlinking' },
    { name: 'force', kind: 'boolean', description: 'Replace an unmanaged skill directory' },
  ],
  examples: [
    'novaflow skill install',
    'novaflow skill install --agent pi,claude --copy',
    'novaflow skill install --local --dry-run',
  ],
  run: (ctx) => {
    const root = resolveSkillRoot({ local: ctx.args.get('local'), env: ctx.env, cwd: ctx.cwd });
    const report = installSkill({
      root,
      agent: ctx.args.get('agent'),
      copy: ctx.args.has('copy'),
      force: ctx.args.has('force'),
      dryRun: ctx.options.dryRun,
      now: ctx.now,
    });

    const summary = [
      `${report.dry_run ? 'Dry run: would write' : report.canonical.changed ? 'wrote' : 'kept'} canonical ${report.canonical.path} (version ${report.version})`,
      '',
      targetRows(report.targets),
    ].join('\n');

    return {
      data: report,
      human: `${summary}${report.changed ? '' : '\nAlready up to date.\n'}`,
      quiet: `${[report.canonical.path, ...report.targets.map((target) => target.path)].join('\n')}\n`,
      next_actions: installNextActions(),
    };
  },
};

const statusVerb: VerbSpec = {
  verb: 'status',
  command: 'skill.status',
  summary: 'Report canonical install state and per-harness link health',
  usage: 'novaflow skill status [--local [dir]]',
  positionals: [],
  flags: [LOCAL_FLAG],
  examples: ['novaflow skill status', 'novaflow skill status --json', 'novaflow skill status --local'],
  run: (ctx) => {
    const root = resolveSkillRoot({ local: ctx.args.get('local'), env: ctx.env, cwd: ctx.cwd });
    const report = skillStatus({ root, version: VERSION });
    const drift = report.targets.some((target) => target.state !== 'linked' && target.state !== 'copied');

    const human = [
      `canonical: ${report.canonical.installed ? 'installed' : 'missing'} (${report.canonical.path})`,
      `version: ${report.canonical.version ?? '-'} / cli ${report.cli_version}${report.canonical.version_match ? ' (match)' : ' (mismatch)'}`,
      '',
      table(
        ['harness', 'state', 'path'],
        report.targets.map((target) => [target.harness, target.state, target.path]),
      ),
    ].join('\n');

    return {
      data: report,
      human,
      quiet: `${report.targets.map((target) => `${target.harness}:${target.state}`).join('\n')}\n`,
      next_actions: drift
        ? [{ command: 'novaflow skill install', description: 'Link the missing or stale harness skills' }]
        : [],
    };
  },
};

const uninstallVerb: VerbSpec = {
  verb: 'uninstall',
  command: 'skill.uninstall',
  summary: 'Remove the skill from canon and every target harness',
  usage: 'novaflow skill uninstall [--agent auto|<list>] [--local [dir]] [--force] [--dry-run]',
  positionals: [],
  flags: [AGENT_FLAG, LOCAL_FLAG, { name: 'force', kind: 'boolean', description: 'Remove unmanaged skill directories too' }],
  examples: ['novaflow skill uninstall', 'novaflow skill uninstall --agent auto --dry-run'],
  run: (ctx) => {
    const root = resolveSkillRoot({ local: ctx.args.get('local'), env: ctx.env, cwd: ctx.cwd });
    const report = uninstallSkill({
      root,
      agent: ctx.args.get('agent'),
      force: ctx.args.has('force'),
      dryRun: ctx.options.dryRun,
    });

    const human = [
      `${report.dry_run ? 'Dry run: would remove' : report.canonical.removed ? 'removed' : 'kept'} canonical ${report.canonical.path}`,
      '',
      table(
        ['harness', 'state', 'removed', 'path'],
        report.targets.map((target) => [target.harness, target.state, target.removed ? 'yes' : 'no', target.path]),
      ),
    ].join('\n');

    return {
      data: report,
      human,
      quiet: `${report.targets
        .filter((target) => target.removed)
        .map((target) => target.path)
        .join('\n')}\n`,
      next_actions: [{ command: 'novaflow skill install', description: 'Reinstall the bundled skill' }],
    };
  },
};

export const skillModule: CommandModule = {
  name: 'skill',
  summary: 'Install and inspect the bundled NovaFlow agent skill.',
  verbs: [installVerb, statusVerb, uninstallVerb],
};
