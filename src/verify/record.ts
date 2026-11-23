import type { VerifyOutcome } from "./runner.ts";

/**
 * THE RUN'S VERIFICATION RECORD (FR-TSK-12; novaflow-v030 amendments row 4 —
 * DEBT-006). `verification_commands` already executed, and `result.json`'s
 * §4.1 block already recorded each command with its exit status
 * (`verification_results`: {command, exit_code, passed, output_tail}), but
 * nothing recorded WHERE a command ran — and the block's item schema is
 * closed (`additionalProperties: false`, pinned live against data.md §4.1 by
 * test/runs/artifact.test.ts and test/verify/artifact-annotate.test.ts), so
 * `cwd` cannot go there without bending a golden pin. The block stays
 * exactly as the spec pins it; the executed side is therefore recorded twice
 * on purpose:
 *
 *   - `result.json` `verification_results` — the handoff artifact's
 *     engine-owned annotation (data 4.1), unchanged; and
 *   - this frame in the run's REDACTED `events.jsonl` — the operator
 *     surface's fact source, carrying cwd, written through the pump's one
 *     choke point (src/runs/pump.ts appendRunEngineFrame, so NFR-SE-04
 *     redaction is never bypassed).
 *
 * Frame shape (one per verification pass; a later pass supersedes an
 * earlier one — a gate-approved re-drive keeps the newest verdict):
 *
 *   { "type": "novaflow_verification", "run_id": "…",
 *     "configured": [{"command": "npm test", "cwd": "/…"}],
 *     "executed":   [{"command": "npm test", "exit": 0, "cwd": "/…"}],
 *     "collection_error": null }
 *
 * `configured` is the command set as COLLECTED for that pass (each pinned to
 * the root it runs in), so the record can state a configured command that
 * never executed — even though a single pass normally executes every command
 * it collects. `collection_error` carries the collection failure text when
 * the command set itself could not be read (a FAILED verdict with no
 * per-command results).
 */

export const VERIFICATION_FRAME_TYPE = "novaflow_verification";

export type ConfiguredVerificationEntry = { command: string; cwd: string | null };
export type ExecutedVerificationEntry = { command: string; exit: number; cwd: string | null };

export type VerificationRecord = {
  type: typeof VERIFICATION_FRAME_TYPE;
  run_id: string;
  configured: ConfiguredVerificationEntry[];
  executed: ExecutedVerificationEntry[];
  collection_error: string | null;
};

/** Build the frame for one completed verification pass. */
export function buildVerificationRecord(runId: string, outcome: VerifyOutcome): VerificationRecord {
  return {
    type: VERIFICATION_FRAME_TYPE,
    run_id: runId,
    configured: outcome.configured.map((c) => ({ command: c.command, cwd: c.rootPath })),
    executed: outcome.results.map((r) => ({
      command: r.command,
      exit: r.exitCodeForArtifact,
      cwd: r.cwd,
    })),
    collection_error: outcome.collectionError,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function configuredEntry(value: unknown): ConfiguredVerificationEntry | null {
  if (!isObject(value) || typeof value["command"] !== "string") return null;
  return { command: value["command"], cwd: stringOrNull(value["cwd"]) };
}

function executedEntry(value: unknown): ExecutedVerificationEntry | null {
  if (!isObject(value) || typeof value["command"] !== "string") return null;
  const exit = value["exit"];
  if (typeof exit !== "number" || !Number.isInteger(exit)) return null;
  return { command: value["command"], exit, cwd: stringOrNull(value["cwd"]) };
}

/**
 * The LAST verification frame in a run's `events.jsonl` lines, or null when
 * the run never recorded one (verification never ran, or it ran before this
 * frame existed — the reader's caller falls back to the §4.1 block). Lines
 * that are not JSON, and frames of other types, are skipped: the stream is
 * a mixed telemetry log, never a schema.
 */
export function parseVerificationRecord(lines: readonly string[]): VerificationRecord | null {
  let found: VerificationRecord | null = null;
  for (const line of lines) {
    if (line.trim() === "" || !line.includes(VERIFICATION_FRAME_TYPE)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed) || parsed["type"] !== VERIFICATION_FRAME_TYPE) continue;
    if (typeof parsed["run_id"] !== "string") continue;
    const configured = parsed["configured"];
    const executed = parsed["executed"];
    if (!Array.isArray(configured) || !Array.isArray(executed)) continue;
    found = {
      type: VERIFICATION_FRAME_TYPE,
      run_id: parsed["run_id"],
      configured: configured
        .map(configuredEntry)
        .filter((c): c is ConfiguredVerificationEntry => c !== null),
      executed: executed.map(executedEntry).filter((e): e is ExecutedVerificationEntry => e !== null),
      collection_error: stringOrNull(parsed["collection_error"]),
    };
  }
  return found;
}
