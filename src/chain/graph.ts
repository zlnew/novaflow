import type { Db } from "../store/db.ts";

/**
 * The chained-task-graph validator (novaflow-v1/data §4.3 + the §5.3
 * chain flexibility ruling; srs FR-PRJ-04 AC1/AC2).
 *
 * Structural validation mirrors the §4.3 JSON Schema block verbatim:
 * required keys, `additionalProperties: false` at EVERY level, the
 * per-field types/patterns/bounds. Golden tests re-parse the live
 * spec block and pin every constant exported here (the
 * test/golden/profile-schema.test.ts pattern, extended to §4.3).
 *
 * Topology rulings (documented, spec-anchored):
 *   - ACYCLICITY applies to `depends_on` edges ONLY. The 8.1 feedback
 *     routing rule builds loops BY DESIGN: a cycle through
 *     `on_changes_requested` (or `on_failure`) edges is the review
 *     path — the emitter completes, the targets re-enter — and is
 *     legal. Rejecting it would reject the core feature's own
 *     topology.
 *   - Self-edges: `depends_on` source==target is an immediate cycle —
 *     rejected. A FEEDBACK self-edge is legal: the matrix's
 *     completed→changes_requested row applies to any task named as an
 *     emitter's target, including the emitter itself (a task may
 *     re-enter its own review loop).
 *   - Duplicate task keys refuse as `duplicate`; duplicate edges
 *     (same source/target/edge_type triple) refuse as `duplicate`
 *     naming the pair — the task_edges DDL's
 *     UNIQUE(source_task_id, target_task_id, edge_type) would refuse
 *     them anyway; the validator refuses EARLY, before any store write.
 *   - `condition_expr` is schema-legal and stored verbatim, but NEVER
 *     evaluated in v1 (§5.3: no expression language exists) — the
 *     p4b boundary.
 *
 * Profile resolution (the §4.3 pre-block rule): a task's
 * `profile_name` resolves workspace-local profiles FIRST, then global
 * defaults. A name that matches nothing in that universe is
 * `not_found` (the same code the established nova_task_create surface
 * gives a missing profile name). A name that matches MORE than one
 * global row (SQLite's UNIQUE treats NULL workspace_id values as
 * distinct, so duplicate global rows can exist) resolves to NEITHER:
 * `profile_unresolved`, the taxonomy's resolution-failure code — the
 * truthful mapping for a name that cannot be resolved to exactly one
 * profile.
 */

export type ChainErrorCode =
  | "schema_invalid"
  | "not_found"
  | "duplicate"
  | "profile_unresolved";

/** Typed validation failure; `code` is the srs 4.1.1 taxonomy row. */
export class ChainValidationError extends Error {
  constructor(readonly code: ChainErrorCode, message: string) {
    super(message);
    this.name = "ChainValidationError";
  }
}

/* ----------------------- the §4.3 schema, pinned ----------------------- */

/** The schema's top-level `required` array (data.md §4.3), order verbatim. */
export const CHAIN_REQUIRED_KEYS: readonly string[] = [
  "version",
  "project_slug",
  "tasks",
  "edges",
];

/** Exported for golden pinning: the closed top-level key set. */
export const CHAIN_KNOWN_KEYS: ReadonlySet<string> = new Set([...CHAIN_REQUIRED_KEYS]);

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const PROJECT_SLUG_PATTERN = /^[a-z0-9-]+$/;
/** Schema: `"key": { "type": "string", "pattern": "^[A-Z0-9_-]+$" }`. */
export const TASK_KEY_PATTERN = /^[A-Z0-9_-]+$/;

/** The schema's task-item `required` array, order verbatim. */
export const TASK_REQUIRED_KEYS: readonly string[] = [
  "key",
  "title",
  "objective",
  "profile_name",
];

/** Exported for golden pinning: the closed task-item key set. */
export const TASK_KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...TASK_REQUIRED_KEYS,
  "priority",
  "requires_human_gate",
  "context_files",
  "output_schema_version",
  "target_scopes",
  "overrides",
]);

/** The schema's target_scopes-item `required` array, order verbatim. */
export const SCOPE_REQUIRED_KEYS: readonly string[] = ["repo_alias", "access_mode"];

/** Exported for golden pinning: the closed target_scopes-item key set. */
export const SCOPE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...SCOPE_REQUIRED_KEYS,
  "write_scope_globs",
  "protected_test_globs",
  "verification_commands",
]);

/** The schema's edge-item `required` array, order verbatim. */
export const EDGE_REQUIRED_KEYS: readonly string[] = [
  "source_key",
  "target_key",
  "edge_type",
];

/** Exported for golden pinning: the closed edge-item key set. */
export const EDGE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...EDGE_REQUIRED_KEYS,
  "condition_expr",
]);

/** The schema's edge_type enum, order verbatim (the DDL CHECK's set). */
export const EDGE_TYPES = ["depends_on", "on_changes_requested", "on_failure"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/* ------------------------------ typed shape ----------------------------- */

export type ValidatedTargetScope = {
  repoAlias: string;
  accessMode: "read_only" | "read_write";
  writeScopeGlobs?: string[];
  protectedTestGlobs?: string[];
  verificationCommands?: string[];
};

export type ValidatedChainTask = {
  key: string;
  title: string;
  objective: string;
  /** Resolved per the §4.3 pre-block rule (local first, then global). */
  profileId: string;
  priority?: number;
  requiresHumanGate?: boolean;
  contextFiles?: string[];
  outputSchemaVersion?: string;
  targetScopes?: ValidatedTargetScope[];
  overrides?: Record<string, unknown>;
};

export type ValidatedChainEdge = {
  sourceKey: string;
  targetKey: string;
  edgeType: EdgeType;
  /** Stored verbatim, never evaluated in v1 (§5.3 ruling — p4b boundary). */
  conditionExpr?: string;
};

export type ValidatedChainGraph = {
  version: string;
  projectSlug: string;
  tasks: ValidatedChainTask[];
  edges: ValidatedChainEdge[];
};

/* ------------------------------ the validator --------------------------- */

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function fail(code: ChainErrorCode, message: string): never {
  throw new ChainValidationError(code, message);
}

function expectObject(
  input: unknown,
  what: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("schema_invalid", `${what} must be an object, got ${typeLabel(input)}`);
  }
  return input as Record<string, unknown>;
}

function closedKeys(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  what: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      fail(
        "schema_invalid",
        `${what} carries an unknown key "${key}" — the §4.3 schema declares additionalProperties: false`,
      );
    }
  }
}

function requireKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  what: string,
): void {
  for (const key of required) {
    if (!(key in obj)) {
      fail("schema_invalid", `${what} is missing required key "${key}"`);
    }
  }
}

function expectString(
  obj: Record<string, unknown>,
  key: string,
  what: string,
  minLength?: number,
): string {
  const v = obj[key];
  if (typeof v !== "string") {
    fail("schema_invalid", `${what} key "${key}" must be a string, got ${typeLabel(v)}`);
  }
  if (minLength !== undefined && v.length < minLength) {
    fail(
      "schema_invalid",
      `${what} key "${key}" must be at least ${minLength} characters, got length ${v.length}`,
    );
  }
  return v;
}

function expectStringArray(
  obj: Record<string, unknown>,
  key: string,
  what: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    fail("schema_invalid", `${what} key "${key}" must be an array of strings`);
  }
  return v as string[];
}

/**
 * Resolve one `profile_name` per the §4.3 pre-block rule:
 * workspace-local first, then global; ambiguous → profile_unresolved.
 * See the module header for the taxonomy mapping.
 */
export function resolveChainProfile(db: Db, workspaceId: string, name: string): string {
  const local = db
    .prepare("SELECT id FROM agent_profiles WHERE name = ? AND workspace_id = ?")
    .all(name, workspaceId) as Array<{ id: string }>;
  if (local.length === 1) return local[0]!.id;
  // UNIQUE(workspace_id, name) makes >1 local rows impossible; a
  // corrupt store is still refused, never silently picked
  if (local.length > 1) {
    fail(
      "profile_unresolved",
      `profile name "${name}" matches ${local.length} workspace-local profiles — ambiguous, refusing to pick`,
    );
  }
  const global = db
    .prepare("SELECT id FROM agent_profiles WHERE name = ? AND workspace_id IS NULL")
    .all(name) as Array<{ id: string }>;
  if (global.length === 1) return global[0]!.id;
  if (global.length > 1) {
    fail(
      "profile_unresolved",
      `profile name "${name}" matches ${global.length} global profiles — ambiguous, refusing to pick`,
    );
  }
  fail(
    "not_found",
    `no profile named "${name}" in the workspace's local or global scope`,
  );
}

/** Validate one target_scopes item (§4.3, closed keys). */
function validateScope(item: unknown, index: number): ValidatedTargetScope {
  const what = `tasks[${index}] target_scopes item`;
  const obj = expectObject(item, what);
  closedKeys(obj, SCOPE_KNOWN_KEYS, what);
  requireKeys(obj, SCOPE_REQUIRED_KEYS, what);
  const repoAlias = expectString(obj, "repo_alias", what);
  const accessMode = obj["access_mode"];
  if (accessMode !== "read_only" && accessMode !== "read_write") {
    fail(
      "schema_invalid",
      `${what} access_mode must be "read_only" or "read_write", got ${JSON.stringify(accessMode)}`,
    );
  }
  return {
    repoAlias,
    accessMode,
    ...(expectStringArray(obj, "write_scope_globs", what) !== undefined
      ? { writeScopeGlobs: expectStringArray(obj, "write_scope_globs", what)! }
      : {}),
    ...(expectStringArray(obj, "protected_test_globs", what) !== undefined
      ? { protectedTestGlobs: expectStringArray(obj, "protected_test_globs", what)! }
      : {}),
    ...(expectStringArray(obj, "verification_commands", what) !== undefined
      ? { verificationCommands: expectStringArray(obj, "verification_commands", what)! }
      : {}),
  };
}

/** Validate one task item (§4.3, closed keys) and resolve its profile. */
function validateTask(
  db: Db,
  workspaceId: string,
  item: unknown,
  index: number,
): ValidatedChainTask {
  const what = `tasks[${index}]`;
  const obj = expectObject(item, what);
  closedKeys(obj, TASK_KNOWN_KEYS, what);
  requireKeys(obj, TASK_REQUIRED_KEYS, what);

  const key = expectString(obj, "key", what);
  if (!TASK_KEY_PATTERN.test(key)) {
    fail(
      "schema_invalid",
      `${what} key must match ${TASK_KEY_PATTERN}, got ${JSON.stringify(key)}`,
    );
  }
  const title = expectString(obj, "title", what, 3); // schema: minLength 3
  const objective = expectString(obj, "objective", what, 10); // minLength 10
  const profileName = expectString(obj, "profile_name", what);
  const profileId = resolveChainProfile(db, workspaceId, profileName);

  const task: ValidatedChainTask = { key, title, objective, profileId };

  if (obj["priority"] !== undefined) {
    const priority = obj["priority"];
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 5) {
      fail(
        "schema_invalid",
        `${what} priority must be an integer 1..5 (schema minimum 1, maximum 5), got ${JSON.stringify(priority)}`,
      );
    }
    task.priority = priority;
  }
  if (obj["requires_human_gate"] !== undefined) {
    if (typeof obj["requires_human_gate"] !== "boolean") {
      fail(
        "schema_invalid",
        `${what} requires_human_gate must be a boolean, got ${typeLabel(obj["requires_human_gate"])}`,
      );
    }
    task.requiresHumanGate = obj["requires_human_gate"];
  }
  const contextFiles = expectStringArray(obj, "context_files", what);
  if (contextFiles !== undefined) task.contextFiles = contextFiles;
  if (obj["output_schema_version"] !== undefined) {
    // schema: type string (default "1.0.0"); the established engine bound
    // (nova_task_create's output_schema_version arg) also refuses empty
    const v = expectString(obj, "output_schema_version", what);
    if (v.trim() === "") {
      fail("schema_invalid", `${what} output_schema_version must be a non-empty string`);
    }
    task.outputSchemaVersion = v;
  }
  if (obj["target_scopes"] !== undefined) {
    const scopes = obj["target_scopes"];
    if (!Array.isArray(scopes)) {
      fail("schema_invalid", `${what} target_scopes must be an array of scope objects`);
    }
    task.targetScopes = scopes.map((s, i) => validateScope(s, i));
  }
  if (obj["overrides"] !== undefined) {
    const overrides = expectObject(obj["overrides"], `${what} overrides`);
    closedKeys(
      overrides,
      new Set(["timeout_sec", "max_cost_usd", "thinking_level"]),
      `${what} overrides`,
    );
    if ("timeout_sec" in overrides) {
      const t = overrides["timeout_sec"];
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1) {
        fail("schema_invalid", `${what} overrides.timeout_sec must be an integer >= 1`);
      }
    }
    if ("max_cost_usd" in overrides) {
      const m = overrides["max_cost_usd"];
      if (typeof m !== "number" || !Number.isFinite(m) || m < 0) {
        fail("schema_invalid", `${what} overrides.max_cost_usd must be a number >= 0`);
      }
    }
    if ("thinking_level" in overrides) {
      const t = overrides["thinking_level"];
      if (typeof t !== "string" || t.trim() === "") {
        fail("schema_invalid", `${what} overrides.thinking_level must be a non-empty string`);
      }
    }
    task.overrides = overrides;
  }
  return task;
}

/** Validate one edge item (§4.3, closed keys). */
function validateEdge(item: unknown, index: number): ValidatedChainEdge {
  const what = `edges[${index}]`;
  const obj = expectObject(item, what);
  closedKeys(obj, EDGE_KNOWN_KEYS, what);
  requireKeys(obj, EDGE_REQUIRED_KEYS, what);
  const sourceKey = expectString(obj, "source_key", what);
  const targetKey = expectString(obj, "target_key", what);
  const edgeType = obj["edge_type"];
  if (typeof edgeType !== "string" || !EDGE_TYPES.includes(edgeType as EdgeType)) {
    fail(
      "schema_invalid",
      `${what} edge_type must be one of depends_on|on_changes_requested|on_failure, got ${JSON.stringify(edgeType)}`,
    );
  }
  const edge: ValidatedChainEdge = { sourceKey, targetKey, edgeType: edgeType as EdgeType };
  if (obj["condition_expr"] !== undefined) {
    edge.conditionExpr = expectString(obj, "condition_expr", what);
  }
  return edge;
}

/**
 * Acyclicity over `depends_on` edges ONLY (the §5.3 ruling — feedback
 * edges create loops by design). A cycle refuses naming the path.
 */
function assertAcyclic(tasks: ValidatedChainTask[], edges: ValidatedChainEdge[]): void {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const deps = new Map<string, string[]>();
  for (const t of tasks) deps.set(t.key, []);
  for (const e of edges) {
    if (e.edgeType === "depends_on") deps.get(e.sourceKey)!.push(e.targetKey);
  }
  // ITERATIVE three-color DFS (review round): the recursive form overflowed
  // Node's stack on large legal chains (~5k members inside the op-handler
  // call depth) and surfaced as an untyped RangeError. Same cycle-path
  // naming, O(V+E), no stack growth.
  const WHITE = 0 as const, GRAY = 1 as const, BLACK = 2 as const;
  const color = new Map<string, 0 | 1 | 2>(tasks.map((t) => [t.key, WHITE]));
  for (const start of tasks) {
    if (color.get(start.key) !== WHITE) continue;
    const path: string[] = [];
    const stack: Array<{ key: string; iter: Iterator<string> }> = [];
    const enter = (key: string): void => {
      color.set(key, GRAY);
      path.push(key);
      stack.push({ key, iter: (deps.get(key) ?? [])[Symbol.iterator]() });
    };
    enter(start.key);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = top.iter.next();
      if (next.done) {
        color.set(top.key, BLACK);
        path.pop();
        stack.pop();
        continue;
      }
      const n = next.value;
      // a missing node here is impossible (node refs were checked first),
      // guarded anyway — never crash on a corrupt edge row
      if (!byKey.has(n)) continue;
      const c = color.get(n)!;
      if (c === GRAY) {
        const cycleStart = path.indexOf(n);
        const cycle = [...path.slice(cycleStart), n].join(" -> ");
        fail(
          "schema_invalid",
          `the chain graph contains a depends_on cycle: ${cycle} — FR-PRJ-04 AC2 rejects cyclic graphs`,
        );
      }
      if (c === WHITE) enter(n);
    }
  }
}

/**
 * Validate a parsed chain graph end to end:
 *   1. structural validation against the §4.3 schema block;
 *   2. duplicate task keys (duplicate) and duplicate edge triples
 *      (duplicate, naming the pair — the DDL UNIQUE);
 *   3. node references: every edge endpoint must be a declared task
 *      key (not_found, naming the edge);
 *   4. self-edges per the module header's ruling;
 *   5. acyclicity over depends_on only (schema_invalid, naming the path);
 *   6. profile resolution per the §4.3 pre-block rule.
 * Throws ChainValidationError BEFORE any store write — the import is
 * all-or-nothing by construction (validation precedes the transaction).
 */
export function validateChainGraph(
  db: Db,
  workspaceId: string,
  input: unknown,
): ValidatedChainGraph {
  const root = expectObject(input, "the chain graph");
  closedKeys(root, CHAIN_KNOWN_KEYS, "the chain graph");
  requireKeys(root, CHAIN_REQUIRED_KEYS, "the chain graph");

  const version = expectString(root, "version", "the chain graph");
  if (!VERSION_PATTERN.test(version)) {
    fail(
      "schema_invalid",
      `version must match ${VERSION_PATTERN}, got ${JSON.stringify(version)}`,
    );
  }
  const projectSlug = expectString(root, "project_slug", "the chain graph");
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
    fail(
      "schema_invalid",
      `project_slug must match ${PROJECT_SLUG_PATTERN}, got ${JSON.stringify(projectSlug)}`,
    );
  }

  const tasksRaw = root["tasks"];
  if (!Array.isArray(tasksRaw)) {
    fail("schema_invalid", "tasks must be an array of task objects");
  }
  if (tasksRaw.length < 1) {
    fail("schema_invalid", "tasks must carry at least one member (schema minItems: 1)");
  }
  const tasks = tasksRaw.map((t, i) => validateTask(db, workspaceId, t, i));

  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) {
      fail("duplicate", `task key "${t.key}" is declared twice in the chain graph`);
    }
    keys.add(t.key);
  }

  const edgesRaw = root["edges"];
  if (!Array.isArray(edgesRaw)) {
    fail("schema_invalid", "edges must be an array of edge objects");
  }
  const edges = edgesRaw.map((e, i) => validateEdge(e, i));

  const seenTriples = new Set<string>();
  for (const e of edges) {
    const triple = `${e.sourceKey}\u0000${e.targetKey}\u0000${e.edgeType}`;
    if (seenTriples.has(triple)) {
      fail(
        "duplicate",
        `edge ${e.sourceKey} -> ${e.targetKey} (${e.edgeType}) is declared twice — the task_edges DDL is UNIQUE(source, target, edge_type)`,
      );
    }
    seenTriples.add(triple);
    for (const [label, key] of [
      ["source_key", e.sourceKey],
      ["target_key", e.targetKey],
    ] as const) {
      if (!keys.has(key)) {
        fail(
          "not_found",
          `edges reference ${label} "${key}" which no task declares (edge ${e.sourceKey} -> ${e.targetKey}, ${e.edgeType}) — FR-PRJ-04 AC2 rejects unresolvable node references`,
        );
      }
    }
    if (e.sourceKey === e.targetKey && e.edgeType === "depends_on") {
      fail(
        "schema_invalid",
        `task "${e.sourceKey}" cannot depend_on itself — a depends_on self-edge is a cycle`,
      );
    }
    // feedback self-edges are legal (module header ruling): fall through
  }

  assertAcyclic(tasks, edges);

  return { version, projectSlug, tasks, edges };
}
