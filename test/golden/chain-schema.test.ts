import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChainSchema } from "../helpers/spec.ts";
import {
  CHAIN_REQUIRED_KEYS,
  CHAIN_KNOWN_KEYS,
  CHAIN_ARRAY_KEYS,
  TASK_REQUIRED_KEYS,
  TASK_KNOWN_KEYS,
  SCOPE_KNOWN_KEYS,
  SCOPE_REQUIRED_KEYS,
  EDGE_KNOWN_KEYS,
  EDGE_REQUIRED_KEYS,
  EDGE_TYPES,
  VERSION_PATTERN,
  PROJECT_SLUG_PATTERN,
  TASK_KEY_PATTERN,
} from "../../src/chain/graph.ts";

type SchemaProp = {
  type?: string;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  minItems?: number;
  items?: Record<string, unknown>;
  enum?: string[];
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, SchemaProp>;
};

type ChainSchema = {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, SchemaProp>;
};

/**
 * Golden: the chain graph validator's contract is pinned to the LIVE
 * §4.3 schema block in data.md — required keys, the
 * additionalProperties:false mechanism at every level, and each
 * property's constraints. Spec drift fails here (the established
 * test/golden/profile-schema.test.ts pattern, extended to §4.3).
 */
test("chain validator required/known keys equal the live §4.3 schema at every level", () => {
  const schema = extractChainSchema() as unknown as ChainSchema;

  // top level
  assert.deepEqual([...CHAIN_REQUIRED_KEYS].sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...CHAIN_KNOWN_KEYS].sort(), [...Object.keys(schema.properties)].sort());

  // tasks items
  const tasks = schema.properties["tasks"] as SchemaProp & {
    items: SchemaProp;
  };
  assert.equal(tasks.type, "array");
  assert.equal(tasks.minItems, 1);
  assert.deepEqual([...TASK_REQUIRED_KEYS].sort(), [...tasks.items.required].sort());
  assert.equal(tasks.items.additionalProperties, false);
  assert.deepEqual(
    [...TASK_KNOWN_KEYS].sort(),
    [...Object.keys(tasks.items.properties ?? {})].sort(),
  );

  // target_scopes items
  const scopes = tasks.items.properties?.["target_scopes"] as SchemaProp & {
    items: SchemaProp;
  };
  assert.deepEqual([...SCOPE_REQUIRED_KEYS].sort(), [...scopes.items.required].sort());
  assert.equal(scopes.items.additionalProperties, false);
  assert.deepEqual(
    [...SCOPE_KNOWN_KEYS].sort(),
    [...Object.keys(scopes.items.properties ?? {})].sort(),
  );

  // edges items
  const edges = schema.properties["edges"] as SchemaProp & {
    items: SchemaProp;
  };
  assert.deepEqual([...EDGE_REQUIRED_KEYS].sort(), [...edges.items.required].sort());
  assert.equal(edges.items.additionalProperties, false);
  assert.deepEqual(
    [...EDGE_KNOWN_KEYS].sort(),
    [...Object.keys(edges.items.properties ?? {})].sort(),
  );

  // overrides: closed object, exactly the three FR-AGT-03 keys
  const overrides = tasks.items.properties?.["overrides"] as SchemaProp;
  assert.equal(overrides.additionalProperties, false);
  assert.deepEqual([...Object.keys(overrides.properties ?? {})].sort(), [
    "max_cost_usd",
    "thinking_level",
    "timeout_sec",
  ]);
});

test("golden: every constraint the validator mirrors equals the live §4.3 block", () => {
  const schema = extractChainSchema() as unknown as ChainSchema;
  const tasks = schema.properties["tasks"] as SchemaProp & {
    items: SchemaProp;
  };

  // top-level scalars
  assert.equal(schema.properties["version"]?.pattern, "^\\d+\\.\\d+\\.\\d+$");
  assert.equal(schema.properties["project_slug"]?.pattern, "^[a-z0-9-]+$");

  // task member constraints
  const props = tasks.items.properties ?? {};
  assert.equal(props["key"]?.pattern, "^[A-Z0-9_-]+$");
  assert.equal(props["title"]?.minLength, 3);
  assert.equal(props["objective"]?.minLength, 10);
  assert.equal(props["priority"]?.minimum, 1);
  assert.equal(props["priority"]?.maximum, 5);
  assert.equal(props["priority"]?.default, 3);
  assert.equal(props["requires_human_gate"]?.type, "boolean");
  assert.equal(props["requires_human_gate"]?.default, false);
  assert.deepEqual(props["context_files"]?.items, { type: "string" });
  assert.equal(props["output_schema_version"]?.default, "1.0.0");

  // target_scopes constraints
  const scopes = props["target_scopes"] as SchemaProp & { items: SchemaProp };
  const sProps = scopes.items.properties ?? {};
  assert.deepEqual(sProps["access_mode"]?.enum, ["read_only", "read_write"]);

  // overrides constraints
  const overrides = props["overrides"] as SchemaProp;
  const oProps = overrides.properties ?? {};
  assert.equal(oProps["timeout_sec"]?.type, "integer");
  assert.equal(oProps["timeout_sec"]?.minimum, 1);
  assert.equal(oProps["max_cost_usd"]?.type, "number");
  assert.equal(oProps["max_cost_usd"]?.minimum, 0.0);
  assert.equal(oProps["thinking_level"]?.type, "string");

  // edges constraints
  const edges = schema.properties["edges"] as SchemaProp & { items: SchemaProp };
  const eProps = edges.items.properties ?? {};
  assert.deepEqual(eProps["edge_type"]?.enum, ["depends_on", "on_changes_requested", "on_failure"]);
  assert.equal(eProps["condition_expr"]?.type, "string");
});

test("golden: the empty-block-list keys are exactly the §4.3 array-typed keys (amendment row 8)", () => {
  const schema = extractChainSchema() as unknown as ChainSchema;
  const tasks = schema.properties["tasks"] as SchemaProp & {
    items: SchemaProp;
  };
  const scopes = tasks.items.properties?.["target_scopes"] as SchemaProp & {
    items: SchemaProp;
  };
  const arrayKeys = [
    ...Object.entries(schema.properties),
    ...Object.entries(tasks.items.properties ?? {}),
    ...Object.entries(scopes.items.properties ?? {}),
  ]
    .filter(([, prop]) => prop.type === "array")
    .map(([key]) => key);
  // the subset's empty-block-list rule covers every array-typed key and
  // no others: a non-array key (`wake:`) still refuses the empty value
  assert.deepEqual([...CHAIN_ARRAY_KEYS].sort(), arrayKeys.sort());
});

test("golden: the validator's patterns equal the live spec patterns (source-identical regexes)", () => {
  const schema = extractChainSchema() as unknown as ChainSchema;
  const tasks = schema.properties["tasks"] as SchemaProp & {
    items: SchemaProp;
  };
  assert.equal(VERSION_PATTERN.source, schema.properties["version"]?.pattern);
  assert.equal(PROJECT_SLUG_PATTERN.source, schema.properties["project_slug"]?.pattern);
  assert.equal(
    TASK_KEY_PATTERN.source,
    tasks.items.properties?.["key"]?.pattern,
  );
  assert.deepEqual([...EDGE_TYPES], [
    "depends_on",
    "on_changes_requested",
    "on_failure",
  ]);
});
