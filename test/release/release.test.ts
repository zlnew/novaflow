/**
 * Release pipeline tests (`novaflow-v100/testing` §2, Release Pipeline).
 *
 * `./release.sh check` runs `npm test`, so a test that calls `./release.sh check`
 * would recurse. These tests instead exercise the script's guards, its pure
 * helpers (sourced through the test-only `NOVAFLOW_RELEASE_LIB_ONLY` hook), the
 * `npm pack` allowlist, and the isolated tarball install smoke directly. The
 * end-to-end `./release.sh check` run is a manual gate, not a test.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureBuild, REPO_ROOT } from '../cli/helpers.js';

const RELEASE = join(REPO_ROOT, 'release.sh');
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_AGENTS_HOME', 'NOVAFLOW_HOME', 'NODE_AUTH_TOKEN'] as const;

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type ExtraEnv = Record<string, string>;

function release(
  args: readonly string[],
  env: ExtraEnv = {},
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [RELEASE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    input: '',
    env: { ...process.env, ...env },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Sources the script's helpers without running a subcommand. */
function lib(script: string, env: ExtraEnv = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    ['-c', `NOVAFLOW_RELEASE_LIB_ONLY=1 source ${JSON.stringify(RELEASE)}; ${script}`],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, input: '', env: { ...process.env, ...env } },
  );
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The `npm pack --dry-run --json` file list, normalised across npm versions. */
function packPaths(args: readonly string[] = ['pack', '--dry-run', '--json']): string[] {
  const result = spawnSync('npm', [...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `npm ${args.join(' ')} failed: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  const meta = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed as Record<string, unknown>)[0]) as {
    files: { path: string }[];
  };
  return meta.files.map((file) => file.path);
}

function currentBranch(): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

describe('release.sh script contract', () => {
  it('exists, is executable, and is syntactically valid bash', () => {
    accessSync(RELEASE, fsConstants.X_OK);
    assert.ok(statSync(RELEASE).isFile());
    const result = spawnSync('bash', ['-n', RELEASE], { encoding: 'utf8' });
    assert.equal(result.status, 0, `bash -n release.sh failed: ${result.stderr}`);
  });

  it('opens with the bash shebang and fails fast under set -euo pipefail', () => {
    const script = readFileSync(RELEASE, 'utf8');
    assert.ok(script.startsWith('#!/usr/bin/env bash'), 'release.sh must start with #!/usr/bin/env bash');
    assert.match(script, /^set -euo pipefail$/m);
  });

  it('documents every subcommand in the help text and exits 0', () => {
    const result = release([ '--help']);
    assert.equal(result.code, 0);
    const text = result.stdout + result.stderr;
    for (const fragment of [
      'check',
      'bump <major|minor|patch|X.Y.Z>',
      'pr',
      'tag',
      'publish',
      '--dry-run',
      '--confirm',
      '--otp',
      '--tag <dist-tag>',
    ]) {
      assert.ok(text.includes(fragment), `help must mention ${fragment}`);
    }
  });

  it('exits 2 for an unknown subcommand or a missing subcommand', () => {
    for (const args of [[], ['nonsense']]) {
      const result = release(args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must exit 2`);
      assert.ok((result.stderr + result.stdout).length > 0, 'usage must be printed');
    }
  });
});

describe('release.sh argument guards', () => {
  it('rejects a missing or invalid bump target with a usage error', () => {
    for (const args of [['bump'], ['bump', 'banana'], ['bump', '1.2']]) {
      const result = release(args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must exit 2, got ${result.code}: ${result.stderr}`);
      assert.match(result.stderr, /major\|minor\|patch|X\.Y\.Z/);
    }
  });

  it('rejects an unknown publish flag and a flag missing its value', () => {
    for (const args of [
      ['publish', '--bogus'],
      ['publish', '--otp'],
      ['publish', '--tag'],
    ]) {
      const result = release(args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must exit 2, got ${result.code}: ${result.stderr}`);
    }
  });

  it('exits 2 when --dry-run and --confirm are combined', () => {
    const result = release(['publish', '--dry-run', '--confirm']);
    assert.equal(result.code, 2, `expected exit 2, got ${result.code}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot combine --dry-run and --confirm/);
  });

  it('exits 2 when --confirm needs an OTP and stdin is not a TTY', () => {
    const result = lib('require_publish_otp_ready 1 "" </dev/null', {
      NODE_AUTH_TOKEN: '',
      NOVAFLOW_NPM_BYPASS_2FA: '0',
    });
    assert.equal(result.code, 2, `expected exit 2, got ${result.code}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--otp/);
    assert.match(result.stderr, /NODE_AUTH_TOKEN/);
  });

  it('does not demand an OTP when NODE_AUTH_TOKEN or explicit bypass opt-in is configured', () => {
    const withEnv = lib('require_publish_otp_ready 1 "" </dev/null', {
      NODE_AUTH_TOKEN: 'npm_fake_token_for_guards',
      NOVAFLOW_NPM_BYPASS_2FA: '0',
    });
    assert.equal(withEnv.code, 0, withEnv.stderr);

    const withOptIn = lib('require_publish_otp_ready 1 "" </dev/null', {
      NODE_AUTH_TOKEN: '',
      NOVAFLOW_NPM_BYPASS_2FA: '1',
    });
    assert.equal(withOptIn.code, 0, withOptIn.stderr);
  });

  it('accepts publish --help without running a preflight', () => {
    const result = release(['publish', '--help']);
    assert.equal(result.code, 0);
    assert.ok((result.stdout + result.stderr).includes('--otp'));
  });
});

describe('release.sh helpers', () => {
  it('requires the exact branch', () => {
    const branch = currentBranch();
    const onDevelop = lib('require_branch develop');
    if (branch === 'develop') {
      assert.equal(onDevelop.code, 0, onDevelop.stderr);
    } else {
      assert.equal(onDevelop.code, 1, `expected exit 1, got ${onDevelop.code}`);
      assert.match(onDevelop.stderr, /must run on 'develop'/);
    }
    const onCurrent = lib(`require_branch ${JSON.stringify(branch)}`);
    assert.equal(onCurrent.code, 0, `require_branch ${branch} must pass: ${onCurrent.stderr}`);
  });

  it('extracts a changelog section body for the exact version only', () => {
    const dir = scratchDir('novaflow-changelog-');
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(
      file,
      [
        '# Changelog',
        '',
        '## [1.0.0-rc.1] — 2026-11-20',
        '',
        '- Release candidate.',
        '',
        '## [1.0.0] — 2026-11-28',
        '',
        'First stable release.',
        '',
        '- Ships the daemonless ledger.',
        '',
        '## [0.9.0] — 2026-11-01',
        '',
        '- Older.',
        '',
      ].join('\n'),
    );

    const good = lib(`changelog_notes 1.0.0 ${JSON.stringify(file)}`);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /First stable release\./);
    assert.match(good.stdout, /daemonless ledger/);
    assert.doesNotMatch(good.stdout, /Older\./);
    assert.doesNotMatch(good.stdout, /Release candidate\./);

    const missing = lib(`changelog_notes 0.8.0 ${JSON.stringify(file)}`);
    assert.equal(missing.code, 1, 'a missing section must fail');
    assert.match(missing.stderr, /## \[0\.8\.0\]/);

    const rcOnly = lib(`changelog_notes 1.0.0-rc ${JSON.stringify(file)}`);
    assert.equal(rcOnly.code, 1, 'a suffix-only heading must not satisfy a different version');
  });

  it('refuses an empty, unreleased, or placeholder changelog section', () => {
    const dir = scratchDir('novaflow-changelog-empty-');
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(
      file,
      ['# Changelog', '', '## [1.0.0] — 2026-11-28', '', '', '## [0.9.0] — 2026-11-01', '', '- Older.', ''].join('\n'),
    );
    const result = lib(`changelog_notes 1.0.0 ${JSON.stringify(file)}`);
    assert.equal(result.code, 1, 'an empty section must fail');
    assert.match(result.stderr, /empty/);

    writeFileSync(
      file,
      [
        '# Changelog',
        '',
        '## [1.0.0] — unreleased',
        '',
        'Write what changed for the user, then run ./release.sh tag.',
        '',
      ].join('\n'),
    );
    const unreleased = lib(`changelog_notes 1.0.0 ${JSON.stringify(file)}`);
    assert.equal(unreleased.code, 1);
    assert.match(unreleased.stderr, /unreleased/);

    writeFileSync(
      file,
      [
        '# Changelog',
        '',
        '## [1.0.0] — 2026-11-28',
        '',
        'Write what changed for the user, then run ./release.sh tag.',
        '',
      ].join('\n'),
    );
    const placeholder = lib(`changelog_notes 1.0.0 ${JSON.stringify(file)}`);
    assert.equal(placeholder.code, 1);
    assert.match(placeholder.stderr, /placeholder/);

    const real = lib(`changelog_notes 1.0.0 ${JSON.stringify(join(REPO_ROOT, 'CHANGELOG.md'))}`);
    assert.equal(real.code, 0, real.stderr);
    assert.match(real.stdout, /SQLite WAL/);
  });

  it('accepts the real pack allowlist and rejects a leaked tree', () => {
    const real = packPaths();
    const ok = lib(`printf '%s\\n' ${real.map((path) => JSON.stringify(path)).join(' ')} | check_pack_paths`);
    assert.equal(ok.code, 0, ok.stderr);

    const leaked = [...real, 'src/cli/index.ts', 'test/release/release.test.ts', '.novaflow/state.db'];
    const bad = lib(`printf '%s\\n' ${leaked.map((path) => JSON.stringify(path)).join(' ')} | check_pack_paths`);
    assert.equal(bad.code, 1, 'src/, test/, and .novaflow/ must fail the allowlist');
    assert.match(bad.stderr, /src\/|test\/|\.novaflow\//);

    const missingSkill = real.filter((path) => path !== 'skills/novaflow/SKILL.md');
    const withoutSkill = lib(`printf '%s\\n' ${missingSkill.map((path) => JSON.stringify(path)).join(' ')} | check_pack_paths`);
    assert.equal(withoutSkill.code, 1, 'a missing skills/novaflow/SKILL.md must fail');
    assert.match(withoutSkill.stderr, /skills\/novaflow\/SKILL\.md/);
  });

  it('prints the exact --confirm command to run after a dry run', () => {
    const plain = lib('next_publish_command latest ""');
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout.trim(), './release.sh publish --confirm --tag latest');

    const withOtp = lib('next_publish_command next 123456');
    assert.equal(withOtp.stdout.trim(), './release.sh publish --confirm --tag next --otp <code>');
  });
});

describe('package manifest and legacy cleanup', () => {
  it('declares the v1.0.0 publication contract', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
      description: string;
      keywords: string[];
      scripts: Record<string, string>;
      bin: Record<string, string>;
      files: string[];
    };
    assert.equal(pkg.version, '1.0.0');
    assert.equal(pkg.scripts.prepublishOnly, 'npm run typecheck && npm run build && npm test');
    for (const keyword of ['cli', 'mcp', 'sqlite', 'tasks', 'orchestration', 'agentskills']) {
      assert.ok(pkg.keywords.includes(keyword), `package.json keywords must include ${keyword}`);
    }
    assert.match(pkg.description, /SQLite/i);
    assert.deepEqual(pkg.bin, { novaflow: './bin/novaflow' });
    assert.ok(pkg.files.includes('dist/'));
  });

  it('drops the obsolete v0.x installer and its daemon surface from the README', () => {
    assert.equal(existsSync(join(REPO_ROOT, 'install.sh')), false, 'install.sh must be removed');
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    for (const forbidden of ['install.sh', 'nova daemon', 'nova task', 'nova workspace', '~/novaflow/novaflow.sock']) {
      assert.ok(!readme.includes(forbidden), `README.md must not mention ${forbidden}`);
    }
    for (const required of ['npm install -g novaflow', '.novaflow/', 'novaflow skill install', 'release.sh']) {
      assert.ok(readme.includes(required), `README.md must mention ${required}`);
    }
  });

  it('documents the v1.0.0 command set in AGENTS.md', () => {
    const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    for (const required of ['npm run typecheck', 'npm run build', 'npm test', './release.sh check', 'node:sqlite', 'dist/']) {
      assert.ok(agents.includes(required), `AGENTS.md must mention ${required}`);
    }
  });
});

describe('published tarball', () => {
  it('packs, installs into an isolated prefix, and runs the smoke commands without host mutation', () => {
    ensureBuild();
    const work = scratchDir('novaflow-tarball-');

    const packed = spawnSync('npm', ['pack', '--pack-destination', work], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
    const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
    assert.ok(tarball, 'npm pack produced no .tgz');

    const prefix = join(work, 'prefix');
    const installed = spawnSync(
      'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--offline', join(work, tarball)],
      { cwd: work, encoding: 'utf8', timeout: 300_000 },
    );
    assert.equal(installed.status, 0, `npm install -g failed: ${installed.stderr}`);
    assert.doesNotMatch(installed.stdout + installed.stderr, /node-gyp|prebuild-install/, 'no native compilation');

    const bin = join(prefix, 'bin', 'novaflow');
    accessSync(bin, fsConstants.X_OK);

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const native = walk(prefix).filter((path) => path.endsWith('.node') || path.endsWith('binding.gyp'));
    assert.deepEqual(native, [], 'the tarball must not ship native artifacts');

    const home = join(work, 'home');
    const workspace = join(work, 'ws');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const isolated: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_AGENTS_HOME: join(home, '.agents'),
      NOVAFLOW_HOME: join(home, '.novaflow'),
    };
    const smoke = (args: readonly string[]) =>
      spawnSync(bin, [...args], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 60_000,
        input: '',
        env: { ...process.env, ...isolated },
      });

    const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const versionRun = smoke(['--version']);
    assert.equal(versionRun.status, 0, versionRun.stderr);
    assert.equal(versionRun.stdout.trim(), `novaflow ${version.version}`);

    const created = smoke(['workspace', 'create', '--name', 'release-smoke', '--path', workspace, '--json']);
    assert.equal(created.status, 0, `workspace create failed: ${created.stderr}`);
    const createdEnvelope = JSON.parse(created.stdout) as { ok: boolean; data: { workspace: { name: string } } };
    assert.equal(createdEnvelope.ok, true);
    assert.equal(createdEnvelope.data.workspace.name, 'release-smoke');

    const skill = smoke(['skill', 'install', '--dry-run', '--json']);
    assert.equal(skill.status, 0, `skill install --dry-run failed: ${skill.stderr}`);
    const skillEnvelope = JSON.parse(skill.stdout) as { ok: boolean; data: { dry_run: boolean; changed: boolean } };
    assert.equal(skillEnvelope.ok, true);
    assert.equal(skillEnvelope.data.dry_run, true);
    assert.equal(
      existsSync(join(home, '.agents', 'skills', 'novaflow')),
      false,
      'a dry run must not write the canonical skill directory',
    );
  });
});
