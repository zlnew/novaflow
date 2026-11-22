/**
 * The srs 4.1.1 error-code taxonomy and the op-argument validators, in
 * ONE place: the daemon's socket ops (src/daemon/server.ts), the shared
 * read-only op bodies (src/daemon/readops.ts) and the MCP server's
 * SQLite-direct fallback (src/mcp/read.ts) all raise the SAME typed
 * failures, so a tool call over MCP and the same call over the socket
 * can never disagree about an error code or a message (mcp.md §4: "One
 * error taxonomy … MCP adds no second error model").
 *
 * NOTE on the two reserved codes: `preflight_failed` and
 * `budget_exceeded` are RESERVED-FOR-CLIENT-MAPPING in v1 — the daemon's
 * ops never return them as response frames; those verdicts land on RUN
 * ROWS (task_runs.error_summary: "preflight failure: …",
 * "budget_exceeded: …"). The CLI (p3b) and MCP server (p5) map the
 * run-row records to these codes client-side when surfacing outcomes.
 */

export type TaxonomyCode =
  | "invalid_transition"
  | "schema_invalid"
  /** Reserved-for-client-mapping (see the module doc above). */
  | "preflight_failed"
  /** Reserved-for-client-mapping (see the module doc above). */
  | "budget_exceeded"
  | "not_found"
  | "daemon_unreachable"
  | "duplicate"
  | "aborted"
  | "profile_unresolved";

/** A typed op failure carrying a taxonomy code. */
export class OpError extends Error {
  constructor(readonly code: TaxonomyCode, message: string) {
    super(message);
    this.name = "OpError";
  }
}

/** A required non-empty string arg, else `schema_invalid` naming the key. */
export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new OpError("schema_invalid", `args.${key} must be a non-empty string`);
  }
  return v;
}

/** An optional string arg: absent/blank takes the fallback (documented per op). */
export function optString(args: Record<string, unknown>, key: string, fallback: string): string {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/** An optional array-of-strings arg; a wrong shape is `schema_invalid`. */
export function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new OpError("schema_invalid", `args.${key} must be an array of strings`);
  }
  return v as string[];
}

/** An optional boolean arg; a non-boolean is `schema_invalid`. */
export function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new OpError("schema_invalid", `args.${key} must be a boolean`);
  }
  return v;
}

/** An optional non-empty string arg; a wrong value is `schema_invalid`. */
export function optNonEmptyString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new OpError("schema_invalid", `args.${key} must be a non-empty string`);
  }
  return v;
}
