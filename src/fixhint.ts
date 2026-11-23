/**
 * THE refusal convention (novaflow-v030 W4 R4.3: "every error names the
 * fix"). A message that refuses an operator request ends with the next move
 * they should make, spelled the same way everywhere:
 *
 *   task tsk_… carries no target_scopes … — fix: add target_scopes to the
 *   task (nova task create --scope <repo_alias>), then re-run `nova task run <id|key>`
 *
 * One separator, one helper: a message is a fix-hinted refusal iff it
 * contains {@link FIX_HINT_SEPARATOR}, which is what the remaining-messages
 * audit in docs/cli.md and test/cli/fixhint.test.ts check.
 *
 * Scope, honestly (P12 → P13): P12 fixed the three worst refusals (graph
 * import schema_invalid, the DEBT-010 unscoped-run refusal, the inert-prices
 * note) and LISTED the rest in docs/cli.md; P13 applied the list, so every
 * refusal in the audit now ends with the marker.
 */

/** The one marker every fix-hinted refusal carries. */
export const FIX_HINT_SEPARATOR = " — fix: ";

/** Append the operator's next move, unless the message already names one. */
export function withFixHint(message: string, fix: string): string {
  if (message.includes(FIX_HINT_SEPARATOR)) return message;
  return `${message}${FIX_HINT_SEPARATOR}${fix}`;
}

/** Does this message name the fix? (The audit's only test.) */
export function hasFixHint(message: string): boolean {
  return message.includes(FIX_HINT_SEPARATOR);
}

/** The graph-import refusal's next move — one sentence, every import error. */
export const IMPORT_GRAPH_FIX =
  "correct the graph file (see nova project import-dag --help for the shape) and re-run `nova project import-dag <file>`";
