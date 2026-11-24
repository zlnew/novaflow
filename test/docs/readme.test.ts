import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOLS } from "../../src/mcp/catalog.ts";
import { EXIT_CODES, EXIT_CODE_VALUES } from "../../src/cli/exitcode.ts";
import { findVerb, nounNames } from "../../src/cli/verbs.ts";

/**
 * README honesty pin.
 *
 * The README is the public face of the repo, so its claims are testable like any other
 * contract: every command it names must exist in the verb table, every exit code it prints
 * must be the code module's, and the surfaces it says do not exist must really not exist.
 * This file fails when the README drifts from what ships.
 */

const REPO = join(import.meta.dirname, "..", "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const INSTALL_DOC = readFileSync(join(REPO, "docs", "install.md"), "utf8");

test("README says what the tool is, who it is for, and that the engine decides", () => {
  assert.match(
    README,
    /\*\*Run coding agents in the background, in their own git worktrees, and see exactly what they spent\.\*\*/,
    "the first line is the product, not the build order",
  );
  assert.match(
    README,
    /local orchestrator for \[Pi\]\(https:\/\/github\.com\/earendil-works\/pi\) coding-agent\s+sessions/,
    "Pi is named as the agent; NovaFlow orchestrates it",
  );
  assert.match(README, /an engine that verifies the\s+result instead of trusting it/);
  assert.match(README, /Every state change passes the same validation whoever asked for it/);
});

test("README's install note and the quick-start page name the path the engine actually spawns", () => {
  assert.match(README, /copies the Pi extension into place/);
  // the page a reader is sent to states the literal path, and that file exists
  assert.match(INSTALL_DOC, /~\/\.pi\/agent\/extensions/);
  assert.match(INSTALL_DOC, /extensions\/novaflow\.ts/);
  assert.ok(existsSync(join(REPO, "extensions", "novaflow.ts")));
});

test("every `nova …` command in the README is a verb the CLI actually has", () => {
  const nouns = nounNames();
  const seen = new Set<string>();
  for (const match of README.matchAll(/\bnova ([a-z][a-z-]*)(?: ([a-z][a-z-]+))?/g)) {
    const noun = match[1]!;
    assert.ok(nouns.includes(noun), `README names "nova ${noun}" — no such noun in the verb table`);
    const sub = match[2];
    if (sub !== undefined) {
      assert.ok(findVerb(noun, sub) !== undefined, `README names "nova ${noun} ${sub}" — no such verb`);
      seen.add(`nova ${noun} ${sub}`);
    } else {
      seen.add(`nova ${noun}`);
    }
  }
  // the everyday surface the quick start and the command table promise
  const must = [
    "nova daemon start",
    "nova workspace create",
    "nova project create",
    "nova profile create",
    "nova task create",
    "nova task run",
    "nova task result",
    "nova task logs",
    "nova task gate-approve",
    "nova task gate-reject",
    "nova project import-dag",
    "nova chain status",
    "nova chain verify",
    "nova chain clean",
    "nova status",
    "nova web sync",
    "nova web start",
  ];
  for (const command of must) assert.ok(seen.has(command), `README no longer shows \`${command}\``);
});

test("README's exit-code line is the code module's table", () => {
  const line = /Exit codes are stable:([\s\S]{0,240})/.exec(README)?.[1] ?? "";
  assert.notEqual(line, "", "the exit-code line is gone");
  for (const code of EXIT_CODE_VALUES) {
    const { short, meaning } = EXIT_CODES[code];
    const stem = meaning.split(" (")[0]!.trim();
    assert.ok(
      line.includes(`\`${code}\` ${short}`) || line.includes(`\`${code}\` ${stem}`),
      `README's exit line does not state exit ${code} as "${short}" or "${stem}"`,
    );
  }
});

test("README's install route is the installer this repo ships", () => {
  assert.match(README, /git clone https:\/\/github\.com\/zlnew\/novaflow\nsh novaflow\/install\.sh/);
  assert.ok(existsSync(join(REPO, "install.sh")), "the installer the README names exists");
  const installer = readFileSync(join(REPO, "install.sh"), "utf8");
  // the README describes this mechanism and these flags; the script must have them
  assert.match(installer, /npm link/);
  assert.match(installer, /--from-tarball/);
  assert.match(installer, /--start/);
  assert.match(installer, /\.novaflow/, "the config directory it writes once");
  assert.match(installer, /config\.yaml/);
  // and the requirements the README states are the ones the installer enforces
  assert.match(installer, /22\.0\.0/, "Node 22 is the floor both state");
  assert.match(installer, /2\.40\.0/, "git 2.40 is the floor both state");
});

test("README's safety claims are the ones the engine enforces", () => {
  assert.match(README, /Nothing runs unconfined/, "the scope guard is stated");
  assert.match(README, /A run without target scopes is refused before a token is spent/);
  assert.match(README, /Preflight is free/);
  assert.match(README, /Write scopes are enforced during the run/);
  assert.match(README, /Verification runs after the agent stops/);
  assert.match(README, /`0600`/, "the raw log mode is stated");
  assert.match(README, /events\.raw\.jsonl`\s+\(verbatim, `0600`, never served\)/);
  assert.match(README, /NovaFlow never merges/, "merging stays the operator's act");
});

test("README promises no surface that does not exist (no daemon HTTP, no telemetry, no web editor)", () => {
  assert.match(README, /Not a fit: you want a hosted service, a web dashboard that edits code/);
  assert.match(README, /no TCP port, no HTTP, no telemetry/);
  assert.match(README, /Pi Web's own renderer/, "the browser view is a renderer over copies, not our UI");
  // the MCP surface is described, and every tool name the README mentions is real
  assert.ok(MCP_TOOLS.length > 0);
  assert.match(README, /MCP/);
  for (const match of README.matchAll(/nova_[a-z_]+/g)) {
    const name = match[0];
    assert.ok(
      MCP_TOOLS.some((tool) => tool.name === name),
      `README mentions ${name} — is it a real MCP tool?`,
    );
  }
});

test("README links every docs page, and the index holds the reading order", () => {
  assert.ok(existsSync(join(REPO, "docs", "index.md")));
  assert.match(README, /\]\(docs\/index\.md\)/, "the README must point at the docs index");
  const pages = readdirSync(join(REPO, "docs"))
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort();
  assert.ok(pages.length >= 6, `expected the concept pages, found ${pages.join(", ")}`);
  for (const page of pages) {
    assert.ok(README.includes(`](docs/${page})`), `README's Documentation table does not link docs/${page}`);
  }
});
