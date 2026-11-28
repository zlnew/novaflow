import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNovaError } from '../../src/store/errors.js';
import {
  MAX_PREFIX_LENGTH,
  SLUG_PATTERN,
  derivePrefix,
  derivePrefixBase,
  deriveSlug,
  formatTaskKey,
  isValidPrefix,
  isValidSlug,
  normalizeTaskKey,
  parseTaskKey,
  prefixCandidates,
  slugify,
  uniqueSlug,
} from '../../src/core/ids.js';

function expectNovaError(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(isNovaError(error), `expected NovaError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

describe('core/ids slugs', () => {
  it('slugifies titles into lowercase kebab-case', () => {
    assert.equal(slugify('JWT Authentication'), 'jwt-authentication');
    assert.equal(slugify('  Refresh  token__rotation!! '), 'refresh-token-rotation');
    assert.equal(slugify('novaflow v3'), 'novaflow-v3');
    assert.equal(slugify('already-kebab'), 'already-kebab');
  });

  it('caps slugs at 64 characters and never leaves a trailing dash', () => {
    const long = slugify('a'.repeat(80));
    assert.equal(long.length, 64);
    assert.ok(SLUG_PATTERN.test(long));
    assert.ok(!long.endsWith('-'));
  });

  it('rejects a slug that cannot be derived from the input', () => {
    assert.throws(() => deriveSlug('!!!'), expectNovaError('VALIDATION_ERROR', 2));
    assert.throws(() => slugify(''), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('validates slug and prefix shapes', () => {
    assert.equal(isValidSlug('novaflow-v3'), true);
    assert.equal(isValidSlug('Novaflow'), false);
    assert.equal(isValidSlug('9lives'), false);
    assert.equal(isValidSlug('a'), true);
    assert.equal(isValidSlug(`${'a'.repeat(65)}`), false);

    assert.equal(isValidPrefix('NV3'), true);
    assert.equal(isValidPrefix('A1'), true);
    assert.equal(isValidPrefix('NV32'), true);
    assert.equal(isValidPrefix('N'), false);
    assert.equal(isValidPrefix('nv3'), false);
    assert.equal(isValidPrefix('NV3-'), false);
  });

  it('suffixes auto slugs on collision and only then', () => {
    assert.equal(uniqueSlug('jwt-auth', new Set()), 'jwt-auth');
    assert.equal(uniqueSlug('jwt-auth', new Set(['jwt-auth'])), 'jwt-auth-2');
    assert.equal(uniqueSlug('jwt-auth', new Set(['jwt-auth', 'jwt-auth-2'])), 'jwt-auth-3');
    assert.throws(() => uniqueSlug('jwt-auth', new Set(['jwt-auth', 'jwt-auth-2']), 2), expectNovaError('VALIDATION_ERROR', 2));
  });
});

describe('core/ids prefixes', () => {
  it('derives the documented deterministic prefixes', () => {
    assert.equal(derivePrefixBase('novaflow-v3'), 'NV3');
    assert.equal(derivePrefixBase('jwt-auth'), 'JA');
    assert.equal(derivePrefixBase('backend'), 'BAC');
  });

  it('keeps derived bases between 2 and 4 characters', () => {
    for (const slug of ['novaflow-v3', 'jwt-auth', 'backend', 'a', 'x-1', 'one-two-three-four', 'v3', 'api2-gateway']) {
      const base = derivePrefixBase(slug);
      assert.ok(base.length >= 2, `${slug} -> ${base}`);
      assert.ok(base.length <= 4, `${slug} -> ${base}`);
      assert.match(base, /^[A-Z][A-Z0-9]*$/, `${slug} -> ${base}`);
    }
  });

  it('derives a free prefix, suffixing on collision in ascending order', () => {
    assert.equal(derivePrefix('novaflow-v3', new Set()), 'NV3');
    assert.equal(derivePrefix('novaflow-v3', new Set(['NV3'])), 'NV32');
    assert.equal(derivePrefix('novaflow-v3', new Set(['NV3', 'NV32'])), 'NV33');
    assert.equal(derivePrefix('novaflow-v3', new Set(['NV3', 'NV32', 'NV33'])), 'NV34');
  });

  it('walks NV39 -> NV310 and keeps every candidate within 8 characters', () => {
    const taken = new Set<string>(['NV3']);
    for (let n = 2; n <= 9; n += 1) taken.add(`NV3${n}`);
    assert.equal(derivePrefix('novaflow-v3', taken), 'NV310');

    const longBase = derivePrefixBase('one-two-three-four');
    for (const candidate of prefixCandidates(longBase)) {
      assert.ok(candidate.length <= MAX_PREFIX_LENGTH, candidate);
      assert.ok(isValidPrefix(candidate), candidate);
    }
  });

  it('fails exit 2 when every suffix is taken', () => {
    const taken = new Set<string>(prefixCandidates(derivePrefixBase('novaflow-v3')));
    assert.throws(() => derivePrefix('novaflow-v3', taken), expectNovaError('VALIDATION_ERROR', 2));
  });

  it('produces the base plus 98 collision candidates', () => {
    const candidates = prefixCandidates('NV3');
    assert.equal(candidates.length, 99);
    assert.equal(candidates[0], 'NV3');
    assert.equal(candidates[1], 'NV32');
    assert.equal(candidates[98], 'NV399');
  });
});

describe('core/ids task keys', () => {
  it('formats and normalizes keys', () => {
    assert.equal(formatTaskKey('NV3', 1), 'NV3-1');
    assert.equal(normalizeTaskKey('nv3-1'), 'NV3-1');
    assert.equal(normalizeTaskKey(' NV3-12 '), 'NV3-12');
  });

  it('parses canonical keys and rejects everything else', () => {
    assert.deepEqual(parseTaskKey('NV3-1'), { prefix: 'NV3', seq: 1 });
    assert.deepEqual(parseTaskKey('nv3-1'), { prefix: 'NV3', seq: 1 });
    assert.deepEqual(parseTaskKey('NV3-12'), { prefix: 'NV3', seq: 12 });
    assert.equal(parseTaskKey('NV3-0'), null);
    assert.equal(parseTaskKey('NV3'), null);
    assert.equal(parseTaskKey('NV3-1x'), null);
    assert.equal(parseTaskKey('jwt-auth'), null);
  });
});
