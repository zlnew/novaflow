import { EXIT_CODES } from "./exitcode.ts";
import { findVerb, nounNames, verbKey, verbsOf, type Verb } from "./verbs.ts";

/**
 * The help renderers (srs 4.1.1; W4 R4.1). THREE surfaces, one table:
 *
 *   `nova <noun> <verb> --help` / `-h`  → that verb's usage, flags, ONE example (exit 0)
 *   `nova help <noun>`                  → the noun's verbs, one line each (exit 0)
 *   `nova help` (and bare `nova`)       → the program overview
 *
 * The verb block is what the observed defect asked for: an operator one flag
 * away from the answer gets one verb, not the whole manual. `OVERVIEW` is
 * generated from the same table the dispatcher refuses verbs against, so a
 * verb that exists cannot be missing from either list.
 */

/** The program overview: every verb, one synopsis line each. */
export function renderOverview(): string {
  return [
    "USAGE: nova <noun> <sub> [args] [flags]",
    "  common flags: --workspace <slug|id>   --json   --watch",
    "",
    ...nounNames().flatMap((noun) => verbsOf(noun).map((verb) => `  ${verb.synopsis}`)),
    "",
    "Run `nova help <noun>` to list one noun's verbs,",
    "`nova <noun> <verb> --help` for one verb's flags and an example.",
  ].join("\n");
}

/** `nova chain clean --help` — this verb only. */
export function renderVerbHelp(verb: Verb): string {
  const flags: Array<[string, string]> = [
    ...verb.flags.map((flag): [string, string] => {
      const split = flag.search(/\s{2,}/);
      return split < 0 ? [flag, ""] : [flag.slice(0, split), flag.slice(split).trim()];
    }),
    ["-h, --help", "print this usage and exit 0"],
  ];
  if (verb.json) flags.push(["--json", "print one JSON document instead of the table"]);
  const width = Math.max(...flags.map(([name]) => name.length));

  return [
    `USAGE`,
    `  ${verb.synopsis}`,
    ``,
    `PURPOSE`,
    `  ${verb.purpose}`,
    ``,
    `FLAGS`,
    ...flags.map(([name, desc]) => (desc === "" ? `  ${name}` : `  ${name.padEnd(width)}  ${desc}`)),
    ``,
    `EXAMPLE`,
    `  ${verb.example}`,
    ``,
    `EXIT`,
    `  ${verb.exits.join(" ")}   ${verb.exits
      .map((code) => `${String(code)}=${EXIT_CODES[code].short}`)
      .join("  ")}`,
    ``,
    verbsOf(verb.noun).length === 1
      ? "Run `nova help` for the whole verb list."
      : `Run \`nova help ${verb.noun}\` to list every ${verb.noun} verb.`,
  ].join("\n");
}

/** `nova help chain` — the noun's verbs, one line each. */
export function renderNounHelp(noun: string): string {
  const verbs = verbsOf(noun);
  const width = Math.max(...verbs.map((verb) => (verb.sub ?? "").length));
  return [
    `USAGE: nova ${noun}${verbs.some((v) => v.sub !== null) ? " <verb> [args] [flags]" : " [args] [flags]"}`,
    ``,
    `VERBS`,
    ...verbs.map((verb) => `  ${(verb.sub ?? "(none)").padEnd(width)}  ${verb.purpose}`),
    ``,
    `Run \`nova ${noun} <verb> --help\` for that verb's flags and one example.`,
  ].join("\n");
}

/** `nova help <noun> <verb>` — the same block `--help` prints. */
export function verbHelpFor(noun: string, sub: string | undefined): string | null {
  const verb = findVerb(noun, sub);
  return verb === undefined ? null : renderVerbHelp(verb);
}

export { findVerb, verbKey };
