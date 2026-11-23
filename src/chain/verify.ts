import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../store/db.ts";
import { getChainRun, listChainMembers } from "./import.ts";
import { latestRun, type RunRow } from "../daemon/readops.ts";
import {
  parseVerificationRecord,
  type ConfiguredVerificationEntry,
  type ExecutedVerificationEntry,
  type VerificationRecord,
} from "../verify/record.ts";

/**
 * FR-TSK-12's OPERATOR SURFACE (srs 4.1.1 + novaflow-v030 amendments row 4 —
 * DEBT-006): per chain member, over its NEWEST run, the verification
 * commands CONFIGURED at run time versus the commands the engine ACTUALLY
 * EXECUTED with their exit status. DEBT-006's whole complaint was that an
 * operator could not tell a verified run from an unchecked one; this module
 * builds that answer out of the run's OWN records only:
 *
 *   1. the verification frame in the run's REDACTED `events.jsonl`
 *      (src/verify/record.ts) — executed commands with exit status and cwd,
 *      plus the configured set as collected for that pass;
 *   2. otherwise the §4.1 artifact block's `verification_results` — the
 *      executed commands a run recorded before the frame existed (no cwd);
 *   3. otherwise, for the configured side, the `engine-context.json`
 *      snapshot the spawner wrote at run start (verification_commands).
 *
 * It NEVER reads `task_target_scopes` — the task's current config is not
 * evidence about a run that already happened (the card's Risk: "a verb that
 * prints intent rather than fact is worse than none").
 *
 * Read-only: no writes, no daemon state, no run-dir mutation. Spec-silent
 * choices (documented): a member with no run at all reports "no run yet"
 * (there is nothing to compare, and that is not an error); a pass whose
 * command set could not be collected carries the collection error as a note.
 */

export type ChainVerifyConfigured = ConfiguredVerificationEntry;
export type ChainVerifyExecuted = ExecutedVerificationEntry;

export type ChainVerifyMember = {
  task_id: string;
  key: string;
  state: string;
  /** The newest run's id, or null when the member never ran. */
  run_id: string | null;
  attempt_number: number | null;
  /** Commands configured at run time (union across the run's scopes, deduped). */
  configured: ChainVerifyConfigured[];
  /** Commands the engine recorded as executed, with their exit status. */
  executed: ChainVerifyExecuted[];
  /** Configured commands with NO executed record — the DEBT-006 alarm. */
  unexecuted: string[];
  /** Record facts an operator must see (a failed collection, a missing snapshot). */
  notes: string[];
};

export type ChainVerifyReport = {
  chain_run_id: string;
  project_id: string;
  state: string;
  members: ChainVerifyMember[];
  /** The same findings flattened: one entry per configured-but-unexecuted command. */
  unexecuted: Array<{ task_id: string; key: string; command: string }>;
};

/**
 * The configured set snapshot the spawner wrote at run start
 * (src/runs/context.ts writeEngineContext — read here, never re-derived).
 * Missing/unreadable is reported as a NOTE, never silently as "nothing
 * configured": an empty set and an unknown set are different facts.
 */
function configuredSnapshot(
  runDir: string,
): { configured: ChainVerifyConfigured[]; notes: string[] } {
  const path = join(runDir, "engine-context.json");
  if (!existsSync(path)) {
    return { configured: [], notes: ["no engine-context.json on this run — the configured set is unknown"] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { verification_commands?: unknown };
    const commands = parsed.verification_commands;
    if (!Array.isArray(commands) || commands.some((c) => typeof c !== "string")) {
      return {
        configured: [],
        notes: ["engine-context.json carries no verification_commands array — the configured set is unknown"],
      };
    }
    return { configured: (commands as string[]).map((command) => ({ command, cwd: null })), notes: [] };
  } catch (err) {
    return {
      configured: [],
      notes: [`engine-context.json is unreadable (${(err as Error).message}) — the configured set is unknown`],
    };
  }
}

/**
 * The executed side a run recorded in its §4.1 artifact block
 * (`verification_results`), for runs whose verification predates the
 * events frame. The block has no cwd (`additionalProperties: false` in data
 * 4.1), so cwd is null — reported as "—", never invented.
 */
function artifactExecuted(run: RunRow, runDir: string): ChainVerifyExecuted[] {
  const path = run.artifact_path ?? join(runDir, "result.json");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const entries = (parsed as Record<string, unknown>)["verification_results"];
  if (!Array.isArray(entries)) return [];
  const out: ChainVerifyExecuted[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o["command"] !== "string") continue;
    const exit = o["exit_code"];
    if (typeof exit !== "number" || !Number.isInteger(exit)) continue;
    out.push({ command: o["command"], exit, cwd: null });
  }
  return out;
}

/** One member's report, from that member's newest run. */
function memberReport(db: Db, member: { id: string; key: string; state: string }): ChainVerifyMember {
  const base = { task_id: member.id, key: member.key, state: member.state };
  // THE newest run per member: a retry is a NEW run, and its record is the
  // only one the operator meant to ask about.
  const run = latestRun(db, member.id);
  if (run === undefined) {
    return {
      ...base,
      run_id: null,
      attempt_number: null,
      configured: [],
      executed: [],
      unexecuted: [],
      notes: ["no run yet"],
    };
  }
  const runDir = dirname(run.events_log_path);
  let record: VerificationRecord | null = null;
  try {
    record = parseVerificationRecord(readFileSync(run.events_log_path, "utf8").split("\n"));
  } catch {
    // a run whose log file is gone still has its artifact block below
    record = null;
  }
  const notes: string[] = [];
  let configured: ChainVerifyConfigured[];
  if (record !== null) {
    configured = record.configured;
    if (record.collection_error !== null) {
      notes.push(`verification command collection failed: ${record.collection_error}`);
    }
  } else {
    const snapshot = configuredSnapshot(runDir);
    configured = snapshot.configured;
    notes.push(...snapshot.notes);
  }
  const executed = record !== null ? record.executed : artifactExecuted(run, runDir);
  const executedCommands = new Set(executed.map((e) => e.command));
  const unexecuted = configured.map((c) => c.command).filter((command) => !executedCommands.has(command));
  return {
    ...base,
    run_id: run.id,
    attempt_number: run.attempt_number,
    configured,
    executed,
    unexecuted,
    notes,
  };
}

/**
 * `nova_chain_verify`'s body: the whole chain's report, or undefined when
 * the chain row itself does not exist (the op raises not_found). Members are
 * listed in ULID creation order (data 5.1), exactly like `nova chain status`.
 */
export function chainVerificationReport(db: Db, chainRunId: string): ChainVerifyReport | undefined {
  const chain = getChainRun(db, chainRunId);
  if (chain === undefined) return undefined;
  const members = listChainMembers(db, chainRunId).map((m) => memberReport(db, m));
  const unexecuted = members.flatMap((m) =>
    m.unexecuted.map((command) => ({ task_id: m.task_id, key: m.key, command })),
  );
  return {
    chain_run_id: chain.id,
    project_id: chain.project_id,
    state: chain.state,
    members,
    unexecuted,
  };
}
