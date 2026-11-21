import type { Db } from "./store/db.ts";
import { ulid } from "./store/ids.ts";
import { applyTransition } from "./fsm/engine.ts";
import { ROWS } from "./fsm/matrix.ts";
import { ProfileValidationError, validateProfile } from "./profiles.ts";
import {
  probeCatalog,
  ProfileUnresolvedError,
  type ProbeOptions,
} from "./catalog.ts";

/**
 * Task admission on the store (novaflow-v1/data DDL; srs FR-TSK-01,
 * FR-AGT-04). Enqueue is the 8.1 draft→queued row's validation gate:
 * "profile assigned and resolvable" — the catalog probe runs before any
 * transition, and a `profile_unresolved` probe leaves the task in draft
 * with no log row.
 */

export type TaskRow = {
  id: string;
  project_id: string;
  key: string;
  title: string;
  objective: string;
  profile_id: string;
  state: string;
  priority: number;
  max_retries: number;
  retry_count: number;
  requires_human_gate: number;
  side_effect_class: string;
  compaction_count: number;
  output_schema_version: string;
  overrides_json: string | null;
  context_files_json: string;
  chain_run_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
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

export type CreateTaskInput = {
  projectId: string;
  key: string;
  title: string;
  objective: string;
  profileId: string;
  /** 1–5, default 3 (DDL default). */
  priority?: number;
  requiresHumanGate?: boolean;
  contextFiles?: string[];
};

const enqueueRows = ROWS.filter(
  (r) => r.state === "draft" && r.target === "queued",
);
if (enqueueRows.length !== 1) {
  throw new Error(
    `the 8.1 matrix must have exactly one draft→queued row, found ${enqueueRows.length}`,
  );
}
/** The verbatim 8.1 trigger for draft→queued — never paraphrase. */
export const ENQUEUE_TRIGGER: string = enqueueRows[0]!.trigger;

export type EnqueueOptions = {
  /** Pi binary for the catalog probe; default "pi". Tests stub this. */
  piBin?: string | undefined;
  /** Extra argv before the engine flags (stub script + mode). */
  args?: string[] | undefined;
  /** Response-frame deadline for the catalog probe. */
  timeoutMs?: number | undefined;
};

export function getTask(db: Db, taskId: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
    | TaskRow
    | undefined;
}

function getTaskOrThrow(db: Db, taskId: string): TaskRow {
  const row = getTask(db, taskId);
  if (!row) throw new Error(`no such task: ${taskId}`);
  return row;
}

/** Insert a `draft` task row (id via ulid(), data.md 5.1 stored id form). */
export function createTask(db: Db, input: CreateTaskInput): TaskRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, key, title, objective, profile_id,
        priority, requires_human_gate, context_files_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.key,
    input.title,
    input.objective,
    input.profileId,
    input.priority ?? 3, // DDL default
    input.requiresHumanGate === true ? 1 : 0,
    JSON.stringify(input.contextFiles ?? []),
  );
  return getTaskOrThrow(db, id);
}

/**
 * List tasks, optionally scoped to a project. ULID ids order by creation
 * time (data.md 5.1), so ordering by id is creation order.
 */
export function listTasks(db: Db, projectId?: string): TaskRow[] {
  const rows =
    projectId === undefined
      ? db.prepare("SELECT * FROM tasks ORDER BY id").all()
      : db
          .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id")
          .all(projectId);
  return rows as TaskRow[];
}

/**
 * Enqueue a draft task (the 8.1 draft→queued row, trigger verbatim):
 * resolve the task's profile — the agent_profiles ROW is the stored
 * profile, validated with the same §4.2 validator — probe the catalog with
 * the row's identity, and only then applyTransition. A `profile_unresolved`
 * probe (or a row that fails §4.2 validation) throws and leaves the task
 * in draft with no log row.
 */
export async function enqueueTask(
  db: Db,
  taskId: string,
  actor: string,
  opts: EnqueueOptions = {},
): Promise<TaskRow> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const profileRow = db
    .prepare("SELECT * FROM agent_profiles WHERE id = ?")
    .get(task.profile_id) as ProfileRow | undefined;
  if (!profileRow) {
    throw new ProfileUnresolvedError(
      `task ${taskId} references missing profile ${task.profile_id}`,
    );
  }

  // The stored row is the profile (data.md DDL: agent_profiles columns are
  // the §4.2 fields) — validate it before spending a subprocess probe.
  let toolsAllowlist: unknown;
  try {
    toolsAllowlist = JSON.parse(profileRow.tools_allowlist_json);
  } catch {
    throw new ProfileValidationError(
      "tools_allowlist",
      `stored tools_allowlist_json is not valid JSON for profile ${profileRow.id}`,
    );
  }
  validateProfile({
    name: profileRow.name,
    ...(profileRow.role !== null ? { role: profileRow.role } : {}),
    provider: profileRow.provider,
    model: profileRow.model,
    thinking_level: profileRow.thinking_level,
    tools_allowlist: toolsAllowlist,
    system_prompt_path: profileRow.system_prompt_path,
    limits: {
      max_timeout_sec: profileRow.max_timeout_sec,
      max_cost_usd: profileRow.max_cost_usd,
    },
  });

  const probeOpts: ProbeOptions = {};
  if (opts.piBin !== undefined) probeOpts.piBin = opts.piBin;
  if (opts.args !== undefined) probeOpts.args = opts.args;
  if (opts.timeoutMs !== undefined) probeOpts.timeoutMs = opts.timeoutMs;
  const probe = await probeCatalog(
    {
      provider: profileRow.provider,
      model: profileRow.model,
      thinking_level: profileRow.thinking_level,
    },
    probeOpts,
  );
  if (!probe.ok) {
    throw new ProfileUnresolvedError(probe.reason);
  }

  applyTransition(db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor });
  return getTaskOrThrow(db, taskId);
}
