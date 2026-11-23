import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./store/db.ts";
import { novaflowDir } from "./workspaces.ts";

/**
 * Agent profile load + validation per the frozen §4.2 schema
 * (novaflow-v1/data 4.2, "AgentProfileConfiguration"). Golden tests
 * re-parse the spec block live and fail the build on any drift — the
 * required-key list and every constraint here mirror the schema verbatim.
 *
 * It is also the profile LIFECYCLE service (v0.2.0 P5, DEBT-008): the
 * daemon's `nova_profile_update` / `nova_profile_delete` op bodies route
 * here so the resolution rule, the canonical file home and the
 * row+file transaction are written once, beside the validator that
 * guards them. The daemon still owns the store: nothing here opens a
 * connection.
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

/** Exported for golden pinning against the live spec block (data.md 4.2). */
export const PROFILE_KNOWN_KEYS: ReadonlySet<string> = KNOWN_KEYS;

/** Schema: `"name": { "type": "string", "pattern": "^[a-z0-9-]+$" }`. */
/** Exported for golden pinning — the pattern must equal the spec's, live. */
export const NAME_PATTERN = /^[a-z0-9-]+$/;

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
 * inside `limits`), wrong types, pattern/minLength violations, non-unique
 * tools_allowlist entries, and out-of-bounds limits — every rejection a
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

  // tools_allowlist: array of strings, uniqueItems: true (the schema pins no
  // minLength on items — an empty string entry is spec-conformant and passes).
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

/* ------------------------- lifecycle (v0.2.0 P5, DEBT-008) ------------------------- */

/** The `agent_profiles` row (data.md DDL columns; the §4.2 fields + scoping). */
export type ProfileRow = {
  id: string;
  workspace_id: string | null;
  name: string;
  role: string | null;
  provider: string;
  model: string;
  thinking_level: string;
  tools_allowlist_json: string;
  system_prompt_path: string;
  max_timeout_sec: number;
  max_cost_usd: number;
  created_at: string;
};

/**
 * The canonical profile home (data.md 5.2):
 * `<workspace_root>/.novaflow/profiles/<name>.json`. ONE definition —
 * create writes it, update rewrites it, delete removes it.
 */
export function canonicalProfilePath(workspaceRoot: string, name: string): string {
  return join(novaflowDir(workspaceRoot), "profiles", `${name}.json`);
}

/**
 * The engine's name-resolution rule, verbatim (the enqueue path's
 * `resolveProfileByName`): a WORKSPACE-scoped row wins over a global row
 * of the same name — NULLS-last on the workspace column — so a stale
 * global row can never shadow the workspace's own profile. With no
 * workspace context only a global row is addressable (a workspace-scoped
 * profile is reached by naming its workspace).
 *
 * Both lifecycle verbs resolve through THIS function, so the verb acts on
 * exactly the row the engine would pick for a task in that workspace.
 */
export function resolveProfileRow(
  db: Db,
  name: string,
  workspaceId: string | undefined,
): ProfileRow | undefined {
  if (workspaceId === undefined) {
    return db
      .prepare("SELECT * FROM agent_profiles WHERE name = ? AND workspace_id IS NULL")
      .get(name) as ProfileRow | undefined;
  }
  return db
    .prepare(
      "SELECT * FROM agent_profiles WHERE name = ? AND (workspace_id IS NULL OR workspace_id = ?) ORDER BY workspace_id IS NULL LIMIT 1",
    )
    .get(name, workspaceId) as ProfileRow | undefined;
}

export function getProfileRow(db: Db, id: string): ProfileRow | undefined {
  return db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as
    | ProfileRow
    | undefined;
}

/**
 * How many tasks pin a profile. `tasks.profile_id` is the store's only
 * ON DELETE RESTRICT reference to `agent_profiles`, and it is counted
 * EXPLICITLY (the card's risk note): a refusal must name the count, and a
 * nullable/absent FK must never let a pinned profile slip through. Run
 * rows snapshot the profile id WITHOUT a foreign key (FR-TSK-09: the
 * attempt's profile is history, not a live reference), so a run is not a
 * pin.
 */
export function countProfilePins(db: Db, profileId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE profile_id = ?").get(profileId) as {
      n: number;
    }
  ).n;
}

/** The writable column projection of a validated §4.2 profile. */
function profileColumns(profile: Profile): {
  role: string | null;
  provider: string;
  model: string;
  thinking_level: string;
  tools_allowlist_json: string;
  system_prompt_path: string;
  max_timeout_sec: number;
  max_cost_usd: number;
} {
  return {
    role: profile.role ?? null,
    provider: profile.provider,
    model: profile.model,
    thinking_level: profile.thinking_level,
    tools_allowlist_json: JSON.stringify(profile.tools_allowlist),
    system_prompt_path: profile.system_prompt_path,
    max_timeout_sec: profile.limits.max_timeout_sec,
    max_cost_usd: profile.limits.max_cost_usd,
  };
}

/** True when the validated profile carries nothing the stored row lacks. */
export function profileMatchesRow(row: ProfileRow, profile: Profile): boolean {
  const c = profileColumns(profile);
  return (
    row.role === c.role &&
    row.provider === c.provider &&
    row.model === c.model &&
    row.thinking_level === c.thinking_level &&
    row.tools_allowlist_json === c.tools_allowlist_json &&
    row.system_prompt_path === c.system_prompt_path &&
    row.max_timeout_sec === c.max_timeout_sec &&
    row.max_cost_usd === c.max_cost_usd
  );
}

/**
 * Rewrite the row and (workspace-scoped only) the canonical file in ONE
 * transaction: the file write runs INSIDE it, so a write failure rolls
 * the row back — the row is never updated without its canonical copy.
 * Global profiles have no canonical home in v1 (create wrote none), so
 * `canonicalPath` is null there.
 */
export function updateProfile(
  db: Db,
  input: { row: ProfileRow; profile: Profile; raw: unknown; canonicalPath: string | null },
): ProfileRow {
  const c = profileColumns(input.profile);
  db.transaction((): void => {
    db.prepare(
      `UPDATE agent_profiles
          SET role = ?, provider = ?, model = ?, thinking_level = ?,
              tools_allowlist_json = ?, system_prompt_path = ?,
              max_timeout_sec = ?, max_cost_usd = ?
        WHERE id = ?`,
    ).run(
      c.role,
      c.provider,
      c.model,
      c.thinking_level,
      c.tools_allowlist_json,
      c.system_prompt_path,
      c.max_timeout_sec,
      c.max_cost_usd,
      input.row.id,
    );
    if (input.canonicalPath !== null) {
      writeFileSync(input.canonicalPath, JSON.stringify(input.raw, null, 2) + "\n");
    }
  })();
  const updated = getProfileRow(db, input.row.id);
  if (!updated) throw new Error(`updated profile ${input.row.id} is missing from the store`);
  return updated;
}

/**
 * Delete the row inside a transaction, THEN remove the canonical file (the
 * row is the authoritative record — never the file first). A removal
 * failure is RETURNED, never swallowed: the caller reports it, so an
 * operator never believes the canonical copy is gone when it is not. An
 * already-absent file is not a failure (nothing to remove).
 */
export function deleteProfile(
  db: Db,
  input: { row: ProfileRow; canonicalPath: string | null },
): { file_removed: boolean; file_removal_error: string | null } {
  const remove = db.transaction(
    (): number => db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(input.row.id).changes,
  );
  const changes = remove();
  if (changes !== 1) {
    throw new Error(`profile ${input.row.id} vanished before the delete (${changes} rows)`);
  }
  if (input.canonicalPath === null) return { file_removed: false, file_removal_error: null };
  try {
    unlinkSync(input.canonicalPath);
    return { file_removed: true, file_removal_error: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { file_removed: false, file_removal_error: null };
    return { file_removed: false, file_removal_error: e.message };
  }
}
