import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, EXIT_CODE_VALUES } from "../../src/cli/exitcode.ts";
import { VERBS, BLOCKING_BEHAVIOURS, verbKey } from "../../src/cli/verbs.ts";

/**
 * R4.2: `docs/cli.md` is the audit table — verb, purpose, blocking
 * behaviour, `--json`, exit codes — and this file is what keeps it honest.
 * The rows are parsed out of the MARKDOWN (a hand-edited table, not a
 * generated string) and compared to the verb table the dispatcher uses, so:
 *
 *   - a new verb without a docs row fails;
 *   - a row for a verb that no longer exists fails;
 *   - a row that disagrees about purpose, blocking, `--json` or exit codes
 *     fails (help text and documentation drift together or not at all).
 */

const REPO = join(import.meta.dirname, "..", "..");
const DOC = join(REPO, "docs", "cli.md");

type DocRow = {
  verb: string;
  purpose: string;
  blocking: string;
  json: string;
  exits: string;
  line: number;
};

function docRows(): DocRow[] {
  const rows: DocRow[] = [];
  const lines = readFileSync(DOC, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const m = /^\| `(nova [^`]+)` \| (.+) \| (.+) \| (yes|no) \| ([0-9 ]+) \|$/.exec(line);
    if (m === null) continue;
    rows.push({
      verb: m[1]!,
      purpose: m[2]!,
      blocking: m[3]!,
      json: m[4]!,
      exits: m[5]!,
      line: index + 1,
    });
  }
  return rows;
}

test("docs/cli.md carries exactly one audit row per verb, in the table's order", () => {
  const rows = docRows();
  assert.ok(rows.length > 0, "the audit table is missing or its rows do not parse");
  assert.deepEqual(
    rows.map((row) => row.verb),
    VERBS.map(verbKey),
    "docs/cli.md's verb rows and src/cli/verbs.ts disagree (missing/extra/duplicate rows)",
  );
});

test("every docs row agrees with the verb table (purpose, blocking, --json, exits)", () => {
  const rows = docRows();
  for (const [index, verb] of VERBS.entries()) {
    const row = rows[index]!;
    assert.ok(BLOCKING_BEHAVIOURS.includes(verb.blocking), `${verbKey(verb)} has an unknown blocking value`);
    assert.equal(row.verb, verbKey(verb));
    assert.equal(row.purpose, verb.purpose, `docs row ${row.line}: purpose drifted`);
    assert.equal(row.blocking, verb.blocking, `docs row ${row.line}: blocking behaviour drifted`);
    assert.equal(row.json, verb.json ? "yes" : "no", `docs row ${row.line}: --json column drifted`);
    assert.deepEqual(
      row.exits.trim().split(/\s+/).map(Number),
      [...verb.exits],
      `docs row ${row.line}: exit codes drifted`,
    );
  }
});

test("docs/cli.md's exit-code table is the code module's table, row for row", () => {
  const doc = readFileSync(DOC, "utf8");
  for (const code of EXIT_CODE_VALUES) {
    const row = EXIT_CODES[code];
    assert.ok(
      doc.includes(`| ${code} | ${row.short} | ${row.meaning} |`),
      `docs/cli.md's exit table is missing the code-${code} row (or its meaning drifted)`,
    );
  }
  // no invented exit rows: every "| <n> | short |" row in the doc names a real code
  const documented = [...doc.matchAll(/^\| ([0-9]) \| [a-z-]+ \| .+ \|$/gm)].map((m) => Number(m[1]));
  assert.deepEqual([...documented].sort(), [...EXIT_CODE_VALUES]);
});

test("docs/cli.md documents the help contract and the fix hint every refusal carries", () => {
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /nova <noun> <verb> --help/, "the help section is gone");
  assert.match(doc, /never the whole manual/, "the help rule is not stated");
  assert.match(doc, /Every error names the fix/, "the fix-hint rule is gone");
  assert.match(doc, / — fix: /, "the separator the refusals end with is not shown");
  // the refusals an operator meets first are named, each with its next move
  for (const subject of ["graph import", "no target scope", "price table"]) {
    assert.ok(doc.includes(subject), `docs/cli.md does not name the fixed refusal "${subject}"`);
  }
});
