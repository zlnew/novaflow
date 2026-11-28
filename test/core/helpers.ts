import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { openDatabase } from '../../src/store/db.js';
import { NOVAFLOW_DIR, createWorkspace as createWorkspaceOnDisk, workspacePaths } from '../../src/store/workspace.js';
import { createProject, type CreateProjectInput } from '../../src/core/project.js';
import { createTask, type CreateTaskInput } from '../../src/core/task.js';
import type { ProjectView } from '../../src/core/project.js';
import type { TaskView } from '../../src/core/task.js';
import { sandbox, type Sandbox } from '../store/helpers.js';

/** Isolated workspace + open database, always inside a `mkdtemp` root. */
export interface CoreSandbox {
  box: Sandbox;
  /** Directory containing `.novaflow/`. */
  root: string;
  /** `<root>/.novaflow/state.db`. */
  dbPath: string;
  db: DatabaseSync;
  env: Record<string, string | undefined>;
  /** Options that resolve this workspace without walking up from `cwd`. */
  options: { workspace: string; env: Record<string, string | undefined>; cwd: string };
  dispose(): void;
}

const FIXED_NOW = new Date('2026-11-28T03:30:00.000Z');

function guard(box: Sandbox, path: string): string {
  // Never let a test touch a workspace outside its own temp root (for example the
  // real ~/.novaflow that lives above the repository checkout).
  assert.ok(path.startsWith(box.root), `refusing to use ${path}: outside sandbox ${box.root}`);
  return path;
}

/**
 * Creates a throwaway workspace with a migrated database.
 *
 * Uses `test/store/helpers.ts#sandbox`, which picks a temp base that has no
 * `.novaflow/` ancestor, so no test can walk up into the developer's real
 * workspace.
 */
export function coreSandbox(name = 'personal'): CoreSandbox {
  const box = sandbox();
  const root = guard(box, join(box.root, 'ws'));
  createWorkspaceOnDisk({ root, name, env: box.env, now: () => FIXED_NOW });
  assert.ok(!root.includes(`${NOVAFLOW_DIR}${NOVAFLOW_DIR}`));
  const dbPath = guard(box, workspacePaths(root).dbPath);
  const db = openDatabase(dbPath);
  return {
    box,
    root,
    dbPath,
    db,
    env: box.env,
    options: { workspace: root, env: box.env, cwd: box.cwd },
    dispose: () => {
      try {
        db.close();
      } finally {
        box.dispose();
      }
    },
  };
}

/** Collects sandboxes so one `after` hook can dispose them. */
export function sandboxPool(): { make(name?: string): CoreSandbox; disposeAll(): void } {
  const boxes: CoreSandbox[] = [];
  after(() => {
    for (const box of boxes) box.dispose();
  });
  return {
    make: (name) => {
      const box = coreSandbox(name);
      boxes.push(box);
      return box;
    },
    disposeAll: () => {
      for (const box of boxes) box.dispose();
    },
  };
}

export function seedProject(box: CoreSandbox, title: string, input: Partial<CreateProjectInput> = {}): ProjectView {
  const result = createProject(box.db, {
    title,
    ...input,
    now: input.now ?? FIXED_NOW,
  });
  return result.project;
}

export function seedTask(box: CoreSandbox, project: string, title: string, input: Partial<CreateTaskInput> = {}): TaskView {
  const result = createTask(box.db, {
    title,
    project,
    env: {},
    now: input.now ?? FIXED_NOW,
    ...input,
  });
  return result.task;
}

/** Fixed timestamp used by deterministic tests. */
export const NOW = FIXED_NOW;

/** `now + seconds`, for lease-expiry tests. */
export function later(seconds: number): Date {
  return new Date(FIXED_NOW.getTime() + seconds * 1000);
}

export function expectNovaError(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error, `expected a NovaError, got ${String(error)}`);
    const candidate = error as { code?: unknown; exitCode?: unknown };
    assert.equal(candidate.code, code);
    assert.equal(candidate.exitCode, exitCode);
    return true;
  };
}
