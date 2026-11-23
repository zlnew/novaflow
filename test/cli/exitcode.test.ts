import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_CODES,
  EXIT_CODE_VALUES,
  EXIT_USAGE,
  exitCodeForTaxonomy,
  type ExitCode,
} from "../../src/cli/exitcode.ts";
import { VERBS, verbKey } from "../../src/cli/verbs.ts";

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

/**
 * R4.3, the generated half: the map is one module (`EXIT_CODES`), one spec
 * table (docs/cli.md) and one test — this one. It WALKS every code the CLI
 * can emit: the table's six rows, every code any verb's `exits` list names,
 * and every code the wire taxonomy maps to. A new code without a row (or a
 * verb that invents a seventh exit) fails here, by type and by assertion.
 */
test("the exit-code table is pinned: every code's meaning, all six rows, nothing else", () => {
  const pinned: Record<ExitCode, { short: string; meaning: string }> = {
    0: { short: "ok", meaning: "success" },
    1: {
      short: "failed",
      meaning: "operation failure (task failed, verification failed, refused operation)",
    },
    2: { short: "usage", meaning: "usage error (unknown verb, flag or positional shape)" },
    3: {
      short: "state",
      meaning: "engine-state rejection (invalid transition, schema invalid, unverified chain)",
    },
    4: { short: "not-found", meaning: "not found (unknown id, key, slug or schedule)" },
    5: { short: "offline", meaning: "daemon unreachable (no socket, or no answer)" },
  };
  assert.deepEqual(EXIT_CODES, pinned, "the code → meaning table drifted (docs/cli.md must match it)");
  assert.deepEqual(Object.keys(EXIT_CODES).map(Number).sort(), [...EXIT_CODE_VALUES]);
});

test("every code a verb can emit is a table row — a verb cannot invent an exit", () => {
  for (const verb of VERBS) {
    assert.ok(verb.exits.length > 0, `${verbKey(verb)} declares no exit codes`);
    assert.equal(verb.exits[0], 0, `${verbKey(verb)} must be able to succeed (exit 0 first)`);
    for (const code of verb.exits) {
      assert.ok(
        Object.hasOwn(EXIT_CODES, code),
        `${verbKey(verb)} emits exit ${code}, which has no row in the exit-code table`,
      );
    }
    assert.deepEqual([...verb.exits], [...new Set(verb.exits)], `${verbKey(verb)} repeats an exit code`);
  }
});

test("every taxonomy code the CLI can print maps to a row, and every row is reachable", () => {
  const taxonomy = [
    "aborted",
    "duplicate",
    "preflight_failed",
    "budget_exceeded",
    "profile_unresolved",
    "invalid_transition",
    "schema_invalid",
    "not_found",
    "daemon_unreachable",
    "mystery_code", // the documented default: an unknown failure is an operation failure
  ];
  for (const code of taxonomy) {
    const exit = exitCodeForTaxonomy(code);
    assert.ok(
      Object.hasOwn(EXIT_CODES, exit),
      `taxonomy "${code}" maps to exit ${exit}, which is not in the table`,
    );
  }
  // and no row is dead: some verb can emit each code
  for (const code of EXIT_CODE_VALUES) {
    assert.ok(
      VERBS.some((verb) => verb.exits.includes(code)),
      `exit ${code} exists in the table but no verb can emit it`,
    );
  }
});
