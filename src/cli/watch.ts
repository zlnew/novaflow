import { daemonRequest } from "./client.ts";

/**
 * The shared live-follow helpers for `nova task status --watch`,
 * `nova task logs --follow` and `nova chain status --watch`
 * (novaflow-v02/watch.md, frozen 2026-11-23).
 *
 * ONE formatter, ONE drain loop, ONE interval policy: the two `--watch`
 * verbs must not drift into two spellings of the same line, and the drain
 * loop is the only place that advances a cursor.
 *
 * NO PUSH, NO SERVER SESSION: a follow is a session-local convenience
 * (watch.md non-goals) — no subscription, no listener, no file watching — so
 * the cursor lives in THIS process and every poll is an ordinary socket op.
 */

/** One row of `nova_transitions_since` (events.md's public projection). */
export type TransitionRow = {
  cursor: number;
  task_id: string;
  run_id: string | null;
  chain_run_id: string | null;
  task_key: string;
  chain_slug: string | null;
  from_state: string;
  to_state: string;
  trigger_type: string;
  actor: string;
  reason: string | null;
  created_at: string;
};

export type TransitionPage = {
  transitions: TransitionRow[];
  next_cursor: number;
  has_more: boolean;
};

/**
 * The CLI's task-terminal test, unchanged from v1's `--watch`: `failed` ends
 * a watch here even though the retry evaluator may later re-queue it (the
 * shipped behaviour the srs 4.1.1 exit table describes, pinned by
 * test/cli/integration.test.ts).
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** The v1 poll interval: 1000 ms, `NOVAFLOW_WATCH_MS` for tests/operators. */
export function pollIntervalMs(): number {
  return Number(process.env["NOVAFLOW_WATCH_MS"] ?? 1000);
}

/** watch.md's pinned interval for `--follow`: FIXED 1 s, not a backoff. */
export const FOLLOW_INTERVAL_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The pinned transition line (watch.md "Formatting discipline"), one line,
 * human-greppable:
 *
 *   `12:06:54 UTC WC2 queued→running (engine, daemon-dispatch) run=01M81…`
 *
 * The clock is the transition's OWN `created_at` (the store's UTC format), not
 * the reader's wall clock: a line printed late still carries the time the edge
 * actually happened. The zone is LABELLED (`UTC`) rather than left implicit:
 * an unlabelled `HH:MM:SS` on a UTC+7 box invites a manual conversion (DEBT-012),
 * and keeping the stamp in UTC stays machine-friendly and unambiguous. Both
 * `--watch` verbs (task and chain) print through THIS function, so the label
 * cannot exist on one surface and not the other. `run=-` when the row names no
 * run (an engine envelope move like draft→queued has none).
 */
export function formatTransitionLine(row: TransitionRow): string {
  return `${formatTransitionClock(row.created_at)} ${row.task_key} ${row.from_state}→${row.to_state} (${row.trigger_type}, ${row.actor}) run=${row.run_id ?? "-"}`;
}

/**
 * `HH:MM:SS UTC` from a row's `created_at` (`YYYY-MM-DDTHH:MM:SS.sssZ`). ONE
 * spelling of the clock and its zone label for every live surface that shows a
 * transition stamp — the `--watch` line above and the tier-C panel below — so
 * the label is never re-typed (DEBT-012: one format, one label, one place).
 */
export function formatTransitionClock(createdAt: string): string {
  return `${createdAt.slice(11, 19)} UTC`;
}

/**
 * Poll `nova_transitions_since` from `cursor` and print every available row,
 * returning the advanced cursor. `--json` emits the raw rows instead of the
 * formatted lines (watch.md). Pages are drained immediately while
 * `has_more`, so a burst is never printed a second late, and the loop is
 * bounded twice: `next_cursor` advances strictly on every page that carries
 * rows (events.md rule 3), and a cursor that fails to advance ends the drain
 * rather than spinning.
 */
export async function drainTransitions(
  cursor: number,
  scope: Record<string, unknown>,
  json: boolean,
): Promise<number> {
  let at = cursor;
  for (;;) {
    const page = (await daemonRequest("nova_transitions_since", {
      cursor: at,
      ...scope,
    })) as TransitionPage;
    for (const row of page.transitions) {
      if (json) console.log(JSON.stringify(row));
      else console.log(formatTransitionLine(row));
    }
    if (!page.has_more) return page.next_cursor;
    if (page.next_cursor <= at) return page.next_cursor;
    at = page.next_cursor;
  }
}
