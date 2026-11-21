import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Db } from "../store/db.ts";
import { runGroupedCommand, type GroupedCommandOptions } from "./runner.ts";

/**
 * FR-TSK-11 AC3 + the architecture Post-Run Verifier (5.8): SHA-256
 * digest verification of the protected test set against the PRE-RUN
 * snapshot, plus the write-scope check over modified paths.
 *
 * Pre-run digest storage is spec-silent; the chosen design: the run
 * loop's preflight (src/runs/loop.ts) snapshots into the run dir as
 * `protected-digests.json` — the SHA-256 of every file matching the
 * target's protected globs, taken BEFORE the agent runs (zero LLM
 * tokens). A MISSING snapshot at verification time fails closed
 * (`protected_files_untouched = false`): integrity cannot be proven
 * without a pre-run baseline, and fail-open would reopen the test-gaming
 * hole RSK-14 exists to close.
 *
 * Modified-path enumeration per target_type (the spec names the git
 * check only):
 *   - `git_repo`: `git status --porcelain` in the target root (all
 *     entries — staged, unstaged, untracked — count as modified; rename
 *     entries contribute their destination path).
 *   - `directory`: spec-silent → digest-based only. No VCS baseline
 *     exists, so the preflight snapshot for a directory target covers
 *     the WHOLE tree (full_tree = true) and modified paths are the
 *     digest diffs (changed, created, deleted) against that baseline.
 * A modified path that matches NO glob in `write_scope_globs_json` is
 * scope creep (RSK-17) and fails verification.
 *
 * Glob matcher subset (documented in-code, deliberately minimal):
 *   - segments split on `/`; `**` matches ZERO OR MORE whole segments
 *     (so `src/**` also matches a bare `src` entry);
 *   - `*` matches any characters EXCEPT `/` within one segment;
 *   - everything else is literal — NO brace expansion, NO character
 *     classes, NO `?`, NO negation. Patterns are matched against the
 *     path RELATIVE to the target root, in full (a pattern without a
 *     slash matches only root-level paths).
 */

/** The snapshot's filename inside the run dir (shape documented below). */
export const SNAPSHOT_FILENAME = "protected-digests.json";

/** Safety bound for tree walks (spec-silent): refuse pathological trees. */
export const MAX_TREE_FILES = 20_000;

/** Default git status timeout (spec-silent; a git call must never hang the engine). */
export const GIT_STATUS_TIMEOUT_MS = 30_000;

/* --------------------------------- glob matching ---------------------------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One path segment: literal text with `*` wildcards (nothing else). */
function segmentMatch(patternSegment: string, pathSegment: string): boolean {
  const re = new RegExp(`^${patternSegment.split("*").map(escapeRe).join(".*")}$`);
  return re.test(pathSegment);
}

function matchSegments(pat: string[], path: string[]): boolean {
  if (pat.length === 0) return path.length === 0;
  const head = pat[0]!;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(pat.slice(1), path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (!segmentMatch(head, path[0]!)) return false;
  return matchSegments(pat.slice(1), path.slice(1));
}

/** Match a glob from the documented subset against a target-relative path. */
export function globMatch(pattern: string, relPath: string): boolean {
  return matchSegments(pattern.split("/"), relPath.split("/"));
}

/** True when the relative path matches at least one glob in the set. */
export function globMatchAny(patterns: readonly string[], relPath: string): boolean {
  return patterns.some((p) => globMatch(p, relPath));
}

/* ---------------------------------- tree walking ---------------------------------- */

/** All regular files under root, as target-relative POSIX-style paths. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) recurse(abs);
      else if (ent.isFile()) {
        out.push(relative(root, abs));
        if (out.length > MAX_TREE_FILES) {
          throw new Error(
            `target tree exceeds ${MAX_TREE_FILES} files under ${root} — refusing the digest snapshot (safety bound; spec-silent)`,
          );
        }
      }
    }
  };
  recurse(root);
  out.sort();
  return out;
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/* ------------------------------- the snapshot file -------------------------------- */

export type ProtectedTargetSnapshot = {
  target_id: string;
  alias: string;
  target_type: "git_repo" | "directory";
  root_path: string;
  protected_globs: string[];
  write_scope_globs: string[];
  /**
   * git_repo targets snapshot ONLY the protected set (git names the
   * modified paths post-run). directory targets snapshot the WHOLE
   * tree — that baseline is the modified-path source (spec-silent
   * reading; see module doc).
   */
  full_tree: boolean;
  /** relative path → sha256 hex digest, at preflight time. */
  files: Record<string, string>;
};

export type ProtectedSnapshot = {
  version: 1;
  task_id: string;
  run_id: string;
  taken_at: string;
  targets: ProtectedTargetSnapshot[];
};

type ScopeJoinRow = {
  target_id: string;
  alias: string;
  target_type: "git_repo" | "directory";
  root_path: string;
  write_scope_globs_json: string;
  protected_test_globs_json: string;
};

function parseStringArray(json: string, column: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`${column} is not a JSON array of strings`);
  }
  return parsed as string[];
}

function scopedTargets(db: Db, taskId: string): Array<ScopeJoinRow & {
  protected_globs: string[];
  write_scope_globs: string[];
}> {
  const rows = db
    .prepare(
      `SELECT tts.target_id AS target_id, pt.alias AS alias, pt.target_type AS target_type,
              pt.root_path AS root_path,
              tts.write_scope_globs_json AS write_scope_globs_json,
              tts.protected_test_globs_json AS protected_test_globs_json
         FROM task_target_scopes tts
         JOIN project_targets pt ON pt.id = tts.target_id
        WHERE tts.task_id = ?
        ORDER BY tts.id`,
    )
    .all(taskId) as ScopeJoinRow[];
  return rows.map((r) => ({
    ...r,
    protected_globs: parseStringArray(r.protected_test_globs_json, "protected_test_globs_json"),
    write_scope_globs: parseStringArray(r.write_scope_globs_json, "write_scope_globs_json"),
  }));
}

/**
 * Snapshot the pre-run protected digests into the run dir (called from
 * startRun's preflight, BEFORE the agent spawns). Throws when a scoped
 * target's root is missing or not a directory — a preflight failure,
 * never a mid-run surprise.
 */
export function writeProtectedDigests(db: Db, taskId: string, runDir: string, runId: string): string {
  const targets: ProtectedTargetSnapshot[] = scopedTargets(db, taskId).map((t) => {
    if (!existsSync(t.root_path) || !statSync(t.root_path).isDirectory()) {
      throw new Error(`target root missing or not a directory: ${t.root_path} (alias ${t.alias})`);
    }
    const fullTree = t.target_type === "directory";
    const files: Record<string, string> = {};
    for (const rel of walkFiles(t.root_path)) {
      if (fullTree || globMatchAny(t.protected_globs, rel)) {
        files[rel] = sha256File(join(t.root_path, rel));
      }
    }
    return {
      target_id: t.target_id,
      alias: t.alias,
      target_type: t.target_type,
      root_path: t.root_path,
      protected_globs: t.protected_globs,
      write_scope_globs: t.write_scope_globs,
      full_tree: fullTree,
      files,
    };
  });
  const snapshot: ProtectedSnapshot = {
    version: 1,
    task_id: taskId,
    run_id: runId,
    taken_at: new Date().toISOString(),
    targets,
  };
  const path = join(runDir, SNAPSHOT_FILENAME);
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
  return path;
}

/* ---------------------------------- verification ---------------------------------- */

export type ProtectedCheckResult = {
  protectedFilesUntouched: boolean;
  /** `<alias>/<relative path>` for every modified path outside the write scope. */
  scopeCreepPaths: string[];
  /** Human-readable findings (tampered files, git failures, fail-closed reasons). */
  notes: string[];
};

/** Parse `git status --porcelain` output into modified relative paths. */
export function parseGitPorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4); // renames contribute the destination
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
      rest = rest.slice(1, -1); // minimally unquoted (documented subset)
    }
    if (rest !== "") paths.push(rest);
  }
  return paths;
}

export type ProtectedVerifyOptions = GroupedCommandOptions & {
  /** Timeout for the per-target `git status` runs (default 30 s). */
  gitTimeoutMs?: number;
};

/**
 * Verify protected-file integrity (SHA-256 vs the pre-run snapshot)
 * and the write scope (modified paths vs write_scope_globs_json).
 * Never throws — every failure mode is a finding in the result.
 */
export async function verifyProtectedAndScope(
  db: Db,
  taskId: string,
  runDir: string,
  opts: ProtectedVerifyOptions = {},
): Promise<ProtectedCheckResult> {
  const notes: string[] = [];
  const scopeCount = (
    db.prepare("SELECT COUNT(*) AS n FROM task_target_scopes WHERE task_id = ?").get(taskId) as {
      n: number;
    }
  ).n;
  if (scopeCount === 0) {
    // no mapped targets: nothing is protected, nothing can creep
    return { protectedFilesUntouched: true, scopeCreepPaths: [], notes };
  }

  const snapshotPath = join(runDir, SNAPSHOT_FILENAME);
  if (!existsSync(snapshotPath)) {
    return {
      protectedFilesUntouched: false,
      scopeCreepPaths: [],
      notes: [
        `${SNAPSHOT_FILENAME} missing from the run dir — failing closed (FR-TSK-11): protected-file integrity cannot be proven without the pre-run snapshot`,
      ],
    };
  }
  let snapshot: ProtectedSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as ProtectedSnapshot;
  } catch (err) {
    return {
      protectedFilesUntouched: false,
      scopeCreepPaths: [],
      notes: [`${SNAPSHOT_FILENAME} is unreadable — failing closed: ${(err as Error).message}`],
    };
  }

  let untouched = true;
  const creep: string[] = [];

  for (const t of snapshot.targets) {
    if (!existsSync(t.root_path) || !statSync(t.root_path).isDirectory()) {
      untouched = false;
      notes.push(`target root vanished between preflight and verification: ${t.root_path}`);
      continue;
    }

    // current digests over the sets we can compare
    let currentAll: Record<string, string> | null = null;
    if (t.full_tree) {
      currentAll = {};
      try {
        for (const rel of walkFiles(t.root_path)) {
          currentAll[rel] = sha256File(join(t.root_path, rel));
        }
      } catch (err) {
        untouched = false;
        notes.push(`cannot walk target tree ${t.alias}: ${(err as Error).message}`);
        continue;
      }
    }
    const currentProtected: Record<string, string> = {};
    if (currentAll !== null) {
      for (const [rel, digest] of Object.entries(currentAll)) {
        if (globMatchAny(t.protected_globs, rel)) currentProtected[rel] = digest;
      }
    } else {
      for (const rel of walkFiles(t.root_path)) {
        if (globMatchAny(t.protected_globs, rel)) {
          currentProtected[rel] = sha256File(join(t.root_path, rel));
        }
      }
    }

    // (a) protected integrity: compare the PROTECTED SET only — for
    // git targets the snapshot holds exactly that set; for directory
    // targets (full-tree baseline) the protected globs select the
    // relevant subset, so an empty protected set is vacuously untouched
    const snapshotProtected = Object.entries(t.files).filter(
      ([rel]) => globMatchAny(t.protected_globs, rel),
    );
    for (const [rel, digest] of snapshotProtected) {
      if (currentProtected[rel] === undefined) {
        untouched = false;
        notes.push(`protected file deleted: ${t.alias}/${rel}`);
      } else if (currentProtected[rel] !== digest) {
        untouched = false;
        notes.push(`protected file modified: ${t.alias}/${rel}`);
      }
    }
    for (const [rel, digest] of Object.entries(currentProtected)) {
      if (t.files[rel] === undefined) {
        untouched = false;
        notes.push(`protected file created after the snapshot: ${t.alias}/${rel}`);
        void digest;
      }
    }

    // (b) modified paths for the write-scope check
    let modified: string[] = [];
    if (t.target_type === "git_repo") {
      // --untracked-files=all: agent-created files must be evaluated
      // INDIVIDUALLY against the write-scope globs; git's default would
      // collapse an untracked directory to a single "dir/" entry
      const res = await runGroupedCommand(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        t.root_path,
        {
          timeoutMs: opts.gitTimeoutMs ?? GIT_STATUS_TIMEOUT_MS,
          ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
        },
      );
      if (res.spawnError !== null || res.exitCode !== 0 || res.timedOut) {
        // spec names the git check; when git itself fails the scope
        // check has no evidence to evaluate (the protected-digest check
        // above is the hard anti-gaming gate). Record and skip.
        notes.push(
          `git status failed for ${t.alias} (exit=${res.exitCode ?? "none"}${res.spawnError !== null ? `, ${res.spawnError}` : ""}) — write-scope check skipped, protected digests still enforced`,
        );
      } else {
        modified = parseGitPorcelain(res.stdout);
      }
    } else if (currentAll !== null) {
      for (const [rel, digest] of Object.entries(currentAll)) {
        if (t.files[rel] !== digest) modified.push(rel);
      }
      for (const rel of Object.keys(t.files)) {
        if (currentAll[rel] === undefined) modified.push(rel);
      }
    }
    for (const rel of modified) {
      if (!globMatchAny(t.write_scope_globs, rel)) creep.push(`${t.alias}/${rel}`);
    }
  }

  return { protectedFilesUntouched: untouched, scopeCreepPaths: creep, notes };
}
