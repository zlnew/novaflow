import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The public surface is written for someone who has just heard the name: no ticket numbers, no
 * decision ids, no internal phase names, no dates of internal events, no spec paths. This is the
 * regression guard for that rule — the whole complaint that produced these pages was that a
 * stranger could not follow them without context we never gave.
 *
 * It scans exactly the files a visitor reads: README.md, CHANGELOG.md and docs/*.md. Internal
 * material (source comments, tests, the workspace) is out of scope on purpose.
 */

const REPO = join(import.meta.dirname, "..", "..");
const DOCS = join(REPO, "docs");

const PUBLIC_FILES = [
  join(REPO, "README.md"),
  join(REPO, "CHANGELOG.md"),
  ...readdirSync(DOCS)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(DOCS, name)),
];

/** term → the shorthand it catches. Every entry is a defect in a public document. */
const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["a debt-register id", /DEBT-\d/],
  ["a decision id", /\bDEC-[A-Za-z]/],
  ["a pull-request number", /\bPR #\d+/],
  ["a personal name", /\bMaul\b/i],
  ["the internal dogfood word", /dogfood/i],
  ["the internal trial word", /\btrial\b/i],
  ["the internal spec path", /odd\/specs/],
  ["an internal spec id", /novaflow-v\d/],
  ["the internal golden-test phrase", /golden tests?/i],
  ["the pipeline slogan", /this box is the pipeline/i],
  ["an internal tier name", /\btier [A-D]\b/i],
  ["an internal phase id", /\bP(?:7|9|13)\b/],
  ["the internal receipt word", /\breceipt/i],
  ["the internal card word", /\bcard\b/i],
  ["an internal requirement id", /\bsrs\b/i],
  ["an internal section reference", /§\d/],
];

function publicText(): Array<{ path: string; text: string }> {
  return PUBLIC_FILES.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

test("no public document uses internal shorthand a stranger cannot decode", () => {
  const hits: string[] = [];
  for (const { path, text } of publicText()) {
    for (const [what, pattern] of BANNED) {
      const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, pattern.flags + "g");
      for (const match of text.matchAll(global)) {
        hits.push(`${relative(REPO, path)}: ${what} — "${match[0]}"`);
      }
    }
  }
  assert.deepEqual(hits, [], "public docs carry internal shorthand:\n" + hits.join("\n"));
});

test("no public document carries a date outside a changelog release heading", () => {
  const hits: string[] = [];
  for (const { path, text } of publicText()) {
    // CHANGELOG headings date the release itself; every other line is prose
    const prose =
      path === join(REPO, "CHANGELOG.md")
        ? text.split("\n").filter((line) => !/^## \[/.test(line)).join("\n")
        : text;
    for (const match of prose.matchAll(/\b20\d\d-\d\d-\d{2}\b/g)) {
      hits.push(`${relative(REPO, path)}: "${match[0]}"`);
    }
  }
  assert.deepEqual(hits, [], "public docs date an internal event:\n" + hits.join("\n"));
});
