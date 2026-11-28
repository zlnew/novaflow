import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXIT_CODES, NovaError, isNovaError, toNovaError } from '../../src/store/errors.js';

describe('store/errors', () => {
  it('maps every domain code to the documented exit code', () => {
    assert.equal(EXIT_CODES.VALIDATION_ERROR, 2);
    assert.equal(EXIT_CODES.NOT_FOUND, 4);
    assert.equal(EXIT_CODES.WORKSPACE_NOT_FOUND, 4);
    assert.equal(EXIT_CODES.STATE_CONFLICT, 3);
    assert.equal(EXIT_CODES.INTERNAL_ERROR, 1);
    assert.equal(EXIT_CODES.SCHEMA_TOO_NEW, 1);
  });

  it('carries code, exit code, message and hint', () => {
    const error = new NovaError('WORKSPACE_NOT_FOUND', 'no workspace', {
      hint: 'run novaflow workspace create',
    });
    assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
    assert.equal(error.exitCode, 4);
    assert.equal(error.message, 'no workspace');
    assert.equal(error.hint, 'run novaflow workspace create');
    assert.ok(error instanceof Error);
    assert.ok(error instanceof NovaError);
  });

  it('defaults the hint to undefined when omitted', () => {
    const error = new NovaError('STATE_CONFLICT', 'already exists');
    assert.equal(error.hint, undefined);
    assert.equal(error.exitCode, 3);
  });

  it('serializes to a JSON error envelope payload', () => {
    const error = new NovaError('VALIDATION_ERROR', 'bad slug', { hint: 'use lowercase kebab-case' });
    assert.deepEqual(error.toJSON(), {
      code: 'VALIDATION_ERROR',
      message: 'bad slug',
      hint: 'use lowercase kebab-case',
    });
  });

  it('keeps a cause for debugging without leaking it into toJSON', () => {
    const cause = new Error('sqlite exploded');
    const error = new NovaError('INTERNAL_ERROR', 'db failure', { cause });
    assert.equal(error.cause, cause);
    assert.deepEqual(Object.keys(error.toJSON()), ['code', 'message']);
  });

  it('narrows only NovaError instances with isNovaError', () => {
    assert.equal(isNovaError(new NovaError('NOT_FOUND', 'missing')), true);
    assert.equal(isNovaError(new Error('plain')), false);
    assert.equal(isNovaError('nope'), false);
  });

  it('wraps unknown failures as INTERNAL_ERROR exit 1 with the original cause', () => {
    const cause = new Error('kaboom');
    const wrapped = toNovaError(cause);
    assert.equal(wrapped.code, 'INTERNAL_ERROR');
    assert.equal(wrapped.exitCode, 1);
    assert.equal(wrapped.cause, cause);

    const passthrough = new NovaError('NOT_FOUND', 'missing');
    assert.equal(toNovaError(passthrough), passthrough);
  });
});
