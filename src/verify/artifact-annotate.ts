import { readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../store/db.ts";
import type { CommandResult, VerifyOutcome } from "./runner.ts";
import type { ProtectedCheckResult } from "./protected.ts";

/**
 * Engine-owned artifact annotation (novaflow-v1/data 4.1,
 * TaskHandoffArtifact): after VALIDATING, the engine OVERWRITES
 * `engine_verified`, `protected_files_untouched`, and
 * `verification_results` with its own findings — agent-authored values
 * in those fields are never read, never trusted. `role` is also an
 * engine-owned annotation per the block ("Optional engine-owned
 * annotation of the profile's role label convention; not required of
 * the agent"): the engine writes the STORED profile's role
 * (agent_profiles.role); when the profile carries no role, any
 * agent-authored `role` key is REMOVED (never trusted).
 *
 * `verification_results` mirrors the 4.1 block's item definition
 * exactly: objects of {command, exit_code, passed} plus an optional
 * `output_tail` (the block's only additional property; nothing else is
 * ever written there).
 */

export type ArtifactVerificationEntry = {
  command: string;
  exit_code: number;
  passed: boolean;
  output_tail?: string;
};

export type EngineAnnotationInput = {
  engineVerified: boolean;
  protectedFilesUntouched: boolean;
  verificationResults: ArtifactVerificationEntry[];
  /** The stored profile's role label, or null to remove any agent value. */
  role: string | null;
};

type RunJoinRow = {
  id: string;
  task_id: string;
  profile_id: string | null;
  artifact_path: string | null;
};

/**
 * Overwrite the engine-owned fields in the run's result.json and set
 * the run row's `engine_verification_passed` (1 iff the engine's
 * verification AND the protected-file check both passed — a protected
 * tamper is a verification failure, RSK-14). Throws when the run or
 * its artifact is missing: this runs only after a settled, validated
 * intake, so a missing artifact here is an engine integrity error, not
 * a verdict.
 */
export function annotateRunArtifact(
  db: Db,
  runId: string,
  input: EngineAnnotationInput,
): { engineVerificationPassed: boolean } {
  const run = db
    .prepare("SELECT id, task_id, profile_id, artifact_path FROM task_runs WHERE id = ?")
    .get(runId) as RunJoinRow | undefined;
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.artifact_path === null) {
    throw new Error(`run ${runId} has no artifact_path — nothing to annotate`);
  }

  // read the settled artifact; it was structurally validated at intake
  let artifact: Record<string, unknown>;
  try {
    artifact = JSON.parse(readFileSync(run.artifact_path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `result.json for run ${runId} is unreadable: ${(err as Error).message}`,
    );
  }

  // engine-owned fields are REPLACED wholesale; agent values are never read
  artifact["engine_verified"] = input.engineVerified;
  artifact["protected_files_untouched"] = input.protectedFilesUntouched;
  artifact["verification_results"] = input.verificationResults;
  if (input.role === null) delete artifact["role"];
  else artifact["role"] = input.role;

  writeFileSync(run.artifact_path, JSON.stringify(artifact, null, 2) + "\n");

  const passed = input.engineVerified && input.protectedFilesUntouched;
  db.prepare("UPDATE task_runs SET engine_verification_passed = ? WHERE id = ?").run(
    passed ? 1 : 0,
    runId,
  );
  return { engineVerificationPassed: passed };
}

/**
 * Derive the annotations from a post-run verification outcome
 * (FR-TSK-12) and protected/scope check (FR-TSK-11) and annotate the
 * run's artifact in one step:
 *   - engineVerified = every command passed AND no scope creep
 *     (out-of-scope modification is a Post-Run Verifier failure);
 *   - protectedFilesUntouched = the digest check's verdict;
 *   - role comes from the run's profile snapshot (FR-TSK-09), never
 *     from the agent.
 */
export function annotateRunVerification(
  db: Db,
  runId: string,
  verify: VerifyOutcome,
  protectedCheck: ProtectedCheckResult,
): { engineVerificationPassed: boolean } {
  const run = db
    .prepare("SELECT profile_id FROM task_runs WHERE id = ?")
    .get(runId) as { profile_id: string | null } | undefined;
  if (!run) throw new Error(`no such run: ${runId}`);
  let role: string | null = null;
  if (run.profile_id !== null) {
    const profile = db
      .prepare("SELECT role FROM agent_profiles WHERE id = ?")
      .get(run.profile_id) as { role: string | null } | undefined;
    role = profile?.role ?? null;
  }

  const verificationResults: ArtifactVerificationEntry[] = verify.results.map(
    (r: CommandResult): ArtifactVerificationEntry => ({
      command: r.command,
      exit_code: r.exitCodeForArtifact,
      passed: r.passed,
      ...(r.stdoutTail !== "" || r.stderrTail !== ""
        ? {
            output_tail: [r.stdoutTail, r.stderrTail].filter((s) => s !== "").join("\n--- stderr ---\n"),
          }
        : {}),
    }),
  );

  return annotateRunArtifact(db, runId, {
    engineVerified: verify.passed && protectedCheck.scopeCreepPaths.length === 0,
    protectedFilesUntouched: protectedCheck.protectedFilesUntouched,
    verificationResults,
    role,
  });
}
