import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The docs index and release history are part of the public face, so they are
 * pinned like the README: every docs page is linked from the index, every
 * relative markdown link resolves inside the repo, and the CHANGELOG keeps
 * the frozen 0.3.0 section (the release number is decided before this file is
 * written, so it can never go stale) plus the 0.2.0 and 0.1.x history.
 */

const REPO = join(import.meta.dirname, "..", "..");
const DOCS = join(REPO, "docs");
const INDEX = readFileSync(join(DOCS, "index.md"), "utf8");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const CHANGELOG = readFileSync(join(REPO, "CHANGELOG.md"), "utf8");

/** Every relative `[text](path.md)` target in a markdown document. */
function relativeLinks(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) continue;
    out.push(target);
  }
  return out;
}

test("docs/index.md links every docs page, and every relative link resolves", () => {
  const pages = readdirSync(DOCS)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort();
  assert.ok(pages.length >= 6, `expected the concept pages, found ${pages.join(", ")}`);
  for (const page of pages) {
    assert.ok(INDEX.includes(`](${page})`), `docs/index.md does not link ${page}`);
  }
  const missing: string[] = [];
  for (const page of ["../README.md", ...pages.map((p) => p)]) {
    const from = page === "../README.md" ? join(REPO, "README.md") : join(DOCS, page);
    for (const target of relativeLinks(readFileSync(from, "utf8"))) {
      const path = resolve(dirname(from), target);
      if (!existsSync(path)) missing.push(`${page} → ${target} (${path})`);
    }
  }
  assert.deepEqual(missing, [], "a docs link points at a file that does not exist");
});

test("the README points at the docs index and the CLI audit page", () => {
  assert.match(README, /\[`docs\/` index\]\(docs\/index\.md\)/);
  assert.match(README, /\[`docs\/cli\.md`\]\(docs\/cli\.md\)/);
  assert.ok(existsSync(join(DOCS, "cli.md")));
});

test("CHANGELOG keeps the frozen 0.3.0 section and the user-facing history", () => {
  // the number was frozen before the file was written; at release the section
  // carries the date. Either form is the frozen claim; a THIRD heading is not.
  assert.match(
    CHANGELOG,
    /^## \[0\.3\.0\] — (unreleased|\d{4}-\d{2}-\d{2})$/m,
    "the 0.3.0 heading is the frozen number, unreleased or dated",
  );
  assert.match(CHANGELOG, /^## \[0\.2\.0\] — 2026-11-23$/m);
  for (const item of ["0.1.4", "0.1.3", "0.1.2", "0.1.1"]) {
    assert.match(CHANGELOG, new RegExp(`\\*\\*${item.replace(/\./g, "\\.")}\\*\\*`), `0.1.x is missing ${item}`);
  }
  // the 0.2.0 entry carries the trial's number with its denominator
  assert.match(CHANGELOG, /\$0\.0643/);
  assert.match(CHANGELOG, /1,230,016 of 1,384,732/);
});

test("package.json's package-page copy is concrete (description + keywords)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    description?: string;
    keywords?: string[];
  };
  assert.match(pkg.description ?? "", /Pi coding-agent tasks/);
  assert.match(pkg.description ?? "", /git worktrees/);
  for (const keyword of ["worktree", "dag", "mcp", "sqlite"]) {
    assert.ok(pkg.keywords?.includes(keyword), `keywords are missing "${keyword}"`);
  }
});
