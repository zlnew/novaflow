import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { REPO_ROOT } from '../cli/helpers.js';

const SKILL_DIR = join(REPO_ROOT, 'skills', 'novaflow');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const REFERENCE_FILE = join(SKILL_DIR, 'references', 'cli-reference.md');

interface SkillDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  lines: string[];
}

function readSkill(): SkillDoc {
  const raw = readFileSync(SKILL_FILE, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  assert.ok(match, 'SKILL.md must start with a YAML frontmatter block');
  return {
    frontmatter: parse(match[1] as string) as Record<string, unknown>,
    body: match[2] as string,
    lines: raw.split('\n').filter((line, index, all) => index < all.length - 1 || line !== ''),
  };
}

describe('bundled skill package', () => {
  it('ships SKILL.md and the offloaded CLI reference', () => {
    assert.ok(readFileSync(SKILL_FILE, 'utf8').length > 0);
    assert.ok(readFileSync(REFERENCE_FILE, 'utf8').length > 0);
  });

  it('declares the agentskills.io frontmatter required by skills.md §1.1', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const { frontmatter } = readSkill();

    assert.equal(frontmatter.name, 'novaflow');
    assert.equal(frontmatter.name, basename(SKILL_DIR), 'name must match the directory name');
    assert.equal(frontmatter.license, 'MIT');
    assert.equal(frontmatter.compatibility, 'Requires novaflow >= 1.0.0 CLI on PATH');

    const description = frontmatter.description;
    assert.equal(typeof description, 'string');
    assert.ok((description as string).length <= 200, `description must be <= 200 chars, got ${(description as string).length}`);
    for (const trigger of ['workspaces', 'projects', 'tasks', 'next', 'context', 'block', 'complete']) {
      assert.match((description as string).toLowerCase(), new RegExp(trigger));
    }

    const metadata = frontmatter.metadata as { version?: string; author?: string };
    assert.equal(metadata.version, pkg.version);
    assert.equal(metadata.author, 'zlnew');
  });

  it('stays inside the 120-line progressive-disclosure budget', () => {
    const { lines } = readSkill();
    assert.ok(lines.length <= 120, `SKILL.md must be <= 120 lines, got ${lines.length}`);
  });

  it('documents the orchestrator loop and the JSON contract in the body', () => {
    const { body } = readSkill();
    for (const fragment of [
      'novaflow task next',
      'novaflow task context',
      'novaflow task start',
      'novaflow task note',
      'novaflow task complete',
      'novaflow task block',
      '--json',
      'next_actions',
    ]) {
      assert.ok(body.includes(fragment), `SKILL.md must mention ${fragment}`);
    }
    assert.ok(body.includes('references/cli-reference.md'), 'SKILL.md must point at the offloaded reference');
  });

  it('keeps exhaustive flag tables out of SKILL.md and inside the reference', () => {
    const reference = readFileSync(REFERENCE_FILE, 'utf8');
    for (const fragment of [
      'novaflow workspace create',
      'novaflow project create',
      'novaflow task attach',
      'novaflow skill install',
      'novaflow_task_next',
      'STATE_CONFLICT',
      '--idempotency-key',
    ]) {
      assert.ok(reference.includes(fragment), `cli-reference.md must document ${fragment}`);
    }
    assert.ok(!readSkill().body.includes('--idempotency-key'), 'deep flags belong in references/');
  });
});
