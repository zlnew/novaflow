import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "../../src/cli/args.ts";

/**
 * The hand-rolled argv parser (no dependencies): positionals,
 * `--flag value`, `--flag=value`, boolean and repeatable flags, the
 * common options --json / --watch, and honest usage errors (exit 2's
 * source).
 */

const SPEC = {
  booleanFlags: ["gate", "foreground"],
  valueFlags: ["workspace", "path", "objective", "project", "profile", "title"],
  repeatableFlags: ["target", "context"],
};

test("parser: bare positionals", () => {
  const p = parseArgs(["alpha", "TASK-1"], SPEC);
  assert.deepEqual(p.positionals, ["alpha", "TASK-1"]);
  assert.equal(p.json, false);
  assert.equal(p.watch, false);
});

test("parser: --flag value, --flag=value, boolean flags, common options", () => {
  const p = parseArgs(
    ["create", "--workspace", "alpha", "--path=/tmp/x", "--json", "--watch", "--gate"],
    SPEC,
  );
  assert.deepEqual(p.positionals, ["create"]);
  assert.equal(p.values.get("workspace"), "alpha");
  assert.equal(p.values.get("path"), "/tmp/x");
  assert.equal(p.json, true);
  assert.equal(p.watch, true);
  assert.ok(p.flags.has("gate"));
});

test("parser: repeatable flags keep order and multiplicity", () => {
  const p = parseArgs(
    ["create", "app", "--target", "a=/tmp/a", "--target", "b=/tmp/b:git_repo", "--target", "c=/tmp/c"],
    SPEC,
  );
  assert.deepEqual(p.positionals, ["create", "app"]);
  assert.deepEqual(p.lists.get("target"), [
    "a=/tmp/a",
    "b=/tmp/b:git_repo",
    "c=/tmp/c",
  ]);
});

test("parser: flags interleave with positionals (GNU-style permutation)", () => {
  const p = parseArgs(["phase", "prj-1", "--workspace", "alpha", "Implementing"], SPEC);
  assert.deepEqual(p.positionals, ["phase", "prj-1", "Implementing"]);
  assert.equal(p.values.get("workspace"), "alpha");
});

test("parser: '--' ends flag parsing — the rest are positionals", () => {
  const p = parseArgs(["task", "steer", "--", "--maybe-a-flag"], SPEC);
  assert.deepEqual(p.positionals, ["task", "steer", "--maybe-a-flag"]);
});

test("parser usage errors: unknown flag, missing value", () => {
  assert.throws(() => parseArgs(["x", "--nope"], SPEC), UsageError);
  assert.throws(() => parseArgs(["x", "--workspace"], SPEC), UsageError);
  // an unknown flag in = form is still unknown
  assert.throws(() => parseArgs(["x", "--nope=1"], SPEC), UsageError);
  // a value flag may not swallow another flag
  assert.throws(() => parseArgs(["x", "--workspace", "--json"], SPEC), UsageError);
});
