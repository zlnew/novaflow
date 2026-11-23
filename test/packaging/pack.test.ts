import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * npm publishability (novaflow-v030 W3 / R3.2): "npm publish --dry-run is
 * inspected and its file list asserted by a test".
 *
 * The list is taken from `npm pack --dry-run --json`, which prints exactly the
 * tarball npm would upload without writing one — the deterministic form of the
 * dry run (no `novaflow-<version>.tgz` left behind, no prepack side effects).
 * The assertions are two-sided on purpose: the shipped runtime must be IN the
 * tarball, and test fixtures, dev config, secrets and raw logs must be OUT.
 */

const REPO = join(import.meta.dirname, "..", "..");
const MIGRATIONS = join(REPO, "src", "store", "migrations");

type Manifest = {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  license?: string;
  keywords?: string[];
  files?: string[];
  engines?: Record<string, string>;
  bin?: Record<string, string>;
  repository?: string | { type?: string; url?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as Manifest;

function packFiles(): string[] {
  const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `npm pack --dry-run failed:\n${res.stdout}\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as unknown;
  // npm <= 11 prints an array of packs; npm 12 prints an object keyed by name.
  const packs = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
  const pack = packs[0] as { files?: Array<{ path: string }> };
  assert.ok(Array.isArray(pack?.files), "npm pack --json printed no file list");
  return pack.files.map((f) => f.path);
}

const FILES = packFiles();

test("package.json carries the publish metadata npm shows (engines, bin, repository, keywords, gate)", () => {
  assert.equal(pkg.private, undefined, "a private package cannot be published — `private` must be gone");
  assert.equal(pkg.engines?.["node"], ">=22.0.0", "engines.node pins the Node floor install.sh enforces");
  assert.deepEqual(pkg.bin, { nova: "./bin/nova" });
  const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  assert.match(repoUrl ?? "", /github\.com\/zlnew\/novaflow/, "the repository is the acquisition route install.sh names");
  assert.ok((pkg.description ?? "").length > 20, "the package page needs a real description");
  assert.ok((pkg.keywords ?? []).length >= 3, "keywords are how the package is found");
  assert.match(pkg.scripts?.["prepublishOnly"] ?? "", /typecheck/, "prepublishOnly runs the typecheck");
  assert.match(pkg.scripts?.["prepublishOnly"] ?? "", /test/, "prepublishOnly runs the suite");
});

test("the `files` allowlist is the shipped set, not the checkout", () => {
  const files = pkg.files ?? [];
  assert.ok(files.length > 0, "`files` must be an allowlist — the checkout root would ship test/ and fixtures");
  for (const required of ["bin/", "src/", "extensions/"]) {
    assert.ok(files.includes(required), `files lists ${required}`);
  }
  // docs/ ships when it exists; the allowlist must name it before P13 writes it
  if (existsSync(join(REPO, "docs"))) assert.ok(files.includes("docs/"), "docs/ exists and must ship");
  for (const leaked of ["test", "test/", "node_modules", "node_modules/", ".env"]) {
    assert.equal(files.includes(leaked), false, `files must not name ${leaked}`);
  }
});

test("the packed file list ships bin, sources, migrations, the extension and the README", () => {
  assert.ok(FILES.includes("bin/nova"), `bin/nova must ship (got ${FILES.length} files)`);
  assert.ok(FILES.includes("package.json"));
  assert.ok(FILES.includes("extensions/novaflow.ts"), "the Pi extension is part of the package");
  assert.ok(FILES.includes("README.md"), "the shipped README is the package page");
  assert.ok(FILES.some((f) => f.startsWith("src/cli/")), "the CLI sources ship (bin/nova loads src/cli/main.ts)");
  assert.ok(FILES.some((f) => f.startsWith("src/daemon/")), "the daemon sources ship");
  // every migration on disk, so a later migration cannot be forgotten
  const migrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrations.length >= 3, "the store ships its migrations");
  for (const name of migrations) {
    assert.ok(
      FILES.includes(`src/store/migrations/${name}`),
      `migration ${name} must ship — the daemon migrates its store from these files`,
    );
  }
  // CHANGELOG is P13's card: asserted when it exists, never required before it does
  if (existsSync(join(REPO, "CHANGELOG.md"))) {
    assert.ok(FILES.includes("CHANGELOG.md"), "a CHANGELOG that exists must ship");
  }
});

test("the packed file list leaks no tests, fixtures, dev config, secrets or raw logs", () => {
  for (const path of FILES) {
    assert.equal(path.startsWith("test/"), false, `test/ leaked: ${path}`);
    assert.equal(path.endsWith(".test.ts"), false, `a test file leaked: ${path}`);
    assert.equal(path.startsWith("node_modules/"), false, `node_modules leaked: ${path}`);
    assert.equal(path.includes("events.raw.jsonl"), false, `the raw log leaked: ${path}`);
    assert.equal(path === ".env" || path.endsWith("/.env"), false, `a dotenv file leaked: ${path}`);
    for (const devOnly of ["tsconfig.json", "package-lock.json", "release.sh", "AGENTS.md"]) {
      assert.notEqual(path, devOnly, `${devOnly} is dev config and must not ship`);
    }
  }
});

test("the license metadata matches the LICENSE file the tarball ships (MIT)", () => {
  // A published package whose license cannot be read is a legal question, not
  // a documentation gap: the field and the shipped text must agree.
  assert.equal(pkg.license, "MIT", "package.json declares an SPDX id");
  const licenseFile = readdirSync(REPO).find((f) => /^LICEN[CS]E(\.md|\.txt)?$/.test(f));
  assert.ok(licenseFile !== undefined, "a LICENSE file exists at the repo root");
  const text = readFileSync(join(REPO, licenseFile), "utf8");
  assert.match(text, /^MIT License\n/, "the file opens as MIT");
  assert.match(
    text,
    /Permission is hereby granted, free of charge, to any person obtaining a copy/,
    "the MIT permission grant",
  );
  assert.match(text, /The above copyright notice and this permission notice shall be included/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/, "the MIT warranty disclaimer");
  assert.match(text, /Copyright \(c\) 2026 zlnew/, "the copyright line");
  assert.ok(FILES.includes(licenseFile), `${licenseFile} must ship in the tarball`);
});

test("every runtime dependency of bin/nova ships as a dependency, not a devDependency", () => {
  // bin/nova drives the tsx loader at runtime; `npm install -g <tarball>` only
  // installs `dependencies`, so a devDependency tsx makes every `nova` call
  // exit 2 ("the tsx loader is not installed in this checkout").
  assert.ok(pkg.dependencies?.["tsx"] !== undefined, "tsx is a runtime dependency of the packaged CLI");
  assert.equal(pkg.devDependencies?.["tsx"], undefined, "tsx must not be dev-only");
  assert.ok(pkg.dependencies?.["better-sqlite3"] !== undefined, "the store driver ships");
  assert.ok(pkg.dependencies?.["@modelcontextprotocol/sdk"] !== undefined, "the MCP server ships");
test("the package declares allowScripts for the one native dep (npm >= 12 blocks install scripts)", () => {
  // npm 12 refuses `--allow-scripts` in a project-scoped install (EALLOWSCRIPTS),
  // so install.sh's default route needs the package's own field — without it the
  // better-sqlite3 prebuilt binding never lands and `nova daemon start` cannot
  // load its driver. Found by the 2026-11-24 stranger test on npm 12.2.3.
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    allowScripts?: Record<string, unknown>;
  };
  assert.equal(
    pkg.allowScripts?.["better-sqlite3"],
    true,
    "package.json must allow install scripts for better-sqlite3",
  );
});

});
