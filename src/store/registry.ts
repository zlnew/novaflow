/**
 * Global workspace index (`novaflow-v100/architecture` §4).
 *
 * Strictly a name -> path lookup: `.novaflow/config.yaml` stays the source of
 * truth for workspace metadata. The file is optional — a missing registry only
 * disables `--workspace <name>` and `default_workspace`, never walk-up discovery.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { NovaError, toNovaError } from './errors.js';

/** Environment map; tests pass a fake one instead of mutating `process.env`. */
export type Env = Record<string, string | undefined>;

export const REGISTRY_FILENAME = 'workspaces.json';
export const REGISTRY_VERSION = 1;

export interface RegistryEntry {
  /** Absolute workspace root (the directory containing `.novaflow/`). */
  path: string;
  /** ISO-8601 UTC timestamp of the last registration. */
  registered_at: string;
}

export interface Registry {
  version: typeof REGISTRY_VERSION;
  /** Name of the workspace used when nothing else resolves, or null. */
  default_workspace: string | null;
  workspaces: Record<string, RegistryEntry>;
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function userHome(env: Env): string {
  return present(env.HOME) ? env.HOME : homedir();
}

/** `${NOVAFLOW_HOME}/workspaces.json`, else `${XDG_CONFIG_HOME:-~/.config}/novaflow/workspaces.json`. */
export function registryFilePath(env: Env = process.env): string {
  if (present(env.NOVAFLOW_HOME)) return join(env.NOVAFLOW_HOME, REGISTRY_FILENAME);
  const configHome = present(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(userHome(env), '.config');
  return join(configHome, 'novaflow', REGISTRY_FILENAME);
}

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, default_workspace: null, workspaces: {} };
}

function registryError(file: string, detail: string): NovaError {
  return new NovaError('INTERNAL_ERROR', `Workspace registry ${file} ${detail}`, {
    hint: 'Delete it to reset the index, or re-register a workspace with "novaflow workspace register".',
  });
}

function asRegistry(raw: unknown, file: string): Registry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw registryError(file, 'is not a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== REGISTRY_VERSION) {
    throw registryError(file, `has unsupported version ${String(record.version)}.`);
  }
  const defaultValue = record.default_workspace;
  if (defaultValue !== null && typeof defaultValue !== 'string') {
    throw registryError(file, 'has an invalid default_workspace.');
  }
  const entries = record.workspaces;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw registryError(file, 'has an invalid workspaces map.');
  }

  const workspaces: Record<string, RegistryEntry> = {};
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw registryError(file, `has an invalid entry for "${name}".`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== 'string' || entry.path === '') {
      throw registryError(file, `has an invalid path for "${name}".`);
    }
    if (typeof entry.registered_at !== 'string' || entry.registered_at === '') {
      throw registryError(file, `has an invalid registered_at for "${name}".`);
    }
    workspaces[name] = { path: entry.path, registered_at: entry.registered_at };
  }

  return { version: REGISTRY_VERSION, default_workspace: defaultValue, workspaces };
}

/** Reads the registry; a missing file is an empty registry, a corrupt one is exit 1. */
export function readRegistry(env: Env = process.env): Registry {
  const file = registryFilePath(env);
  if (!existsSync(file)) return emptyRegistry();
  try {
    const text = readFileSync(file, 'utf8');
    return asRegistry(JSON.parse(text), file);
  } catch (error) {
    if (error instanceof NovaError) throw error;
    if (error instanceof SyntaxError) throw registryError(file, 'is not valid JSON.');
    throw toNovaError(error, `Unable to read workspace registry ${file}.`);
  }
}

/** Writes the registry atomically: temp file in the same directory, then rename. */
export function writeRegistry(registry: Registry, env: Env = process.env): string {
  const file = registryFilePath(env);
  const directory = dirname(file);
  const temp = join(directory, `.${REGISTRY_FILENAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
    return file;
  } catch (error) {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup; the write error is what matters.
      }
    }
    throw toNovaError(error, `Unable to write workspace registry ${file}.`);
  }
}

/** Adds or re-points `name` at `root`. */
export function registerWorkspace(name: string, root: string, env: Env = process.env): Registry {
  const registry = readRegistry(env);
  registry.workspaces[name] = { path: resolve(root), registered_at: new Date().toISOString() };
  writeRegistry(registry, env);
  return registry;
}

/** Removes `name` from the index; unknown names are a no-op. */
export function unregisterWorkspace(name: string, env: Env = process.env): Registry {
  const registry = readRegistry(env);
  if (!(name in registry.workspaces)) return registry;
  delete registry.workspaces[name];
  if (registry.default_workspace === name) registry.default_workspace = null;
  writeRegistry(registry, env);
  return registry;
}

/** Sets or clears `default_workspace`. */
export function setDefaultWorkspace(name: string | null, env: Env = process.env): Registry {
  const registry = readRegistry(env);
  registry.default_workspace = name;
  writeRegistry(registry, env);
  return registry;
}

/** Looks up a registered workspace by name. */
export function lookupWorkspace(name: string, env: Env = process.env): RegistryEntry | undefined {
  return readRegistry(env).workspaces[name];
}
