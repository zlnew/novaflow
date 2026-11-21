import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid, isUlid, displayId, bareId, ULID_ALPHABET } from "../../src/store/ids.ts";

test("ulid: 26 chars over the Crockford base32 alphabet", () => {
  for (let i = 0; i < 1000; i++) {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.ok(isUlid(id));
    for (const c of id) assert.ok(ULID_ALPHABET.includes(c));
  }
});

test("ulid: lexicographically sortable (monotone within a run)", () => {
  let prev = ulid();
  for (let i = 0; i < 5000; i++) {
    const next = ulid();
    assert.ok(next > prev, `ulid not monotone: ${prev} -> ${next}`);
    assert.notEqual(next, prev);
    prev = next;
  }
});

test("id form: bare 26-char ULID is stored/transmitted; the tsk_ prefix is display-only (data 5.1)", () => {
  const bare = ulid();
  assert.equal(displayId("task", bare), `tsk_${bare}`);
  assert.equal(bareId(`tsk_${bare}`), bare);
  assert.equal(bareId(bare), bare); // tolerant of already-bare ids
  assert.throws(() => bareId("tsk_not-a-ulid"));
});
