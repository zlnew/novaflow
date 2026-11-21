import { readFileSync } from "node:fs";

/**
 * Agent profile load + validation per the frozen §4.2 schema
 * (novaflow-v1/data 4.2, "AgentProfileConfiguration"). Golden tests
 * re-parse the spec block live and fail the build on any drift — the
 * required-key list and every constraint here mirror the schema verbatim.
 */

export type ProfileLimits = {
  max_timeout_sec: number;
  max_cost_usd: number;
};

export type Profile = {
  name: string;
  provider: string;
  model: string;
  thinking_level: string;
  system_prompt_path: string;
  tools_allowlist: string[];
  limits: ProfileLimits;
  /** Optional free-form label; a convention, carries no engine behavior. */
  role?: string;
};

/** The schema's `required` array (data.md §4.2), order verbatim. */
export const PROFILE_REQUIRED_KEYS: readonly string[] = [
  "name",
  "provider",
  "model",
  "thinking_level",
  "system_prompt_path",
  "tools_allowlist",
  "limits",
];

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...PROFILE_REQUIRED_KEYS,
  "role",
]);

/** Schema: `"name": { "type": "string", "pattern": "^[a-z0-9-]+$" }`. */
const NAME_PATTERN = /^[a-z0-9-]+$/;

/** Typed validation failure carrying the offending key (dotted for limits). */
export class ProfileValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function expectString(
  obj: Record<string, unknown>,
  key: string,
  minLength?: number,
): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new ProfileValidationError(
      key,
      `profile key "${key}" must be a string, got ${typeLabel(v)}`,
    );
  }
  if (minLength !== undefined && v.length < minLength) {
    throw new ProfileValidationError(
      key,
      `profile key "${key}" must be at least ${minLength} characters, got length ${v.length}`,
    );
  }
  return v;
}

function expectObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ProfileValidationError(
      key,
      `profile key "${key}" must be an object, got ${typeLabel(v)}`,
    );
  }
  return v as Record<string, unknown>;
}

/**
 * Validate an unknown value against the §4.2 schema. Rejects unknown keys
 * (the schema declares `additionalProperties: false` at the top level and
 * inside `limits`), wrong types, pattern/minLength violations, non-unique or
 * empty tools_allowlist entries, and out-of-bounds limits — every rejection a
 * ProfileValidationError carrying the offending key.
 */
export function validateProfile(input: unknown): Profile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProfileValidationError(
      "(root)",
      `profile must be a JSON object, got ${typeLabel(input)}`,
    );
  }
  const obj = input as Record<string, unknown>;

  // additionalProperties: false — unknown keys are rejected, never dropped.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ProfileValidationError(
        key,
        `unknown profile key "${key}" — the §4.2 schema declares additionalProperties: false`,
      );
    }
  }
  for (const key of PROFILE_REQUIRED_KEYS) {
    if (!(key in obj)) {
      throw new ProfileValidationError(
        key,
        `profile is missing required key "${key}"`,
      );
    }
  }

  const name = expectString(obj, "name");
  if (!NAME_PATTERN.test(name)) {
    throw new ProfileValidationError(
      "name",
      `profile key "name" must match ${NAME_PATTERN}, got ${JSON.stringify(name)}`,
    );
  }
  const provider = expectString(obj, "provider");
  const model = expectString(obj, "model", 1); // schema: minLength 1
  const thinkingLevel = expectString(obj, "thinking_level");
  const systemPromptPath = expectString(obj, "system_prompt_path", 1); // minLength 1

  // tools_allowlist: array of strings, uniqueItems: true, no empty entries.
  const allow = obj["tools_allowlist"];
  if (!Array.isArray(allow)) {
    throw new ProfileValidationError(
      "tools_allowlist",
      `profile key "tools_allowlist" must be an array, got ${typeLabel(allow)}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of allow) {
    if (typeof entry !== "string") {
      throw new ProfileValidationError(
        "tools_allowlist",
        `tools_allowlist entries must be strings, got ${typeLabel(entry)}`,
      );
    }
    if (entry === "") {
      throw new ProfileValidationError(
        "tools_allowlist",
        "tools_allowlist must not contain empty entries",
      );
    }
    if (seen.has(entry)) {
      throw new ProfileValidationError(
        "tools_allowlist",
        `tools_allowlist entries must be unique (schema uniqueItems: true): ${JSON.stringify(entry)}`,
      );
    }
    seen.add(entry);
  }

  // limits: object, required max_timeout_sec / max_cost_usd,
  // additionalProperties: false.
  const limits = expectObject(obj, "limits");
  for (const key of Object.keys(limits)) {
    if (key !== "max_timeout_sec" && key !== "max_cost_usd") {
      throw new ProfileValidationError(
        `limits.${key}`,
        `unknown limits key "${key}" — the §4.2 limits object declares additionalProperties: false`,
      );
    }
  }
  for (const required of ["max_timeout_sec", "max_cost_usd"] as const) {
    if (!(required in limits)) {
      throw new ProfileValidationError(
        `limits.${required}`,
        `limits is missing required key "${required}"`,
      );
    }
  }
  const timeout = limits["max_timeout_sec"];
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1) {
    throw new ProfileValidationError(
      "limits.max_timeout_sec",
      `max_timeout_sec must be an integer >= 1 (schema "integer", minimum 1), got ${JSON.stringify(timeout)}`,
    );
  }
  const cost = limits["max_cost_usd"];
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new ProfileValidationError(
      "limits.max_cost_usd",
      `max_cost_usd must be a number >= 0 (schema "number", minimum 0.0), got ${JSON.stringify(cost)}`,
    );
  }

  const profile: Profile = {
    name,
    provider,
    model,
    thinking_level: thinkingLevel,
    system_prompt_path: systemPromptPath,
    tools_allowlist: allow as string[],
    limits: { max_timeout_sec: timeout, max_cost_usd: cost },
  };
  if ("role" in obj) {
    profile.role = expectString(obj, "role", 3); // schema: minLength 3
  }
  return profile;
}

/** Load and validate a `profiles/<name>.json` file (data.md §4.2). */
export function loadProfile(path: string): Profile {
  return validateProfile(JSON.parse(readFileSync(path, "utf8")));
}
