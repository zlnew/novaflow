/**
 * `novaflow events [list]` — the immutable audit log (`novaflow-v100/cli` §3.5).
 *
 * `events` and `events list` are the same query. `--after-seq` is the polling
 * cursor: `next_after_seq` in the payload is the value to pass next.
 */
import { listEvents, type EventView } from '../../core/events.js';
import { resolveProjectRef } from '../../core/project.js';
import { resolveTaskRow } from '../../core/task.js';
import { withWorkspace } from '../context.js';
import { orDash, table } from '../format.js';
import { identifiers } from '../output.js';
import { afterEvents } from '../next-actions.js';
import type { CommandModule, VerbSpec } from '../types.js';

const COLUMNS = ['SEQ', 'CREATED_AT', 'EVENT', 'ENTITY', 'ACTOR', 'FROM', 'TO'] as const;

function rows(events: readonly EventView[]): string[][] {
  return events.map((event) => [
    String(event.seq),
    event.created_at,
    event.event_type,
    `${event.entity_type}:${event.entity_key}`,
    orDash(event.actor),
    orDash(event.from_state),
    orDash(event.to_state),
  ]);
}

const listVerb: VerbSpec = {
  verb: 'list',
  command: 'events.list',
  summary: 'Query the audit log in chronological order',
  usage: 'novaflow events [list] [--project <p>] [--task <ID>] [--since <iso|dur>] [--after-seq <n>] [--limit <n>]',
  positionals: [],
  flags: [
    { name: 'task', kind: 'string', placeholder: '<ID>', description: 'Restrict to one task (key, slug, or ULID)' },
    {
      name: 'since',
      kind: 'string',
      placeholder: '<iso|dur>',
      description: 'Only events at or after this ISO-8601 timestamp or relative duration (30m, 2h, 7d)',
    },
    { name: 'after-seq', kind: 'int', min: 0, placeholder: '<n>', description: 'Cursor: only events with seq > n' },
    { name: 'limit', kind: 'int', min: 1, placeholder: '<n>', description: 'Maximum events returned (default 100)' },
  ],
  examples: [
    'novaflow events --limit 20',
    'novaflow events list --task NV3-1 --since 2h',
    'novaflow events --after-seq 42 --json',
  ],
  run: (ctx) => {
    const taskRef = ctx.args.get('task');
    const afterSeq = ctx.args.int('after-seq');

    const events = withWorkspace(ctx, (db, resolved) => {
      const project =
        ctx.options.project === undefined
          ? null
          : resolveProjectRef(db, { project: ctx.options.project, env: ctx.env, config: resolved.config });
      const taskId =
        taskRef === undefined
          ? null
          : resolveTaskRow(db, {
              id: taskRef,
              project: ctx.options.project ?? null,
              env: ctx.env,
              config: resolved.config,
            }).task.id;

      return listEvents(db, {
        task_id: taskId,
        project_id: project?.id ?? null,
        after_seq: afterSeq ?? null,
        since: ctx.args.get('since') ?? null,
        limit: ctx.args.int('limit') ?? null,
        now: ctx.now,
      });
    });

    const last = events.length === 0 ? (afterSeq ?? null) : (events[events.length - 1] as EventView).seq;
    return {
      data: { events, next_after_seq: last },
      human: events.length === 0 ? `${table(COLUMNS, [])}(no events matched)\n` : table(COLUMNS, rows(events)),
      quiet: identifiers(events.map((event) => event.id)),
      next_actions: afterEvents(last),
    };
  },
};

export const eventsModule: CommandModule = {
  name: 'events',
  summary: 'Read the immutable audit log.',
  verbs: [listVerb],
  defaultVerb: 'list',
};
