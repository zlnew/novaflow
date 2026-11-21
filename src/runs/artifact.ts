import { existsSync, readFileSync } from "node:fs";

/**
 * Structural validation of the Task Handoff Artifact (`result.json`)
 * against the frozen §4.1 block (novaflow-v1/data 4.1, TaskHandoffArtifact).
 * Golden tests re-parse the spec block live and pin every constant here,
 * exactly like the p2a profile pins.
 *
 * Scope note (data.md §4.1 description): the engine OVERWRITES the
 * engine-owned annotations (engine_verified, protected_files_untouched,
 * verification_results, role) after VALIDATING and never trusts
 * agent-authored values — the VALIDATING-phase verification itself is
 * p2c scope, so this validator only checks STRUCTURE; the run loop
 * records the artifact and leaves the engine-owned fields untouched.
 */

/** The block's `required` array, order verbatim. */
export const ARTIFACT_REQUIRED_KEYS: readonly string[] = [
  "schema_version",
  "task_id",
  "run_id",
  "status",
  "summary",
  "assumptions_made",
  "open_questions",
  "artifacts_modified",
  "feedback_items",
  "next_recommended_action",
];

/** `additionalProperties: false` allow-list = the block's property set. */
export const ARTIFACT_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  ...ARTIFACT_REQUIRED_KEYS,
  "role",
  "engine_verified",
  "protected_files_untouched",
  "verification_results",
]);

export const ARTIFACT_STATUS_ENUM = [
  "completed",
  "changes_requested",
  "blocked",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUS_ENUM)[number];

export const ARTIFACT_NEXT_ACTION_ENUM = [
  "proceed_to_next",
  "human_review",
  "retry_with_context",
  "abort_pipeline",
] as const;

export const ARTIFACT_ACTION_ENUM = [
  "created",
  "modified",
  "deleted",
  "renamed",
] as const;

export const ARTIFACT_FEEDBACK_SEVERITY_ENUM = [
  "info",
  "warning",
  "error",
  "critical",
] as const;

/** §4.1: `"task_id": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" }`. */
export const ARTIFACT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SCHEMA_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export type ArtifactModifiedItem = {
  target_alias: string;
  path: string;
  action: (typeof ARTIFACT_ACTION_ENUM)[number];
  diff_summary?: string;
};

export type TaskHandoffArtifact = {
  schema_version: string;
  task_id: string;
  run_id: string;
  role?: string;
  status: ArtifactStatus;
  summary: string;
  assumptions_made: string[];
  open_questions: string[];
  artifacts_modified: ArtifactModifiedItem[];
  verification_results?: unknown[];
  engine_verified?: boolean;
  protected_files_untouched?: boolean;
  feedback_items: unknown[];
  next_recommended_action: (typeof ARTIFACT_NEXT_ACTION_ENUM)[number];
  [key: string]: unknown;
};

export type ArtifactValidation =
  | { ok: true; artifact: TaskHandoffArtifact }
  | { ok: false; errors: string[] };

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateModifiedItems(items: unknown, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push(`"artifacts_modified" must be an array`);
    return;
  }
  items.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`"artifacts_modified[${i}]" must be an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    if (typeof o["target_alias"] !== "string") errors.push(`"artifacts_modified[${i}].target_alias" must be a string`);
    if (typeof o["path"] !== "string") errors.push(`"artifacts_modified[${i}].path" must be a string`);
    if (!(ARTIFACT_ACTION_ENUM as readonly string[]).includes(o["action"] as string)) {
      errors.push(`"artifacts_modified[${i}].action" must be one of ${JSON.stringify(ARTIFACT_ACTION_ENUM)}`);
    }
    for (const k of Object.keys(o)) {
      if (!["target_alias", "path", "action", "diff_summary"].includes(k)) {
        errors.push(`"artifacts_modified[${i}]" has unknown key "${k}"`);
      }
    }
  });
}

function validateFeedbackItems(items: unknown, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push(`"feedback_items" must be an array`);
    return;
  }
  items.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`"feedback_items[${i}]" must be an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    if (!(ARTIFACT_FEEDBACK_SEVERITY_ENUM as readonly string[]).includes(o["severity"] as string)) {
      errors.push(`"feedback_items[${i}].severity" must be one of ${JSON.stringify(ARTIFACT_FEEDBACK_SEVERITY_ENUM)}`);
    }
    if (typeof o["category"] !== "string") errors.push(`"feedback_items[${i}].category" must be a string`);
    if (typeof o["message"] !== "string") errors.push(`"feedback_items[${i}].message" must be a string`);
    for (const k of Object.keys(o)) {
      if (!["severity", "category", "message", "file_location"].includes(k)) {
        errors.push(`"feedback_items[${i}]" has unknown key "${k}"`);
      }
    }
  });
}

function validateVerificationResults(items: unknown, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push(`"verification_results" must be an array`);
    return;
  }
  items.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`"verification_results[${i}]" must be an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    if (typeof o["command"] !== "string") errors.push(`"verification_results[${i}].command" must be a string`);
    if (typeof o["exit_code"] !== "number" || !Number.isInteger(o["exit_code"])) {
      errors.push(`"verification_results[${i}].exit_code" must be an integer`);
    }
    if (typeof o["passed"] !== "boolean") errors.push(`"verification_results[${i}].passed" must be a boolean`);
    for (const k of Object.keys(o)) {
      if (!["command", "exit_code", "passed", "output_tail"].includes(k)) {
        errors.push(`"verification_results[${i}]" has unknown key "${k}"`);
      }
    }
  });
}

/**
 * Validate the structure of a parsed result.json candidate. Returns
 * either the typed artifact or the full list of structural errors.
 */
export function validateArtifact(value: unknown): ArtifactValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["result.json must be a JSON object"] };
  }
  const o = value as Record<string, unknown>;

  for (const key of Object.keys(o)) {
    if (!ARTIFACT_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unknown top-level key "${key}"`);
    }
  }
  for (const key of ARTIFACT_REQUIRED_KEYS) {
    if (!(key in o)) errors.push(`missing required key "${key}"`);
  }

  if (typeof o["schema_version"] === "string") {
    if (!SCHEMA_VERSION_PATTERN.test(o["schema_version"])) {
      errors.push(`"schema_version" must match semver (got ${JSON.stringify(o["schema_version"])})`);
    }
  } else if ("schema_version" in o) {
    errors.push(`"schema_version" must be a string`);
  }

  for (const key of ["task_id", "run_id"]) {
    const v = o[key];
    if (typeof v === "string") {
      if (!ARTIFACT_ID_PATTERN.test(v)) {
        errors.push(`"${key}" must match the §4.1 ULID pattern (got ${JSON.stringify(v)})`);
      }
    } else if (key in o) {
      errors.push(`"${key}" must be a string`);
    }
  }

  if (typeof o["status"] === "string") {
    if (!(ARTIFACT_STATUS_ENUM as readonly string[]).includes(o["status"])) {
      errors.push(`"status" must be one of ${JSON.stringify(ARTIFACT_STATUS_ENUM)}`);
    }
  } else if ("status" in o) {
    errors.push(`"status" must be a string`);
  }

  if (typeof o["summary"] === "string") {
    if (o["summary"].length < 10) errors.push(`"summary" must be at least 10 characters`);
  } else if ("summary" in o) {
    errors.push(`"summary" must be a string`);
  }

  for (const key of ["assumptions_made", "open_questions"]) {
    if (key in o && !isStringArray(o[key])) errors.push(`"${key}" must be an array of strings`);
  }

  if ("artifacts_modified" in o) validateModifiedItems(o["artifacts_modified"], errors);
  if ("feedback_items" in o) validateFeedbackItems(o["feedback_items"], errors);
  if ("verification_results" in o) validateVerificationResults(o["verification_results"], errors);

  if ("role" in o && typeof o["role"] !== "string") errors.push(`"role" must be a string`);
  if ("engine_verified" in o && typeof o["engine_verified"] !== "boolean") errors.push(`"engine_verified" must be a boolean`);
  if ("protected_files_untouched" in o && typeof o["protected_files_untouched"] !== "boolean") {
    errors.push(`"protected_files_untouched" must be a boolean`);
  }

  if (typeof o["next_recommended_action"] === "string") {
    if (!(ARTIFACT_NEXT_ACTION_ENUM as readonly string[]).includes(o["next_recommended_action"])) {
      errors.push(`"next_recommended_action" must be one of ${JSON.stringify(ARTIFACT_NEXT_ACTION_ENUM)}`);
    }
  } else if ("next_recommended_action" in o) {
    errors.push(`"next_recommended_action" must be a string`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, artifact: value as TaskHandoffArtifact };
}

export type ArtifactRead =
  | { ok: true; artifact: TaskHandoffArtifact }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid"; errors: string[] };

/**
 * Read and structurally validate `<run_dir>/result.json` after
 * agent_settled (FR-TSK-06: validates immediately upon the completion
 * signal). Missing → reason "missing"; unparseable or schema-invalid →
 * reason "invalid" with the error list. Never throws.
 */
export function readArtifactFile(path: string): ArtifactRead {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      ok: false,
      reason: "invalid",
      errors: [`result.json is not parseable JSON: ${(err as Error).message}`],
    };
  }
  const res = validateArtifact(raw);
  if (res.ok) return { ok: true, artifact: res.artifact };
  return { ok: false, reason: "invalid", errors: res.errors };
}
