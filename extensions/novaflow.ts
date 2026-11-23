/**
 * novaflow.ts — the NovaFlow Pi extension (novaflow-v1/api §6).
 *
 * ONE self-contained module, by design: the installed copy lives at
 * ~/.pi/agent/extensions/novaflow.ts (a COPY of this file — manual
 * install, not engine state), so it never imports repo `src/`
 * modules at runtime. Everything it needs is either a Node builtin,
 * a type-only import (erased under pi's jiti loader), or one of the
 * documented PORTS below, each pinned to the engine original by a
 * parity test (test/extensions/runmode.test.ts):
 *
 *   PORT 1 — glob matcher (src/verify/protected.ts globMatch): the
 *   p2c-bounded matcher (linear two-pointer segment scan, memoized
 *   `**` splitting — no regex, no catastrophic backtracking).
 *
 *   PORT 2 — the Task Handoff Artifact structural validator
 *   (src/runs/artifact.ts validateArtifact): the frozen §4.1 block's
 *   rules, error strings byte-identical. The extension's in-process
 *   check is the agent-facing FAST FAIL; the engine re-runs
 *   artifact.ts on settle and remains the validator of record.
 *
 *   PORT 3 — the daemon socket client (src/cli/client.ts
 *   daemonRequest): the same one-line JSONL frame
 *   {id, op, args, surface:"human"} over ~/.novaflow/novaflow.sock,
 *   honoring NOVAFLOW_HOME / NOVAFLOW_SOCK. Operator mode is a
 *   socket client ONLY — the extension never opens the store.
 *
 * Two modes, one factory (the mode is an env fact at load time):
 *
 *   RUN MODE (`NOVAFLOW_RUN_CONTEXT` set — the spawner's contract):
 *     - `session_start` loads engine-context.json (§6 "Extension
 *       context injection"); the run dir is dirname(contextPath).
 *     - `tool_call` enforces the scopes per call: write/edit/bash
 *       targets must match the governing read_write target's
 *       write_scope_globs, never touch protected_test_globs, and
 *       read_only targets refuse writes outright. The check-time
 *       realpath defends against links that already exist when the
 *       call is judged; a same-command `ln`+write is source-scanned —
 *       a link created inside a governed root from a source outside
 *       that root's writable scope is refused up front (the
 *       create-then-write window). Blocked calls
 *       return {block, reason} WITHOUT terminate — the agent retries
 *       with the reason as feedback.
 *     - `novaflow_submit_result` is the completion signal: it
 *       validates the §4.1 artifact in-process, writes
 *       <run_dir>/result.json (the ONLY thing this extension ever
 *       writes), and returns {block: true, terminate: true,
 *       reason: "artifact accepted"} — termination is a BLOCK-RESULT
 *       field, and pi stops the agent only when EVERY finalized
 *       result in the batch is terminating (the batch rule is pi's,
 *       not ours — verified live in test/extensions/smoke.mjs).
 *     - Target root paths are NOT part of the §6 context fields;
 *       they ride the run dir's protected-digests.json (written by
 *       the engine's own preflight, src/runs/loop.ts), joined by
 *       target_id. Scopes without a snapshot fail CLOSED.
 *
 *   OPERATOR MODE (no run context): the /nova command family —
 *   status / plan / queue / gate approve|reject — over the socket
 *   client, surface "human". A dead socket renders the CLI's
 *   exit-5-style structured error to the chat, never a throw. Operator
 *   sessions additionally run the WAKE WATCHER (novaflow-v02/wake.md):
 *   a ~2 s poll of `nova_transitions_since` that injects one
 *   `[novaflow] …` follow-up message per human-attention transition
 *   (awaiting_gate, failed, inferred chain completion) — seeded at head
 *   on session_start, cleared on session_shutdown.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/* --------------------------------- constants ---------------------------------- */

export const SUBMIT_TOOL_NAME = "novaflow_submit_result";
export const RESULT_FILENAME = "result.json";
export const SNAPSHOT_FILENAME = "protected-digests.json";

/** Payload cap for the submit tool (spec-silent, documented): 256 KiB. */
export const MAX_RESULT_PAYLOAD_BYTES = 262_144;

/** The §6 run-context injection path (src/runs/spawn.ts passes it). */
const RUN_CONTEXT_ENV = "NOVAFLOW_RUN_CONTEXT";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/* ------------------------------ PORT 1: glob matcher ------------------------------ */
/* (ported from src/verify/protected.ts — see module doc; parity-tested) */

function segmentMatch(patternSegment: string, pathSegment: string): boolean {
  let pi = 0;
  let si = 0;
  let starPat = -1;
  let starStr = 0;
  while (si < pathSegment.length) {
    if (pi < patternSegment.length && patternSegment[pi] === "*") {
      starPat = pi++;
      starStr = si;
    } else if (pi < patternSegment.length && patternSegment[pi] === pathSegment[si]) {
      pi++;
      si++;
    } else if (starPat >= 0) {
      pi = starPat + 1;
      si = ++starStr;
    } else {
      return false;
    }
  }
  while (pi < patternSegment.length && patternSegment[pi] === "*") pi++;
  return pi === patternSegment.length;
}

function matchSegments(pat: string[], path: string[]): boolean {
  const width = path.length + 1;
  const memo = new Int8Array((pat.length + 1) * width);
  const visit = (pi: number, si: number): boolean => {
    const hit = memo[pi * width + si]!;
    if (hit !== 0) return hit === 1;
    let res: boolean;
    if (pi === pat.length) {
      res = si === path.length;
    } else if (pat[pi] === "**") {
      res = false;
      for (let k = si; k <= path.length && !res; k++) res = visit(pi + 1, k);
    } else if (si === path.length) {
      res = false;
    } else if (segmentMatch(pat[pi]!, path[si]!)) {
      res = visit(pi + 1, si + 1);
    } else {
      res = false;
    }
    memo[pi * width + si] = res ? 1 : -1;
    return res;
  };
  return visit(0, 0);
}

/** Match a glob from the documented subset against a target-relative path. */
export function globMatch(pattern: string, relPath: string): boolean {
  return matchSegments(pattern.split("/"), relPath.split("/"));
}

/** True when the relative path matches at least one glob in the set. */
export function globMatchAny(patterns: readonly string[], relPath: string): boolean {
  return patterns.some((p) => globMatch(p, relPath));
}

/* --------------------------- PORT 2: artifact validator --------------------------- */
/* (ported from src/runs/artifact.ts — see module doc; parity-tested) */

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

export const ARTIFACT_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  ...ARTIFACT_REQUIRED_KEYS,
  "role",
  "engine_verified",
  "protected_files_untouched",
  "verification_results",
]);

export const ARTIFACT_STATUS_ENUM = ["completed", "changes_requested", "blocked"] as const;
export const ARTIFACT_NEXT_ACTION_ENUM = [
  "proceed_to_next",
  "human_review",
  "retry_with_context",
  "abort_pipeline",
] as const;
export const ARTIFACT_ACTION_ENUM = ["created", "modified", "deleted", "renamed"] as const;
export const ARTIFACT_FEEDBACK_SEVERITY_ENUM = ["info", "warning", "error", "critical"] as const;

export const ARTIFACT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SCHEMA_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export type ArtifactValidation =
  | { ok: true; artifact: Record<string, unknown> }
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

function validateFileLocation(value: unknown, index: number, errors: string[]): void {
  const where = `"feedback_items[${index}].file_location"`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${where} must be an object`);
    return;
  }
  const o = value as Record<string, unknown>;
  if (typeof o["path"] !== "string") errors.push(`${where}.path" must be a string`);
  const line = o["line"];
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    errors.push(`${where}.line" must be an integer >= 1`);
  }
  for (const k of Object.keys(o)) {
    if (k !== "path" && k !== "line") errors.push(`${where} has unknown key "${k}"`);
  }
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
    if ("file_location" in o) validateFileLocation(o["file_location"], i, errors);
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
 * Validate the structure of a parsed result.json candidate (the §4.1
 * block's rules — the port of the engine's own validator).
 */
export function validateArtifactStructure(value: unknown): ArtifactValidation {
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

  if ("role" in o) {
    if (typeof o["role"] !== "string") errors.push(`"role" must be a string`);
    else if ((o["role"] as string).length < 1) errors.push(`"role" must be at least 1 character`);
  }
  if ("engine_verified" in o && typeof o["engine_verified"] !== "boolean") {
    errors.push(`"engine_verified" must be a boolean`);
  }
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
  return { ok: true, artifact: o };
}

/* ------------------------------- run context loading ------------------------------ */

export type RunScope = {
  target_id: string;
  alias: string;
  access_mode: "read_only" | "read_write";
  write_scope_globs: string[];
  protected_test_globs: string[];
  root_path: string;
  target_type: "git_repo" | "directory";
};

export type RunContext = {
  taskId: string;
  runId: string;
  runDir: string;
  scopes: RunScope[];
  /** Non-null when the context (or its snapshot) could not be loaded — fail closed. */
  loadError: string | null;
};

type EngineContextFile = {
  task_id: string;
  run_id: string;
  scopes: Array<{
    target_id: string;
    alias: string;
    access_mode: "read_only" | "read_write";
    write_scope_globs: string[];
    protected_test_globs: string[];
  }>;
};

type SnapshotFile = {
  targets: Array<{
    target_id: string;
    alias: string;
    target_type: "git_repo" | "directory";
    root_path: string;
  }>;
};

function isStringArrayStrict(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Load the §6 run context: engine-context.json for the scopes, joined
 * with the run dir's protected-digests.json (the engine's own preflight
 * file) for each target's root path and type — the §6 context fields
 * do not carry roots, and scope enforcement cannot exist without them.
 * Any failure is a loadError (never a throw): the tool_call hook then
 * fails closed on every mutating call.
 */
export function loadRunContext(contextPath: string): RunContext {
  const runDir = dirname(contextPath);
  try {
    const parsed: unknown = JSON.parse(readFileSync(contextPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("engine-context.json is not a JSON object");
    }
    const file = parsed as EngineContextFile;
    if (typeof file["task_id"] !== "string" || typeof file["run_id"] !== "string") {
      throw new Error("engine-context.json is missing task_id/run_id");
    }
    if (!Array.isArray(file["scopes"])) {
      throw new Error("engine-context.json has no scopes array");
    }
    const scopes: RunScope[] = [];
    for (const raw of file["scopes"]) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("a scope entry is not an object");
      }
      const s = raw as Record<string, unknown>;
      if (typeof s["target_id"] !== "string" || typeof s["alias"] !== "string") {
        throw new Error("a scope entry is missing target_id/alias");
      }
      if (s["access_mode"] !== "read_only" && s["access_mode"] !== "read_write") {
        throw new Error(`scope ${String(s["alias"])} has an invalid access_mode`);
      }
      if (!isStringArrayStrict(s["write_scope_globs"]) || !isStringArrayStrict(s["protected_test_globs"])) {
        throw new Error(`scope ${String(s["alias"])} has malformed glob arrays`);
      }
      scopes.push({
        target_id: s["target_id"],
        alias: s["alias"],
        access_mode: s["access_mode"],
        write_scope_globs: s["write_scope_globs"],
        protected_test_globs: s["protected_test_globs"],
        root_path: "",
        target_type: "directory",
      });
    }

    if (scopes.length === 0) {
      // zero mapped targets mirror the engine (src/verify/protected.ts:
      // "nothing is protected, nothing can creep") — no roots needed.
      return { taskId: file["task_id"], runId: file["run_id"], runDir, scopes, loadError: null };
    }

    const snapshotPath = join(runDir, SNAPSHOT_FILENAME);
    const snapParsed: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (snapParsed === null || typeof snapParsed !== "object" || Array.isArray(snapParsed)) {
      throw new Error(`${SNAPSHOT_FILENAME} is not a JSON object`);
    }
    const snap = snapParsed as SnapshotFile;
    if (!Array.isArray(snap["targets"])) {
      throw new Error(`${SNAPSHOT_FILENAME} has no targets array`);
    }
    const roots = new Map<string, { root_path: string; target_type: "git_repo" | "directory" } | null>();
    for (const t of snap["targets"]) {
      if (t === null || typeof t !== "object") continue;
      const o = t as Record<string, unknown>;
      if (typeof o["target_id"] !== "string" || typeof o["root_path"] !== "string") continue;
      if (o["root_path"] === "" || !isAbsolute(o["root_path"])) {
        // an empty root silently resolves to process.cwd() — a scope
        // anchored nowhere is a scope that governs the wrong tree
        roots.set(o["target_id"], null);
        continue;
      }
      roots.set(o["target_id"], {
        root_path: o["root_path"],
        target_type: o["target_type"] === "git_repo" ? "git_repo" : "directory",
      });
    }
    for (const s of scopes) {
      const root = roots.get(s.target_id);
      if (root === undefined) {
        throw new Error(`target "${s.alias}" (${s.target_id}) has no entry in ${SNAPSHOT_FILENAME} — its root path is unknown, so its scope cannot be enforced; failing closed`);
      }
      if (root === null) {
        throw new Error(`target "${s.alias}" (${s.target_id}) has an empty or non-absolute root_path in ${SNAPSHOT_FILENAME} — a rootless scope cannot be enforced; failing closed`);
      }
      s.root_path = root.root_path;
      s.target_type = root.target_type;
    }
    return { taskId: file["task_id"], runId: file["run_id"], runDir, scopes, loadError: null };
  } catch (err) {
    return {
      taskId: "",
      runId: "",
      runDir,
      scopes: [],
      loadError: `run context failed to load from ${contextPath}: ${(err as Error).message}`,
    };
  }
}

/* ------------------------------ scope enforcement ------------------------------ */

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * realpath that tolerates a not-yet-existing tail: the deepest
 * EXISTING ancestor is resolved through realpathSync (defeating
 * symlink escapes in the path), and the remainder rides along. A
 * path whose ancestors do not exist at all falls back to the plain
 * resolution — the scope check then judges it by where it would land.
 */
export function realpathSafe(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    let cur = absPath;
    const tail: string[] = [];
    for (;;) {
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) return resolve(absPath);
      tail.unshift(cur.slice(idx + 1));
      cur = cur.slice(0, idx);
      try {
        const real = realpathSync(cur);
        return join(real, ...tail);
      } catch {
        /* keep walking up */
      }
    }
  }
}

/** Strip the built-in `@path` convention, expand `~`, resolve, realpath. */
export function resolveToolPath(cwd: string, rawPath: string): string {
  let p = rawPath;
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return realpathSafe(resolve(cwd, p));
}

/** The scope whose (realpathed) root contains absPath; deepest root wins. */
export function governingScope(scopes: RunScope[], absPath: string): RunScope | null {
  let best: RunScope | null = null;
  let bestLen = -1;
  for (const s of scopes) {
    const root = realpathSafe(s.root_path);
    const rel = relative(root, absPath);
    if (rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))) {
      if (root.length > bestLen) {
        best = s;
        bestLen = root.length;
      }
    }
  }
  return best;
}

/**
 * The write-scope verdict for one resolved absolute path:
 *   - zero mapped scopes → allowed (the engine's own reading);
 *   - no governing target → refused (writes are confined to targets);
 *   - read_only target → refused;
 *   - protected_test_globs match → refused (always, scope or not);
 *   - write_scope_globs match → allowed.
 */
export function checkWritePath(scopes: RunScope[], absPath: string): CheckResult {
  if (scopes.length === 0) return { ok: true };
  const scope = governingScope(scopes, absPath);
  if (scope === null) {
    return { ok: false, reason: `no target scope covers ${absPath} — writes are confined to mapped targets (fail closed)` };
  }
  const rel = relative(realpathSafe(scope.root_path), absPath);
  if (scope.access_mode === "read_only") {
    return { ok: false, reason: `target "${scope.alias}" is read_only — writes are refused` };
  }
  if (globMatchAny(scope.protected_test_globs, rel)) {
    return { ok: false, reason: `path matches protected_test_globs of target "${scope.alias}" — protected test paths are never writable` };
  }
  if (!globMatchAny(scope.write_scope_globs, rel)) {
    return {
      ok: false,
      reason: `path is outside the write scope of target "${scope.alias}" (write_scope_globs: ${
        scope.write_scope_globs.join(", ") || "(none)"
      })`,
    };
  }
  return { ok: true };
}

/* --------------------------- bash write-target scanning --------------------------- */

/**
 * Best-effort SYNTACTIC extraction of the paths a bash command writes
 * (documented limit): redirection targets (the full operator family —
 * `>`, `>>`, `>|`, `2>`, `2>>`, `2>|`, `&>`, `&>>`) and the file
 * arguments of direct mutators (rm, mv, cp, install, ln, mkdir,
 * touch, tee, truncate, sed -i, chmod, chown, rmdir, plus dd's
 * `of=` operand; the mv/cp/install/ln `-t DIR` forms land every
 * source INSIDE DIR, not at the last operand). `cd` segments are
 * tracked, so later segments resolve their operands against the
 * updated working directory — an unresolvable `cd` (no argument, a
 * nonexistent path, `cd -`) leaves every later RELATIVE operand
 * unmapped, which checkWritePath refuses (fail closed). `ln` — hard
 * or symbolic — additionally exposes its SOURCES as link targets:
 * a link created inside a governed root from a source outside that
 * root's writable scope is exactly the create-then-write window
 * (write through the new link), so the source is held to the same
 * write-scope verdict as a direct write. Reads (cat, grep, git
 * diff, test runners) and script bodies (python -c, heredocs, git
 * internals) are NOT analyzable here — the engine's post-run
 * verification (protected digests + git status) remains the
 * authority for everything this scan cannot see.
 */

/**
 * The resolution base for operands after an unresolvable `cd`: an
 * absolute path no target root can contain, so relative write
 * operands land unmapped and are refused (fail closed). Absolute
 * operands still resolve to themselves — they never depended on
 * the working directory.
 */
const UNRESOLVED_CWD = "/novaflow-cd-untracked";

/** The redirection operator family, as standalone tokens. */
const REDIRECT_TOKEN_RE = /^(?:\d?>|&>)>?&?\|?$/;

type ScannedTarget = {
  /** The operand as written in the command. */
  raw: string;
  /** The absolute directory the operand resolves against (cd-aware). */
  base: string;
  /** True for `ln` sources — the link's source, not a direct write. */
  viaLink: boolean;
};

/** Minimal quote-aware tokenizer: quoted spans stay one token, unquoted. */
function tokenizeCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let hasToken = false;
  for (const ch of s) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === " " || ch === "\t") {
      if (hasToken || cur !== "") {
        out.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken || cur !== "") out.push(cur);
  return out;
}

/** One scanned write target per (base, raw, kind) triple, first occurrence wins. */
function scanBashWriteTargets(command: string, baseCwd: string): ScannedTarget[] {
  const out: ScannedTarget[] = [];
  let cwd = baseCwd;
  let untracked = false;
  const push = (raw: string, viaLink = false): void => {
    if (raw === "") return;
    out.push({ raw, base: untracked ? UNRESOLVED_CWD : cwd, viaLink });
  };
  // the noclobber forms (`>|`, `2>|`) carry a `|` that would read as a
  // pipe split — rewrite them to their append spellings first (the scan
  // only cares WHERE they write, not with what clobber semantics)
  const presplit = command.replace(/(\d?)>\|/g, " $1>> ");
  // re-judge r2 finding 2: the splitter is paren-blind, so a subshell
  // `(cd x && true); ...` would leak its cd into later segments — one
  // direction a masking bypass, the other a spurious block. Any paren
  // anywhere untracks the whole command: every write resolves unmapped
  // and blocks, subshell writes included. Conservative and honest.
  const parenCommand = command.includes("(") || command.includes(")");
  if (parenCommand) untracked = true;
  for (const segment of presplit.split(/&&|\|\||;|\|/)) {
    // normalize redirection operators into their own whitespace tokens
    const normalized = segment.replace(/(\d?>+)/g, " $1 ").replace(/(&>)/g, " $1 ");
    const tokens = tokenizeCommand(normalized);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (REDIRECT_TOKEN_RE.test(t) && i + 1 < tokens.length) {
        const target = tokens[i + 1]!;
        if (!target.startsWith("&")) push(target); // `2>&1`-style fd duplication is not a file write
      }
    }

    let first = 0;
    while (first < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first]!)) first++;
    const head = tokens[first];
    if (head === undefined) continue;
    const name = (head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head)
      .replace(/^\(+/, "")
      .replace(/^\\+/, ""); // `\cd` is plain cd to bash (re-judge r2 finding 3)
    const rest = tokens.slice(first + 1);

    // `command cd` / `builtin cd` move the shell exactly like cd
    let cdLike = name === "cd";
    let cdRest = rest;
    if ((name === "command" || name === "builtin") && rest[0] === "cd") {
      cdLike = true;
      cdRest = rest.slice(1);
    }

    // `cd` moves the resolution base for every later segment — but
    // NEVER adopt one inside a paren command (the splitter cannot tell a
    // subshell cd from a top-level one; untracked stays true)
    if (cdLike && parenCommand) {
      untracked = true;
      continue;
    }
    if (cdLike) {
      const op = cdRest.find((t) => t !== "-" && !t.startsWith("-"));
      if (op === undefined) {
        untracked = true; // `cd` with no argument: untrackable, fail closed
        continue;
      }
      const resolved = resolveToolPath(untracked ? UNRESOLVED_CWD : cwd, op);
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        cwd = resolved;
        untracked = false;
      } else {
        untracked = true; // a path bash itself would refuse — never guess
        // over-block, documented: after an unresolvable cd a later
        // RELATIVE cd can never recover (its base is the unmapped
        // sentinel) — real bash would recover; we keep failing closed.
      }
      continue;
    }

    const args = rest.filter((t) => !t.startsWith("-"));
    switch (name) {
      case "rm":
      case "rmdir":
      case "mkdir":
      case "touch":
      case "chmod":
      case "chown":
      case "tee":
      case "truncate":
        for (const t of args) push(t);
        break;
      case "mv":
      case "cp":
      case "install":
      case "ln": {
        // destination resolution: `-t DIR` / `--target-directory=DIR`
        // forms land every source INSIDE DIR (as DIR/basename(source));
        // the plain forms write the LAST operand. `ln` additionally
        // exposes its sources (the create-then-write window, above).
        let targetDir: string | undefined;
        const operands: string[] = [];
        for (let j = 0; j < rest.length; j++) {
          const t = rest[j]!;
          if (t === "-t" || t === "--target-directory") {
            if (j + 1 < rest.length) targetDir = rest[++j];
            continue;
          }
          if (t.startsWith("--target-directory=")) {
            targetDir = t.slice("--target-directory=".length);
            continue;
          }
          const gluedT = /^-([a-zA-Z]*t)(.+)$/.exec(t);
          if (gluedT !== null) {
            targetDir = gluedT[2]!;
            continue;
          }
          if (t.startsWith("-")) continue;
          operands.push(t);
        }
        if (targetDir !== undefined) {
          push(targetDir);
          for (const s of operands) {
            push(join(targetDir, basename(s)));
            // re-judge r2 finding 1: with -t the SOURCES still feed the
            // create-then-write window — `ln -s -t DIR OUT-OF-SCOPE-SRC`
            // must not pass just because the destination parsing changed
            if (name === "ln") push(s, true);
          }
        } else if (name === "ln") {
          if (operands.length >= 2) {
            push(operands[operands.length - 1]!);
            for (const s of operands.slice(0, -1)) push(s, true);
          }
        } else if (operands.length >= 2) {
          push(operands[operands.length - 1]!);
        }
        break;
      }
      case "dd":
        // dd's write target rides its `of=<path>` operand
        for (const t of rest) {
          if (t.startsWith("of=") && t.length > 3) push(t.slice(3));
        }
        break;
      case "sed":
        if (rest.some((t) => /^-[a-zA-Z]*i/.test(t)) && args.length >= 1) {
          push(args[args.length - 1]!);
        }
        break;
      default:
        // re-judge r2 finding 3: an unrecognized head whose segment
        // contains a standalone `cd` word (env cd, exec cd, future
        // spellings) — we cannot know whether bash moves the shell, so
        // fail closed for the rest of the command
        if (tokens.some((t) => t === "cd")) untracked = true;
        break;
    }
  }
  const seen = new Set<string>();
  const uniq: ScannedTarget[] = [];
  for (const t of out) {
    const key = `${t.base}\u0000${t.raw}\u0000${t.viaLink}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(t);
    }
  }
  return uniq;
}

/**
 * The write targets of a bash command as raw operand strings — the
 * exported corpus seam; the cd-aware scope verdict itself lives in
 * checkBashWriteScope, which resolves each operand against the base
 * its segment actually ran under.
 */
export function bashWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const t of scanBashWriteTargets(command, process.cwd())) {
    if (!out.includes(t.raw)) out.push(t.raw);
  }
  return out;
}

/** Device sinks that are never scope-relevant (documented exemption). */
const DEVICE_EXEMPT: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** The write-scope verdict for a bash command, per the syntactic scan. */
export function checkBashWriteScope(scopes: RunScope[], cwd: string, command: string): CheckResult {
  if (scopes.length === 0) return { ok: true };
  for (const t of scanBashWriteTargets(command, cwd)) {
    const abs = resolveToolPath(t.base, t.raw);
    if (DEVICE_EXEMPT.has(abs)) continue;
    const res = checkWritePath(scopes, abs);
    if (!res.ok) {
      return t.viaLink
        ? {
            ok: false,
            reason: `bash command links ${t.raw} into a governed target — writing through the new link would land out of scope (the create-then-write window): ${res.reason}`,
          }
        : { ok: false, reason: `bash command writes ${t.raw}: ${res.reason}` };
    }
  }
  return { ok: true };
}

/* ------------------------------ submit (result.json) ------------------------------ */

export type SubmitResult =
  | { ok: true; path: string }
  | { ok: false; errors: string[] };

/** The identity a submitted artifact must carry: the loaded run context's own ids. */
export type SubmitIdentity = { taskId: string; runId: string };

/**
 * Validate the submitted artifact in-process (§4.1 structural rules —
 * the ported validator), bind it to the loaded run context (when the
 * caller passes the identity, task_id/run_id must equal the context's
 * own — this extension is the only layer holding both ids; the engine
 * intakes result.json by path and never cross-checks), cap it on the
 * bytes that actually land on disk, and write <run_dir>/result.json
 * on success. The run dir is DERIVED from the loaded context — a path
 * argument is never accepted (the validator's allow-list rejects any
 * unknown top-level key, path-shaped or otherwise). The write is
 * wrapped: an unwritable destination returns a structured refusal,
 * never a throw out of the hook. This is the ONLY write the
 * extension ever performs.
 */
export function validateAndWriteResult(
  runDir: string,
  input: unknown,
  identity?: SubmitIdentity,
): SubmitResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input, null, 2);
  } catch {
    return { ok: false, errors: ["the submitted artifact is not JSON-serializable"] };
  }
  if (serialized === undefined) {
    return { ok: false, errors: ["the submitted artifact is not JSON-serializable"] };
  }
  serialized += "\n";
  // the cap is measured on the SERIALIZED form — the exact bytes that
  // land on disk, not a compact projection of them
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RESULT_PAYLOAD_BYTES) {
    return {
      ok: false,
      errors: [
        `artifact payload is ${bytes} bytes serialized to ${RESULT_FILENAME} — the cap is ${MAX_RESULT_PAYLOAD_BYTES} bytes; shrink summaries and diff text`,
      ],
    };
  }
  const res = validateArtifactStructure(input);
  if (!res.ok) return { ok: false, errors: res.errors };
  if (identity !== undefined) {
    const o = res.artifact;
    if (o["task_id"] !== identity.taskId || o["run_id"] !== identity.runId) {
      return {
        ok: false,
        errors: [
          `the artifact's task_id/run_id do not match this run's loaded context — expected task_id ${identity.taskId} / run_id ${identity.runId}, got ${JSON.stringify(o["task_id"])} / ${JSON.stringify(o["run_id"])}; submit the artifact for THIS run, not another`,
        ],
      };
    }
  }
  const path = join(runDir, RESULT_FILENAME);
  try {
    writeFileSync(path, serialized);
  } catch (err) {
    return { ok: false, errors: [`cannot write result.json: ${(err as Error).message}`] };
  }
  return { ok: true, path };
}

/* --------------------------- PORT 3: the socket client --------------------------- */

export function novaHome(): string {
  return process.env["NOVAFLOW_HOME"] ?? join(homedir(), ".novaflow");
}

/** The control socket (srs 4.3: ~/.novaflow/novaflow.sock). */
export function socketPath(): string {
  return process.env["NOVAFLOW_SOCK"] ?? join(novaHome(), "novaflow.sock");
}

export class DaemonUnreachableError extends Error {
  readonly code = "daemon_unreachable";
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}

/** A structured op failure carrying the wire taxonomy code. */
export class OpFailureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpFailureError";
  }
}

type OpResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

const CONNECT_TIMEOUT_MS = 2000;
const RESPONSE_TIMEOUT_MS = 60_000;

let requestId = 0;

function sendOneLine(path: string, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      fn();
    };
    const fail = (err: Error): void =>
      done(() => {
        sock.destroy();
        reject(err);
      });
    const sock = connect(path, () => {
      sock.write(request + "\n");
    });
    sock.setEncoding("utf8");
    const connectTimer = setTimeout(
      () => fail(new DaemonUnreachableError(`connecting to ${path} timed out`)),
      CONNECT_TIMEOUT_MS,
    );
    const responseTimer = setTimeout(
      () => fail(new DaemonUnreachableError(`no response from ${path} within ${RESPONSE_TIMEOUT_MS} ms`)),
      RESPONSE_TIMEOUT_MS,
    );
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        done(() => {
          sock.end();
          resolve(line);
        });
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      fail(
        new DaemonUnreachableError(
          `cannot reach the daemon at ${path} (${err.code ?? err.message}) — is it running? (nova daemon start)`,
        ),
      );
    });
  });
}

/**
 * One op, one response, over the daemon's Unix socket — the port of
 * src/cli/client.ts's transport with the operator's audit surface
 * pinned to "human" (the CLI's own default; mcp.md §5 attribution).
 */
export async function daemonRequest(
  op: string,
  args: Record<string, unknown> = {},
  opts: { socketPath?: string } = {},
): Promise<unknown> {
  const path = opts.socketPath ?? socketPath();
  if (!existsSync(path)) {
    throw new DaemonUnreachableError(
      `no socket at ${path} — is the daemon running? (nova daemon start)`,
    );
  }
  const line = await sendOneLine(
    path,
    JSON.stringify({ id: `nova-ext-${++requestId}`, op, args, surface: "human" }),
  );
  let parsed: OpResponse;
  try {
    parsed = JSON.parse(line) as OpResponse;
  } catch {
    throw new Error(`daemon sent a non-JSON response: ${line.slice(0, 200)}`);
  }
  if (parsed.ok === false) {
    throw new OpFailureError(parsed.error.code, parsed.error.message);
  }
  return parsed.data;
}

/** The CLI-local active-workspace marker (srs 4.1.1's `nova workspace switch`). */
export function readActiveWorkspace(): string | null {
  try {
    const slug = readFileSync(join(novaHome(), "active-workspace"), "utf8").trim();
    return slug === "" ? null : slug;
  } catch {
    return null;
  }
}

/** The triggering identity for audit-carrying commands (the CLI's rule). */
export function operatorActor(): string {
  return process.env["USER"] ?? "operator";
}

/* ------------------------------- operator surface ------------------------------- */

type TaskRow = { id: string; key: string; state: string; title: string };

const USAGE_LINES = [
  "/nova status [project] — daemon + workspace + project execution state",
  "/nova plan [chain-run-id | project-slug] — the execution DAG preview",
  "/nova queue — queued tasks and pending gate decisions",
  "/nova gate approve <task-id|key> [note...] — approve the live gate",
  "/nova gate reject <task-id|key> <feedback...> — reject with feedback",
];

function notifyLines(ctx: ExtensionCommandContext, lines: string[], severity: "info" | "error"): void {
  ctx.ui.notify(lines.join("\n"), severity);
}

/** Render a transport/op failure as the chat surface's structured error. */
function renderOpError(ctx: ExtensionCommandContext, err: unknown): void {
  if (err instanceof DaemonUnreachableError) {
    ctx.ui.notify(
      `[novaflow] daemon unreachable (the chat surface's exit 5): ${err.message}`,
      "error",
    );
    return;
  }
  if (err instanceof OpFailureError) {
    ctx.ui.notify(`[novaflow] op failed (${err.code}): ${err.message}`, "error");
    return;
  }
  throw err;
}

async function findWorkspaceByIdent(
  ident: string,
): Promise<{ id: string; slug: string; root_path: string; status: string }> {
  const data = (await daemonRequest("nova_workspace_list")) as {
    workspaces: Array<{ id: string; slug: string; root_path: string; status: string }>;
  };
  const row = data.workspaces.find((w) => w.slug === ident || w.id === ident);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no such workspace: ${ident}`);
  }
  return row;
}

async function resolveProjectIdent(
  ident: string,
): Promise<string> {
  const active = readActiveWorkspace();
  const listArgs: Record<string, unknown> =
    active !== null ? { workspace_id: (await findWorkspaceByIdent(active)).id } : {};
  const data = (await daemonRequest("nova_project_list", listArgs)) as {
    projects: Array<{ id: string; slug: string }>;
  };
  const row = data.projects.find((p) => p.slug === ident || p.id === ident);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no project "${ident}"${active !== null ? ` in workspace ${active}` : ""}`);
  }
  return row.id;
}

/** srs 4.1.1's identifier rule, ported: ULID direct, key within the active workspace. */
async function resolveTaskIdent(ident: string): Promise<TaskRow> {
  const args: Record<string, unknown> = { ident };
  const bare = ident.replace(/^tsk_/, "");
  if (!ULID_RE.test(bare)) {
    const active = readActiveWorkspace();
    if (active === null) {
      throw new OpFailureError(
        "schema_invalid",
        `key-form identifier "${ident}" needs an active workspace — run 'nova workspace switch <slug>' first (or use the task's ULID id)`,
      );
    }
    args["workspace_id"] = (await findWorkspaceByIdent(active)).id;
  }
  const data = (await daemonRequest("nova_task_resolve", args)) as { task: TaskRow };
  return data.task;
}

async function novaStatus(args: string[], ctx: ExtensionCommandContext): Promise<void> {
  try {
    const daemon = (await daemonRequest("nova_daemon_status")) as {
      version: string;
      uptime_sec: number;
      scheduler: { paused: boolean; running: number; queued: number };
    };
    const lines: string[] = [
      `novaflow daemon v${String(daemon["version"])} — up ${String(daemon["uptime_sec"])} s`,
      `runner: ${String(daemon.scheduler.running)} running, ${String(daemon.scheduler.queued)} queued${
        daemon.scheduler.paused ? " (PAUSED — no new runs)" : ""
      }`,
    ];
    const active = readActiveWorkspace();
    const wsl = (await daemonRequest("nova_workspace_list")) as {
      workspaces: Array<{ id: string; slug: string; status: string }>;
    };
    if (wsl.workspaces.length === 0) {
      lines.push("workspaces: (none)");
    } else {
      lines.push(
        "workspaces: " +
          wsl.workspaces
            .map((w) => {
              const isActive = w.slug === active || w.id === active;
              return `${w.slug}${isActive ? " (active)" : ""}${w.status !== "active" ? ` [${w.status}]` : ""}`;
            })
            .join(", "),
      );
    }
    const ident = args[1];
    if (ident !== undefined) {
      const projectId = await resolveProjectIdent(ident);
      const ps = (await daemonRequest("nova_project_status", { project_id: projectId })) as {
        project: Record<string, unknown>;
        task_counts: Record<string, number>;
        targets: Array<Record<string, unknown>>;
      };
      lines.push(`project ${String(ps.project["slug"])} — phase ${String(ps.project["phase"])}, status ${String(ps.project["status"])}`);
      const counts = Object.entries(ps.task_counts)
        .map(([state, n]) => `${state}=${String(n)}`)
        .join(" ");
      lines.push(`tasks: ${counts === "" ? "(none)" : counts}`);
      for (const t of ps.targets) {
        lines.push(`  target ${String(t["alias"])} (${String(t["target_type"])}, ${String(t["default_access"])})`);
      }
    } else {
      const listArgs: Record<string, unknown> =
        active !== null ? { workspace_id: (await findWorkspaceByIdent(active)).id } : {};
      const pl = (await daemonRequest("nova_project_list", listArgs)) as {
        projects: Array<Record<string, unknown>>;
      };
      if (pl.projects.length === 0) {
        lines.push("projects: (none)");
      } else {
        for (const p of pl.projects.slice(0, 20)) {
          lines.push(`project ${String(p["slug"])} — phase ${String(p["phase"])}, status ${String(p["status"])}`);
        }
        if (pl.projects.length > 20) {
          lines.push(`…and ${String(pl.projects.length - 20)} more (pass a project slug to /nova status)`);
        }
      }
    }
    notifyLines(ctx, lines, "info");
  } catch (err) {
    renderOpError(ctx, err);
  }
}

async function novaPlan(args: string[], ctx: ExtensionCommandContext): Promise<void> {
  try {
    const ident = args[1];
    if (ident !== undefined && ULID_RE.test(ident)) {
      const cs = (await daemonRequest("nova_chain_status", { chain_run_id: ident })) as {
        chain: { id: string; project_id: string; state: string; started_at: string; completed_at: string | null };
        members: Array<{ id: string; key: string; state: string; ready: boolean; root: boolean; feedback?: string[] }>;
        paused: boolean;
      };
      const lines = [
        `chain ${cs.chain.id} — ${cs.paused && cs.chain.state === "active" ? "active (paused)" : cs.chain.state}`,
        `started ${cs.chain.started_at}${cs.chain.completed_at !== null ? `, completed ${cs.chain.completed_at}` : ""}`,
        `${String(cs.members.length)} member${cs.members.length === 1 ? "" : "s"}:`,
      ];
      for (const m of cs.members) {
        lines.push(
          `  ${m.key} — ${m.state}, ${m.root ? "root (enqueue with 'nova task run')" : m.ready ? "ready" : "blocked by upstream"}${
            m.feedback !== undefined && m.feedback.length > 0 ? `, ${String(m.feedback.length)} feedback file(s)` : ""
          }`,
        );
      }
      notifyLines(ctx, lines, "info");
      return;
    }
    const active = readActiveWorkspace();
    const listArgs: Record<string, unknown> =
      active !== null ? { workspace_id: (await findWorkspaceByIdent(active)).id } : {};
    const cl = (await daemonRequest("nova_chain_list", listArgs)) as {
      chains: Array<{ id: string; project_slug: string; state: string; member_count: number; paused: boolean }>;
    };
    const chains = ident !== undefined ? cl.chains.filter((c) => c.project_slug === ident) : cl.chains;
    if (chains.length === 0) {
      notifyLines(
        ctx,
        [
          ident !== undefined
            ? `no chains for project "${ident}" — build one with 'nova project import-dag <file>'`
            : "no chains — build one with 'nova project import-dag <file>'",
        ],
        "info",
      );
      return;
    }
    const lines = [`${String(chains.length)} chain${chains.length === 1 ? "" : "s"}:`];
    for (const c of chains) {
      lines.push(
        `chain ${c.id} — project ${c.project_slug}, ${c.paused && c.state === "active" ? "active (paused)" : c.state}, ${String(c.member_count)} member${c.member_count === 1 ? "" : "s"}`,
      );
    }
    lines.push("member readiness: pass a chain-run-id to /nova plan");
    notifyLines(ctx, lines, "info");
  } catch (err) {
    renderOpError(ctx, err);
  }
}

async function novaQueue(_args: string[], ctx: ExtensionCommandContext): Promise<void> {
  try {
    const queued = (await daemonRequest("nova_task_list", { state: "queued" })) as { tasks: TaskRow[] };
    const gating = (await daemonRequest("nova_task_list", { state: "awaiting_gate" })) as { tasks: TaskRow[] };
    const lines: string[] = [
      `queued — pending queued→running (${String(queued.tasks.length)}):`,
    ];
    if (queued.tasks.length === 0) lines.push("  (none)");
    for (const t of queued.tasks) {
      lines.push(`  ${t.key} (tsk_${t.id}) — ${t.title}`);
    }
    lines.push(`awaiting_gate — pending gate decision (${String(gating.tasks.length)}):`);
    if (gating.tasks.length === 0) lines.push("  (none)");
    for (const t of gating.tasks) {
      lines.push(`  ${t.key} (tsk_${t.id}) — ${t.title}`);
    }
    lines.push("decide a gate from the chat: /nova gate approve|reject <task>");
    notifyLines(ctx, lines, "info");
  } catch (err) {
    renderOpError(ctx, err);
  }
}

async function novaGate(args: string[], ctx: ExtensionCommandContext): Promise<void> {
  const verb = args[1];
  if (verb !== "approve" && verb !== "reject") {
    const lines = [`[novaflow] unknown gate verb${verb === undefined ? "" : ` "${verb}"`}`];
    lines.push("usage: /nova gate approve <task-id|key> [note...]");
    lines.push("       /nova gate reject <task-id|key> <feedback...>");
    notifyLines(ctx, lines, "error");
    return;
  }
  const ident = args[2];
  if (ident === undefined) {
    notifyLines(
      ctx,
      [`[novaflow] usage: /nova gate ${verb} <task-id|key>${verb === "reject" ? " <feedback...>" : " [note...]"}`],
      "error",
    );
    return;
  }
  const rest = args.slice(3).join(" ");
  try {
    const task = await resolveTaskIdent(ident);
    if (verb === "approve") {
      const st = (await daemonRequest("nova_task_status", { task_id: task.id })) as {
        current_run: { id: string } | null;
      };
      if (st.current_run === null) {
        throw new OpFailureError("not_found", `task ${task.key} has no run to approve`);
      }
      const data = (await daemonRequest("nova_gate_approve", {
        task_id: task.id,
        run_id: st.current_run.id,
        approved_by: operatorActor(),
        note: rest,
      })) as { final_state: string };
      notifyLines(ctx, [`task ${task.key}: ${data.final_state} (gate approved)`], "info");
      return;
    }
    if (rest === "") {
      notifyLines(ctx, [`[novaflow] usage: /nova gate reject <task-id|key> <feedback...>`], "error");
      return;
    }
    const data = (await daemonRequest("nova_gate_reject", {
      task_id: task.id,
      feedback: rest,
    })) as { final_state: string; retry_count: number };
    notifyLines(ctx, [`task ${task.key}: ${data.final_state} (retry ${String(data.retry_count)})`], "info");
  } catch (err) {
    renderOpError(ctx, err);
  }
}

/**
 * The /nova dispatcher — the four §6 operator commands. Each branch
 * renders its own errors (dead socket → exit-5-style structured
 * error; op failure → the wire taxonomy code), never throwing at the
 * user's chat.
 */
export async function runNovaCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter((p) => p !== "");
  const sub = parts[0];
  switch (sub) {
    case "status":
      await novaStatus(parts, ctx);
      return;
    case "plan":
      await novaPlan(parts, ctx);
      return;
    case "queue":
      await novaQueue(parts, ctx);
      return;
    case "gate":
      await novaGate(parts, ctx);
      return;
    case undefined:
      notifyLines(ctx, ["novaflow operator commands:", ...USAGE_LINES], "info");
      return;
    default:
      notifyLines(ctx, [`[novaflow] unknown /nova subcommand "${sub}"`, ...USAGE_LINES], "error");
      return;
  }
}

/* -------------------------------- the wake watcher -------------------------------- */
/*
 * wake.md (frozen 2026-11-23) — the orchestrator gets woken, not spammed.
 *
 *   - OPERATOR MODE ONLY. Operator mode is the factory's existing
 *     NOVAFLOW_RUN_CONTEXT branch; a run-mode session ends with the run and
 *     never starts a watcher.
 *   - The watcher polls `nova_transitions_since` (events.md) every ~2 s over
 *     the ported socket client, holding its cursor IN MEMORY. The cursor is
 *     the store's own rowid, so a daemon restart gaps nothing.
 *   - SESSION START SEEDS AT HEAD (events.md rule 2's `cursor: 0`): the first
 *     poll of a session wakes on NOTHING from that page. Pre-existing
 *     transitions are history, not news — that trap is why this is pinned.
 *   - Policy (wake.md's table): `to_state = awaiting_gate`, `to_state =
 *     failed`, and chain-run completion INFERRED from the chain status
 *     surface (a member reached `completed`, every member completed, the
 *     chain row `completed` — chain runs have no transition rows). Never
 *     queued/running/validating/changes_requested, never a standalone task's
 *     `completed`.
 *   - Dedupe is structural: one wake per transition row; the cursor filter in
 *     pollWakeStep turns a re-served page into a no-op, and the chain-complete
 *     check is latched per chain run (completion is ONE logical event even
 *     when two member rows land on the same page).
 *   - Injection: `pi.sendUserMessage("[novaflow] …", {deliverAs:
 *     "followUp"})` — proven live on pi 1.6.0, so it never interrupts the
 *     operator's own turn. The captured `pi` is STALE after a session
 *     replacement: a throwing send is swallowed with a warn (never thrown out
 *     of a timer), and the timer is re-established on the next session_start.
 *   - Lifecycle: `session_shutdown` clears the interval; every `session_start`
 *     (startup/reload/new/resume/fork) re-pins exactly ONE interval — start()
 *     stops first, so the reasons cannot double-pin.
 *   - A daemon-down poll never throws: it warns once per session and keeps its
 *     cursor, so the next successful poll resumes from where it stood.
 */

/** wake.md: the poll interval (~2 s); `NOVAFLOW_WAKE_MS` overrides for tests/operators. */
export const WAKE_DEFAULT_INTERVAL_MS = 2000;
const WAKE_INTERVAL_ENV = "NOVAFLOW_WAKE_MS";
const WAKE_ENV = "NOVAFLOW_WAKE";

const TRANSITIONS_OP = "nova_transitions_since";
const CHAIN_STATUS_OP = "nova_chain_status";
const RESULT_GET_OP = "nova_result_get";
const WORKSPACE_LIST_OP = "nova_workspace_list";

/** The `wake: { enabled, workspace }` block of `~/.novaflow/config.yaml`. */
export type WakeConfig = { enabled: boolean; workspace: string | null };

/** wake.md defaults: enabled true, workspace null (every workspace). */
export function defaultWakeConfig(): WakeConfig {
  return { enabled: true, workspace: null };
}

/** The daemon's own config file — the extension is a direct consumer of its `wake` block. */
export function wakeConfigPath(home: string = novaHome()): string {
  return join(home, "config.yaml");
}

const WAKE_TRUE: ReadonlySet<string> = new Set(["true", "yes", "on"]);
const WAKE_FALSE: ReadonlySet<string> = new Set(["false", "no", "off"]);

function wakeScalar(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]!;
    if ((first === '"' || first === "'") && raw.endsWith(first)) return raw.slice(1, -1);
  }
  return raw;
}

function applyWakeKey(cfg: WakeConfig, key: string, raw: string): void {
  const value = wakeScalar(raw.trim());
  const lower = value.toLowerCase();
  if (key === "enabled") {
    if (WAKE_TRUE.has(lower)) cfg.enabled = true;
    else if (WAKE_FALSE.has(lower)) cfg.enabled = false;
    // anything else is ignored — the config is read DEFENSIVELY, never thrown on
    return;
  }
  if (key === "workspace") {
    cfg.workspace = value === "" || lower === "null" || value === "~" ? null : value;
  }
  // unknown keys under `wake:` are ignored (the daemon owns the rest of the file)
}

/**
 * Parse the `wake` block of a config.yaml text. DELIBERATELY forgiving — the
 * extension reads a file the daemon owns, so a malformed or unknown-shape file
 * must never throw: every unreadable key keeps its default. Accepted spellings:
 * the block form
 *
 *     wake:
 *       enabled: true
 *       workspace: null
 *
 * and the inline flow form `wake: { enabled: false, workspace: my-ws }`. Only
 * the two documented keys are read; everything else (other sections, unknown
 * keys, deeper nesting, junk lines) is skipped.
 */
export function parseWakeConfig(text: string): WakeConfig {
  const cfg = defaultWakeConfig();
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      if (indent === 0) section = null; // a junk top-level line ends the section
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (indent === 0) {
      if (value === "") {
        section = key;
        continue;
      }
      section = null;
      if (key === "wake" && value.startsWith("{")) {
        for (const pair of value.replace(/^\{/, "").replace(/\}$/, "").split(",")) {
          const idx = pair.indexOf(":");
          if (idx < 0) continue;
          applyWakeKey(cfg, pair.slice(0, idx).trim(), pair.slice(idx + 1));
        }
      }
      continue;
    }
    if (section === "wake") applyWakeKey(cfg, key, value);
  }
  return cfg;
}

export type WakeEnv = Record<string, string | undefined>;

/**
 * Load the session's wake config: `~/.novaflow/config.yaml`'s `wake` block,
 * with `NOVAFLOW_WAKE=off` overriding to disabled (wake.md). A missing or
 * unreadable file is all defaults — never a throw.
 */
export function loadWakeConfig(opts: { home?: string; env?: WakeEnv } = {}): WakeConfig {
  const env = opts.env ?? process.env;
  const cfg = defaultWakeConfig();
  try {
    const parsed = parseWakeConfig(readFileSync(wakeConfigPath(opts.home ?? novaHome()), "utf8"));
    cfg.enabled = parsed.enabled;
    cfg.workspace = parsed.workspace;
  } catch {
    /* missing/unreadable config.yaml = the documented defaults */
  }
  if ((env[WAKE_ENV] ?? "").trim().toLowerCase() === "off") cfg.enabled = false;
  return cfg;
}

/** The poll interval: 2000 ms, `NOVAFLOW_WAKE_MS` for tests/operators. */
export function wakeIntervalMs(env: WakeEnv = process.env): number {
  const raw = env[WAKE_INTERVAL_ENV];
  if (raw === undefined) return WAKE_DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : WAKE_DEFAULT_INTERVAL_MS;
}

/** One row of `nova_transitions_since` (events.md's public projection). */
export type WakeTransitionRow = {
  cursor: number;
  task_id: string;
  run_id: string | null;
  chain_run_id: string | null;
  task_key: string;
  chain_slug: string | null;
  from_state: string;
  to_state: string;
  trigger_type: string;
  actor: string;
  reason: string | null;
  created_at: string;
};

export type WakePage = {
  transitions: WakeTransitionRow[];
  next_cursor: number;
  has_more: boolean;
};

/** The socket request seam (defaults to the ported daemon client). */
export type WakeRequest = (op: string, args: Record<string, unknown>) => Promise<unknown>;

/** The in-memory watch state — one per session, reset on every session_start. */
export type WakeState = {
  /** The last rowid this session has consumed (0 before the seed). */
  cursor: number;
  /** True once a poll has succeeded; the seed poll consumes its page silently. */
  seeded: boolean;
  /** Chain runs already reported complete (completion is one event, not per row). */
  chainsWoken: Set<string>;
  /**
   * Chains whose member reached `completed` while the chain row was still
   * `active`. The engine applies the member's transition row and THEN
   * evaluates the chain (src/daemon/lifecycle.ts), so a poll can land in
   * between; these are re-checked on the next poll instead of losing the wake.
   */
  pendingChains: Map<string, WakeTransitionRow>;
  /** The daemon-down warn is raised once per session (wake.md: "silences"). */
  warnedDown: boolean;
};

export function newWakeState(): WakeState {
  return {
    cursor: 0,
    seeded: false,
    chainsWoken: new Set<string>(),
    pendingChains: new Map<string, WakeTransitionRow>(),
    warnedDown: false,
  };
}

export type WakeKind = "awaiting_gate" | "failed" | "chain_completed";

export type Wake = {
  kind: WakeKind;
  /** The injected `[novaflow] …` message body (it names the follow-up calls). */
  text: string;
  cursor: number;
  task_id: string;
  chain_run_id: string | null;
};

export type WakePollDeps = {
  request: WakeRequest;
  /** `wake.workspace` resolved to an id; null/absent = every workspace. */
  workspaceId?: string | null;
  /** The session's warn sink (one daemon-down warn per session). */
  warn?: (message: string) => void;
};

export type WakePollResult = {
  /** False when no page could be read (daemon down) — the cursor did not move. */
  polled: boolean;
  seeded: boolean;
  cursor: number;
  wakes: Wake[];
  warnings: string[];
};

function taskRef(row: WakeTransitionRow): string {
  return `${row.task_key} (${row.task_id})`;
}

function transitionRef(row: WakeTransitionRow): string {
  const reason = row.reason !== null && row.reason !== "" ? `, reason: ${JSON.stringify(row.reason)}` : "";
  return `${row.from_state}→${row.to_state} (${row.trigger_type}, ${row.actor}${reason})`;
}

/** The gate wake: what moved, whether the artifact is a `blocked` refusal, and the calls to make. */
function gateWakeMessage(row: WakeTransitionRow, artifactStatus: string | null): string {
  const lines = [`[novaflow] gate needed: ${taskRef(row)} is awaiting_gate — ${transitionRef(row)}.`];
  if (artifactStatus === "blocked") {
    lines.push("artifact status: blocked — a refusal to fix, not a review to approve.");
  } else if (artifactStatus !== null) {
    lines.push(`artifact status: ${artifactStatus}.`);
  }
  lines.push(
    `follow up: nova_task_status ${row.task_id}; nova_result_get ${row.task_id} (the handoff artifact); ` +
      `then decide the gate: nova_gate_approve ${row.task_id} "<note>" or nova_gate_reject ${row.task_id} "<feedback>" ` +
      `(/nova gate approve|reject ${row.task_key} … in this chat).`,
  );
  return lines.join("\n");
}

/** The failure wake: the transition, then the status/log/re-run calls. */
function failedWakeMessage(row: WakeTransitionRow): string {
  const chain =
    row.chain_run_id !== null ? `; the chain: nova_chain_status ${row.chain_run_id}` : "";
  return [
    `[novaflow] task failed: ${taskRef(row)} — ${transitionRef(row)}.`,
    `follow up: nova_task_status ${row.task_id}; nova_run_logs ${row.task_id} (the run's redacted events.jsonl); ` +
      `then nova_task_run ${row.task_id} to retry${chain}.`,
  ].join("\n");
}

/** The inferred chain-completion wake (there is no chain transition row to read). */
function chainCompletedMessage(chainRunId: string, member: WakeTransitionRow): string {
  const project = member.chain_slug !== null ? ` (project ${member.chain_slug})` : "";
  return [
    `[novaflow] chain completed: ${chainRunId}${project} — member ${taskRef(member)} reached completed ` +
      `and every member is completed, so the chain row is completed.`,
    `follow up: nova_chain_status ${chainRunId} (member states + readiness). Nothing is pending on this chain — no gate decision is required.`,
  ].join("\n");
}

/**
 * The inferred chain-completion check (wake.md: "inferred, never read").
 * Called only for a member row that reached `completed`; the chain run's own
 * state comes from `nova chain status`, never from the feed. A chain that is
 * still `active` stays PENDING (re-checked next poll — the engine moves the
 * chain row a beat after the member's row); a terminal non-completed chain
 * (failed/aborted) is dropped, since only completion wakes.
 */
async function chainCompletionWake(
  state: WakeState,
  deps: WakePollDeps,
  chainRunId: string,
  member: WakeTransitionRow,
): Promise<Wake | null> {
  if (state.chainsWoken.has(chainRunId)) {
    state.pendingChains.delete(chainRunId);
    return null;
  }
  let data: unknown;
  try {
    data = await deps.request(CHAIN_STATUS_OP, { chain_run_id: chainRunId });
  } catch {
    // the surface refused or the daemon went away — never throw out of a poll;
    // the chain stays pending for the next attempt
    state.pendingChains.set(chainRunId, member);
    return null;
  }
  const chain = (data as { chain?: { state?: unknown } } | null)?.["chain"];
  const members = (data as { members?: unknown } | null)?.["members"];
  const chainState = typeof chain?.state === "string" ? chain.state : null;
  if (chainState === null || !Array.isArray(members)) return null;
  if (chainState === "completed") {
    const everyMemberCompleted =
      members.length > 0 &&
      members.every((m: unknown) => (m as { state?: unknown } | null)?.["state"] === "completed");
    state.pendingChains.delete(chainRunId);
    if (!everyMemberCompleted) return null;
    state.chainsWoken.add(chainRunId);
    return {
      kind: "chain_completed",
      text: chainCompletedMessage(chainRunId, member),
      cursor: member.cursor,
      task_id: member.task_id,
      chain_run_id: chainRunId,
    };
  }
  if (chainState !== "active") {
    // failed/aborted: terminal, but never a completion wake
    state.pendingChains.delete(chainRunId);
    return null;
  }
  state.pendingChains.set(chainRunId, member);
  return null;
}

/**
 * The gate wake reads the run's artifact to carry its `blocked` status into
 * the message (wake.md: a blocked artifact must read as a refusal to fix). A
 * failed or absent artifact read is simply "no status" — never a throw.
 */
async function artifactStatusOf(deps: WakePollDeps, taskId: string): Promise<string | null> {
  try {
    const data = await deps.request(RESULT_GET_OP, { task_id: taskId });
    const status = (data as { artifact?: { status?: unknown } } | null)?.["artifact"]?.["status"];
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/** Fold one transition row into the wake list, per wake.md's policy table. */
async function considerTransition(
  state: WakeState,
  deps: WakePollDeps,
  row: WakeTransitionRow,
  wakes: Wake[],
): Promise<void> {
  if (row.to_state === "awaiting_gate") {
    const artifactStatus = await artifactStatusOf(deps, row.task_id);
    wakes.push({
      kind: "awaiting_gate",
      text: gateWakeMessage(row, artifactStatus),
      cursor: row.cursor,
      task_id: row.task_id,
      chain_run_id: row.chain_run_id,
    });
    return;
  }
  if (row.to_state === "failed") {
    wakes.push({
      kind: "failed",
      text: failedWakeMessage(row),
      cursor: row.cursor,
      task_id: row.task_id,
      chain_run_id: row.chain_run_id,
    });
    return;
  }
  // a standalone task's `completed` never wakes (wake.md); a CHAIN member's
  // `completed` is the only thing that can imply a chain-completion wake
  if (row.to_state === "completed" && row.chain_run_id !== null) {
    const wake = await chainCompletionWake(state, deps, row.chain_run_id, row);
    if (wake !== null) wakes.push(wake);
  }
}

/**
 * ONE poll step of the watcher — the whole policy, driven by an injected
 * request seam so it is deterministic in tests (no timers, no daemon).
 *
 * Seed rule: while `!state.seeded`, the poll asks with `cursor: 0` ("start at
 * head", events.md rule 2) and wakes on NOTHING from the page — it only
 * records `next_cursor`. A store that was EMPTY at seed keeps cursor 0, and
 * the following poll's head page is genuinely news; the `seeded` latch is what
 * separates the two (a pre-existing page always leaves a nonzero cursor).
 *
 * Everything else: every row above the cursor is judged by `considerTransition`
 * (skipping rows at or below the cursor makes a re-served page a no-op), pages
 * are drained while `has_more`, and the pending chain checks run after the page
 * so a chain row that landed since the member's row is not lost.
 */
export async function pollWakeStep(state: WakeState, deps: WakePollDeps): Promise<WakePollResult> {
  const wakes: Wake[] = [];
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    deps.warn?.(message);
  };
  const scope: Record<string, unknown> =
    deps.workspaceId !== null && deps.workspaceId !== undefined
      ? { workspace_id: deps.workspaceId }
      : {};
  const seeding = !state.seeded;
  let at = state.cursor;
  let pagesRead = 0;
  try {
    let page = (await deps.request(TRANSITIONS_OP, { cursor: at, ...scope })) as WakePage;
    if (page === null || typeof page !== "object" || !Array.isArray(page.transitions)) {
      throw new Error(`${TRANSITIONS_OP} returned an unexpected payload`);
    }
    pagesRead++;
    if (seeding) {
      // seed at head: consume the page, wake on none of it
      state.seeded = true;
      state.cursor = page.next_cursor;
    } else {
      for (;;) {
        for (const row of page.transitions) {
          if (row.cursor <= state.cursor) continue;
          await considerTransition(state, deps, row, wakes);
        }
        if (page.next_cursor > state.cursor) state.cursor = page.next_cursor;
        if (!page.has_more || page.next_cursor <= at) break;
        at = page.next_cursor;
        page = (await deps.request(TRANSITIONS_OP, { cursor: at, ...scope })) as WakePage;
        if (page === null || typeof page !== "object" || !Array.isArray(page.transitions)) {
          throw new Error(`${TRANSITIONS_OP} returned an unexpected payload`);
        }
        pagesRead++;
      }
    }
    for (const [chainRunId, member] of [...state.pendingChains]) {
      const wake = await chainCompletionWake(state, deps, chainRunId, member);
      if (wake !== null) wakes.push(wake);
    }
  } catch (err) {
    // a daemon-down (or any failed) poll SILENCES: one warn per session, the
    // cursor untouched, so the next successful poll resumes exactly there
    if (!state.warnedDown) {
      state.warnedDown = true;
      warn(
        `[novaflow] wake poll failed: ${(err as Error).message} — the watcher keeps its cursor and resumes when the daemon answers`,
      );
    }
    return { polled: pagesRead > 0, seeded: state.seeded, cursor: state.cursor, wakes, warnings };
  }
  return { polled: true, seeded: state.seeded, cursor: state.cursor, wakes, warnings };
}

/** The timer seam (the factory uses the Node globals; tests inject a fake). */
export type WakeScheduler = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const NODE_SCHEDULER: WakeScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type WakeWatcherOptions = {
  /** The socket request seam (tests). */
  request?: WakeRequest;
  /** The config to use instead of loading the file (tests). */
  config?: WakeConfig;
  /** The poll interval override (tests). */
  intervalMs?: number;
  /** The timer seam (tests). */
  scheduler?: WakeScheduler;
  /** The injection seam (tests); the factory uses pi.sendUserMessage. */
  send?: (text: string) => void;
};

export type WakeWatcher = {
  /** Seed at head and start polling — called on EVERY session_start; re-pins once. */
  start: (ctx: Pick<ExtensionContext, "ui">) => Promise<void>;
  /** Clear the interval and invalidate any in-flight poll (session_shutdown). */
  stop: () => void;
  /** Drive exactly one poll step (tests, and the interval's own callback). */
  poll: () => Promise<void>;
  state: () => WakeState;
};

/**
 * The operator-mode wake watcher (wake.md). Owned by the extension factory for
 * the lifetime of the extension instance; `start`/`stop` ride the session
 * lifecycle. Nothing here throws out of a timer: the poll step swallows its
 * failures, and the injection is wrapped (a stale `pi`/ctx after a session
 * replacement is a warn, per the PROVEN mechanism note in wake.md).
 */
export function createWakeWatcher(pi: ExtensionAPI, options: WakeWatcherOptions = {}): WakeWatcher {
  const scheduler = options.scheduler ?? NODE_SCHEDULER;
  const request: WakeRequest = options.request ?? ((op, args) => daemonRequest(op, args));
  const send: (text: string) => void =
    options.send ??
    ((text: string) => {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    });

  let generation = 0;
  let running = false;
  let inFlight = false;
  let handle: unknown = null;
  let state = newWakeState();
  let workspaceId: string | null = null;
  let warn: (message: string) => void = () => undefined;

  function stop(): void {
    // the generation bump is the staleness discipline: a poll still awaiting its
    // page, and a tick still queued by the old interval, both become no-ops
    generation++;
    running = false;
    if (handle !== null) {
      scheduler.clearInterval(handle);
      handle = null;
    }
  }

  async function run(gen: number): Promise<void> {
    const result = await pollWakeStep(state, { request, workspaceId, warn });
    for (const wake of result.wakes) {
      if (gen !== generation) return;
      try {
        send(wake.text);
      } catch (err) {
        // the captured pi/ctx is stale (session replaced): never throw out of
        // a timer, and never re-try through a dead context
        warn(
          `[novaflow] wake not delivered — the session context is stale (${(err as Error).message})`,
        );
      }
    }
  }

  async function poll(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    const gen = generation;
    try {
      await run(gen);
    } catch (err) {
      warn(`[novaflow] wake poll failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
  }

  async function start(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
    stop(); // every session_start reason re-pins exactly ONE interval
    state = newWakeState(); // a new session seeds at head again
    workspaceId = null;
    warn = (message: string): void => {
      try {
        ctx.ui.notify(message, "warning");
      } catch {
        /* a stale ctx after a session replacement never throws out of a poll */
      }
    };
    const config = options.config ?? loadWakeConfig();
    if (!config.enabled) return; // wake.enabled: false or NOVAFLOW_WAKE=off
    running = true;
    const gen = generation;

    if (config.workspace !== null) {
      try {
        const data = (await request(WORKSPACE_LIST_OP, {})) as {
          workspaces?: Array<{ id?: unknown; slug?: unknown }>;
        };
        const row = (data.workspaces ?? []).find(
          (w) => w.slug === config.workspace || w.id === config.workspace,
        );
        if (typeof row?.id === "string") workspaceId = row.id;
      } catch {
        /* unresolved below: the session polls every workspace, with a warn */
      }
      if (gen !== generation) return;
      if (workspaceId === null) {
        warn(
          `[novaflow] wake.workspace "${config.workspace}" did not resolve to a workspace id — the watcher polls every workspace for this session`,
        );
      }
    }

    // the SEED poll (cursor 0, wakes on nothing) — awaited so the seed point
    // is exactly session start, and so a caller sees a seeded watcher
    inFlight = true;
    try {
      await run(gen);
    } catch (err) {
      warn(`[novaflow] wake poll failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
    if (gen !== generation || !running) return;
    handle = scheduler.setInterval(() => {
      void poll();
    }, options.intervalMs ?? wakeIntervalMs());
  }

  return {
    start,
    stop,
    poll,
    state: () => state,
  };
}

/* ---------------------------------- the factory ---------------------------------- */

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash", "powershell"]);

type SubmitDetails = {
  accepted: boolean;
  path?: string;
  errors?: string[];
};

/**
 * The submit tool's parameter declaration — the §4.1 block's shape as
 * plain JSON Schema (pi validates tool arguments as JSON Schema
 * whatever built them). Strict at pi's layer (unknown keys like a
 * smuggled path argument are rejected before the hook ever runs);
 * the in-process validator remains the detailed authority for
 * patterns, enums and lengths.
 */
export const SUBMIT_TOOL_PARAMS: TSchema = {
  type: "object",
  properties: {
    schema_version: { type: "string", description: "Semantic version of the artifact schema (e.g. 1.0.0)" },
    task_id: { type: "string", description: "The task's ULID id" },
    run_id: { type: "string", description: "The run's ULID id" },
    status: { type: "string", description: "completed | changes_requested | blocked" },
    summary: { type: "string", description: "At least 10 characters describing the outcome" },
    assumptions_made: { type: "array", items: { type: "string" }, description: "Assumptions taken during the run" },
    open_questions: { type: "array", items: { type: "string" }, description: "Open questions for the human" },
    artifacts_modified: {
      type: "array",
      description: "Files created/modified/deleted/renamed, per target",
      items: {
        type: "object",
        properties: {
          target_alias: { type: "string" },
          path: { type: "string", description: "The modified path, relative to its target root" },
          action: { type: "string", description: "created | modified | deleted | renamed" },
          diff_summary: { type: "string" },
        },
        required: ["target_alias", "path", "action"],
        additionalProperties: false,
      },
    },
    feedback_items: {
      type: "array",
      description: "Structured feedback for the pipeline",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", description: "info | warning | error | critical" },
          category: { type: "string" },
          message: { type: "string" },
          file_location: { type: "object", properties: { path: { type: "string" }, line: { type: "integer" } }, required: ["path", "line"], additionalProperties: false },
        },
        required: ["severity", "category", "message"],
        additionalProperties: false,
      },
    },
    verification_results: {
      type: "array",
      description: "Verification command outcomes (engine overwrites these annotations after validating)",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          exit_code: { type: "integer" },
          passed: { type: "boolean" },
          output_tail: { type: "string" },
        },
        required: ["command", "exit_code", "passed"],
        additionalProperties: false,
      },
    },
    role: { type: "string" },
    engine_verified: { type: "boolean" },
    protected_files_untouched: { type: "boolean" },
    next_recommended_action: { type: "string", description: "proceed_to_next | human_review | retry_with_context | abort_pipeline" },
  },
  required: [...ARTIFACT_REQUIRED_KEYS],
  additionalProperties: false,
} as unknown as TSchema;

function submitToolDefinition(getRun: () => RunContext | null, state: { accepted: boolean }): ToolDefinition {
  return {
    name: SUBMIT_TOOL_NAME,
    label: "Submit Result",
    description:
      "Submit the Task Handoff Artifact (result.json) as the run's final action. The artifact object is the whole input — no path argument, the run directory is derived. The artifact is structurally validated; when it is accepted the run cleanly ends.",
    promptSnippet: "Submit the final result.json handoff artifact; ends the run when accepted",
    promptGuidelines: [
      "Use novaflow_submit_result as the final action when the objective is met — it validates the artifact and cleanly ends the run.",
      "Never pass a path or file argument to novaflow_submit_result; the artifact object itself is the entire input.",
    ],
    parameters: SUBMIT_TOOL_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Defense in depth for paths that skip the tool_call hook
      // (the hook owns the normal flow): same validation, same
      // identity binding, same write, and terminate on acceptance
      // per pi's structured-output rule.
      const run = getRun();
      if (run === null || run.loadError !== null) {
        throw new Error(`novaflow: run context unavailable — refusing submission (${run?.loadError ?? "session_start not completed"})`);
      }
      if (state.accepted) {
        throw new Error("artifact already accepted for this run — the completion signal was sent; resubmission is not possible");
      }
      const res = validateAndWriteResult(run.runDir, params, { taskId: run.taskId, runId: run.runId });
      if (!res.ok) {
        throw new Error(`result.json rejected:\n- ${res.errors.join("\n- ")}`);
      }
      state.accepted = true;
      if (ctx.hasUI) {
        ctx.ui.notify(`novaflow: artifact accepted → ${res.path}`, "info");
      }
      return {
        content: [{ type: "text", text: "artifact accepted" }],
        details: { accepted: true, path: res.path } satisfies SubmitDetails,
        terminate: true,
      };
    },
  };
}

function registerRunMode(pi: ExtensionAPI, contextPath: string): void {
  let run: RunContext | null = null;
  /** The acceptance latch: set once result.json is written for this run. */
  const state = { accepted: false };

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    run = loadRunContext(contextPath);
    if (run.loadError !== null) {
      ctx.ui.notify(`novaflow: run context failed to load — mutating tools fail closed (${run.loadError})`, "error");
      return;
    }
    ctx.ui.notify(
      `novaflow run mode — task ${run.taskId}, run ${run.runId}, ${String(run.scopes.length)} scoped target(s); submit with ${SUBMIT_TOOL_NAME}`,
      "info",
    );
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    // the completion signal: validate in-process, bind to the loaded
    // run context, write result.json, and end the run through pi's
    // block-result rule
    if (event.toolName === SUBMIT_TOOL_NAME) {
      if (state.accepted) {
        return {
          block: true,
          reason: "artifact already accepted for this run — the completion signal was sent; resubmission is not possible",
        };
      }
      if (run === null || run.loadError !== null) {
        return {
          block: true,
          reason: `novaflow: run context unavailable — refusing submission (${run?.loadError ?? "session_start not completed"})`,
        };
      }
      const res = validateAndWriteResult(run.runDir, event.input, { taskId: run.taskId, runId: run.runId });
      if (!res.ok) {
        return { block: true, reason: `result.json rejected:\n- ${res.errors.join("\n- ")}` };
      }
      state.accepted = true;
      if (ctx.hasUI) {
        ctx.ui.notify(`novaflow: artifact accepted → ${res.path}`, "info");
      }
      return { block: true, terminate: true, reason: "artifact accepted" };
    }

    // the acceptance latch: after result.json is written the run is
    // complete — mutating calls are refused, reads stay open. bash is
    // SCOPED, not wholesale (re-judge r2 finding 4): a zero-write bash
    // call after acceptance still passes the write-scope check.
    if (state.accepted && MUTATING_TOOLS.has(event.toolName)) {
      if ((event.toolName === "bash" || event.toolName === "powershell") && run !== null && run.loadError === null) {
        const raw = (event.input as { command?: unknown })["command"];
        // ZERO-WRITE, not merely in-scope: an in-scope write after
        // acceptance still violates the latch — only a bash call whose
        // scan finds NO write targets at all stays open
        if (typeof raw === "string" && bashWriteTargets(raw).length === 0) {
          return undefined; // zero-write bash stays open post-acceptance
        }
      }
      return {
        block: true,
        reason: "artifact already accepted for this run — no further mutating tool calls are permitted",
      };
    }

    // scope enforcement per mutating tool call (§6)
    if (run === null || run.loadError !== null) {
      if (MUTATING_TOOLS.has(event.toolName)) {
        return {
          block: true,
          reason: `novaflow: run context unavailable — failing closed (${run?.loadError ?? "session_start not completed"})`,
        };
      }
      return undefined;
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const raw = (event.input as { path?: unknown })["path"];
      if (typeof raw !== "string") return undefined; // the built-in reports its own validation error
      const res = checkWritePath(run.scopes, resolveToolPath(ctx.cwd, raw));
      if (!res.ok) return { block: true, reason: `novaflow: ${res.reason}` };
      return undefined;
    }
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const raw = (event.input as { command?: unknown })["command"];
      if (typeof raw !== "string") return undefined;
      const res = checkBashWriteScope(run.scopes, ctx.cwd, raw);
      if (!res.ok) return { block: true, reason: `novaflow: ${res.reason}` };
      return undefined;
    }
    // read/grep/find/ls: reads are unrestricted in v1
    return undefined;
  });

  pi.registerTool(submitToolDefinition(() => run, state));
}

function registerOperatorMode(pi: ExtensionAPI): void {
  pi.registerCommand("nova", {
    description: "NovaFlow operator control: status | plan | queue | gate approve|reject",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runNovaCommand(args, ctx);
    },
  });

  // the wake watcher (wake.md) is an OPERATOR-mode feature: run-mode sessions
  // end with the run. Seeded at head on every session_start reason, cleared on
  // session_shutdown (the captured pi is stale after a session replacement).
  const watcher = createWakeWatcher(pi);
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    await watcher.start(ctx);
  });
  pi.on("session_shutdown", async () => {
    watcher.stop();
  });
}

/**
 * The extension factory (pi 1.6.0: `export default function (pi:
 * ExtensionAPI)`). RUN MODE when NOVAFLOW_RUN_CONTEXT is set to a
 * non-empty path, OPERATOR MODE otherwise — the two surfaces never
 * coexist (run sessions get no slash-command family; operator
 * sessions get no submit tool).
 */
export default function novaflowExtension(pi: ExtensionAPI): void {
  const contextPath = process.env[RUN_CONTEXT_ENV];
  if (contextPath !== undefined && contextPath !== "") {
    registerRunMode(pi, contextPath);
  } else {
    registerOperatorMode(pi);
  }
}
