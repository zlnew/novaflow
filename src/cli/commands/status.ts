import { parseArgs, UsageError } from "../args.ts";
import { daemonRequest, DaemonUnreachableError } from "../client.ts";
import { EXIT_OK } from "../exitcode.ts";
import { sleep } from "../procs.ts";
import type { CommandOpts } from "../opts.ts";
import type { TransitionPage, TransitionRow } from "../watch.ts";

/**
 * `nova status [--watch]` — the tier-C live screen (novaflow-v030/panel.md;
 * W4 R4.4's minimal form, which P12 extends). ONE screen, printed once:
 *
 *   daemon: running (v0.2.0, started 2026-11-23T…)
 *   scheduler: inflight 2 queued 3 paused false live WC2,WC3
 *   spend: today $0.4200 (3 runs), month $1.1000 (9 runs), prices_armed true, inert_models -
 *   transitions (last 3):
 *     12:06:54 UTC WC2 queued→running
 *
 * SOURCES ARE EXISTING OPS, NO NEW ONE (panel.md non-goals): `nova_daemon_status`
 * (scheduler + the spend block with `prices_armed`/`inert_models`) and
 * `nova_transitions_since` (the last three rows, then a CURSOR poll).
 *
 * `--watch` reprints only when the screen CHANGES: the transition cursor
 * advances `rowid > cursor` every 2 s (the panel's pinned interval,
 * NOVAFLOW_STATUS_WATCH_MS for tests), so a quiet daemon costs one socket op
 * per tick and no terminal writes — never a busy loop. Uptime is deliberately
 * NOT on the screen: a field that moves every second would reprint forever.
 */

const DEFAULT_INTERVAL_MS = 2000;
const HEAD = 3;

type DaemonStatusData = {
  version: string;
  started_at: string;
  scheduler: { paused: boolean; running: number; queued: number; liveTasks?: string[] };
  spend: {
    prices_armed: boolean;
    inert_models: string[];
    today: { cost_usd: number; runs: number };
    month: { cost_usd: number; runs: number };
  };
};

function intervalMs(): number {
  const raw = process.env["NOVAFLOW_STATUS_WATCH_MS"];
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 50) {
    throw new UsageError("NOVAFLOW_STATUS_WATCH_MS must be a number >= 50 (milliseconds)");
  }
  return ms;
}

/** `HH:MM:SS UTC KEY from→to` (the clock is the transition's own UTC stamp). */
function formatTransition(row: TransitionRow): string {
  return `${row.created_at.slice(11, 19)} UTC ${row.task_key} ${row.from_state}→${row.to_state}`;
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function renderScreen(daemon: DaemonStatusData, rows: TransitionRow[]): string {
  const scheduler = daemon.scheduler;
  const spend = daemon.spend;
  const live = scheduler.liveTasks ?? [];
  const inert = spend.inert_models.length === 0 ? "-" : spend.inert_models.join(",");
  const lines = [
    `daemon: running (v${daemon.version}, started ${daemon.started_at})`,
    `scheduler: inflight ${scheduler.running} queued ${scheduler.queued} paused ${String(scheduler.paused)}${
      live.length === 0 ? "" : ` live ${live.join(",")}`
    }`,
    `spend: today ${money(spend.today.cost_usd)} (${spend.today.runs} runs), month ${money(
      spend.month.cost_usd,
    )} (${spend.month.runs} runs), prices_armed ${String(spend.prices_armed)}, inert_models ${inert}`,
    `transitions (last ${HEAD}):`,
    ...(rows.length === 0
      ? ["  (no transitions yet)"]
      : rows.map((row) => `  ${formatTransition(row)}`)),
  ];
  return lines.join("\n");
}

function renderUnreachable(message: string, rows: TransitionRow[], interval: number): string {
  return [
    `daemon: unreachable — ${message}`,
    `scheduler: -`,
    `spend: -`,
    `transitions (last ${HEAD}):`,
    ...(rows.length === 0 ? ["  (no transitions yet)"] : rows.map((row) => `  ${formatTransition(row)}`)),
    `retrying every ${interval / 1000} s (Ctrl-C to stop)`,
  ].join("\n");
}

function renderJson(daemon: DaemonStatusData, rows: TransitionRow[]): string {
  return JSON.stringify({ daemon, transitions: rows });
}

async function snapshot(): Promise<{
  daemon: DaemonStatusData;
  rows: TransitionRow[];
  cursor: number;
}> {
  const daemon = (await daemonRequest("nova_daemon_status")) as DaemonStatusData;
  const page = (await daemonRequest("nova_transitions_since", {
    cursor: 0,
    limit: HEAD,
  })) as TransitionPage;
  return { daemon, rows: page.transitions, cursor: page.next_cursor };
}

/** Poll `rowid > cursor` (draining pages) and return the rows plus the new cursor. */
async function pollTransitions(cursor: number): Promise<{ rows: TransitionRow[]; cursor: number }> {
  let at = cursor;
  const rows: TransitionRow[] = [];
  for (;;) {
    const page = (await daemonRequest("nova_transitions_since", { cursor: at })) as TransitionPage;
    rows.push(...page.transitions);
    if (!page.has_more || page.next_cursor <= at) return { rows, cursor: page.next_cursor };
    at = page.next_cursor;
  }
}

export async function statusCommand(argv: string[], opts: CommandOpts): Promise<number> {
  const p = parseArgs(argv, {});
  if (p.positionals.length > 0) {
    throw new UsageError(`nova status takes no positional arguments (got "${p.positionals[0]}")`);
  }
  const initial = await snapshot();
  const watch = opts.watch;
  if (!watch) {
    console.log(
      opts.json ? renderJson(initial.daemon, initial.rows) : renderScreen(initial.daemon, initial.rows),
    );
    return EXIT_OK;
  }

  const interval = intervalMs();
  let rows = initial.rows;
  let cursor = initial.cursor;
  let last = opts.json
    ? renderJson(initial.daemon, initial.rows)
    : renderScreen(initial.daemon, initial.rows);
  console.log(last);

  for (;;) {
    await sleep(interval);
    let text: string;
    try {
      const page = await pollTransitions(cursor);
      cursor = page.cursor;
      if (page.rows.length > 0) rows = [...rows, ...page.rows].slice(-HEAD);
      const daemon = (await daemonRequest("nova_daemon_status")) as DaemonStatusData;
      text = opts.json ? renderJson(daemon, rows) : renderScreen(daemon, rows);
    } catch (err) {
      // a dead daemon is a screen state (keep watching); any other failure is
      // a real error and must not be dressed up as "unreachable"
      if (!(err instanceof DaemonUnreachableError)) throw err;
      text = opts.json
        ? JSON.stringify({ daemon: null, error: err.message, transitions: rows })
        : renderUnreachable(err.message, rows, interval);
    }
    if (text !== last) {
      console.log(text);
      last = text;
    }
  }
}
