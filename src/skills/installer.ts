/**
 * Skill installation engine (`novaflow-v100/skills` §3).
 *
 * One canonical directory owns the bytes; every harness gets a symlink (or a
 * copy on restricted filesystems) so all agents read the same skill version.
 * Every directory NovaFlow creates carries `.novaflow-managed.json`, which is
 * what makes re-install idempotent and uninstall surgical: anything without
 * that marker belongs to the operator and is never overwritten or deleted
 * without `--force`.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { conflictError } from '../core/errors.js';
import { requireBundledSkill } from './asset.js';
import { layoutFor, selectHarnesses, type HarnessId } from './harnesses.js';
import type { SkillRoot } from './root.js';

/** Marker filename written inside every directory NovaFlow manages. */
export const MANAGED_MARKER = '.novaflow-managed.json';
/** Value of `package` in a marker this tool owns. */
export const MANAGED_PACKAGE = 'novaflow';

export interface ManagedMarker {
  package: string;
  version: string;
  installed_at: string;
}

/** Health of one skill directory on disk (`novaflow-v100/cli` §3.4). */
export type EntryState = 'missing' | 'linked' | 'copied' | 'stale' | 'unmanaged';

export type EntryMode = 'symlink' | 'copy';

export interface EntryInfo {
  state: EntryState;
  version: string | null;
  mode: EntryMode | null;
}

export interface TargetReport {
  harness: HarnessId;
  path: string;
  state: EntryState;
  version: string | null;
  mode: EntryMode | null;
  changed: boolean;
}

export interface CanonicalReport {
  path: string;
  installed: boolean;
  managed: boolean;
  version: string | null;
  changed: boolean;
}

export interface InstallReport {
  local: boolean;
  root: string;
  dry_run: boolean;
  changed: boolean;
  version: string;
  canonical: CanonicalReport;
  targets: TargetReport[];
}

export interface TargetStatus {
  harness: HarnessId;
  path: string;
  state: EntryState;
  version: string | null;
  mode: EntryMode | null;
}

export interface StatusReport {
  local: boolean;
  root: string;
  cli_version: string;
  canonical: {
    path: string;
    installed: boolean;
    managed: boolean;
    version: string | null;
    version_match: boolean;
  };
  targets: TargetStatus[];
}

export interface UninstallReport {
  local: boolean;
  root: string;
  dry_run: boolean;
  changed: boolean;
  canonical: { path: string; removed: boolean };
  targets: Array<{ harness: HarnessId; path: string; state: EntryState; removed: boolean }>;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left: string, right: string): boolean {
  return realpathOr(left) === realpathOr(right);
}

/** Reads the management marker, treating malformed JSON as "not ours". */
export function readMarker(dir: string): ManagedMarker | null {
  const file = join(dir, MANAGED_MARKER);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ManagedMarker>;
    if (typeof parsed.package !== 'string' || typeof parsed.version !== 'string') return null;
    return {
      package: parsed.package,
      version: parsed.version,
      installed_at: typeof parsed.installed_at === 'string' ? parsed.installed_at : '',
    };
  } catch {
    return null;
  }
}

function writeMarker(dir: string, version: string, installedAt: string): void {
  const marker: ManagedMarker = { package: MANAGED_PACKAGE, version, installed_at: installedAt };
  writeFileSync(join(dir, MANAGED_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** Classifies one path against the canonical store and its version. */
export function classifyEntry(path: string, canonical: string, canonicalVersion: string | null): EntryInfo {
  const stats = lstatOrNull(path);
  if (stats === null) return { state: 'missing', version: null, mode: null };

  if (stats.isSymbolicLink()) {
    let target: string;
    try {
      target = resolve(dirname(path), readlinkSync(path));
    } catch {
      return { state: 'stale', version: null, mode: 'symlink' };
    }
    if (canonicalVersion !== null && samePath(target, canonical)) {
      return { state: 'linked', version: canonicalVersion, mode: 'symlink' };
    }
    return { state: 'stale', version: null, mode: 'symlink' };
  }

  if (!stats.isDirectory()) return { state: 'unmanaged', version: null, mode: null };

  const marker = readMarker(path);
  if (marker === null || marker.package !== MANAGED_PACKAGE) {
    return { state: 'unmanaged', version: null, mode: null };
  }
  const versionMatch = canonicalVersion !== null && marker.version === canonicalVersion;
  return { state: versionMatch ? 'copied' : 'stale', version: marker.version, mode: 'copy' };
}

function canonicalState(canonical: string): { installed: boolean; managed: boolean; version: string | null } {
  const stats = lstatOrNull(canonical);
  if (stats === null || !stats.isDirectory()) return { installed: false, managed: false, version: null };
  const marker = readMarker(canonical);
  const managed = marker !== null && marker.package === MANAGED_PACKAGE;
  return {
    installed: existsSync(join(canonical, 'SKILL.md')),
    managed,
    version: managed ? marker.version : null,
  };
}

function removeEntry(path: string): void {
  const stats = lstatOrNull(path);
  if (stats === null) return;
  if (stats.isDirectory() && !stats.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

function copyTree(source: string, dest: string): void {
  cpSync(source, dest, { recursive: true, dereference: true });
}

/** Writes the canonical store: a real directory, copied from the bundled asset. */
function writeCanonical(canonical: string, source: string, version: string, installedAt: string): void {
  removeEntry(canonical);
  mkdirSync(canonical, { recursive: true });
  copyTree(source, canonical);
  writeMarker(canonical, version, installedAt);
}

/**
 * Materialises one harness path: symlink first, copy on `EPERM`/restricted
 * filesystems or when the caller asked for `--copy`.
 */
function writeTarget(
  path: string,
  canonical: string,
  mode: EntryMode,
  version: string,
  installedAt: string,
): { state: EntryState; mode: EntryMode } {
  removeEntry(path);
  mkdirSync(dirname(path), { recursive: true });
  if (mode === 'symlink') {
    try {
      symlinkSync(canonical, path, 'dir');
      return { state: 'linked', mode: 'symlink' };
    } catch {
      // Fall through: some filesystems (and Windows without privileges) deny links.
    }
  }
  copyTree(canonical, path);
  writeMarker(path, version, installedAt);
  return { state: 'copied', mode: 'copy' };
}

function targetChanged(current: EntryInfo, desired: EntryMode, version: string): boolean {
  if (desired === 'symlink') return current.state !== 'linked';
  return !(current.state === 'copied' && current.version === version);
}

export interface InstallOptions {
  root: SkillRoot;
  agent: string | undefined;
  copy: boolean;
  force: boolean;
  dryRun: boolean;
  now: Date;
}

/**
 * Installs (or refreshes) the canonical store and every selected harness.
 *
 * All conflicts are detected before the first write, so a refused run leaves the
 * filesystem untouched (`novaflow-v100/skills` §3.3).
 */
export function installSkill(options: InstallOptions): InstallReport {
  const { root } = options;
  const { dir: source, version } = requireBundledSkill();
  const installedAt = options.now.toISOString();
  const desired: EntryMode = options.copy ? 'copy' : 'symlink';
  const selection = selectHarnesses(root, options.agent);
  const before = canonicalState(root.canonical);

  const conflicts: string[] = [];
  const canonicalStats = lstatOrNull(root.canonical);
  if (canonicalStats !== null && !(canonicalStats.isDirectory() && !canonicalStats.isSymbolicLink() && before.managed)) {
    conflicts.push(`Canonical skill directory ${root.canonical}`);
  }

  const targets = selection.ids.map((harness) => {
    const layout = layoutFor(harness, root);
    const current = classifyEntry(layout.skillDir, root.canonical, before.version);
    if (current.state === 'unmanaged') conflicts.push(`${harness} skill path ${layout.skillDir}`);
    return { harness, layout, current };
  });

  if (conflicts.length > 0 && !options.force) {
    throw conflictError(
      `Refusing to overwrite ${conflicts.length} unmanaged path${conflicts.length === 1 ? '' : 's'}: ${conflicts.join(', ')}.`,
      'Move the existing skill aside, or pass --force to replace it with the bundled novaflow skill.',
    );
  }

  const canonicalChanged = !(before.installed && before.managed && before.version === version);

  if (!options.dryRun) {
    if (canonicalChanged) writeCanonical(root.canonical, source, version, installedAt);
  }

  const targetReports: TargetReport[] = targets.map(({ harness, layout, current }) => {
    const changed = targetChanged(current, desired, version);
    if (!changed) {
      return { harness, path: layout.skillDir, state: current.state, version: current.version, mode: current.mode, changed: false };
    }
    if (options.dryRun) {
      const planned: EntryState = desired === 'copy' ? 'copied' : 'linked';
      return { harness, path: layout.skillDir, state: planned, version, mode: desired, changed: true };
    }
    const written = writeTarget(layout.skillDir, root.canonical, desired, version, installedAt);
    return { harness, path: layout.skillDir, state: written.state, version, mode: written.mode, changed: true };
  });

  return {
    local: root.kind === 'local',
    root: root.canonical,
    dry_run: options.dryRun,
    changed: canonicalChanged || targetReports.some((target) => target.changed),
    version,
    canonical: {
      // `installed`/`managed` reflect the disk; `version` is what this run targets,
      // so a dry run over a fresh root reports "not installed, version 1.0.0".
      path: root.canonical,
      installed: options.dryRun ? before.installed : true,
      managed: options.dryRun ? before.managed : true,
      version,
      changed: canonicalChanged,
    },
    targets: targetReports,
  };
}

/** Reports canonical install state plus per-harness link health. */
export function skillStatus(options: { root: SkillRoot; version: string }): StatusReport {
  const { root, version } = options;
  const canonical = canonicalState(root.canonical);
  const selection = selectHarnesses(root, undefined);
  return {
    local: root.kind === 'local',
    root: root.canonical,
    cli_version: version,
    canonical: {
      path: root.canonical,
      installed: canonical.installed,
      managed: canonical.managed,
      version: canonical.version,
      version_match: canonical.installed && canonical.version === version,
    },
    targets: selection.ids.map((harness) => {
      const layout = layoutFor(harness, root);
      const info = classifyEntry(layout.skillDir, root.canonical, canonical.version);
      return { harness, path: layout.skillDir, state: info.state, version: info.version, mode: info.mode };
    }),
  };
}

/** Removes managed links/directories only; siblings and unmanaged skills survive. */
export function uninstallSkill(options: {
  root: SkillRoot;
  agent: string | undefined;
  force: boolean;
  dryRun: boolean;
}): UninstallReport {
  const { root } = options;
  const selection = selectHarnesses(root, options.agent);
  const canonical = canonicalState(root.canonical);
  const canonicalExists = lstatOrNull(root.canonical) !== null;

  const blockable: string[] = [];
  if (canonicalExists && !canonical.managed) blockable.push(`Canonical skill directory ${root.canonical}`);

  const targets = selection.ids.map((harness) => {
    const layout = layoutFor(harness, root);
    const info = classifyEntry(layout.skillDir, root.canonical, canonical.version);
    if (info.state === 'unmanaged') blockable.push(`${harness} skill path ${layout.skillDir}`);
    return { harness, path: layout.skillDir, info };
  });

  if (blockable.length > 0 && !options.force) {
    throw conflictError(
      `Refusing to delete ${blockable.length} unmanaged path${blockable.length === 1 ? '' : 's'}: ${blockable.join(', ')}.`,
      'Delete it yourself, or pass --force to remove it.',
    );
  }

  const canonicalRemoved = canonicalExists;
  if (!options.dryRun && canonicalRemoved) removeEntry(root.canonical);

  const targetReports = targets.map(({ harness, path, info }) => {
    const removable = info.state !== 'missing';
    if (!options.dryRun && removable) removeEntry(path);
    return { harness, path, state: info.state, removed: removable };
  });

  return {
    local: root.kind === 'local',
    root: root.canonical,
    dry_run: options.dryRun,
    changed: canonicalRemoved || targetReports.some((target) => target.removed),
    canonical: { path: root.canonical, removed: canonicalRemoved },
    targets: targetReports,
  };
}
