import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONCURRENCY_WORKSPACE } from "../../src/config.ts";
import { DEFAULT_CONCURRENCY_GLOBAL } from "../../src/daemonconfig.ts";
import { DEFAULT_RETENTION_DAYS } from "../../src/daemon/maintenance.ts";
import { DISK_FREE_FLOOR_BYTES } from "../../src/runs/preflight.ts";

/**
 * The docs index, the operator pages and the release history are the public face, so they are
 * pinned like the README: every page is linked from the index, every relative markdown link
 * resolves inside the repo, and the numbers the pages state are the numbers the code enforces.
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

function page(name: string): string {
  return readFileSync(join(DOCS, name), "utf8");
}

test("docs/index.md links every docs page, and every relative link resolves", () => {
  const pages = readdirSync(DOCS)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort();
  assert.ok(pages.length >= 6, `expected the concept pages, found ${pages.join(", ")}`);
  for (const name of pages) {
    assert.ok(INDEX.includes(`](${name})`), `docs/index.md does not link ${name}`);
  }
  const missing: string[] = [];
  for (const name of ["../README.md", ...pages]) {
    const from = name === "../README.md" ? join(REPO, "README.md") : join(DOCS, name);
    for (const target of relativeLinks(readFileSync(from, "utf8"))) {
      const path = resolve(dirname(from), target);
      if (!existsSync(path)) missing.push(`${name} → ${target} (${path})`);
    }
  }
  assert.deepEqual(missing, [], "a docs link points at a file that does not exist");
});

test("docs/index.md states a reading order, not just a list", () => {
  assert.match(INDEX, /## Read this first/);
  assert.match(INDEX, /the question it answers/);
  // the order starts with the page a newcomer needs first
  assert.match(INDEX, /## Read this first[\s\S]*\n\| 1 \| \[Quick start\]\(install\.md\) \|/);
});

test("the README links the docs index and every page, and the template is gone", () => {
  assert.ok(existsSync(join(DOCS, "cli.md")));
  assert.match(README, /\]\(docs\/index\.md\)/);
  assert.match(README, /\]\(docs\/cli\.md\)/);
  assert.ok(existsSync(join(DOCS, "maintaining.md")), "the maintainer page replaces the release-notes template");
  assert.equal(
    existsSync(join(DOCS, "release-notes-template.md")),
    false,
    "the release-notes template was replaced by docs/maintaining.md",
  );
});

test("the maintainer page documents the release flow it ships with", () => {
  const doc = page("maintaining.md");
  for (const step of ["bump", "pr", "tag", "publish"]) {
    assert.ok(doc.includes(`./release.sh ${step}`), `docs/maintaining.md does not describe ./release.sh ${step}`);
  }
  // the two refusals an operator must know before running the commands
  assert.match(doc, /--confirm/, "the confirm gate is stated");
  assert.match(doc, /npm view novaflow@X\.Y\.Z version/, "the verify step is stated");
  assert.match(doc, /Rolling back|rolling back|Roll forward/i, "the rollback story is stated");
});

test("CHANGELOG carries the publication release and the user-facing history", () => {
  // the newest section is "Unreleased" until the release commit dates it — a
  // changelog that claims a date before the version bump is a false claim.
  assert.match(
    CHANGELOG,
    /^## \[0\.4\.0\] — (Unreleased|\d{4}-\d{2}-\d{2})$/m,
    "the publication release heads the file, dated or explicitly unreleased",
  );
  assert.match(CHANGELOG, /^## \[0\.3\.2\] — \d{4}-\d{2}-\d{2}$/m);
  assert.match(CHANGELOG, /^## \[0\.3\.1\] — \d{4}-\d{2}-\d{2}$/m);
  assert.match(CHANGELOG, /^## \[0\.3\.0\] — \d{4}-\d{2}-\d{2}$/m);
  assert.match(CHANGELOG, /^## \[0\.2\.0\] — 2026-11-23$/m);
  for (const item of ["0.1.4", "0.1.3", "0.1.2", "0.1.1"]) {
    assert.match(CHANGELOG, new RegExp(`\\*\\*${item.replace(/\./g, "\\.")}\\*\\*`), `0.1.x is missing ${item}`);
  }
  // the measured cost fact keeps both numbers and its denominator
  assert.match(CHANGELOG, /\$0\.0643/);
  assert.match(CHANGELOG, /1,230,016 of\s+1,384,732/);
});

test("the docs state the numbers and paths the code enforces", () => {
  const chains = page("chains.md");
  assert.equal(DEFAULT_CONCURRENCY_WORKSPACE, 2);
  assert.equal(DEFAULT_CONCURRENCY_GLOBAL, 4);
  assert.match(chains, /concurrency\.workspace` defaults to \*\*2\*\*/);
  assert.match(chains, /concurrency\.global` to\s+\*\*4\*\*/);
  assert.match(chains, /\.novaflow\/worktrees\/<run_id>\/<target_alias>\//);
  assert.match(chains, /novaflow\/run-<run_id>/, "the per-run branch name is stated");

  const operations = page("operations.md");
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.match(operations, /retention/i);
  assert.match(operations, /30 days/, "the default retention the prune verb uses is stated");
  assert.equal(DISK_FREE_FLOOR_BYTES, 1024 * 1024 * 1024);
  assert.match(operations, /1 GiB/, "the preflight free-space floor is stated");
  assert.match(operations, /`\.md`, `\.txt` and\s+`\.rst`/, "the doc extension list is the FR's .md/.txt/.rst");

  const install = page("install.md");
  assert.match(install, /~\/\.pi\/agent\/extensions\/novaflow\.ts/, "the extension destination is the spawned path");

  const liveView = page("live-view.md");
  assert.match(liveView, /30142/, "the dedicated Pi Web port is stated");
  assert.match(liveView, /events\.raw\.jsonl` is never copied/, "the one absolute mirror rule is stated");
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
