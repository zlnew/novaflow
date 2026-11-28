/**
 * Core-layer error surface (`novaflow-v100/architecture` §2, `novaflow-v100/mcp` §3).
 *
 * `src/core/` never prints and never exits: every failure is a `NovaError`
 * carrying a canonical code and the CLI exit code it maps to. Re-exporting the
 * store class keeps a single error identity across layers.
 */
import { NovaError, type NovaErrorCode } from '../store/errors.js';

export { NovaError, EXIT_CODES, isNovaError, toNovaError } from '../store/errors.js';
export type { NovaErrorCode, ExitCode, NovaErrorEnvelope } from '../store/errors.js';

/** Canonical domain codes emitted by `src/core/` (`novaflow-v100/mcp` §3). */
export const CORE_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'WORKSPACE_NOT_FOUND',
  'STATE_CONFLICT',
  'ALREADY_CLAIMED',
  'UNMET_DEPENDENCIES',
  'CYCLE_DETECTED',
  'INTERNAL_ERROR',
] as const satisfies readonly NovaErrorCode[];

function fail(code: NovaErrorCode, message: string, hint?: string): NovaError {
  return hint === undefined ? new NovaError(code, message) : new NovaError(code, message, { hint });
}

/** Usage or input shape problem; exit 2. */
export function validationError(message: string, hint?: string): NovaError {
  return fail('VALIDATION_ERROR', message, hint);
}

/** Missing workspace; exit 4 with remediation. */
export function workspaceNotFoundError(message: string, hint?: string): NovaError {
  return fail('WORKSPACE_NOT_FOUND', message, hint);
}

/** Missing project, task, note, or dependency edge; exit 4. */
export function notFoundError(message: string, hint?: string): NovaError {
  return fail('NOT_FOUND', message, hint);
}

/** Illegal state transition or duplicate unique value; exit 3. */
export function conflictError(message: string, hint?: string): NovaError {
  return fail('STATE_CONFLICT', message, hint);
}

/** Another actor holds a live claim; exit 3. */
export function alreadyClaimedError(message: string, hint?: string): NovaError {
  return fail('ALREADY_CLAIMED', message, hint);
}

/** Dependencies are not all `done`; exit 3. */
export function unmetDependenciesError(message: string, hint?: string): NovaError {
  return fail('UNMET_DEPENDENCIES', message, hint);
}

/** The dependency edge would close a cycle; exit 3. */
export function cycleDetectedError(message: string, hint?: string): NovaError {
  return fail('CYCLE_DETECTED', message, hint);
}
