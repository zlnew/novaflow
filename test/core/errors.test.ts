import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CORE_ERROR_CODES,
  EXIT_CODES,
  NovaError,
  alreadyClaimedError,
  conflictError,
  cycleDetectedError,
  notFoundError,
  unmetDependenciesError,
  validationError,
  workspaceNotFoundError,
} from '../../src/core/errors.js';

const CORE_DIR = fileURLToPath(new URL('../../src/core/', import.meta.url));

describe('core/errors', () => {
  it('maps every canonical domain code to the documented exit code', () => {
    assert.equal(EXIT_CODES.VALIDATION_ERROR, 2);
    assert.equal(EXIT_CODES.NOT_FOUND, 4);
    assert.equal(EXIT_CODES.WORKSPACE_NOT_FOUND, 4);
    assert.equal(EXIT_CODES.STATE_CONFLICT, 3);
    assert.equal(EXIT_CODES.ALREADY_CLAIMED, 3);
    assert.equal(EXIT_CODES.UNMET_DEPENDENCIES, 3);
    assert.equal(EXIT_CODES.CYCLE_DETECTED, 3);
    assert.equal(EXIT_CODES.INTERNAL_ERROR, 1);
    assert.equal(EXIT_CODES.SCHEMA_TOO_NEW, 1);
  });

  it('exposes the canonical code list', () => {
    assert.deepEqual([...CORE_ERROR_CODES].sort(), [
      'ALREADY_CLAIMED',
      'CYCLE_DETECTED',
      'INTERNAL_ERROR',
      'NOT_FOUND',
      'STATE_CONFLICT',
      'UNMET_DEPENDENCIES',
      'VALIDATION_ERROR',
      'WORKSPACE_NOT_FOUND',
    ]);
  });

  it('builds typed errors with optional hints', () => {
    const cases: Array<[NovaError, string, number]> = [
      [validationError('bad input', 'fix it'), 'VALIDATION_ERROR', 2],
      [notFoundError('missing'), 'NOT_FOUND', 4],
      [workspaceNotFoundError('missing ws'), 'WORKSPACE_NOT_FOUND', 4],
      [conflictError('duplicate'), 'STATE_CONFLICT', 3],
      [alreadyClaimedError('held'), 'ALREADY_CLAIMED', 3],
      [unmetDependenciesError('waiting'), 'UNMET_DEPENDENCIES', 3],
      [cycleDetectedError('loop'), 'CYCLE_DETECTED', 3],
    ];
    for (const [error, code, exitCode] of cases) {
      assert.ok(error instanceof NovaError);
      assert.equal(error.code, code);
      assert.equal(error.exitCode, exitCode);
    }
    assert.equal(validationError('bad input', 'fix it').hint, 'fix it');
    assert.equal(validationError('bad input').hint, undefined);
  });
});

describe('core purity', () => {
  const files = readdirSync(CORE_DIR).filter((file) => file.endsWith('.ts'));

  it('never reads process.argv or writes to stdout/stderr', () => {
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      for (const forbidden of ['process.argv', 'process.stdout', 'process.stderr', 'console.', 'process.exit']) {
        assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`);
      }
    }
  });

  it('never spawns processes or opens a network connection', () => {
    for (const file of files) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      for (const forbidden of ['node:child_process', 'node:net', 'node:http', 'node:dgram']) {
        assert.equal(source.includes(forbidden), false, `${file} must not import ${forbidden}`);
      }
    }
  });
});
