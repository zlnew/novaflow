import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./store/db.ts";
import { ulid } from "./store/ids.ts";
import { novaflowDir } from "./workspaces.ts";

/**
 * Project provisioning service (srs FR-PRJ-01/02/03; data.md DDL).
 *
 * The daemon's project ops (src/daemon/server.ts) validate the request
 * shape and call this module for every store + filesystem effect — the
 * single-writer rule.
 *
 * Spec-silent choices (documented):
 *   - Project name discipline mirrors the workspace's: FR-PRJ names no
 *     constraint, data.md 5.1 pins slugs to lower-case kebab-case, and
 *     the DDL stores BOTH name and slug. This module requires
 *     `^[a-z0-9-]+$` and uses the name as the slug — one rule, one
 *     identifier, matching the workspace ruling.
 *   - Phase labels are free text (FR-PRJ-02 AC1: no transition rules);
 *     the documented sane bound is 200 characters.
 *   - A phase SET with an identical label is not a change: no audit
 *     row (AC2 logs changes), response carries `changed: false`.
 */

export const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;

/** Documented sane bound for the free-text phase label. */
export const MAX_PHASE_LENGTH = 200;

export type ProjectRow = {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  objective: string;
  phase: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ProjectTargetInput = {
  alias: string;
  root_path: string;
  target_type: "git_repo" | "directory";
  /** DDL defaults when omitted: 'main', 'novaflow/', 'read_write'. */
  base_branch?: string;
  branch_prefix?: string;
  default_access?: "read_only" | "read_write";
};

export type ProjectTargetRow = {
  id: string;
  project_id: string;
  alias: string;
  target_type: string;
  root_path: string;
  base_branch: string | null;
  branch_prefix: string | null;
  default_access: string;
  created_at: string;
};

export function getProject(db: Db, id: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

/**
 * FR-PRJ-01: insert the project row plus 0..N `project_targets` rows in
 * ONE transaction, and scaffold `<root>/.novaflow/projects/<slug>/`
 * (data.md 5.2 layout). Callers pre-validate the payload and the
 * workspace's existence.
 */
export function createProject(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    objective: string;
    targets?: ProjectTargetInput[];
    workspaceRoot: string;
  },
): { project: ProjectRow; targets: ProjectTargetRow[] } {
  const id = ulid();
  const insert = db.transaction((): void => {
    db.prepare(
      `INSERT INTO projects (id, workspace_id, slug, name, objective)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.workspaceId, input.name, input.name, input.objective);
    for (const target of input.targets ?? []) {
      db.prepare(
        `INSERT INTO project_targets
           (id, project_id, alias, target_type, root_path, base_branch,
            branch_prefix, default_access)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        id,
        target.alias,
        target.target_type,
        target.root_path,
        target.base_branch ?? "main", // DDL default
        target.branch_prefix ?? "novaflow/", // DDL default
        target.default_access ?? "read_write", // DDL default
      );
    }
  });
  insert();
  // the project directory under the canonical layout (best-effort
  // scaffold; the row is already authoritative)
  try {
    mkdirSync(join(novaflowDir(input.workspaceRoot), "projects", input.name), { recursive: true });
  } catch {
    // a project whose directory cannot be created still exists in the
    // store; the run path surfaces directory problems
  }
  const project = getProject(db, id);
  if (!project) throw new Error(`created project ${id} is missing from the store`);
  return { project, targets: listProjectTargets(db, id) };
}

export function listProjectTargets(db: Db, projectId: string): ProjectTargetRow[] {
  return db
    .prepare("SELECT * FROM project_targets WHERE project_id = ? ORDER BY alias")
    .all(projectId) as ProjectTargetRow[];
}

export function listProjects(db: Db, workspaceId?: string): Array<ProjectRow & { target_count: number }> {
  const sql = `
    SELECT p.*, (SELECT COUNT(*) FROM project_targets t WHERE t.project_id = p.id) AS target_count
      FROM projects p
     ${workspaceId !== undefined ? "WHERE p.workspace_id = ?" : ""}
     ORDER BY p.created_at, p.id`;
  return (
    workspaceId !== undefined
      ? db.prepare(sql).all(workspaceId)
      : db.prepare(sql).all()
  ) as Array<ProjectRow & { target_count: number }>;
}

/**
 * Task counts by canonical state for one project (the srs 4.1.1
 * `nova project status` shape).
 */
export function projectTaskCounts(db: Db, projectId: string): Record<string, number> {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state")
    .all(projectId) as Array<{ state: string; n: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = row.n;
  return counts;
}

/**
 * FR-PRJ-02: set the free-text phase label and append the audit row
 * (migration 0002's `project_phase_logs`) for every CHANGE, carrying
 * the triggering identity. An identical label is not a change.
 */
export function setProjectPhase(
  db: Db,
  projectId: string,
  phase: string,
  actor: string,
): { changed: boolean; from_phase: string; to_phase: string } {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`no such project: ${projectId}`);
  if (project.phase === phase) {
    return { changed: false, from_phase: phase, to_phase: phase };
  }
  db.transaction((): void => {
    db.prepare("UPDATE projects SET phase = ?, updated_at = ? WHERE id = ?").run(
      phase,
      new Date().toISOString(),
      projectId,
    );
    db.prepare(
      `INSERT INTO project_phase_logs (id, project_id, from_phase, to_phase, actor)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ulid(), projectId, project.phase, phase, actor);
  })();
  return { changed: true, from_phase: project.phase, to_phase: phase };
}
