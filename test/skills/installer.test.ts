import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { seedGitRoot, seedMarker, seedUnmanaged, skillBox, type SkillBox } from './helpers.js';

const boxes: SkillBox[] = [];
function makeBox(options: { env?: Record<string, string> } = {}): SkillBox {
  const box = skillBox(options);
  boxes.push(box);
  return box;
}
after(() => {
  for (const box of boxes) box.dispose();
});

function states(targets: ReadonlyArray<{ harness: string; state: string }>): Record<string, string> {
  return Object.fromEntries(targets.map((target) => [target.harness, target.state]));
}

describe('skill install', () => {
  it('links only harnesses whose config directory already exists', () => {
    const box = makeBox();
    box.seed('claude');
    box.seed('pi');

    const envelope = box.json(['skill', 'install']);
    assert.equal(envelope.command, 'skill.install');
    assert.equal(envelope.data.dry_run, false);
    assert.equal(envelope.data.changed, true);
    assert.equal(envelope.data.version, '1.0.0');
    assert.deepEqual(states(envelope.data.targets), { claude: 'linked', pi: 'linked' });
    assert.ok(envelope.data.targets.every((target: { mode: string }) => target.mode === 'symlink'));

    assert.equal(box.state(box.paths.canonical), 'dir');
    assert.equal(box.state(box.paths.harness('claude')), 'symlink');
    assert.equal(box.state(box.paths.harness('pi')), 'symlink');
    assert.equal(existsSync(box.paths.configDir('codex')), false, 'auto-detection must not create ~/.codex');
    assert.equal(existsSync(box.paths.configDir('cursor')), false);

    assert.match(readFileSync(join(box.paths.harness('pi'), 'SKILL.md'), 'utf8'), /^---\nname: novaflow\n/);
    assert.ok(existsSync(join(box.paths.harness('pi'), 'references', 'cli-reference.md')));
  });

  it('writes the .novaflow-managed.json marker into the canonical store', () => {
    const box = makeBox();
    box.json(['skill', 'install']);
    const marker = box.marker(box.paths.canonical);
    assert.ok(marker, 'marker file must exist');
    assert.equal(marker.package, 'novaflow');
    assert.equal(marker.version, '1.0.0');
    assert.match(marker.installed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('copies instead of linking with --copy, creating an explicit harness path', () => {
    const box = makeBox();
    const envelope = box.json(['skill', 'install', '--agent', 'codex', '--copy']);
    assert.equal(box.state(box.paths.harness('codex')), 'dir');
    assert.equal(envelope.data.targets[0].mode, 'copy');
    assert.equal(envelope.data.targets[0].state, 'copied');
    assert.equal(box.marker(box.paths.harness('codex'))?.version, '1.0.0');
    assert.match(readFileSync(join(box.paths.harness('codex'), 'SKILL.md'), 'utf8'), /^---\nname: novaflow\n/);
  });

  it('converts an existing copy back to a symlink on a plain re-install', () => {
    const box = makeBox();
    box.json(['skill', 'install', '--agent', 'hermes', '--copy']);
    assert.equal(box.state(box.paths.harness('hermes')), 'dir');
    const envelope = box.json(['skill', 'install', '--agent', 'hermes']);
    assert.equal(envelope.data.targets[0].mode, 'symlink');
    assert.equal(envelope.data.targets[0].changed, true);
    assert.equal(box.state(box.paths.harness('hermes')), 'symlink');
  });

  it('is idempotent when the canonical version and links are current', () => {
    const box = makeBox();
    box.seed('claude');
    const first = box.json(['skill', 'install']);
    assert.equal(first.data.changed, true);

    const second = box.json(['skill', 'install']);
    assert.equal(second.data.changed, false);
    assert.equal(second.data.canonical.changed, false);
    assert.equal(second.data.targets[0].changed, false);
    assert.equal(box.state(box.paths.harness('claude')), 'symlink');
  });

  it('refuses an unmanaged directory with exit 3 and writes nothing', () => {
    const box = makeBox();
    seedUnmanaged(box.paths.harness('claude'));

    const result = box.run(['skill', 'install', '--agent', 'claude', '--json']);
    assert.equal(result.code, 3);
    const envelope = JSON.parse(result.stderr) as { ok: false; error: { code: string; message: string; hint?: string } };
    assert.equal(envelope.error.code, 'STATE_CONFLICT');
    assert.match(envelope.error.message, /claude/);
    assert.match(envelope.error.hint ?? '', /--force/);
    assert.equal(existsSync(box.paths.canonical), false, 'a refused run must not create the canonical store');
    assert.equal(readFileSync(join(box.paths.harness('claude'), 'SKILL.md'), 'utf8'), '# hand written skill\n');

    const forced = box.json(['skill', 'install', '--agent', 'claude', '--force']);
    assert.equal(forced.data.changed, true);
    assert.match(readFileSync(join(box.paths.harness('claude'), 'SKILL.md'), 'utf8'), /^---\nname: novaflow\n/);
  });

  it('refuses an unmanaged canonical directory with exit 3', () => {
    const box = makeBox();
    seedUnmanaged(box.paths.canonical);
    const result = box.run(['skill', 'install', '--json']);
    assert.equal(result.code, 3);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'STATE_CONFLICT');
    assert.match(envelope.error.message, /skills\/novaflow/);
    assert.equal(readFileSync(join(box.paths.canonical, 'SKILL.md'), 'utf8'), '# hand written skill\n');
  });

  it('rejects an unknown agent harness with exit 2', () => {
    const box = makeBox();
    const result = box.run(['skill', 'install', '--agent', 'bogus', '--json']);
    assert.equal(result.code, 2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string; hint?: string } };
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
    assert.match(envelope.error.message, /bogus/);
    assert.match(envelope.error.hint ?? '', /claude/);
    assert.equal(existsSync(box.paths.canonical), false);
  });

  it('plans without writing under --dry-run', () => {
    const box = makeBox();
    box.seed('claude');
    const envelope = box.json(['skill', 'install', '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.changed, true);
    assert.equal(envelope.data.targets[0].state, 'linked');
    assert.equal(existsSync(box.paths.canonical), false);
    assert.equal(box.state(box.paths.harness('claude')), 'missing');
  });

  it('prints the canonical path first under --quiet', () => {
    const box = makeBox();
    box.seed('claude');
    const result = box.run(['skill', 'install', '-q']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.split('\n').filter((line) => line !== ''), [
      box.paths.canonical,
      box.paths.harness('claude'),
    ]);
  });
});

describe('skill status', () => {
  it('reports a missing install before anything is installed', () => {
    const box = makeBox();
    const envelope = box.json(['skill', 'status']);
    assert.equal(envelope.data.canonical.installed, false);
    assert.equal(envelope.data.canonical.version, null);
    assert.equal(envelope.data.canonical.version_match, false);
    assert.equal(envelope.data.cli_version, '1.0.0');
    assert.deepEqual(envelope.data.targets, []);
  });

  it('reports linked, missing, stale and unmanaged harness states', () => {
    const box = makeBox();
    box.seed('claude');
    box.seed('codex');
    box.seed('pi');
    box.json(['skill', 'install', '--agent', 'claude,codex']);

    assert.deepEqual(states(box.json(['skill', 'status']).data.targets), {
      claude: 'linked',
      codex: 'linked',
      pi: 'missing',
    });

    unlinkSync(box.paths.harness('claude'));
    unlinkSync(box.paths.harness('codex'));
    seedMarker(box.paths.harness('codex'), '0.9.0');
    seedUnmanaged(box.paths.harness('pi'));

    const envelope = box.json(['skill', 'status']);
    assert.equal(envelope.data.canonical.version, '1.0.0');
    assert.equal(envelope.data.canonical.version_match, true);
    assert.deepEqual(states(envelope.data.targets), { claude: 'missing', codex: 'stale', pi: 'unmanaged' });
    assert.equal(envelope.data.targets.find((target: { harness: string }) => target.harness === 'codex').version, '0.9.0');
  });

  it('suggests an install when a link is missing', () => {
    const box = makeBox();
    box.seed('claude');
    box.json(['skill', 'install']);
    unlinkSync(box.paths.harness('claude'));
    const envelope = box.json(['skill', 'status']);
    assert.deepEqual(
      envelope.next_actions.map((action: { command: string }) => action.command),
      ['novaflow skill install'],
    );
  });
});

describe('skill uninstall', () => {
  it('removes the canonical store and managed links but keeps sibling skills', () => {
    const box = makeBox();
    box.seed('claude');
    box.seed('codex');
    box.json(['skill', 'install']);
    const sibling = join(box.paths.configDir('claude'), 'skills', 'other');
    seedUnmanaged(sibling);

    const envelope = box.json(['skill', 'uninstall']);
    assert.equal(envelope.data.canonical.removed, true);
    assert.equal(existsSync(box.paths.canonical), false);
    assert.equal(box.state(box.paths.harness('claude')), 'missing');
    assert.equal(box.state(box.paths.harness('codex')), 'missing');
    assert.equal(readFileSync(join(sibling, 'SKILL.md'), 'utf8'), '# hand written skill\n');
  });

  it('refuses to delete an unmanaged directory without --force', () => {
    const box = makeBox();
    seedUnmanaged(box.paths.harness('cursor'));
    const result = box.run(['skill', 'uninstall', '--json']);
    assert.equal(result.code, 3);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'STATE_CONFLICT');
    assert.ok(existsSync(join(box.paths.harness('cursor'), 'SKILL.md')));

    const forced = box.json(['skill', 'uninstall', '--force']);
    assert.equal(forced.data.changed, true);
    assert.equal(box.state(box.paths.harness('cursor')), 'missing');
  });

  it('plans removals under --dry-run without deleting anything', () => {
    const box = makeBox();
    box.seed('claude');
    box.json(['skill', 'install']);
    const envelope = box.json(['skill', 'uninstall', '--dry-run']);
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.canonical.removed, true);
    assert.ok(existsSync(box.paths.canonical));
    assert.equal(box.state(box.paths.harness('claude')), 'symlink');
  });
});

describe('skill --local', () => {
  it('installs into <dir>/.agents/skills/novaflow without touching the global root', () => {
    const box = makeBox();
    const project = box.box.mkdir('proj');
    const canonical = join(project, '.agents', 'skills', 'novaflow');

    const envelope = box.json(['skill', 'install', '--local', project]);
    assert.equal(envelope.data.local, true);
    assert.equal(envelope.data.root, canonical);
    assert.equal(box.state(canonical), 'dir');
    assert.equal(box.marker(canonical)?.version, '1.0.0');
    assert.equal(existsSync(box.paths.agentsHome), false, 'global ~/.agents must stay untouched');
    assert.equal(box.state(join(project, '.claude', 'skills', 'novaflow')), 'missing');
  });

  it('creates an explicitly named harness inside the project root', () => {
    const box = makeBox();
    const project = box.box.mkdir('proj2');
    box.json(['skill', 'install', '--local', project, '--agent', 'claude']);
    assert.equal(box.state(join(project, '.claude', 'skills', 'novaflow')), 'symlink');
  });

  it('links an existing local harness directory in auto mode', () => {
    const box = makeBox();
    const project = box.box.mkdir('proj-auto');
    box.box.mkdir('proj-auto', '.claude');
    const envelope = box.json(['skill', 'install', '--local', project]);
    assert.deepEqual(states(envelope.data.targets), { claude: 'linked' });
    assert.equal(box.state(join(project, '.claude', 'skills', 'novaflow')), 'symlink');
  });

  it('reports and removes a local install', () => {
    const box = makeBox();
    const project = box.box.mkdir('proj3');
    box.json(['skill', 'install', '--local', project]);
    const status = box.json(['skill', 'status', '--local', project]);
    assert.equal(status.data.local, true);
    assert.equal(status.data.canonical.installed, true);
    const removed = box.json(['skill', 'uninstall', '--local', project]);
    assert.equal(removed.data.canonical.removed, true);
    assert.equal(existsSync(join(project, '.agents', 'skills', 'novaflow')), false);
  });

  it('defaults a bare --local to the nearest git root', () => {
    const box = makeBox();
    const repo = seedGitRoot(box.box.mkdir('repo'));
    const nested = box.box.mkdir('repo', 'packages', 'app');
    const envelope = box.json(['skill', 'install', '--local'], { cwd: nested });
    assert.equal(envelope.data.root, join(repo, '.agents', 'skills', 'novaflow'));
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'novaflow', 'SKILL.md')));
  });

  it('honours NOVAFLOW_SKILL_HOME and XDG_AGENTS_HOME for the global root', () => {
    const box = makeBox();
    const custom = join(box.box.root, 'custom-skill');
    const overridden = box.json(['skill', 'install'], { env: { NOVAFLOW_SKILL_HOME: custom } });
    assert.equal(overridden.data.root, custom);
    assert.ok(existsSync(join(custom, 'SKILL.md')));
    assert.equal(existsSync(box.paths.canonical), false);

    const other = makeBox();
    const agentsHome = join(other.box.root, 'agents-home');
    const viaXdg = other.json(['skill', 'install'], { env: { XDG_AGENTS_HOME: agentsHome } });
    assert.equal(viaXdg.data.root, join(agentsHome, 'skills', 'novaflow'));
    assert.ok(existsSync(join(agentsHome, 'skills', 'novaflow', 'SKILL.md')));
  });
});

describe('skill command surface', () => {
  it('never requires an active workspace', () => {
    const box = makeBox();
    const empty = box.box.mkdir('empty-dir');
    const result = box.run(['skill', 'install', '--json'], { cwd: empty });
    assert.equal(result.code, 0);
  });

  it('rejects --copy on status, which does not accept it', () => {
    const box = makeBox();
    const result = box.run(['skill', 'status', '--local', '--copy', '--json']);
    assert.equal(result.code, 2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
  });
});
