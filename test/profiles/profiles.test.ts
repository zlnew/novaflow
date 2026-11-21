import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProfile,
  validateProfile,
  ProfileValidationError,
  PROFILE_REQUIRED_KEYS,
  type Profile,
} from "../../src/profiles.ts";

/** A §4.2-conformant profile (data.md 4.2 example shape). */
const VALID: Record<string, unknown> = {
  name: "dev",
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  thinking_level: "high",
  system_prompt_path: "prompts/dev_system.md",
  tools_allowlist: ["read", "bash", "edit"],
  limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
  role: "implementer",
};

/** Deep clone so mutations in one case never leak into the next. */
function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
}

/** Assert the mutated profile passes validation unchanged. */
function expectValid(mutate: (p: Record<string, unknown>) => void): void {
  const profile = clone();
  mutate(profile);
  assert.doesNotThrow(() => validateProfile(profile));
}

/** Assert the profile is rejected with a ProfileValidationError carrying `key`. */
function expectReject(key: string, mutate: (p: Record<string, unknown>) => void): void {
  const profile = clone();
  mutate(profile);
  assert.throws(
    () => validateProfile(profile),
    (err: unknown) => {
      assert.ok(
        err instanceof ProfileValidationError,
        `expected ProfileValidationError, got: ${String(err)}`,
      );
      assert.equal((err as ProfileValidationError).key, key);
      return true;
    },
    `expected rejection carrying key "${key}"`,
  );
}

test("validateProfile accepts a §4.2-conformant profile and returns it typed", () => {
  const profile: Profile = validateProfile(clone());
  assert.equal(profile.name, "dev");
  assert.equal(profile.provider, "anthropic");
  assert.equal(profile.model, "claude-3-5-sonnet-20241022");
  assert.equal(profile.thinking_level, "high");
  assert.equal(profile.system_prompt_path, "prompts/dev_system.md");
  assert.deepEqual(profile.tools_allowlist, ["read", "bash", "edit"]);
  assert.deepEqual(profile.limits, { max_timeout_sec: 3600, max_cost_usd: 5 });
  assert.equal(profile.role, "implementer");
});

test("role is optional — a convention, not required", () => {
  const input = clone();
  delete input["role"];
  const profile = validateProfile(input);
  assert.equal(profile.role, undefined);
  assert.equal("role" in profile, false);
});

test("every §4.2 required key is enforced, each error carrying its key", () => {
  for (const key of PROFILE_REQUIRED_KEYS) {
    expectReject(key, (p) => {
      delete p[key];
    });
  }
});

test("unknown top-level keys are rejected (additionalProperties: false)", () => {
  expectReject("extra", (p) => {
    p["extra"] = 1;
  });
});

test("unknown limits keys are rejected (limits additionalProperties: false)", () => {
  expectReject("limits.bonus", (p) => {
    (p["limits"] as Record<string, unknown>)["bonus"] = 1;
  });
});

test("name must match the schema pattern ^[a-z0-9-]+$", () => {
  expectReject("name", (p) => {
    p["name"] = "Dev Profile";
  });
  expectReject("name", (p) => {
    p["name"] = "";
  });
});

test("wrong types are rejected per property", () => {
  expectReject("name", (p) => {
    p["name"] = 7;
  });
  expectReject("provider", (p) => {
    p["provider"] = true;
  });
  expectReject("model", (p) => {
    p["model"] = 42;
  });
  expectReject("thinking_level", (p) => {
    p["thinking_level"] = null;
  });
  expectReject("system_prompt_path", (p) => {
    p["system_prompt_path"] = [];
  });
  expectReject("role", (p) => {
    p["role"] = 99;
  });
  expectReject("tools_allowlist", (p) => {
    p["tools_allowlist"] = "read";
  });
  expectReject("limits", (p) => {
    p["limits"] = 5;
  });
});

test("minLength constraints: model, system_prompt_path, role", () => {
  expectReject("model", (p) => {
    p["model"] = "";
  });
  expectReject("system_prompt_path", (p) => {
    p["system_prompt_path"] = "";
  });
  expectReject("role", (p) => {
    p["role"] = "ab";
  });
});

test("tools_allowlist: non-string, empty, and duplicate entries are rejected", () => {
  expectReject("tools_allowlist", (p) => {
    p["tools_allowlist"] = ["read", 7];
  });
  // The schema pins no minLength on items — an empty entry is spec-conformant
  // (review round: the old rejection was an invented constraint).
  expectValid((p) => {
    p["tools_allowlist"] = ["read", ""];
  });
  expectReject("tools_allowlist", (p) => {
    p["tools_allowlist"] = ["read", "read"];
  });
});

test("limits requires both max_timeout_sec and max_cost_usd (dotted keys)", () => {
  expectReject("limits.max_timeout_sec", (p) => {
    delete (p["limits"] as Record<string, unknown>)["max_timeout_sec"];
  });
  expectReject("limits.max_cost_usd", (p) => {
    delete (p["limits"] as Record<string, unknown>)["max_cost_usd"];
  });
});

test("limits: bounds and integer-ness are rejected with dotted keys", () => {
  expectReject("limits.max_timeout_sec", (p) => {
    (p["limits"] as Record<string, unknown>)["max_timeout_sec"] = 0;
  });
  expectReject("limits.max_timeout_sec", (p) => {
    (p["limits"] as Record<string, unknown>)["max_timeout_sec"] = 1.5;
  });
  expectReject("limits.max_timeout_sec", (p) => {
    (p["limits"] as Record<string, unknown>)["max_timeout_sec"] = "3600";
  });
  expectReject("limits.max_cost_usd", (p) => {
    (p["limits"] as Record<string, unknown>)["max_cost_usd"] = -0.01;
  });
  expectReject("limits.max_cost_usd", (p) => {
    (p["limits"] as Record<string, unknown>)["max_cost_usd"] = "5";
  });
});

test("a non-object profile root is rejected", () => {
  assert.throws(() => validateProfile("nope"), ProfileValidationError);
  assert.throws(() => validateProfile([VALID]), ProfileValidationError);
  assert.throws(() => validateProfile(null), ProfileValidationError);
});

test("loadProfile reads and validates a profile.json file", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-profile-"));
  try {
    const path = join(dir, "dev.json");
    writeFileSync(path, JSON.stringify(VALID, null, 2) + "\n");
    const profile = loadProfile(path);
    assert.equal(profile.name, "dev");
    assert.deepEqual(profile.limits, { max_timeout_sec: 3600, max_cost_usd: 5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProfile propagates JSON parse failures (no silent drops)", () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-profile-"));
  try {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => loadProfile(path), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
