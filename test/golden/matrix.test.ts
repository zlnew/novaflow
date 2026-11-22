import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatrix, extractFallbackMap, canonicalStates } from "../helpers/spec.ts";
import { ROWS, FALLBACK_MAP } from "../../src/fsm/matrix.ts";

test("golden: FSM matrix equals the architecture 8.1 table row for row", () => {
  assert.deepEqual(ROWS, extractMatrix());
});

test("matrix closure: 24 rows, 9 canonical states only", () => {
  assert.equal(ROWS.length, 24);
  const states = new Set(ROWS.flatMap((r) => [r.state, r.target]));
  for (const s of states) assert.ok(canonicalStates.includes(s), `bad state ${s}`);
});

test("matrix closure: draft is initial, cancelled is terminal, every other state has in and out edges", () => {
  const inDeg: Record<string, number> = {};
  const outDeg: Record<string, number> = {};
  for (const r of ROWS) {
    inDeg[r.target] = (inDeg[r.target] ?? 0) + 1;
    outDeg[r.state] = (outDeg[r.state] ?? 0) + 1;
  }
  assert.equal(inDeg["draft"] ?? 0, 0);
  assert.equal(outDeg["cancelled"] ?? 0, 0);
  for (const s of canonicalStates) {
    if (s === "draft") continue;
    assert.ok((inDeg[s] ?? 0) > 0, `state ${s} has no in-edge`);
    if (s !== "cancelled") {
      assert.ok((outDeg[s] ?? 0) > 0, `state ${s} has no out-edge`);
    }
  }
});

test("golden: fallback-label map equals the architecture table verbatim; labels are never stored states", () => {
  assert.deepEqual(FALLBACK_MAP, extractFallbackMap());
  assert.ok(Object.keys(FALLBACK_MAP).length >= 6);
  for (const label of Object.keys(FALLBACK_MAP)) {
    assert.ok(
      !canonicalStates.includes(label),
      `fallback label ${label} must never itself be a canonical state`,
    );
  }
});
