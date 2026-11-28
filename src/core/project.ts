/**
 * Project service (`novaflow-v100/cli` §3.2, `novaflow-v100/data` §1.1).
 *
 * Owns project creation (deterministic slug/prefix derivation), read views with
 * task counts, mutable metadata, archival, and the project half of context
 * resolution: `--project` > `NOVAFLOW_PROJECT` > `defaults.project`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '../store/id.js';
import type { Env } from '../store/registry.js';
import type { WorkspaceConfig } from '../store/workspace.js';
import { appendEventWithSeq } from './events.js';
import { conflictError, notFoundError, validationError } from './errors.js';
import { derivePrefix, deriveSlug, isValidPrefix, isValidSlug, uniqueSlug } from './ids.js';
import {
  PROJECT_STATUSES,
  findProjectByPrefix,
  findProjectBySlug,
  listProjectRows,
  normalizeTags,
  parseJsonArray,
  parseJsonObject,
  projectPrefixes,
  projectSlugs,
  readProjectRow,
  serializeMeta,
  serializeTags,
  statusCounts,
  type ProjectRow,
  type ProjectStatus,
  type StatusCounts,
} from './model.js';
import { runMutation } from './transaction.js';

/** JSON view of a project, with derived task counts. */
export interface ProjectView {
  id: string;
  slug: string;
  prefix: string;
  title: string;
  objective: string;
  repo_path: string | null;
  verify_cmd: string | null;
  status: ProjectStatus;
  tags: string[];
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  counts: StatusCounts;
}

/** Result of a mutating project operation. */
export interface ProjectMutationResult {
  project: ProjectView;
  /** Names of the fields actually written. Empty means a no-op. */
  changed: string[];
  /** `events.seq` values appended by this call, in order. */
  event_seqs: number[];
  dry_run: boolean;
}

export function projectView(db: DatabaseSync, row: ProjectRow, now: Date): ProjectView {
  return {
    id: row.id,
    slug: row.slug,
    prefix: row.prefix,
    title: row.title,
    objective: row.objective,
    repo_path: row.repo_path,
    verify_cmd: row.verify_cmd,
    status: row.status,
    tags: parseJsonArray(row.tags_json),
    meta: parseJsonObject(row.meta_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    counts: statusCounts(db, { project_id: row.id, now }),
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireTitle(value: string | null | undefined): string {
  const title = nonEmpty(value);
  if (title === null) {
    throw validationError('A project title is required.', 'Pass --title <title>.');
  }
  return title;
}

function projectStatus(value: string | null | undefined): ProjectStatus | null {
  if (value === null || value === undefined) return null;
  if (!(PROJECT_STATUSES as readonly string[]).includes(value)) {
    throw validationError(`Invalid project status ${JSON.stringify(value)}.`, `Use one of: ${PROJECT_STATUSES.join(', ')}.`);
  }
  return value as ProjectStatus;
}

export function describeAvailableProjects(db: DatabaseSync): string {
  const rows = listProjectRows(db);
  if (rows.length === 0) return 'none yet (create one with "novaflow project create --title <title>")';
  return rows.map((row) => `${row.slug} (${row.prefix})`).join(', ');
}

/**
 * Resolves a project by slug, prefix, `NOVAFLOW_PROJECT`, or workspace default.
 *
 * Returns `null` when nothing is configured; `requireProject` turns that into a
 * named exit-2 failure.
 */
export interface ProjectRefInput {
  project?: string | null | undefined;
  /** Injected environment; keeps core free of direct `process.env` reads in tests. */
  env?: Env | undefined;
  /** Workspace `config.yaml`, whose `defaults.project` is the last resort. */
  config?: WorkspaceConfig | null | undefined;
}

export function resolveProjectRef(db: DatabaseSync, input: ProjectRefInput = {}): ProjectRow | null {
  const env = input.env ?? process.env;

  const candidates: Array<{ value: string; source: 'flag' | 'env' | 'default' }> = [];
  const flag = nonEmpty(input.project);
  if (flag !== null) candidates.push({ value: flag, source: 'flag' });
  const fromEnv = nonEmpty(env.NOVAFLOW_PROJECT);
  if (fromEnv !== null) candidates.push({ value: fromEnv, source: 'env' });
  const fromConfig = nonEmpty(input.config?.defaults.project ?? null);
  if (fromConfig !== null) candidates.push({ value: fromConfig, source: 'default' });

  for (const candidate of candidates) {
    const row = findProjectBySlug(db, candidate.value.toLowerCase()) ?? findProjectByPrefix(db, candidate.value.toUpperCase());
    if (row !== undefined) return row;
    if (candidate.source === 'flag') {
      throw notFoundError(`Project ${JSON.stringify(candidate.value)} does not exist.`, `Available projects: ${describeAvailableProjects(db)}.`);
    }
  }

  return null;
}

/** Resolves a project or fails exit 2 naming the available projects. */
export function requireProject(db: DatabaseSync, input: ProjectRefInput = {}): ProjectRow {
  const row = resolveProjectRef(db, input);
  if (row === null) {
    throw validationError('No project selected.', `Pass --project <slug|prefix>, set NOVAFLOW_PROJECT, or pick one of: ${describeAvailableProjects(db)}.`);
  }
  return row;
}

export interface ListProjectsInput {
  /** Defaults to `active` (`novaflow-v100/cli` §3.2). */
  status?: ProjectStatus | 'all' | undefined;
  now?: Date | undefined;
}

/** Lists projects with derived task counts. */
export function listProjects(db: DatabaseSync, input: ListProjectsInput = {}): ProjectView[] {
  const now = input.now ?? new Date();
  const status = input.status ?? 'active';
  const rows = listProjectRows(db).filter((row) => status === 'all' || row.status === status);
  return rows.map((row) => projectView(db, row, now));
}

export interface ShowProjectInput extends ProjectRefInput {
  project: string;
  now?: Date | undefined;
}

/** Full project detail plus task counts. */
export function showProject(db: DatabaseSync, input: ShowProjectInput): ProjectView {
  const now = input.now ?? new Date();
  const row = resolveProjectRef(db, { project: input.project, env: input.env, config: input.config });
  if (row === null) {
    throw notFoundError(`Project ${JSON.stringify(input.project)} does not exist.`, `Available projects: ${describeAvailableProjects(db)}.`);
  }
  return projectView(db, row, now);
}

export interface CreateProjectInput {
  title: string;
  slug?: string | null | undefined;
  prefix?: string | null | undefined;
  objective?: string | null | undefined;
  repo_path?: string | null | undefined;
  verify_cmd?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
  meta?: Record<string, unknown> | undefined;
  status?: ProjectStatus | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/**
 * Creates a project, deriving the slug from the title and a free prefix from the
 * slug when they are omitted (`novaflow-v100/data` §1.1).
 *
 * Explicit duplicate slug or prefix is exit 3; prefix-family exhaustion is exit 2.
 */
export function createProject(db: DatabaseSync, input: CreateProjectInput): ProjectMutationResult {
  const title = requireTitle(input.title);
  const now = input.now ?? new Date();

  return runMutation(db, input.dry_run === true, (tx) => {
    const explicitSlug = nonEmpty(input.slug);
    let slug: string;
    if (explicitSlug !== null) {
      if (!isValidSlug(explicitSlug)) {
        throw validationError(`Invalid project slug ${JSON.stringify(explicitSlug)}.`, 'Use lowercase kebab-case: ^[a-z][a-z0-9-]{0,63}$.');
      }
      if (findProjectBySlug(tx, explicitSlug) !== undefined) {
        throw conflictError(`Project slug ${JSON.stringify(explicitSlug)} already exists.`, 'Pass a different --slug.');
      }
      slug = explicitSlug;
    } else {
      slug = uniqueSlug(deriveSlug(title), projectSlugs(tx));
    }

    const explicitPrefix = nonEmpty(input.prefix);
    let prefix: string;
    if (explicitPrefix !== null) {
      if (!isValidPrefix(explicitPrefix)) {
        throw validationError(`Invalid project prefix ${JSON.stringify(explicitPrefix)}.`, 'Use uppercase alphanumeric: ^[A-Z][A-Z0-9]{1,7}$.');
      }
      if (findProjectByPrefix(tx, explicitPrefix) !== undefined) {
        throw conflictError(`Project prefix ${JSON.stringify(explicitPrefix)} already exists.`, 'Pass a different --prefix.');
      }
      prefix = explicitPrefix;
    } else {
      prefix = derivePrefix(slug, projectPrefixes(tx));
    }

    const status = projectStatus(input.status ?? 'active');
    if (status === null) throw validationError('A project status is required.', 'Use one of: active, paused, archived.');

    const id = ulid(now.getTime());
    const timestamp = now.toISOString();
    tx.prepare(
      `INSERT INTO projects
         (id, slug, prefix, title, objective, repo_path, verify_cmd, status, next_seq, tags_json, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      slug,
      prefix,
      title,
      nonEmpty(input.objective) ?? '',
      nonEmpty(input.repo_path),
      nonEmpty(input.verify_cmd),
      status,
      serializeTags(normalizeTags(input.tags)),
      serializeMeta(input.meta ?? {}),
      timestamp,
      timestamp,
    );

    const event = appendEventWithSeq(tx, {
      entity_type: 'project',
      entity_id: id,
      entity_key: slug,
      event_type: 'project.created',
      from_state: null,
      to_state: status,
      payload: { slug, prefix, title, status },
      now,
    });

    return {
      project: projectView(tx, readProjectRow(tx, id), now),
      changed: ['slug', 'prefix', 'title', 'objective', 'repo_path', 'verify_cmd', 'status', 'tags'],
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface UpdateProjectInput extends ProjectRefInput {
  project: string;
  title?: string | null | undefined;
  objective?: string | null | undefined;
  repo_path?: string | null | undefined;
  verify_cmd?: string | null | undefined;
  /** Replaces the full tag list; `null` clears it. */
  tags?: readonly string[] | null | undefined;
  status?: ProjectStatus | null | undefined;
  /** Immutable once the project has tasks (exit 3). */
  prefix?: string | null | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** Updates project metadata. `null` or `""` clears a nullable text field. */
export function updateProject(db: DatabaseSync, input: UpdateProjectInput): ProjectMutationResult {
  const now = input.now ?? new Date();
  const requestedStatus = projectStatus(input.status);

  return runMutation(db, input.dry_run === true, (tx) => {
    const row = resolveProjectRef(tx, { project: input.project, env: input.env, config: input.config });
    if (row === null) {
      throw notFoundError(`Project ${JSON.stringify(input.project)} does not exist.`, `Available projects: ${describeAvailableProjects(tx)}.`);
    }

    const fields: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const values: Array<string | null> = [];

    const setText = (column: string, value: string | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
      fields[column] = { from: row[column as keyof ProjectRow], to: value };
    };

    if (input.title !== undefined) {
      const title = requireTitle(input.title);
      if (title !== row.title) setText('title', title);
    }
    if (input.objective !== undefined) {
      const objective = nonEmpty(input.objective) ?? '';
      if (objective !== row.objective) setText('objective', objective);
    }
    if (input.repo_path !== undefined) {
      const repoPath = nonEmpty(input.repo_path);
      if (repoPath !== row.repo_path) setText('repo_path', repoPath);
    }
    if (input.verify_cmd !== undefined) {
      const verifyCmd = nonEmpty(input.verify_cmd);
      if (verifyCmd !== row.verify_cmd) setText('verify_cmd', verifyCmd);
    }
    if (input.status !== undefined && requestedStatus !== null && requestedStatus !== row.status) {
      setText('status', requestedStatus);
    }
    if (input.tags !== undefined) {
      const tags = serializeTags(normalizeTags(input.tags));
      if (tags !== row.tags_json) {
        sets.push('tags_json = ?');
        values.push(tags);
        fields.tags_json = { from: parseJsonArray(row.tags_json), to: normalizeTags(input.tags) };
      }
    }
    if (input.prefix !== undefined && nonEmpty(input.prefix) !== null) {
      const prefix = nonEmpty(input.prefix) as string;
      if (prefix !== row.prefix) {
        if (!isValidPrefix(prefix)) {
          throw validationError(`Invalid project prefix ${JSON.stringify(prefix)}.`, 'Use uppercase alphanumeric: ^[A-Z][A-Z0-9]{1,7}$.');
        }
        const taskCount = Number(
          (tx.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(row.id) as { count: number | bigint }).count,
        );
        if (taskCount > 0) {
          throw conflictError(
            `Project prefix "${row.prefix}" is immutable: ${taskCount} task(s) already use keys ${row.prefix}-*.`,
            'Keep the prefix, or create a new project.',
          );
        }
        const clash = findProjectByPrefix(tx, prefix);
        if (clash !== undefined) {
          throw conflictError(`Project prefix ${JSON.stringify(prefix)} already exists.`, 'Pass a different --prefix.');
        }
        setText('prefix', prefix);
      }
    }

    const changed = Object.keys(fields);
    if (changed.length === 0) {
      return { project: projectView(tx, row, now), changed: [], event_seqs: [], dry_run: input.dry_run === true };
    }

    sets.push('updated_at = ?');
    values.push(now.toISOString());
    tx.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);

    const event = appendEventWithSeq(tx, {
      entity_type: 'project',
      entity_id: row.id,
      entity_key: row.slug,
      event_type: 'project.updated',
      from_state: row.status,
      to_state: (fields.status?.to as ProjectStatus | undefined) ?? row.status,
      payload: { fields },
      now,
    });

    return {
      project: projectView(tx, readProjectRow(tx, row.id), now),
      changed,
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}

export interface ArchiveProjectInput extends ProjectRefInput {
  project: string;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

/** `project archive`: shorthand for status `archived`, emitting `project.archived`. */
export function archiveProject(db: DatabaseSync, input: ArchiveProjectInput): ProjectMutationResult {
  const now = input.now ?? new Date();

  return runMutation(db, input.dry_run === true, (tx) => {
    const row = resolveProjectRef(tx, { project: input.project, env: input.env, config: input.config });
    if (row === null) {
      throw notFoundError(`Project ${JSON.stringify(input.project)} does not exist.`, `Available projects: ${describeAvailableProjects(tx)}.`);
    }
    if (row.status === 'archived') {
      return { project: projectView(tx, row, now), changed: [], event_seqs: [], dry_run: input.dry_run === true };
    }

    tx.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('archived', now.toISOString(), row.id);
    const event = appendEventWithSeq(tx, {
      entity_type: 'project',
      entity_id: row.id,
      entity_key: row.slug,
      event_type: 'project.archived',
      from_state: row.status,
      to_state: 'archived',
      payload: {},
      now,
    });

    return {
      project: projectView(tx, readProjectRow(tx, row.id), now),
      changed: ['status'],
      event_seqs: [event.seq],
      dry_run: input.dry_run === true,
    };
  });
}
