/**
 * Workspace service: creation, registry listing, metadata updates, the status
 * board, and the portable export (`novaflow-v100/cli` §3.1, §3.5).
 *
 * Workspace metadata lives in `.novaflow/config.yaml`; `workspaces.json` is only
 * a name -> path index (`novaflow-v100/architecture` §3.2, §4). A rename writes
 * both, and the config write is reverted if the registry write fails.
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../store/db.js';
import { ulid } from '../store/id.js';
import {
  lookupWorkspace,
  readRegistry,
  registerWorkspace as registerWorkspaceInIndex,
  registryFilePath,
  setDefaultWorkspace,
  unregisterWorkspace as unregisterWorkspaceFromIndex,
  writeRegistry,
  type Env,
} from '../store/registry.js';
import {
  WORKSPACE_NAME_PATTERN,
  createWorkspace as createWorkspaceOnDisk,
  findWorkspaceRoot,
  gitRootFor,
  readWorkspaceConfig,
  resolveWorkspace,
  slugifyName,
  workspacePaths,
  writeWorkspaceConfig,
  type ResolvedWorkspace,
  type WorkspaceConfig,
} from '../store/workspace.js';
import { appendEventWithSeq, listEvents } from './events.js';
import { conflictError, notFoundError, validationError } from './errors.js';
import { listProjectRows, statusCounts, type StatusCounts } from './model.js';
import { listProjects, projectView, resolveProjectRef, type ProjectView } from './project.js';
import { listTasks, type TaskView } from './task.js';
import type { EventView } from './events.js';
import type { ArtifactKind } from './model.js';

/** Workspace-scoped options shared by every command (`novaflow-v100/cli` §2). */
export interface WorkspaceOptions {
  /** `--workspace <name|path>`; overrides env, walk-up, and registry default. */
  workspace?: string | null | undefined;
  cwd?: string | undefined;
  env?: Env | undefined;
}

/** Metadata view of one workspace. */
export interface WorkspaceView {
  name: string;
  /** Directory containing `.novaflow/`. */
  root: string;
  /** `<root>/.novaflow`. */
  path: string;
  workspace_id: string;
  created_at: string;
  defaults: { project: string | null };
}

export interface WorkspaceConnection {
  resolved: ResolvedWorkspace;
  db: DatabaseSync;
  close(): void;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function workspaceView(resolved: ResolvedWorkspace): WorkspaceView {
  return {
    name: resolved.config.name,
    root: resolved.root,
    path: resolved.dir,
    workspace_id: resolved.config.workspace_id,
    created_at: resolved.config.created_at,
    defaults: { project: resolved.config.defaults.project },
  };
}

function resolveWorkspaceFor(options: WorkspaceOptions): ResolvedWorkspace {
  const workspace = options.workspace ?? undefined;
  return resolveWorkspace({
    ...(workspace === undefined ? {} : { workspace }),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
}

/** Resolves the workspace and opens its database (`novaflow-v100/architecture` §5.1). */
export function openWorkspaceConnection(options: WorkspaceOptions = {}): WorkspaceConnection {
  const resolved = resolveWorkspaceFor(options);
  const db = openDatabase(workspacePaths(resolved.root).dbPath);
  return { resolved, db, close: () => db.close() };
}

function assertWorkspaceName(name: string): string {
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw validationError(`Invalid workspace name ${JSON.stringify(name)}.`, 'Use lowercase kebab-case: ^[a-z][a-z0-9-]{0,63}$.');
  }
  return name;
}

export interface CreateWorkspaceInput {
  name?: string | null | undefined;
  /** Directory that will contain `.novaflow/`; defaults to `cwd`. */
  path?: string | null | undefined;
  gitignore?: boolean | undefined;
  set_default?: boolean | undefined;
  cwd?: string | undefined;
  env?: Env | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

export interface CreateWorkspaceResult {
  workspace: WorkspaceView;
  registry_path: string;
  dry_run: boolean;
}

/**
 * Plans the workspace without writing anything, so `--dry-run` can report the
 * exact conflict a real run would hit (`novaflow-v100/cli` §3.1).
 */
function planWorkspace(input: CreateWorkspaceInput, env: Env, now: Date): { root: string; name: string; config: WorkspaceConfig } {
  const root = resolve(input.cwd ?? process.cwd(), nonEmpty(input.path) ?? '.');
  const paths = workspacePaths(root);

  if (existsSync(paths.dir)) {
    throw conflictError(`A NovaFlow workspace already exists at ${paths.dir}.`, 'Register it with "novaflow workspace register", or pick another --path.');
  }

  const name = assertWorkspaceName(nonEmpty(input.name) ?? slugifyName(basename(root)));
  const registered = lookupWorkspace(name, env);
  if (registered !== undefined && resolve(registered.path) !== root) {
    throw conflictError(`Workspace name "${name}" is already registered to ${registered.path}.`, 'Pick another --name, or unregister the existing workspace first.');
  }
  if (input.gitignore === true && gitRootFor(root) === null) {
    throw validationError(`${root} is not inside a git repository.`, 'Run "git init" in the repository root, or omit --gitignore.');
  }

  return {
    root,
    name,
    config: {
      schema_version: 1,
      workspace_id: ulid(now.getTime()),
      name,
      created_at: now.toISOString(),
      defaults: { project: null },
    },
  };
}

/** `workspace create`: scaffold `.novaflow/`, register it, emit `workspace.created`. */
export function createWorkspace(input: CreateWorkspaceInput = {}): CreateWorkspaceResult {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const planned = planWorkspace(input, env, now);
  const registryPath = registryFilePath(env);

  if (input.dry_run === true) {
    return {
      workspace: {
        name: planned.name,
        root: planned.root,
        path: workspacePaths(planned.root).dir,
        workspace_id: planned.config.workspace_id,
        created_at: planned.config.created_at,
        defaults: { project: null },
      },
      registry_path: registryPath,
      dry_run: true,
    };
  }

  const created = createWorkspaceOnDisk({
    root: planned.root,
    name: planned.name,
    ...(input.gitignore === true ? { gitignore: true } : {}),
    env,
    now: () => now,
  });

  const connection = openWorkspaceConnection({ workspace: created.root, env, cwd: created.root });
  try {
    appendEventWithSeq(connection.db, {
      entity_type: 'workspace',
      entity_id: created.config.workspace_id,
      entity_key: created.config.name,
      event_type: 'workspace.created',
      to_state: created.config.name,
      payload: { name: created.config.name, root: created.root },
      now,
    });
  } finally {
    connection.close();
  }

  if (input.set_default === true) setDefaultWorkspace(created.config.name, env);

  return {
    workspace: {
      name: created.config.name,
      root: created.root,
      path: created.dir,
      workspace_id: created.config.workspace_id,
      created_at: created.config.created_at,
      defaults: { project: created.config.defaults.project },
    },
    registry_path: registryPath,
    dry_run: false,
  };
}

export interface WorkspaceListing {
  name: string;
  root: string;
  path: string;
  registered_at: string;
  /** True when `<root>/.novaflow/config.yaml` still exists. */
  exists: boolean;
  /** True when the config parses; false for a missing or corrupt config. */
  config_ok: boolean;
  is_default: boolean;
  is_active: boolean;
  workspace_id: string | null;
  created_at: string | null;
  defaults: { project: string | null } | null;
}

export interface ListWorkspacesResult {
  workspaces: WorkspaceListing[];
  default_workspace: string | null;
  /** Workspace discovered by walking up from `cwd`, if any. */
  active: string | null;
  registry_path: string;
}

/** `workspace list`: every registered workspace plus the one active from `cwd`. */
export function listWorkspaces(options: { env?: Env | undefined; cwd?: string | undefined } = {}): ListWorkspacesResult {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const registry = readRegistry(env);

  const activeRoot = findWorkspaceRoot(cwd);
  const active = activeRoot === null ? null : readWorkspaceConfigSafe(activeRoot);

  const listings: WorkspaceListing[] = Object.entries(registry.workspaces)
    .map(([name, entry]) => {
      const root = resolve(entry.path);
      const paths = workspacePaths(root);
      const config = existsSync(paths.configPath) ? readWorkspaceConfigSafe(root) : null;
      return {
        name,
        root,
        path: paths.dir,
        registered_at: entry.registered_at,
        exists: existsSync(paths.configPath),
        config_ok: config !== null,
        is_default: registry.default_workspace === name,
        is_active: activeRoot !== null && resolve(activeRoot) === root,
        workspace_id: config?.workspace_id ?? null,
        created_at: config?.created_at ?? null,
        defaults: config === null ? null : { project: config.defaults.project },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    workspaces: listings,
    default_workspace: registry.default_workspace,
    active: active?.name ?? null,
    registry_path: registryFilePath(env),
  };
}

function readWorkspaceConfigSafe(root: string): WorkspaceConfig | null {
  try {
    return readWorkspaceConfig(root);
  } catch {
    return null;
  }
}

export interface ShowWorkspaceInput extends WorkspaceOptions {
  now?: Date | undefined;
}

export interface ShowWorkspaceResult extends WorkspaceView {
  source: ResolvedWorkspace['source'];
  projects: { active: number; paused: number; archived: number; total: number };
  tasks: StatusCounts;
}

/** `workspace show`: metadata, path, active project count, task counts by status. */
export function showWorkspace(input: ShowWorkspaceInput = {}): ShowWorkspaceResult {
  const now = input.now ?? new Date();
  const connection = openWorkspaceConnection(input);
  try {
    const projects = listProjectRows(connection.db);
    return {
      ...workspaceView(connection.resolved),
      source: connection.resolved.source,
      projects: {
        active: projects.filter((project) => project.status === 'active').length,
        paused: projects.filter((project) => project.status === 'paused').length,
        archived: projects.filter((project) => project.status === 'archived').length,
        total: projects.length,
      },
      tasks: statusCounts(connection.db, { now }),
    };
  } finally {
    connection.close();
  }
}

export interface UpdateWorkspaceInput extends WorkspaceOptions {
  /** New workspace name; renames `config.yaml` and the registry entry together. */
  name?: string | null | undefined;
  /** Default project slug; `null` or `""` clears it. */
  default_project?: string | null | undefined;
  /** Mark this workspace as the registry default. */
  set_default?: boolean | undefined;
  now?: Date | undefined;
  dry_run?: boolean | undefined;
}

export interface UpdateWorkspaceResult {
  workspace: WorkspaceView;
  changed: string[];
  registry_path: string;
  dry_run: boolean;
}

/**
 * `workspace update`: rename, set or clear the default project, and set the
 * registry default. Both metadata homes are written or neither is.
 */
export function updateWorkspace(input: UpdateWorkspaceInput = {}): UpdateWorkspaceResult {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const resolved = resolveWorkspaceFor({ ...input, env });
  const registryPath = registryFilePath(env);
  const changed: string[] = [];

  const previousConfig = resolved.config;
  const nextConfig: WorkspaceConfig = {
    schema_version: 1,
    workspace_id: previousConfig.workspace_id,
    name: previousConfig.name,
    created_at: previousConfig.created_at,
    defaults: { project: previousConfig.defaults.project },
  };

  let nextName = previousConfig.name;
  if (input.name !== undefined) {
    const requested = assertWorkspaceName(nonEmpty(input.name) ?? '');
    if (requested !== previousConfig.name) {
      const registered = lookupWorkspace(requested, env);
      if (registered !== undefined && resolve(registered.path) !== resolved.root) {
        throw conflictError(`Workspace name "${requested}" is already registered to ${registered.path}.`, 'Pick another --name, or unregister the existing workspace first.');
      }
      nextName = requested;
      nextConfig.name = requested;
      changed.push('name');
    }
  }

  if (input.default_project !== undefined) {
    const requested = nonEmpty(input.default_project);
    let projectSlug: string | null = null;
    if (requested !== null) {
      const connection = openWorkspaceConnection({ workspace: resolved.root, env, cwd: resolved.root });
      try {
        const project = resolveProjectRef(connection.db, { project: requested, env: {}, config: null });
        if (project === null) {
          throw notFoundError(`Project ${JSON.stringify(requested)} does not exist.`, 'List projects with "novaflow project list".');
        }
        projectSlug = project.slug;
      } finally {
        connection.close();
      }
    }
    if (projectSlug !== previousConfig.defaults.project) {
      nextConfig.defaults = { project: projectSlug };
      changed.push('default_project');
    }
  }

  const registry = readRegistry(env);
  const setDefaultNow = input.set_default === true && registry.default_workspace !== nextName;
  if (setDefaultNow) changed.push('set_default');

  if (changed.length === 0) {
    return { workspace: workspaceView(resolved), changed: [], registry_path: registryPath, dry_run: input.dry_run === true };
  }

  const plannedView: WorkspaceView = {
    ...workspaceView(resolved),
    name: nextName,
    defaults: { project: nextConfig.defaults.project },
  };
  if (input.dry_run === true) {
    return { workspace: plannedView, changed, registry_path: registryPath, dry_run: true };
  }

  const configWritten = changed.includes('name') || changed.includes('default_project');
  try {
    if (configWritten) writeWorkspaceConfig(resolved.root, nextConfig);

    if (changed.includes('name')) {
      const entry = registry.workspaces[previousConfig.name];
      if (entry !== undefined) delete registry.workspaces[previousConfig.name];
      registry.workspaces[nextName] = { path: resolved.root, registered_at: now.toISOString() };
      if (registry.default_workspace === previousConfig.name) registry.default_workspace = nextName;
    }
    if (input.set_default === true) registry.default_workspace = nextName;
    writeRegistry(registry, env);
  } catch (error) {
    if (configWritten) {
      try {
        writeWorkspaceConfig(resolved.root, previousConfig);
      } catch {
        // Best effort: the registry error is the one the caller must see.
      }
    }
    throw error;
  }

  const paths = workspacePaths(resolved.root);
  if (existsSync(paths.dbPath)) {
    const connection = openWorkspaceConnection({ workspace: resolved.root, env, cwd: resolved.root });
    try {
      appendEventWithSeq(connection.db, {
        entity_type: 'workspace',
        entity_id: nextConfig.workspace_id,
        entity_key: nextName,
        event_type: 'workspace.updated',
        from_state: previousConfig.name,
        to_state: nextName,
        payload: { changed, defaults: nextConfig.defaults, set_default: setDefaultNow },
        now,
      });
    } finally {
      connection.close();
    }
  }

  return { workspace: plannedView, changed, registry_path: registryPath, dry_run: false };
}

export interface RegisterWorkspaceInput {
  name?: string | null | undefined;
  path: string;
  cwd?: string | undefined;
  env?: Env | undefined;
  now?: Date | undefined;
}

export interface RegisterWorkspaceResult {
  name: string;
  root: string;
  registry_path: string;
  registered_at: string;
}

/** `workspace register`: adds an existing `.novaflow/` to the global index. */
export function registerWorkspace(input: RegisterWorkspaceInput): RegisterWorkspaceResult {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const root = resolve(input.cwd ?? process.cwd(), input.path);
  const config = readWorkspaceConfig(root);
  const name = assertWorkspaceName(nonEmpty(input.name) ?? config.name);

  if (name !== config.name) {
    throw validationError(
      `Workspace at ${root} is named "${config.name}", not "${name}".`,
      'Register with the name recorded in .novaflow/config.yaml, or edit it with "novaflow workspace update --name".',
    );
  }

  const registered = lookupWorkspace(name, env);
  if (registered !== undefined && resolve(registered.path) !== root) {
    throw conflictError(`Workspace name "${name}" is already registered to ${registered.path}.`, 'Unregister the existing workspace first.');
  }

  registerWorkspaceInIndex(name, root, env);

  return { name, root, registry_path: registryFilePath(env), registered_at: now.toISOString() };
}

export interface UnregisterWorkspaceInput {
  name: string;
  env?: Env | undefined;
}

export interface UnregisterWorkspaceResult {
  name: string;
  removed: boolean;
  registry_path: string;
}

/** `workspace unregister`: drops the registry entry, never the directory. */
export function unregisterWorkspace(input: UnregisterWorkspaceInput): UnregisterWorkspaceResult {
  const env = input.env ?? process.env;
  const registry = readRegistry(env);
  if (!(input.name in registry.workspaces)) {
    throw notFoundError(`Workspace "${input.name}" is not registered.`, 'List registered workspaces with "novaflow workspace list".');
  }
  unregisterWorkspaceFromIndex(input.name, env);
  return { name: input.name, removed: true, registry_path: registryFilePath(env) };
}

export interface OverviewStatusInput extends WorkspaceOptions {
  /** Explicit project filter only; omitted means the whole workspace. */
  project?: string | null | undefined;
  now?: Date | undefined;
}

export interface OverviewStatusResult {
  workspace: { name: string; root: string };
  project: { slug: string; prefix: string; title: string } | null;
  counts: StatusCounts;
  in_progress: TaskView[];
  ready: TaskView[];
  blocked: TaskView[];
  recent_events: EventView[];
}

/** `status`: compact board summary for the resolved workspace (`novaflow-v100/cli` §3.5). */
export function getOverviewStatus(input: OverviewStatusInput = {}): OverviewStatusResult {
  const now = input.now ?? new Date();
  const connection = openWorkspaceConnection(input);
  try {
    const project =
      nonEmpty(input.project) === null
        ? null
        : resolveProjectRef(connection.db, { project: input.project, env: {}, config: null });
    const projectId = project?.id ?? null;

    return {
      workspace: { name: connection.resolved.config.name, root: connection.resolved.root },
      project: project === null ? null : { slug: project.slug, prefix: project.prefix, title: project.title },
      counts: statusCounts(connection.db, { project_id: projectId, now }),
      in_progress: listTasks(connection.db, { project: project?.slug ?? null, status: ['in_progress'], now }),
      ready: listTasks(connection.db, { project: project?.slug ?? null, ready: true, now }),
      blocked: listTasks(connection.db, { project: project?.slug ?? null, status: ['blocked'], now }),
      recent_events: listEvents(connection.db, { project_id: projectId, limit: 20, now }),
    };
  } finally {
    connection.close();
  }
}

export interface ExportWorkspaceInput extends WorkspaceOptions {
  /** Explicit project filter only; omitted exports the whole workspace. */
  project?: string | null | undefined;
  now?: Date | undefined;
}

export interface ExportSnapshot {
  export_version: 1;
  exported_at: string;
  workspace: {
    name: string;
    workspace_id: string;
    root: string;
    created_at: string;
    defaults: { project: string | null };
  };
  projects: ProjectView[];
  tasks: TaskView[];
  deps: Array<{ task: string; depends_on: string; created_at: string }>;
  notes: Array<{ id: string; task: string; author: string | null; body: string; created_at: string }>;
  artifacts: Array<{ id: string; task: string; uri: string; label: string | null; kind: ArtifactKind; created_at: string }>;
  events: EventView[];
}

/** `export`: portable JSON snapshot of projects, tasks, deps, notes, artifacts. */
export function exportWorkspace(input: ExportWorkspaceInput = {}): ExportSnapshot {
  const now = input.now ?? new Date();
  const connection = openWorkspaceConnection(input);
  try {
    const project =
      nonEmpty(input.project) === null
        ? null
        : resolveProjectRef(connection.db, { project: input.project, env: {}, config: null });
    const projectId = project?.id ?? null;

    const projects =
      project === null
        ? listProjects(connection.db, { status: 'all', now })
        : [projectView(connection.db, project, now)];
    const tasks = listTasks(connection.db, { project: project?.slug ?? null, now });

    const depRows = (
      projectId === null
        ? connection.db
            .prepare(
              `SELECT t.key AS task, d.key AS depends_on, td.created_at AS created_at
                 FROM task_deps td
                 JOIN tasks t ON t.id = td.task_id
                 JOIN tasks d ON d.id = td.depends_on
                ORDER BY t.key, d.key`,
            )
            .all()
        : connection.db
            .prepare(
              `SELECT t.key AS task, d.key AS depends_on, td.created_at AS created_at
                 FROM task_deps td
                 JOIN tasks t ON t.id = td.task_id
                 JOIN tasks d ON d.id = td.depends_on
                WHERE t.project_id = ?
                ORDER BY t.key, d.key`,
            )
            .all(projectId)
    ) as unknown as Array<{ task: string; depends_on: string; created_at: string }>;

    const noteRows = (
      projectId === null
        ? connection.db
            .prepare(
              `SELECT n.id AS id, t.key AS task, n.author AS author, n.body AS body, n.created_at AS created_at
                 FROM task_notes n JOIN tasks t ON t.id = n.task_id
                ORDER BY n.created_at, n.id`,
            )
            .all()
        : connection.db
            .prepare(
              `SELECT n.id AS id, t.key AS task, n.author AS author, n.body AS body, n.created_at AS created_at
                 FROM task_notes n JOIN tasks t ON t.id = n.task_id
                WHERE t.project_id = ?
                ORDER BY n.created_at, n.id`,
            )
            .all(projectId)
    ) as unknown as ExportSnapshot['notes'];

    const artifactRows = (
      projectId === null
        ? connection.db
            .prepare(
              `SELECT a.id AS id, t.key AS task, a.uri AS uri, a.label AS label, a.kind AS kind, a.created_at AS created_at
                 FROM task_artifacts a JOIN tasks t ON t.id = a.task_id
                ORDER BY a.created_at, a.id`,
            )
            .all()
        : connection.db
            .prepare(
              `SELECT a.id AS id, t.key AS task, a.uri AS uri, a.label AS label, a.kind AS kind, a.created_at AS created_at
                 FROM task_artifacts a JOIN tasks t ON t.id = a.task_id
                WHERE t.project_id = ?
                ORDER BY a.created_at, a.id`,
            )
            .all(projectId)
    ) as unknown as ExportSnapshot['artifacts'];

    return {
      export_version: 1,
      exported_at: now.toISOString(),
      workspace: {
        name: connection.resolved.config.name,
        workspace_id: connection.resolved.config.workspace_id,
        root: connection.resolved.root,
        created_at: connection.resolved.config.created_at,
        defaults: { project: connection.resolved.config.defaults.project },
      },
      projects,
      tasks,
      // Rebuilt as plain objects: raw node:sqlite rows carry a null prototype.
      deps: depRows.map((row) => ({ task: row.task, depends_on: row.depends_on, created_at: row.created_at })),
      notes: noteRows.map((row) => ({
        id: row.id,
        task: row.task,
        author: row.author,
        body: row.body,
        created_at: row.created_at,
      })),
      artifacts: artifactRows.map((row) => ({
        id: row.id,
        task: row.task,
        uri: row.uri,
        label: row.label,
        kind: row.kind,
        created_at: row.created_at,
      })),
      events: listEvents(connection.db, { project_id: projectId, limit: 1000, now }),
    };
  } finally {
    connection.close();
  }
}
