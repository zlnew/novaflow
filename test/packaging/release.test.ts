import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `release.sh tag` and `release.sh publish`, exercised as a real script.
 *
 * The fixture is a throwaway git repository with a bare `origin` beside it, a
 * package.json at version 0.4.0 and a CHANGELOG with two sections. `npm` and
 * `gh` are stubs that record their argv (and, for gh, the notes file it was
 * handed); `git` and `node` are the real binaries, because the point is the
 * script's own refusals, not a mock of git.
 *
 * The refusals are the contract: a dirty tree, a red suite, a missing tag, a
 * version already on the registry, and a missing `--confirm` all stop before
 * anything is uploaded, and the notes file is the changelog section.
 */

const REPO = join(import.meta.dirname, "..", "..");
const RELEASE = join(REPO, "release.sh");
const SH = "/bin/sh";

const CHANGELOG = `# Changelog

## [0.4.0] — 2026-11-24

Publication release: the docs are written for a stranger.

- **\`nova status\` prints one screen.**
- **\`./release.sh publish\` refuses a missing --confirm.**

## [0.3.2] — 2026-11-24

- An older fix that must not appear in the 0.4.0 notes.
`;

type Fixture = {
  dir: string;
  repo: string;
  origin: string;
  bin: string;
  env: NodeJS.ProcessEnv;
};

type Run = { code: number; stdout: string; stderr: string };

function realBinary(name: string): string {
  const res = spawnSync(SH, ["-c", `command -v ${name}`], { encoding: "utf8" });
  const path = (res.stdout ?? "").trim();
  assert.notEqual(path, "", `${name} must exist on the test machine to run release.sh`);
  return path;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return String(res.stdout ?? "");
}

function writeStub(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!${SH}\n${body}\n`);
  chmodSync(path, 0o755);
}

type FixtureOptions = {
  /** create and push the v0.4.0 tag (publish needs it; tag must not exist) */
  tagged?: boolean;
  /** CHANGELOG content override */
  changelog?: string;
  /** package.json version override */
  version?: string;
};

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-release-"));
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);

  git(dir, ["init", "--bare", "-q", origin]);

  copyFileSync(RELEASE, join(repo, "release.sh"));
  chmodSync(join(repo, "release.sh"), 0o755);
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "novaflow", version: opts.version ?? "0.4.0" }, null, 2) + "\n",
  );
  writeFileSync(join(repo, "CHANGELOG.md"), opts.changelog ?? CHANGELOG);

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["config", "user.email", "release@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "tag.gpgsign", "false"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);

  if (opts.tagged === true) {
    git(repo, ["tag", "-a", "v0.4.0", "-m", "NovaFlow v0.4.0"]);
    git(repo, ["push", "-q", "origin", "v0.4.0"]);
  }

  // npm: records argv, answers `view` from the published list, fails `test` on demand
  writeStub(
    bin,
    "npm",
    [
      `log="${dir}/npm.log"`,
      `{ printf 'npm'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$log"`,
      `if [ "$1" = "view" ]; then`,
      `  ver=\${2##*@}`,
      `  if [ -f "${dir}/published" ] && grep -qx "$ver" "${dir}/published"; then printf '%s\\n' "$ver"; exit 0; fi`,
      `  printf 'npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/novaflow\\n' >&2`,
      `  exit 1`,
      `fi`,
      `if [ "$1" = "test" ] && [ -f "${dir}/red-suite" ]; then printf 'stub npm test: failing\\n' >&2; exit 1; fi`,
      `printf 'stub npm: %s\\n' "$*"`,
      `exit 0`,
    ].join("\n"),
  );

  // gh: a token for the owning account, argv recorded, --notes-file copied aside
  writeStub(
    bin,
    "gh",
    [
      `if [ "$1" = "auth" ] && [ "$2" = "token" ]; then printf '%s\\n' "stub-token"; exit 0; fi`,
      `log="${dir}/gh.log"`,
      `{ printf 'gh'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$log"`,
      `prev=""`,
      `for a in "$@"; do`,
      `  if [ "$prev" = "--notes-file" ]; then cp "$a" "${dir}/notes.md"; fi`,
      `  prev="$a"`,
      `done`,
      `printf 'stub gh: %s\\n' "$*"`,
      `exit 0`,
    ].join("\n"),
  );

  mkdirSync(join(dir, "home"));

  return {
    dir,
    repo,
    origin,
    bin,
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    } as NodeJS.ProcessEnv,
  };
}

function runRelease(f: Fixture, args: string[]): Run {
  const res = spawnSync(realBinary("bash"), [join(f.repo, "release.sh"), ...args], {
    cwd: f.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: f.env,
  });
  return { code: res.status ?? -1, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function logLines(f: Fixture, name: string): string[] {
  const path = join(f.dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").filter((line) => line !== "");
}

function publishLines(f: Fixture): string[] {
  return logLines(f, "npm.log").filter((line) => line.startsWith("npm publish"));
}

function withFixture(opts: FixtureOptions, body: (f: Fixture) => void): void {
  const f = makeFixture(opts);
  try {
    body(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

test("release.sh tag: the GitHub release body is the CHANGELOG section for the version", () => {
  withFixture({}, (f) => {
    const res = runRelease(f, ["tag"]);
    assert.equal(res.code, 0, res.stderr);

    // the release was created with a notes file, not a pointer at a pull request
    const ghLine = logLines(f, "gh.log").find((line) => line.startsWith("gh release create"));
    assert.ok(ghLine !== undefined, "no GitHub release was created");
    assert.match(ghLine, /^gh release create v0\.4\.0 --title NovaFlow v0\.4\.0 --notes-file /);

    const notes = readFileSync(join(f.dir, "notes.md"), "utf8");
    assert.match(notes, /Publication release: the docs are written for a stranger\./);
    assert.match(notes, /`\.\/release\.sh publish` refuses a missing --confirm\./);
    assert.equal(notes.includes("## [0.3.2]"), false, "the notes must be one version's section only");
    assert.equal(notes.includes("An older fix"), false, "the notes must not carry the previous section");
    assert.equal(notes.includes("## [0.4.0]"), false, "the heading is the release title, not the body");

    // the tag exists in both places
    assert.match(git(f.repo, ["tag", "--list", "v0.4.0"]), /v0\.4\.0/);
    assert.match(git(f.origin, ["tag", "--list", "v0.4.0"]), /v0\.4\.0/);
  });
});

test("release.sh tag: refuses when the changelog has no section for the version, naming the heading", () => {
  withFixture({ changelog: CHANGELOG.replace(/## \[0\.4\.0\][\s\S]*?(?=## \[0\.3\.2\])/, "") }, (f) => {
    const res = runRelease(f, ["tag"]);
    assert.notEqual(res.code, 0, "a missing changelog section must refuse the tag");
    assert.match(res.stderr, /CHANGELOG\.md has no "## \[0\.4\.0\]" section/);
    assert.equal(git(f.repo, ["tag", "--list", "v0.4.0"]).trim(), "", "no tag may be created");
    assert.deepEqual(logLines(f, "gh.log"), [], "no release may be created");
  });
});

test("release.sh publish: refuses without --confirm and uploads nothing", () => {
  withFixture({ tagged: true }, (f) => {
    const res = runRelease(f, ["publish"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /publish needs --confirm/);
    assert.match(res.stderr, /--dry-run/, "the refusal names the plan command");
    assert.deepEqual(publishLines(f), [], "an unconfirmed publish must not run npm publish at all");
  });
});

test("release.sh publish --dry-run: prints the plan and runs only the dry run", () => {
  withFixture({ tagged: true }, (f) => {
    const res = runRelease(f, ["publish", "--dry-run"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /package: novaflow/);
    assert.match(res.stdout, /version: 0\.4\.0/);
    assert.match(res.stdout, /https:\/\/www\.npmjs\.com\/package\/novaflow\/v\/0\.4\.0/);
    assert.deepEqual(publishLines(f), ["npm publish --dry-run"], "a dry run must not upload");
    assert.match(res.stdout, /nothing was uploaded/);
  });
});

test("release.sh publish: refuses a version the registry already has", () => {
  withFixture({ tagged: true }, (f) => {
    writeFileSync(join(f.dir, "published"), "0.4.0\n");
    const res = runRelease(f, ["publish", "--confirm"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /novaflow@0\.4\.0 is already on the registry/);
    assert.deepEqual(publishLines(f), []);
  });
});

test("release.sh publish: refuses on a red suite", () => {
  withFixture({ tagged: true }, (f) => {
    writeFileSync(join(f.dir, "red-suite"), "1\n");
    const res = runRelease(f, ["publish", "--confirm"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /npm test is red/);
    assert.deepEqual(publishLines(f), []);
    assert.equal(
      logLines(f, "npm.log").some((line) => line.startsWith("npm view")),
      false,
      "the registry is not consulted for a release that cannot pass its own suite",
    );
  });
});

test("release.sh publish: refuses a dirty tree", () => {
  withFixture({ tagged: true }, (f) => {
    writeFileSync(join(f.repo, "untracked.txt"), "not committed\n");
    const res = runRelease(f, ["publish", "--confirm"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /dirty tree/);
    assert.deepEqual(publishLines(f), []);
  });
});

test("release.sh publish: refuses when the tag does not exist locally", () => {
  withFixture({}, (f) => {
    const res = runRelease(f, ["publish", "--confirm"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no tag v0\.4\.0/);
    assert.match(res.stderr, /\.\/release\.sh tag/, "the refusal names the step that creates it");
    assert.deepEqual(publishLines(f), []);
  });
});

test("release.sh publish --confirm: the dry run comes first, then the upload, with the recorded argv", () => {
  withFixture({ tagged: true }, (f) => {
    const res = runRelease(f, ["publish", "--confirm"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(
      publishLines(f),
      ["npm publish --dry-run", "npm publish"],
      "a confirmed publish must run the dry run first and then the real upload",
    );
    assert.match(res.stdout, /package: novaflow/);
    assert.match(res.stdout, /version: 0\.4\.0/);
    assert.match(res.stdout, /https:\/\/www\.npmjs\.com\/package\/novaflow\/v\/0\.4\.0/);
    assert.match(res.stdout, /novaflow@0\.4\.0 published/);
  });
});
