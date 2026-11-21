import { ROWS, type CanonicalState, type MatrixRow } from "../fsm/matrix.ts";
import { ESCALATE_FAILED_TRIGGER } from "../fsm/triggers.ts";
import { ABORT_TRIGGER } from "../runs/triggers.ts";

/**
 * The daemon's verbatim 8.1 trigger constants (novaflow-v1/architecture
 * 8.1). Each is extracted from src/fsm/matrix.ts ROWS with a uniqueness
 * guard — never retyped, never paraphrased (the src/runs/triggers.ts
 * pattern). Golden tests re-parse the live spec matrix and pin every
 * constant here.
 *
 * One-source rule: the failed→awaiting_gate escalation is the SAME
 * constant src/fsm/triggers.ts exports (ESCALATE_FAILED_TRIGGER);
 * re-exported here for daemon callers. The queued→running scheduler
 * row is never duplicated either — dispatch does not apply it at all,
 * startRun does (src/runs/triggers.ts START_TRIGGER).
 */

function soleTrigger(state: CanonicalState, target: CanonicalState): string {
  const rows = ROWS.filter((r) => r.state === state && r.target === target);
  if (rows.length !== 1) {
    throw new Error(
      `the 8.1 matrix must have exactly one ${state}→${target} row, found ${rows.length}`,
    );
  }
  return rows[0]!.trigger;
}

/**
 * The failed state has TWO →queued rows (auto-retry and operator
 * retry), so (state, target) alone cannot disambiguate — match on the
 * trigger prefix with a uniqueness guard on the match count.
 */
function soleTriggerWhere(
  state: CanonicalState,
  target: CanonicalState,
  prefix: string,
  describe: string,
): string {
  const rows = ROWS.filter(
    (r) => r.state === state && r.target === target && r.trigger.startsWith(prefix),
  );
  if (rows.length !== 1) {
    throw new Error(
      `the 8.1 matrix must have exactly one ${state}→${target} row whose trigger starts with "${prefix}" (${describe}), found ${rows.length}`,
    );
  }
  return rows[0]!.trigger;
}

/** failed → queued: the auto-retry timer row (daemon config retry.delay_sec). */
export const AUTO_RETRY_TRIGGER: string = soleTriggerWhere(
  "failed",
  "queued",
  "auto-retry timer expires",
  "the auto-retry row",
);

/** failed → queued: the operator retry row (CLI `task retry`). */
export const OPERATOR_RETRY_TRIGGER: string = soleTriggerWhere(
  "failed",
  "queued",
  "operator retry",
  "the operator-retry row",
);

/**
 * failed → awaiting_gate: the retry-budget escalation row — the SAME
 * constant src/fsm/triggers.ts exports (one source, re-exported).
 */
export const FAILED_ESCALATION_TRIGGER: string = ESCALATE_FAILED_TRIGGER;

/**
 * running → cancelled: the operator-abort row — the SAME constant the run
 * loop applies on an abort-classified exit (src/runs/triggers.ts, one source).
 */
export const RUNNING_ABORT_TRIGGER: string = ABORT_TRIGGER;

const ABORTABLE_STATES: readonly CanonicalState[] = [
  "queued",
  "running",
  "awaiting_gate",
  "validating",
  "changes_requested",
  "failed",
];

const ABORT_TRIGGERS: ReadonlyMap<string, string> = new Map(
  ABORTABLE_STATES.map((state) => [state, soleTrigger(state, "cancelled")]),
);

/**
 * The operator-abort row for a task's current state, or null when the
 * matrix has no abort row from it (draft/completed/cancelled are not
 * abortable — the op refuses with invalid_transition naming the state).
 */
export function abortTriggerFor(state: string): string | null {
  return ABORT_TRIGGERS.get(state) ?? null;
}

/** Exported for golden pinning: the full set of abortable states. */
export const DAEMON_ABORTABLE_STATES: readonly string[] = ABORTABLE_STATES;

/** Type re-export so daemon modules share one MatrixRow shape. */
export type { MatrixRow };
