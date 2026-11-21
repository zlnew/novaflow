import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProfileSchema } from "../helpers/spec.ts";
import { PROFILE_REQUIRED_KEYS } from "../../src/profiles.ts";

type SchemaProp = {
  type?: string;
  pattern?: string;
  minLength?: number;
  items?: Record<string, unknown>;
  uniqueItems?: boolean;
};

type ProfileSchema = {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, SchemaProp & {
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, SchemaProp>;
  }>;
};

/**
 * Golden: the validator's contract is pinned to the live §4.2 schema block
 * in data.md — required keys, the additionalProperties:false mechanism, and
 * the per-property constraints it mirrors. Spec drift fails here.
 */
test("validator required keys and constraints equal the live §4.2 schema block", () => {
  const schema = extractProfileSchema() as unknown as ProfileSchema;

  assert.deepEqual(
    [...PROFILE_REQUIRED_KEYS].sort(),
    [...schema.required].sort(),
    "validator required keys must equal the schema's required array",
  );

  // The unknown-key rejection mechanism, verified in the spec block itself.
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties["limits"]?.additionalProperties, false);
  assert.deepEqual(schema.properties["limits"]?.required, [
    "max_timeout_sec",
    "max_cost_usd",
  ]);

  // Per-property constraints the validator mirrors verbatim.
  assert.equal(schema.properties["name"]?.pattern, "^[a-z0-9-]+$");
  assert.equal(schema.properties["model"]?.minLength, 1);
  assert.equal(schema.properties["system_prompt_path"]?.minLength, 1);
  assert.equal(schema.properties["role"]?.minLength, 3);
  assert.deepEqual(schema.properties["tools_allowlist"]?.items, { type: "string" });
  assert.equal(schema.properties["tools_allowlist"]?.uniqueItems, true);
  assert.equal(
    schema.properties["limits"]?.properties["max_timeout_sec"]?.type,
    "integer",
  );
  assert.equal(
    schema.properties["limits"]?.properties["max_cost_usd"]?.type,
    "number",
  );
});
