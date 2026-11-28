import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cliBox, createWorkspace } from './helpers.js';

const boxes: Array<ReturnType<typeof cliBox>> = [];
function makeBox(): ReturnType<typeof cliBox> {
  const box = cliBox();
  boxes.push(box);
  return box;
}
after(() => {
  for (const box of boxes) box.dispose();
});

describe('cli global flags and grammar', () => {
  it('prints the semver for --version and -V, exit 0', () => {
    const box = makeBox();
    for (const flag of ['--version', '-V']) {
      const result = box.run([flag]);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'novaflow 1.0.0\n');
      assert.equal(result.stderr, '');
    }
  });

  it('prints help for a bare invocation without touching stdin', () => {
    const box = makeBox();
    const result = box.run([]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: novaflow/);
    assert.equal(result.stderr, '');
  });

  it('scopes --help to the noun and to the exact verb', () => {
    const box = makeBox();
    const noun = box.run(['task', '--help']);
    assert.equal(noun.code, 0);
    assert.match(noun.stdout, /task\.start/);
    assert.match(noun.stdout, /task\.attach/);

    const verb = box.run(['task', 'start', '--help']);
    assert.equal(verb.code, 0);
    assert.match(verb.stdout, /--lease/);
    assert.match(verb.stdout, /--force/);
    assert.match(verb.stdout, /Exit codes/);
    assert.match(verb.stdout, /3 {2}State \/ Domain Conflict/);
  });

  it('accepts global flags before the noun and after the verb', () => {
    const box = makeBox();
    const before = box.run(['--json', 'workspace', 'list']);
    assert.equal(before.code, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).command, 'workspace.list');

    const afterNoun = box.run(['workspace', '--json', 'list']);
    assert.equal(afterNoun.code, 0, afterNoun.stderr);
    assert.equal(JSON.parse(afterNoun.stdout).command, 'workspace.list');
  });

  it('supports the short forms -w, -p, -q', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'short-flags');
    box.json(['project', 'create', '--title', 'short-project', '-w', workspace.root]);

    const quiet = box.run(['task', 'list', '-w', workspace.root, '-q']);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stdout, '');

    const project = box.run(['project', 'list', '-w', workspace.root, '-q']);
    assert.equal(project.code, 0, project.stderr);
    assert.equal(project.stdout, 'short-project\n');
  });

  it('fails exit 2 with VALIDATION_ERROR for an unknown flag', () => {
    const box = makeBox();
    const error = box.jsonError(['workspace', 'list', '--bogus']);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /--bogus/);
    assert.equal(box.run(['workspace', 'list', '--bogus']).code, 2);
  });

  it('fails exit 2 when a known flag belongs to another command', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'scoped-flags');
    const error = box.jsonError(['workspace', 'list', '--tag', 'x', '-w', workspace.root]);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /--tag/);
  });

  it('fails exit 2 for a missing flag value and an invalid integer', () => {
    const box = makeBox();
    assert.equal(box.run(['workspace', 'list', '--limit']).code, 2);
    assert.equal(box.run(['workspace', 'list', '--limit', 'abc']).code, 2);
    const error = box.jsonError(['events', '--limit', '0']);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /--limit/);
  });

  it('fails exit 2 for unknown commands, unknown verbs and extra positionals', () => {
    const box = makeBox();
    assert.equal(box.jsonError(['bogus']).code, 'VALIDATION_ERROR');
    assert.equal(box.jsonError(['task', 'bogus']).code, 'VALIDATION_ERROR');
    assert.equal(box.jsonError(['workspace', 'list', 'extra']).code, 'VALIDATION_ERROR');
    assert.equal(box.jsonError(['workspace', 'unregister']).code, 'VALIDATION_ERROR');
  });

  it('keeps stdout empty and writes the error envelope only to stderr', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'envelope-errors');
    const result = box.run(['project', 'show', 'missing', '--json', '-w', workspace.root]);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, '');
    const envelope = JSON.parse(result.stderr.trim());
    assert.deepEqual(Object.keys(envelope).sort(), ['command', 'error', 'ok']);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, 'project.show');
    assert.equal(envelope.error.code, 'NOT_FOUND');
    assert.equal(typeof envelope.error.message, 'string');
  });

  it('writes human diagnostics to stderr, never stdout', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'human-errors');
    const result = box.run(['project', 'show', 'missing', '-w', workspace.root]);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /does not exist/);
    assert.match(result.stderr, /hint/);
  });

  it('maps a corrupt registry to INTERNAL_ERROR exit 1', () => {
    const box = makeBox();
    mkdirSync(box.box.env.NOVAFLOW_HOME as string, { recursive: true });
    writeFileSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json'), '{ not json');
    const result = box.run(['workspace', 'list']);
    assert.equal(result.code, 1);
    const error = box.jsonError(['workspace', 'list']);
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(existsSync(join(box.box.env.NOVAFLOW_HOME as string, 'workspaces.json')), true);
  });

  it('prompts on no stream: create succeeds with stdin closed', () => {
    const box = makeBox();
    const root = box.box.mkdir('closed-stdin');
    const result = box.run(['workspace', 'create', '--name', 'closed-stdin', '--path', root]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(root, '.novaflow', 'state.db')));
    assert.equal(result.stderr, '');
  });

  it('fails exit 2 with JSON on stderr when a noun omits its verb', () => {
    const box = makeBox();
    const result = box.run(['task', '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
  });

  it('does not treat -V as --version when consumed as a flag value', () => {
    const box = makeBox();
    const workspace = createWorkspace(box, 'val-flag');
    const envelope = box.json(['project', 'create', '--title', '-V', '--slug', 'dash-v', '-w', workspace.root]);
    assert.equal(envelope.data.project.title, '-V');
  });

  it('accepts --local with or without a directory argument', () => {
    const box = makeBox();
    const withoutDir = box.jsonError(['skill', 'status', '--local', '--copy']);
    assert.match(withoutDir.message, /Unknown flag|--copy|not wired/i);
    const statusBare = box.json(['skill', 'status', '--local']);
    assert.equal(statusBare.command, 'skill.status');
    assert.equal(statusBare.data.local, true);
  });
});
