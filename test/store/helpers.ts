import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Isolated environment used by every store test. Never touches the real HOME or ~/.config. */
export interface Sandbox {
  /** Temporary root for everything this test creates. */
  readonly root: string;
  /** Fake XDG config home. */
  readonly xdg: string;
  /** Fake user home. */
  readonly home: string;
  /** Working directory used for resolution tests. */
  readonly cwd: string;
  /** Explicit env map; store APIs accept it instead of process.env. */
  readonly env: Record<string, string | undefined>;
  path(...segments: string[]): string;
  mkdir(...segments: string[]): string;
  dispose(): void;
}

let counter = 0;

function hasAncestorNovaflow(dir: string): boolean {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, '.novaflow', 'config.yaml'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function cleanTempBase(): string {
  const candidate = tmpdir();
  if (!hasAncestorNovaflow(candidate)) return candidate;
  try {
    accessSync('/tmp', constants.W_OK);
    if (!hasAncestorNovaflow('/tmp')) return '/tmp';
  } catch {
    // Fall back to os.tmpdir() below if /tmp is unavailable.
  }
  return candidate;
}

export function sandbox(): Sandbox {
  counter += 1;
  const root = mkdtempSync(join(cleanTempBase(), `novaflow-store-${process.pid}-${counter}-`));
  const xdg = join(root, 'xdg');
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const novaflowHome = join(root, 'novaflow-home');
  mkdirSync(xdg, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = {
    NOVAFLOW_HOME: novaflowHome,
    XDG_CONFIG_HOME: xdg,
    HOME: home,
  };
  return {
    root,
    xdg,
    home,
    cwd,
    env,
    path: (...segments: string[]) => join(root, ...segments),
    mkdir: (...segments: string[]) => {
      const target = join(root, ...segments);
      mkdirSync(target, { recursive: true });
      return target;
    },
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeText(file: string, contents: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

/** Writes a workspace scaffold with a valid config.yaml and no database (tests that need only config). */
export function seedWorkspaceConfig(
  root: string,
  name: string,
  options: { project?: string | null; workspaceId?: string } = {},
): void {
  const dir = join(root, '.novaflow');
  mkdirSync(dir, { recursive: true });
  const project = options.project === undefined ? 'null' : options.project === null ? 'null' : options.project;
  writeText(
    join(dir, 'config.yaml'),
    [
      'schema_version: 1',
      `workspace_id: ${options.workspaceId ?? '01JNABCDEFGHJKMNPQRSTVWXYZ'}`,
      `name: ${name}`,
      'created_at: 2026-11-28T03:30:00.000Z',
      'defaults:',
      `  project: ${project}`,
      '',
    ].join('\n'),
  );
  writeText(
    join(dir, '.gitignore'),
    [
      '# NovaFlow runtime state (keep config.yaml inspectable; ignore local DB & locks)',
      'state.db',
      'state.db-wal',
      'state.db-shm',
      '*.lock',
      '*.tmp',
      '',
    ].join('\n'),
  );
}
