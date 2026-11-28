/**
 * `.novaflow/` workspace layout, config, and context resolution
 * (`novaflow-v100/architecture` §3, §5).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { NovaError, toNovaError } from './errors.js';
import { isUlid, ulid } from './id.js';
import { openDatabase } from './db.js';
import {
  lookupWorkspace,
  readRegistry,
  registerWorkspace,
  registryFilePath,
  type Env,
} from './registry.js';

export const NOVAFLOW_DIR = '.novaflow';
export const CONFIG_FILENAME = 'config.yaml';
export const DB_FILENAME = 'state.db';
export const GITIGNORE_FILENAME = '.gitignore';

/** Exact contents of `.novaflow/.gitignore` from `novaflow-v100/architecture` §3.1. */
export const NOVAFLOW_GITIGNORE = [
  '# NovaFlow runtime state (keep config.yaml inspectable; ignore local DB & locks)',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  '*.lock',
  '*.tmp',
  '',
].join('\n');

/** Line appended to a repository root `.gitignore` by `workspace create --gitignore`. */
export const ROOT_GITIGNORE_ENTRY = '.novaflow/';

/** Project/workspace name shape: lowercase kebab-case, max 64 characters. */
export const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Reserved keys of `.novaflow/config.yaml`; anything else is rejected. */
const CONFIG_KEYS = ['schema_version', 'workspace_id', 'name', 'created_at', 'defaults'] as const;
const DEFAULTS_KEYS = ['project'] as const;

export interface WorkspaceDefaults {
  /** Default project slug, or null when unset. */
  project: string | null;
}

export interface WorkspaceConfig {
  schema_version: 1;
  /** 26-character ULID, immutable for the life of the workspace. */
  workspace_id: string;
  /** Lowercase kebab-case workspace name, also the registry key. */
  name: string;
  /** ISO-8601 UTC creation timestamp. */
  created_at: string;
  defaults: WorkspaceDefaults;
}

export interface WorkspacePaths {
  /** `<root>/.novaflow` */
  dir: string;
  /** `<root>/.novaflow/config.yaml` */
  configPath: string;
  /** `<root>/.novaflow/state.db` */
  dbPath: string;
  /** `<root>/.novaflow/.gitignore` */
  gitignorePath: string;
}

/** Absolute `.novaflow/` paths for a workspace root. */
export function workspacePaths(root: string): WorkspacePaths {
  const dir = join(resolve(root), NOVAFLOW_DIR);
  return {
    dir,
    configPath: join(dir, CONFIG_FILENAME),
    dbPath: join(dir, DB_FILENAME),
    gitignorePath: join(dir, GITIGNORE_FILENAME),
  };
}

/** True when `root` holds a `.novaflow/config.yaml`. */
export function isWorkspaceRoot(root: string): boolean {
  return existsSync(workspacePaths(root).configPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function configError(source: string, detail: string): NovaError {
  return new NovaError('VALIDATION_ERROR', `${source}: ${detail}`, {
    hint: 'Expected schema_version: 1, workspace_id (ULID), name, created_at (ISO-8601 UTC), defaults.project (slug or null). Regenerate with "novaflow workspace create".',
  });
}

function validateConfig(raw: unknown, source: string): WorkspaceConfig {
  if (!isRecord(raw)) throw configError(source, 'must be a YAML mapping.');

  for (const key of Object.keys(raw)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw configError(source, `unknown key "${key}".`);
  }
  for (const key of CONFIG_KEYS) {
    if (!(key in raw)) throw configError(source, `missing required key "${key}".`);
  }

  if (raw.schema_version !== 1) {
    throw configError(source, `unsupported schema_version ${JSON.stringify(raw.schema_version)} (this binary supports 1).`);
  }
  if (typeof raw.workspace_id !== 'string' || !isUlid(raw.workspace_id)) {
    throw configError(source, 'workspace_id must be a 26-character ULID.');
  }
  if (typeof raw.name !== 'string' || !WORKSPACE_NAME_PATTERN.test(raw.name)) {
    throw configError(source, 'name must be lowercase kebab-case (^[a-z][a-z0-9-]{0,63}$).');
  }
  if (typeof raw.created_at !== 'string' || !isIsoTimestamp(raw.created_at)) {
    throw configError(source, 'created_at must be an ISO-8601 UTC timestamp.');
  }
  if (!isRecord(raw.defaults)) throw configError(source, 'defaults must be a mapping with a "project" key.');
  for (const key of Object.keys(raw.defaults)) {
    if (!(DEFAULTS_KEYS as readonly string[]).includes(key)) throw configError(source, `unknown key "defaults.${key}".`);
  }
  if (!('project' in raw.defaults)) throw configError(source, 'missing required key "defaults.project".');
  const project = raw.defaults.project;
  if (project !== null && (typeof project !== 'string' || !WORKSPACE_NAME_PATTERN.test(project))) {
    throw configError(source, 'defaults.project must be a lowercase slug or null.');
  }

  return {
    schema_version: 1,
    workspace_id: raw.workspace_id,
    name: raw.name,
    created_at: raw.created_at,
    defaults: { project },
  };
}

/** Parses and strictly validates `config.yaml` text. */
export function parseWorkspaceConfig(text: string, source = CONFIG_FILENAME): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw configError(source, `invalid YAML (${error instanceof Error ? error.message : String(error)}).`);
  }
  return validateConfig(raw, source);
}

/** Reads and validates `<root>/.novaflow/config.yaml`; missing workspace is exit 4. */
export function readWorkspaceConfig(root: string): WorkspaceConfig {
  const { configPath } = workspacePaths(root);
  if (!existsSync(configPath)) {
    throw new NovaError('WORKSPACE_NOT_FOUND', `No NovaFlow workspace at ${resolve(root)} (missing ${configPath}).`, {
      hint: 'Create one with "novaflow workspace create --name <name>", or list registered workspaces with "novaflow workspace list".',
    });
  }
  try {
    return parseWorkspaceConfig(readFileSync(configPath, 'utf8'), configPath);
  } catch (error) {
    if (error instanceof NovaError) throw error;
    throw toNovaError(error, `Unable to read ${configPath}.`);
  }
}

/** Serializes a validated config to `<root>/.novaflow/config.yaml`. */
export function writeWorkspaceConfig(root: string, config: WorkspaceConfig): string {
  const validated = validateConfig(config, CONFIG_FILENAME);
  const { dir, configPath } = workspacePaths(root);
  const body = stringifyYaml({
    schema_version: validated.schema_version,
    workspace_id: validated.workspace_id,
    name: validated.name,
    created_at: validated.created_at,
    defaults: { project: validated.defaults.project },
  });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, body, 'utf8');
    return configPath;
  } catch (error) {
    throw toNovaError(error, `Unable to write ${configPath}.`);
  }
}

/** Creates `.novaflow/.gitignore` when absent; returns true when it wrote the file. */
export function ensureWorkspaceGitignore(root: string): boolean {
  const { dir, gitignorePath } = workspacePaths(root);
  if (existsSync(gitignorePath)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(gitignorePath, NOVAFLOW_GITIGNORE, 'utf8');
    return true;
  } catch (error) {
    throw toNovaError(error, `Unable to write ${gitignorePath}.`);
  }
}

/** Nearest ancestor of `start` containing `.git` (directory or worktree file), or null. */
export function gitRootFor(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Appends `.novaflow/` to the nearest repository root `.gitignore`.
 *
 * Idempotent: the exact line is added at most once, existing lines are kept.
 * Outside a git repository this fails with `VALIDATION_ERROR` (exit 2).
 */
export function ensureRootGitignore(workspaceRoot: string): { root: string; changed: boolean } {
  const root = gitRootFor(workspaceRoot);
  if (root === null) {
    throw new NovaError('VALIDATION_ERROR', `${resolve(workspaceRoot)} is not inside a git repository.`, {
      hint: 'Run "git init" in the repository root, or omit --gitignore.',
    });
  }

  const file = join(root, '.gitignore');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const alreadyListed = existing.split('\n').some((line) => line.trim() === ROOT_GITIGNORE_ENTRY);
  if (alreadyListed) return { root, changed: false };

  const next =
    existing === ''
      ? `${ROOT_GITIGNORE_ENTRY}\n`
      : existing.endsWith('\n')
        ? `${existing}${ROOT_GITIGNORE_ENTRY}\n`
        : `${existing}\n${ROOT_GITIGNORE_ENTRY}\n`;
  try {
    writeFileSync(file, next, 'utf8');
    return { root, changed: true };
  } catch (error) {
    throw toNovaError(error, `Unable to update ${file}.`);
  }
}

/** Derives a workspace name from a directory basename. */
export function slugifyName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (WORKSPACE_NAME_PATTERN.test(slug)) return slug;
  const prefixed = `ws-${slug}`.replace(/-+$/g, '').slice(0, 64);
  return WORKSPACE_NAME_PATTERN.test(prefixed) ? prefixed : 'workspace';
}

export interface CreateWorkspaceInput {
  /** Directory that will contain `.novaflow/`. */
  root: string;
  /** Defaults to the slugified directory basename. */
  name?: string;
  /** Append `.novaflow/` to the nearest git root's `.gitignore`. */
  gitignore?: boolean;
  env?: Env;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface CreatedWorkspace extends WorkspacePaths {
  root: string;
  config: WorkspaceConfig;
  /** Path of the global registry file this workspace was added to. */
  registryPath: string;
}

/**
 * Creates `<root>/.novaflow/` (config, `.gitignore`, migrated `state.db`) and
 * registers the workspace. Fails before writing when preconditions are unmet.
 */
export function createWorkspace(input: CreateWorkspaceInput): CreatedWorkspace {
  const root = resolve(input.root);
  const paths = workspacePaths(root);
  const env = input.env ?? process.env;

  if (existsSync(paths.dir)) {
    throw new NovaError('STATE_CONFLICT', `A NovaFlow workspace already exists at ${paths.dir}.`, {
      hint: 'Register it with "novaflow workspace register", or pick another --path.',
    });
  }

  const name = input.name ?? slugifyName(basename(root));
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new NovaError('VALIDATION_ERROR', `Invalid workspace name "${name}".`, {
      hint: 'Use lowercase kebab-case: ^[a-z][a-z0-9-]{0,63}$.',
    });
  }

  const registered = lookupWorkspace(name, env);
  if (registered !== undefined && resolve(registered.path) !== root) {
    throw new NovaError('STATE_CONFLICT', `Workspace name "${name}" is already registered to ${registered.path}.`, {
      hint: 'Pick another --name, or unregister the existing workspace first.',
    });
  }

  // Validate the git precondition before creating any file.
  const hasGitRoot = input.gitignore === true ? gitRootFor(root) !== null : false;
  if (input.gitignore === true && !hasGitRoot) {
    throw new NovaError('VALIDATION_ERROR', `${root} is not inside a git repository.`, {
      hint: 'Run "git init" in the repository root, or omit --gitignore.',
    });
  }

  const timestamp = (input.now ?? (() => new Date()))();
  const config: WorkspaceConfig = {
    schema_version: 1,
    workspace_id: ulid(timestamp.getTime()),
    name,
    created_at: timestamp.toISOString(),
    defaults: { project: null },
  };

  try {
    mkdirSync(paths.dir, { recursive: true });
    writeWorkspaceConfig(root, config);
    ensureWorkspaceGitignore(root);
    const db = openDatabase(paths.dbPath);
    db.close();
    if (input.gitignore === true) ensureRootGitignore(root);
    registerWorkspace(name, root, env);
  } catch (error) {
    rmSync(paths.dir, { recursive: true, force: true });
    throw error;
  }

  return { root, config, ...paths, registryPath: registryFilePath(env) };
}

/** Workspace resolution source, in precedence order. */
export type WorkspaceSource = 'flag' | 'env' | 'walkup' | 'default';

export interface ResolvedWorkspace {
  name: string;
  /** Absolute workspace root (the directory containing `.novaflow/`). */
  root: string;
  dir: string;
  configPath: string;
  config: WorkspaceConfig;
  source: WorkspaceSource;
}

export interface ResolveWorkspaceOptions {
  cwd?: string;
  env?: Env;
  /** Value of `--workspace` / `-w`, when supplied. */
  workspace?: string;
}

/** Nearest ancestor of `start` holding `.novaflow/config.yaml`, or null. */
export function findWorkspaceRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (isWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function workspaceNotFound(message: string): NovaError {
  return new NovaError('WORKSPACE_NOT_FOUND', message, {
    hint: 'Create one with "novaflow workspace create --name <name>", or list registered workspaces with "novaflow workspace list".',
  });
}

function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.startsWith('.') || value.startsWith('~');
}

function expandHome(value: string, env: Env): string {
  if (value === '~') return env.HOME ?? value;
  if (value.startsWith('~/')) return join(env.HOME ?? '~', value.slice(2));
  return value;
}

function loadWorkspace(root: string, source: WorkspaceSource): ResolvedWorkspace {
  const absolute = resolve(root);
  const config = readWorkspaceConfig(absolute);
  const paths = workspacePaths(absolute);
  return {
    name: config.name,
    root: absolute,
    dir: paths.dir,
    configPath: paths.configPath,
    config,
    source,
  };
}

function resolveNameOrPath(value: string, cwd: string, env: Env, source: WorkspaceSource): ResolvedWorkspace {
  const candidate = value.trim();
  if (candidate === '') throw workspaceNotFound('Workspace name is empty.');

  if (isPathLike(candidate)) {
    return loadWorkspace(resolve(cwd, expandHome(candidate, env)), source);
  }

  const registered = lookupWorkspace(candidate, env);
  if (registered !== undefined) return loadWorkspace(resolve(registered.path), source);

  const local = resolve(cwd, candidate);
  if (isWorkspaceRoot(local)) return loadWorkspace(local, source);

  throw workspaceNotFound(`Workspace "${candidate}" is not registered and has no .novaflow/ config.`);
}

/**
 * Resolves the target workspace in strict precedence order:
 * `--workspace` > `NOVAFLOW_WORKSPACE` > nearest walk-up `config.yaml` >
 * `default_workspace` > `WORKSPACE_NOT_FOUND` (exit 4).
 */
export function resolveWorkspace(options: ResolveWorkspaceOptions = {}): ResolvedWorkspace {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;

  if (options.workspace !== undefined && options.workspace.trim() !== '') {
    return resolveNameOrPath(options.workspace, cwd, env, 'flag');
  }

  const fromEnv = env.NOVAFLOW_WORKSPACE;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return resolveNameOrPath(fromEnv, cwd, env, 'env');
  }

  const walked = findWorkspaceRoot(cwd);
  if (walked !== null) return loadWorkspace(walked, 'walkup');

  const registry = readRegistry(env);
  const defaultName = registry.default_workspace;
  if (defaultName !== null) {
    const entry = registry.workspaces[defaultName];
    if (entry !== undefined) return loadWorkspace(resolve(entry.path), 'default');
    throw workspaceNotFound(`Default workspace "${defaultName}" is no longer registered.`);
  }

  throw workspaceNotFound(`No NovaFlow workspace found from ${cwd}.`);
}
