import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUlid, ulid } from '../../src/store/id.js';

describe('store/id', () => {
  it('produces 26-character Crockford base32 ULIDs', () => {
    const value = ulid();
    assert.equal(value.length, 26);
    assert.equal(isUlid(value), true);
    assert.match(value, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonic within the same millisecond', () => {
    const first = ulid(1_700_000_000_000);
    const second = ulid(1_700_000_000_000);
    const third = ulid(1_700_000_000_000);
    assert.ok(first < second, `${first} < ${second}`);
    assert.ok(second < third, `${second} < ${third}`);
  });

  it('sorts in time order across milliseconds', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    assert.ok(earlier < later);
  });

  it('rejects non-ULID strings', () => {
    assert.equal(isUlid('not-a-ulid'), false);
    assert.equal(isUlid('01JNOVATEST0000000000000'), false);
    assert.equal(isUlid(''), false);
  });
});
