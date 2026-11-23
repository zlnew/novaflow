import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDaemonConfig } from "../../src/daemonconfig.ts";

/**
 * `install.sh` (novaflow-v030 W3 / R3.1), exercised as a real script.
 *
 * The script is run under a hermetic PATH: a stub directory holding fake
 * `node`/`npm`/`pi`/`git`/`sqlite3`/`nova` and symlinks to the six coreutils
 * the script itself uses, prepended to nothing — PATH is the stub dir ALONE, so
 * "pi is not on PATH" is produced by the absence of a stub, not by whatever the
 * test machine happens to have installed. HOME is a temp dir, so every write
 * the script makes ($HOME/.pi/agent/extensions, $HOME/.novaflow) lands in the
 * fixture and the assertions can diff the whole home.
 */

const REPO = join(import.meta.dirname, "..", "..");
const INSTALL = join(REPO, "install.sh");
const EXT_SRC = join(REPO, "extensions", "novaflow.ts");
const SH = "/bin/sh";

/** The coreutils install.sh is allowed to shell out to (POSIX, non-builtin). */
const COREUTILS = ["awk", "basename", "cat", "cmp", "cp", "dirname", "mkdir"];

function realPathOf(name: string): string {
  const res = spawnSync(SH, ["-c", `command -v ${name}`], { encoding: "utf8" });
  const path = (res.stdout ?? "").trim();
  assert.notEqual(path, "", `${name} must exist on the test machine to build the stub PATH`);
  return path;
}

type StubOptions = {
  /** what `node -v` prints (null = node is not on PATH) */
  node?: string | null;
  /** what `git --version` prints (null = git is not on PATH) */
  git?: string | null;
  /** what `pi --version` prints (null = pi is not on PATH) */
  pi?: string | null;
  /** what `sqlite3 --version` prints (null = sqlite3 is not on PATH) */
  sqlite3?: string | null;
  /** put a `nova` stub on PATH (records its argv) */
  nova?: boolean;
};

type Fixture = {
  dir: string;
  home: string;
  bin: string;
  env: Record<string, string>;
};

function writeStub(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!${SH}\n${body}\n`);
  chmodSync(path, 0o755);
}

function makeFixture(opts: StubOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-install-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  for (const name of COREUTILS) symlinkSync(realPathOf(name), join(bin, name));

  const node = opts.node === undefined ? "v24.21.0" : opts.node;
  if (node !== null) writeStub(bin, "node", `printf '%s\\n' '${node}'`);

  // npm/nova record their argv so the test can pin the install MECHANISM
  writeStub(
    bin,
    "npm",
    `if [ "$1" = "--version" ]; then printf '%s\\n' '11.0.0'; exit 0; fi\n` +
      `printf 'npm' >> '${join(dir, "npm.log")}'\n` +
      `for a in "$@"; do printf ' %s' "$a" >> '${join(dir, "npm.log")}'; done\n` +
      `printf '\\n' >> '${join(dir, "npm.log")}'\n` +
      `printf 'stub npm: %s\\n' "$*"`,
  );

  const pi = opts.pi === undefined ? "1.6.0" : opts.pi;
  if (pi !== null) writeStub(bin, "pi", `printf '%s\\n' '${pi}'`);

  const git = opts.git === undefined ? "git version 2.56.1" : opts.git;
  if (git !== null) writeStub(bin, "git", `printf '%s\\n' '${git}'`);

  const sqlite3 = opts.sqlite3 === undefined ? "3.54.0 2026-10-09 15:46:58" : opts.sqlite3;
  if (sqlite3 !== null) writeStub(bin, "sqlite3", `printf '%s\\n' '${sqlite3}'`);

  if (opts.nova === true) {
    writeStub(
      bin,
      "nova",
      `printf 'nova' >> '${join(dir, "nova.log")}'\n` +
        `for a in "$@"; do printf ' %s' "$a" >> '${join(dir, "nova.log")}'; done\n` +
        `printf '\\n' >> '${join(dir, "nova.log")}'\n` +
        `printf 'daemon started (stub)\\n'`,
    );
  }

  return {
    dir,
    home,
    bin,
    env: { ...process.env, HOME: home, PATH: bin } as Record<string, string>,
  };
}

type Run = { code: number; stdout: string; stderr: string };

function runInstall(f: Fixture, args: string[] = [], cwd = REPO): Run {
  const res = spawnSync(SH, [INSTALL, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: f.env,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function logLines(f: Fixture, name: string): string[] {
  const path = join(f.dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").filter((l) => l !== "");
}

/** Every file under `root`, with its content and mtime — the idempotency diff. */
function snapshot(root: string): Array<{ rel: string; content: string; mtimeMs: number }> {
  const out: Array<{ rel: string; content: string; mtimeMs: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        out.push({
          rel: path.slice(root.length),
          content: readFileSync(path, "utf8"),
          mtimeMs: Math.trunc(statSync(path).mtimeMs),
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const CONFIG = ".novaflow/config.yaml";
const EXT = ".pi/agent/extensions/novaflow.ts";

test("install.sh is POSIX sh and passes `sh -n`", () => {
  assert.ok(existsSync(INSTALL), "install.sh exists at the repo root");
  const text = readFileSync(INSTALL, "utf8");
  assert.match(text, /^#!\/bin\/sh\n/, "the shebang is POSIX sh");
  assert.match(text, /^set -eu$/m, "set -eu");
  const syntax = spawnSync(SH, ["-n", INSTALL], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `sh -n install.sh: ${syntax.stderr}`);
});

test("install.sh --from-source: deps + `npm link`, extension, pinned config, the three next commands", () => {
  const f = makeFixture();
  try {
    const res = runInstall(f);
    assert.equal(res.code, 0, res.stderr);

    // the chosen mechanism: `npm install` in the checkout, then `npm link`
    // (a plain `npm install -g .` would omit tsx and break bin/nova)
    assert.deepEqual(logLines(f, "npm.log"), ["npm install", "npm link"]);

    // the acquisition route is named on screen (R3.1)
    assert.match(res.stdout, /git clone https:\/\/github\.com\/zlnew\/novaflow && sh novaflow\/install\.sh/);

    // the extension is deployed from this checkout, byte for byte
    assert.equal(readFileSync(join(f.home, EXT), "utf8"), readFileSync(EXT_SRC, "utf8"));
    assert.match(res.stdout, /\/reload/, "the reload instruction is printed after a deploy");

    // the config is the pinned shape, and the daemon's own loader accepts it
    const parsed = parseDaemonConfig(readFileSync(join(f.home, CONFIG), "utf8"));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    if (parsed.ok) {
      assert.deepEqual(parsed.config.budgets, { dailyUsd: 5, monthlyUsd: 40 });
      assert.equal(parsed.config.concurrency.global, 4);
      assert.equal(parsed.config.retry.delaySec, 300);
      assert.deepEqual(parsed.config.wake, { enabled: true, workspace: null });
    }

    // exactly the three next commands
    assert.match(res.stdout, /nova daemon start --migrate/);
    assert.match(res.stdout, /nova workspace create <name> --path <dir>/);
    assert.match(res.stdout, /nova project create <name> --objective "<text>"/);

    // no daemon without --start
    assert.deepEqual(logLines(f, "nova.log"), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh is idempotent: a second run with the same flags changes nothing (and never the store)", () => {
  const f = makeFixture({ nova: true });
  try {
    // a pre-existing store + a pre-existing config that must survive
    mkdirSync(join(f.home, ".novaflow"), { recursive: true });
    writeFileSync(join(f.home, ".novaflow", "state.db"), "SENTINEL-STORE\n");

    const first = runInstall(f, ["--from-source"]);
    assert.equal(first.code, 0, first.stderr);
    const afterFirst = snapshot(f.home);

    // a second identical run: no file added, removed, rewritten or retouched
    const second = runInstall(f, ["--from-source"]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(snapshot(f.home), afterFirst, "the second run changed the fake home");
    assert.match(second.stdout, /left alone/, "the extension is reported as already current");
    assert.match(second.stdout, /keeping the existing/, "the config is reported as kept");
    assert.equal(readFileSync(join(f.home, ".novaflow", "state.db"), "utf8"), "SENTINEL-STORE\n");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh refuses a missing pi, names the fix, and installs nothing", () => {
  const f = makeFixture({ pi: null });
  try {
    const res = runInstall(f);
    assert.notEqual(res.code, 0, "a missing pi refuses the install");
    assert.match(res.stderr, /pi is not on PATH/);
    assert.match(res.stderr, /npm install -g @earendil-works\/pi-coding-agent/, "the fix is named");
    assert.equal(existsSync(join(f.home, CONFIG)), false, "nothing was written");
    assert.equal(existsSync(join(f.home, EXT)), false, "the extension was not deployed");
    assert.deepEqual(logLines(f, "npm.log"), [], "npm never ran");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh refuses a missing git and an old git (>= 2.40), naming the fix", () => {
  const missing = makeFixture({ git: null });
  try {
    const res = runInstall(missing);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /git is not on PATH/);
    assert.match(res.stderr, /install git/i, "the fix is named");
    assert.equal(existsSync(join(missing.home, CONFIG)), false);
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }

  const old = makeFixture({ git: "git version 2.39.5" });
  try {
    const res = runInstall(old);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /git 2\.39\.5 is older than 2\.40/);
    assert.match(res.stderr, /upgrade git/i, "the fix is named");
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }
});

test("install.sh refuses an old node (< 22) and an unknown flag (usage, exit 2)", () => {
  const old = makeFixture({ node: "v20.11.1" });
  try {
    const res = runInstall(old);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /node 20\.11\.1 is older than 22/);
    assert.match(res.stderr, /nvm install 22/, "the fix is named");
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }

  const f = makeFixture();
  try {
    const res = runInstall(f, ["--bogus"]);
    assert.equal(res.code, 2, "an unknown flag is a usage error");
    assert.match(res.stderr, /unknown option "--bogus"/);
    assert.match(res.stderr, /usage: sh install\.sh/);
    assert.deepEqual(logLines(f, "npm.log"), [], "nothing was installed");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh keeps an existing config verbatim (only written when absent)", () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.home, ".novaflow"), { recursive: true });
    const mine = "budgets:\n  daily_usd: 1.0\n  monthly_usd: 2.0\nconcurrency:\n  global: 2\nretry:\n  delay_sec: 60\nwake:\n  enabled: false\n  workspace: null\n";
    writeFileSync(join(f.home, CONFIG), mine);
    const res = runInstall(f);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(readFileSync(join(f.home, CONFIG), "utf8"), mine, "the operator's config was overwritten");
    assert.match(res.stdout, /keeping the existing/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh warns instead of overwriting a different extension; --force-ext replaces it", () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(join(f.home, EXT), "// an older novaflow extension\n");
    const res = runInstall(f);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /differs from this checkout's extensions\/novaflow\.ts/);
    assert.match(res.stderr, /--force-ext/, "the remedy is named");
    assert.match(res.stdout, /\/reload/, "the reload instruction is still printed");
    assert.equal(readFileSync(join(f.home, EXT), "utf8"), "// an older novaflow extension\n");

    const forced = runInstall(f, ["--force-ext"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(readFileSync(join(f.home, EXT), "utf8"), readFileSync(EXT_SRC, "utf8"));
    assert.match(forced.stdout, /--force-ext/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh --start starts the daemon with --migrate (and only then)", () => {
  const f = makeFixture({ nova: true });
  try {
    const res = runInstall(f, ["--start"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(logLines(f, "nova.log"), ["nova daemon start --migrate"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh --from-tarball installs the packed artifact globally, not the checkout", () => {
  const f = makeFixture();
  try {
    const tgz = join(f.dir, "novaflow-0.3.0.tgz");
    writeFileSync(tgz, "not a real tarball\n");
    const res = runInstall(f, ["--from-tarball", tgz]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(logLines(f, "npm.log"), [`npm install -g ${tgz}`]);

    const missing = runInstall(f, ["--from-tarball", join(f.dir, "nope.tgz")]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /tarball not found/);
    assert.match(missing.stderr, /npm pack/, "the fix is named");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("install.sh warns (only) about an older sqlite3 — the driver is bundled", () => {
  const f = makeFixture({ sqlite3: "3.40.1 2023-01-01" });
  try {
    const res = runInstall(f);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /warning: sqlite3 3\.40\.1 is older than 3\.42/);
    assert.match(res.stderr, /bundles its own SQLite|better-sqlite3/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
