/**
 * `novaflow status` — compact board summary (`novaflow-v100/cli` §3.5).
 *
 * The `--json` payload shape is pinned: `{ workspace, counts, in_progress,
 * ready, blocked, recent_events }`, with `counts` holding exactly the seven
 * documented buckets (no internal `total`).
 */
import { getOverviewStatus } from '../../core/workspace.js';
import { bucket, countsLine } from '../format.js';
import { identifiers } from '../output.js';
import { afterStatus } from '../next-actions.js';
import type { CommandModule, VerbSpec } from '../types.js';

const statusVerb: VerbSpec = {
  verb: null,
  command: 'status',
  summary: 'Compact board summary: counts, in-progress, ready, blocked, recent events',
  usage: 'novaflow status [--project <p>]',
  positionals: [],
  flags: [],
  examples: ['novaflow status', 'novaflow status --project novaflow-v3 --json'],
  run: (ctx) => {
    const result = getOverviewStatus({
      workspace: ctx.options.workspace ?? null,
      project: ctx.options.project ?? null,
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
    });

    const counts = bucket(result.counts);
    const data = {
      workspace: result.workspace,
      counts,
      in_progress: result.in_progress,
      ready: result.ready,
      blocked: result.blocked,
      recent_events: result.recent_events,
    };

    const lines: string[] = [];
    lines.push(`workspace: ${result.workspace.name} (${result.workspace.root})`);
    if (result.project !== null) lines.push(`project: ${result.project.slug} (${result.project.prefix})`);
    lines.push(`counts: ${countsLine(counts)}`);
    const section = (label: string, tasks: readonly { key: string; title: string; status: string }[]): void => {
      lines.push(`${label}: ${tasks.length === 0 ? '-' : tasks.map((task) => `${task.key} [${task.status}] ${task.title}`).join(' | ')}`);
    };
    section('in_progress', result.in_progress);
    section('ready', result.ready);
    section('blocked', result.blocked);
    lines.push(`recent_events: ${result.recent_events.length}`);

    return {
      data,
      human: `${lines.join('\n')}\n`,
      quiet: identifiers([]),
      next_actions: afterStatus(),
    };
  },
};

export const statusModule: CommandModule = {
  name: 'status',
  summary: 'Board summary for the resolved workspace (or one project).',
  verbs: [statusVerb],
};
