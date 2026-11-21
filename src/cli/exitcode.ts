/**
 * THE exit-code map (srs 4.1.1, verbatim — the operator's contract;
 * every script built on the CLI depends on it):
 *
 *   | exit | srs row                                          |
 *   |------+--------------------------------------------------|
 *   |   0  | success                                          |
 *   |   1  | operation failure (task failed, verification failed) |
 *   |   2  | usage error                                      |
 *   |   3  | engine-state rejection (invalid transition, schema invalid) |
 *   |   4  | not found                                        |
 *   |   5  | daemon unreachable                               |
 *
 * One table, one source: taxonomy codes arrive from the daemon's wire
 * envelope (the srs 4.1.1 error-code taxonomy, printed by the CLI and
 * returned by the MCP tools alike); `preflight_failed` and
 * `budget_exceeded` are the documented client-mapped codes (the daemon
 * records them on run rows). Client-side outcomes that are not taxonomy
 * frames — a --watch run ending in a failed/cancelled task — are
 * operation failures and exit 1.
 */

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export const EXIT_OK: ExitCode = 0;
export const EXIT_OPERATION_FAILED: ExitCode = 1;
export const EXIT_USAGE: ExitCode = 2;
export const EXIT_ENGINE_STATE: ExitCode = 3;
export const EXIT_NOT_FOUND: ExitCode = 4;
export const EXIT_DAEMON_UNREACHABLE: ExitCode = 5;

/**
 * Taxonomy code → srs exit row. An unrecognized failure code maps to 1
 * (operation failure — the honest default for "the operation did not
 * succeed"), never to an invented exit.
 */
export function exitCodeForTaxonomy(code: string): ExitCode {
  switch (code) {
    case "invalid_transition":
    case "schema_invalid":
      return EXIT_ENGINE_STATE;
    case "not_found":
      return EXIT_NOT_FOUND;
    case "daemon_unreachable":
      return EXIT_DAEMON_UNREACHABLE;
    // aborted, duplicate, preflight_failed, budget_exceeded,
    // profile_unresolved — and the default below.
    default:
      return EXIT_OPERATION_FAILED;
  }
}
