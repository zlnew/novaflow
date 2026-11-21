import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
 *     entries contribute BOTH their source and destination paths).
 *   - `directory`: spec-silent → digest-based only. No VCS baseline
 *     exists, so the preflight snapshot for a directory target covers
 *     the WHOLE tree (full_tree = true) and modified paths are the
 *     digest diffs (changed, created, deleted) against that baseline.
 * A modified path that matches NO glob in `write_scope_globs_json` is
 * scope creep (RSK-17) and fails verification. Symlinks are digest
 * entries too, hashed by their TARGET string (never followed) — an
 * agent-created or retargeted link is a modified path like any file.
 *
 * Glob matcher subset (documented in-code, deliberately minimal):
 *   - segments split on `/`; `**` matches ZERO OR MORE whole segments
 *     (so `src/**` also matches a bare `src` entry);
 *   - `*` matches any characters EXCEPT `/` within one segment;
 *   - everything else is literal — NO brace expansion, NO character
 *     classes, NO `?`, NO negation. Patterns are matched against the
 *     path RELATIVE to the target root, in full (a pattern without a
 *     slash matches only root-level paths).
 *
 * Matcher performance: the naive recursive matcher backtracks
 * catastrophically (146 s on `"*".repeat(10)+"!"` vs a 60-char
 * segment; exponential on `**` chains). The matcher runs synchronously
 * in startRun preflight and verification, so it is O(n·m) and bounded:
 * `segmentMatch` is a linear two-pointer wildcard scan (no regex), and
 * `matchSegments` memoizes on (pattern index, path index).
 */

/** The snapshot's filename inside the run dir (shape documented below). */
export const SNAPSHOT_FILENAME = "protected-digests.json";

/** Safety bound for tree walks (spec-silent): refuse pathological trees. */
export const MAX_TREE_FILES = 20_000;

/** Default git status timeout (spec-silent; a git call must never hang the engine). */
export const GIT_STATUS_TIMEOUT_MS = 30_000;

/* --------------------------------- glob matching ---------------------------------- */

/**
 * One path segment: literal text with `*` wildcards (nothing else).
 * Linear two-pointer wildcard scan — the classic greedy algorithm
 * (no regex: a `split("*").join(".*")` regex backtracks
 * catastrophically on many-star patterns; see module doc).
 */
function segmentMatch(patternSegment: string, pathSegment: string): boolean {
  let pi = 0;
  let si = 0;
  let starPat = -1; // index of the last `*` seen in the pattern
  let starStr = 0; // the path position that `*` last matched through
  while (si < pathSegment.length) {
    if (pi < patternSegment.length && patternSegment[pi] === "*") {
      starPat = pi++;
      starStr = si;
    } else if (pi < patternSegment.length && patternSegment[pi] === pathSegment[si]) {
      pi++;
      si++;
    } else if (starPat >= 0) {
      // backtrack: widen the last `*` by one character
      pi = starPat + 1;
      si = ++starStr;
    } else {
      return false;
    }
  }
  while (pi < patternSegment.length && patternSegment[pi] === "*") pi++;
  return pi === patternSegment.length;
}

/**
 * Match a pattern's segments against a path's segments. Memoized on
 * (pattern index, path index) — `**` chains otherwise retry
 * exponentially many segment splits (see module doc).
 */
function matchSegments(pat: string[], path: string[]): boolean {
  const width = path.length + 1;
  // 0 = unknown, 1 = true, -1 = false
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

/* ---------------------------------- tree walking ---------------------------------- */

/**
 * Digest-invariant directories pruned from every tree walk
 * (spec-silent, documented for the agent): `.git` internals churn with
 * every git operation — git_repo targets already cover repo state via
 * `git status` — and `node_modules` changes with every install while
 * routinely exceeding the walk's safety bound by orders of magnitude.
 * Neither may be relied on to carry task state; neither participates in
 * digest baselines or protected-set snapshots (pruning wins even when a
 * glob names them explicitly).
 */
const PRUNED_DIRS = new Set([".git", "node_modules"]);

/**
 * All regular files and symlinks (never followed) under the walked
 * roots, as target-relative paths. `subRoots` (root-relative,
 * POSIX-style) restricts the walk to those subtrees — used when every
 * protected glob is literal-prefixed, so a scoped target's snapshot
 * never walks (or trips the file-count bound on) the rest of the tree;
 * `undefined` walks the whole tree, `[]` walks nothing (empty protected
 * set). `.git` and `node_modules` are pruned everywhere (PRUNED_DIRS).
 * A walk root that is a FILE contributes itself as a bare entry (the
 * documented `src/**`-matches-bare-`src` case); a missing root matches
 * nothing. Throws at MAX_TREE_FILES — callers translate (preflight
 * error naming the target / verification finding).
 */
export function walkFiles(root: string, subRoots?: string[]): string[] {
  const out: string[] = [];
  const count = (): void => {
    if (out.length > MAX_TREE_FILES) {
      throw new Error(
        `target tree exceeds ${MAX_TREE_FILES} files under ${root} — refusing the digest snapshot (safety bound; spec-silent)`,
      );
    }
  };
  const recurse = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (PRUNED_DIRS.has(ent.name)) continue;
        recurse(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(relative(root, abs));
        count();
      }
    }
  };
  for (const rel of subRoots ?? [""]) {
    const firstSegment = rel === "" ? "" : rel.split("/")[0]!;
    if (firstSegment !== "" && PRUNED_DIRS.has(firstSegment)) continue; // pruning wins
    const abs = join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // a missing walk root simply matches nothing
    }
    if (st.isDirectory()) {
      recurse(abs);
    } else if (st.isFile() || st.isSymbolicLink()) {
      out.push(relative(root, abs));
      count();
    }
  }
  out.sort();
  return out;
}

/** Leading literal (wildcard-free) segments of a glob — `["src"]` for
 * `src/**`, `[]` once a segment contains `*` (e.g. `*.md` or a leading
 * `**` segment). */
function literalPrefix(pattern: string): string[] {
  const out: string[] = [];
  for (const seg of pattern.split("/")) {
    if (seg.includes("*")) break;
    out.push(seg);
  }
  return out;
}

/** Dedupe prefix roots, dropping any root nested inside another. */
function dedupeSubRoots(prefixes: string[]): string[] {
  const out: string[] = [];
  for (const p of [...new Set(prefixes)].sort()) {
    if (out.some((q) => p.startsWith(q + "/"))) continue;
    out.push(p);
  }
  return out;
}

/**
 * Walk roots covering everything the protected globs can match.
 * Returns `undefined` (walk the whole tree) when any glob starts with
 * a wildcard segment, and `[]` (walk nothing) for an empty protected
 * set — otherwise the deduped literal prefixes, so e.g. `tests/**`
 * snapshots without ever touching the rest of the repo.
 */
function protectedWalkRoots(protectedGlobs: readonly string[]): string[] | undefined {
  if (protectedGlobs.length === 0) return [];
  const prefixes = protectedGlobs.map((g) => literalPrefix(g).join("/"));
  if (prefixes.some((p) => p === "")) return undefined;
  return dedupeSubRoots(prefixes);
}

/**
 * SHA-256 of one tree entry. A symlink's identity is its TARGET string
 * (readlink, never followed — an agent link may point outside the
 * target tree), so created/retargeted links are detectable digests.
 */
function sha256Path(absPath: string): string {
  const st = lstatSync(absPath);
  const data = st.isSymbolicLink() ? readlinkSync(absPath) : readFileSync(absPath);
  return createHash("sha256").update(data).digest("hex");
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
   * reading; see module doc) — minus the digest-invariant PRUNED_DIRS,
   * with symlinks hashed by target string.
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
    // walk only what the protected globs can reach: literal-prefixed
    // globs restrict the walk to their subtrees, an empty protected set
    // walks nothing; directory baselines always walk the whole tree
    const walkRoots = fullTree ? undefined : protectedWalkRoots(t.protected_globs);
    try {
      for (const rel of walkFiles(t.root_path, walkRoots)) {
        if (fullTree || globMatchAny(t.protected_globs, rel)) {
          files[rel] = sha256Path(join(t.root_path, rel));
        }
      }
    } catch (err) {
      // never a raw walk error out of preflight: name the target
      throw new Error(`target ${t.alias} (${t.root_path}): ${(err as Error).message}`);
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
  /**
   * True when the write-scope check could NOT be evaluated for at
   * least one target (git status failed on a git_repo target — the
   * agent may have erased `.git`). The scope check is INCONCLUSIVE:
   * fail closed — the overall verification verdict must fail even
   * though protectedFilesUntouched may be true (the digest check
   * still runs and is still enforced).
   */
  scopeCheckInconclusive: boolean;
  /** Human-readable findings (tampered files, git failures, fail-closed reasons). */
  notes: string[];
};

/** Strip a matching pair of surrounding quotes, if present (git still
 * quotes paths with embedded quotes/control characters even under
 * core.quotePath=false). */
function unquoteOne(path: string): string {
  if (path.length >= 2) {
    const first = path[0]!;
    if ((first === '"' || first === "'") && path.endsWith(first)) {
      return path.slice(1, -1);
    }
  }
  return path;
}

/**
 * Parse `git status --porcelain` output into modified relative paths.
 * Rename entries contribute BOTH their source and destination: the
 * renamed-away source vanished from its (possibly out-of-scope)
 * location — a renamed-away out-of-scope file is scope creep too.
 */
export function parseGitPorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      for (const side of [rest.slice(0, arrow), rest.slice(arrow + 4)]) {
        const unquoted = unquoteOne(side);
        if (unquoted !== "") paths.push(unquoted);
      }
      continue;
    }
    const unquoted = unquoteOne(rest);
    if (unquoted !== "") paths.push(unquoted);
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
    return { protectedFilesUntouched: true, scopeCreepPaths: [], scopeCheckInconclusive: false, notes };
  }

  const snapshotPath = join(runDir, SNAPSHOT_FILENAME);
  if (!existsSync(snapshotPath)) {
    return {
      protectedFilesUntouched: false,
      scopeCreepPaths: [],
      scopeCheckInconclusive: false,
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
      scopeCheckInconclusive: false,
      notes: [`${SNAPSHOT_FILENAME} is unreadable — failing closed: ${(err as Error).message}`],
    };
  }

  let untouched = true;
  let scopeInconclusive = false;
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
          currentAll[rel] = sha256Path(join(t.root_path, rel));
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
      // the protected-set walk (same roots the snapshot used) may fail
      // — a >20k or unreadable tree is a FINDING, never a throw out of
      // verification
      try {
        for (const rel of walkFiles(t.root_path, protectedWalkRoots(t.protected_globs))) {
          if (globMatchAny(t.protected_globs, rel)) {
            currentProtected[rel] = sha256Path(join(t.root_path, rel));
          }
        }
      } catch (err) {
        untouched = false;
        notes.push(`cannot walk target tree ${t.alias}: ${(err as Error).message}`);
        continue;
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
      // collapse an untracked directory to a single "dir/" entry.
      // -c core.quotePath=false: non-ASCII paths arrive RAW (no C-style
      // octal escaping to undo); git still quotes embedded quotes /
      // control characters, handled by the minimal unquote in
      // parseGitPorcelain.
      const res = await runGroupedCommand(
        ["git", "-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"],
        t.root_path,
        {
          timeoutMs: opts.gitTimeoutMs ?? GIT_STATUS_TIMEOUT_MS,
          ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
        },
      );
      if (res.spawnError !== null || res.exitCode !== 0 || res.timedOut) {
        // FAIL CLOSED (RSK-17): a git_repo target's scope check has no
        // evidence when git itself fails (the agent can `rm -rf .git`)
        // — the verdict must fail, not skip. Protected digests above
        // are unaffected and still enforced.
        scopeInconclusive = true;
        notes.push(
          `git status failed for ${t.alias} (exit=${res.exitCode ?? "none"}${res.spawnError !== null ? `, ${res.spawnError}` : ""}) — scope check inconclusive, failing closed; protected digests still enforced`,
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

  return {
    protectedFilesUntouched: untouched,
    scopeCreepPaths: creep,
    scopeCheckInconclusive: scopeInconclusive,
    notes,
  };
}
