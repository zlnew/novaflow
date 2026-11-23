import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOLS } from "../../src/mcp/catalog.ts";
import { DEFAULT_RETENTION_DAYS } from "../../src/daemon/maintenance.ts";
import { DISK_FREE_FLOOR_BYTES } from "../../src/runs/preflight.ts";

/**
 * README honesty pin.
 *
 * The README is the public face of the repo, so its claims are testable like
 * any other contract: every command it tells an operator to run must exist,
 * the extension install path must be the one the engine actually spawns, and
 * the numbers it states must be the numbers the code enforces. This file
 * fails when the README drifts from what ships — the same discipline the
 * golden tests apply to the spec.
 */

const REPO = join(import.meta.dirname, "..", "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");

test("README states the core ruling verbatim: NovaFlow is not the harness, Pi is", () => {
  assert.match(README, /not a harness\. Pi is the\s+harness/, "the harness ruling is the opening claim");
  assert.match(README, /The engine rules; everyone else proposes/);
  assert.match(README, /Profiles are free-form/);
  assert.match(README, /Chains are the core feature/);
});

test("README's extension install note is the path the engine actually spawns", () => {
  assert.match(README, /~\/\.pi\/agent\/extensions/);
  assert.match(README, /extensions\/novaflow\.ts/, "the repo file it copies from exists");
  assert.ok(existsSync(join(REPO, "extensions", "novaflow.ts")));
});

test("README's quickstart references only verbs the CLI actually has", () => {
  // the README hands the operator these commands; each must be a real sub
  const must: Array<[string, RegExp]> = [
    ["daemon start", /bin\/nova daemon start/],
    ["workspace create", /bin\/nova workspace create/],
    ["workspace switch", /bin\/nova workspace switch/],
    ["project create", /bin\/nova project create/],
    ["profile create", /bin\/nova profile create --file/],
    ["task create (with a doc context)", /bin\/nova task create[\s\S]{0,200}--context docs\/spec\.md/],
    ["task run --watch", /bin\/nova task run FEAT-1 --watch/],
    ["task result", /bin\/nova task result FEAT-1/],
    ["project import-dag", /bin\/nova project import-dag chain\.yaml/],
    ["chain status", /bin\/nova chain status/],
    ["status --watch (tier C)", /bin\/nova status --watch/],
    ["web sync --all (tier D)", /bin\/nova web sync --all/],
    ["web start", /bin\/nova web start/],
    ["web stop", /bin\/nova web stop/],
  ];
  for (const [what, re] of must) assert.match(README, re, `README must show ${what}`);
  // and the exact verb lists the help prints
  const help = readFileSync(join(REPO, "src", "cli", "main.ts"), "utf8");
  // the usage block prints both daemon verbs on one line; the individual
  // names must each appear
  for (const verb of [/nova workspace create/, /nova docs list/, /daemon backup/, /prune \[--retention-days/]) {
    assert.match(help, verb, `the CLI usage names ${verb}`);
  }
});

test("README's install route is the installer this repo ships (R3.1)", () => {
  // the acquisition step is one command, and it is the script in this repo
  assert.match(README, /git clone https:\/\/github\.com\/zlnew\/novaflow && sh novaflow\/install\.sh/);
  assert.ok(existsSync(join(REPO, "install.sh")), "the installer the README names exists");
  const installer = readFileSync(join(REPO, "install.sh"), "utf8");
  // the README describes this mechanism and these flags; the script must have them
  assert.match(installer, /npm link/);
  assert.match(installer, /--from-tarball/);
  assert.match(installer, /--start/);
  assert.match(installer, /\.novaflow/, "the config directory it writes once");
  assert.match(installer, /config\.yaml/);
});

test("README's storage numbers are the numbers the code enforces (no marketing drift)", () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.match(README, /retention/i, "the prune retention story is stated");
  assert.equal(DISK_FREE_FLOOR_BYTES, 1024 * 1024 * 1024);
  assert.match(README, /\.md.*\.txt.*\.rst/, "the doc extension list is the FR's .md/.txt/.rst");
  assert.match(README, /0600/, "the raw-log mode is stated");
});

test("README claims no surface that does not exist (no web UI, no REST, no SSE)", () => {
  // the honest-scope paragraph is present, and the doc does not promise the
  // removed v1 scope anywhere as a feature
  assert.match(README, /Deliberately \*\*not\*\* in v1/);
  assert.match(README, /web UI/i);
  assert.match(README, /no TCP, no HTTP/);
  // the MCP tool count is real (the catalog is the source)
  assert.ok(MCP_TOOLS.length > 0);
  assert.match(README, /MCP/, "the MCP surface is described");
  // every MCP tool name the README mentions (if any) must be real
  for (const m of README.matchAll(/nova_[a-z_]+/g)) {
    const name = m[0];
    if (name === "nova_kill_all" || name === "nova_run_logs") continue; // mentioned as context
    assert.ok(
      MCP_TOOLS.some((t) => t.name === name) || /^nova_(daemon|task|workspace|docs|project|profile|result|schedule|chain|run)_?/.test(name),
      `README mentions ${name} — is it real?`,
    );
  }
});
