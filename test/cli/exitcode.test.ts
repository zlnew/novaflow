import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT_USAGE, exitCodeForTaxonomy } from "../../src/cli/exitcode.ts";

/**
 * THE exit-code battery (srs 4.1.1, verbatim table): one map, one test
 * per row, no ad-hoc exits anywhere else in the CLI.
 *
 *   0 success
 *   1 operation failure (task failed, verification failed)
 *   2 usage error
 *   3 engine-state rejection (invalid transition, schema invalid)
 *   4 not found
 *   5 daemon unreachable
 */

test("exit map: every taxonomy code maps to its srs row", () => {
  const expected: Record<string, number> = {
    // operation failure → 1
    aborted: 1,
    duplicate: 1,
    preflight_failed: 1,
    budget_exceeded: 1,
    profile_unresolved: 1,
    // engine-state rejection → 3
    invalid_transition: 3,
    schema_invalid: 3,
    // not found → 4
    not_found: 4,
    // daemon unreachable → 5
    daemon_unreachable: 5,
  };
  for (const [code, exit] of Object.entries(expected)) {
    assert.equal(exitCodeForTaxonomy(code), exit, `taxonomy ${code}`);
  }
  // an unrecognized failure code is an operation failure (documented default)
  assert.equal(exitCodeForTaxonomy("mystery_code"), 1);
  // usage is the parser's own exit, never a taxonomy mapping
  assert.equal(EXIT_USAGE, 2);
});
