/**
 * Workspace context for one invocation (`novaflow-v100/architecture` §5.1).
 *
 * Resolution order is owned by `src/store/workspace.ts`; the CLI only forwards
 * `--workspace`, the environment, and `cwd`, and guarantees the connection closes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openWorkspaceConnection, type WorkspaceOptions } from '../core/workspace.js';
import type { ResolvedWorkspace } from '../store/workspace.js';
import type { CliContext } from './types.js';

/** Options that resolve the workspace for this invocation. */
export function workspaceOptions(ctx: CliContext): WorkspaceOptions {
  return { workspace: ctx.options.workspace, env: ctx.env, cwd: ctx.cwd };
}

/** Opens the resolved workspace, runs `fn`, and always closes the database. */
export function withWorkspace<T>(
  ctx: CliContext,
  fn: (db: DatabaseSync, resolved: ResolvedWorkspace) => T,
): T {
  const connection = openWorkspaceConnection(workspaceOptions(ctx));
  try {
    return fn(connection.db, connection.resolved);
  } finally {
    connection.close();
  }
}
