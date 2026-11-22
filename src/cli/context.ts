import { OpFailureError, daemonRequest } from "./client.ts";
import { readActiveWorkspace } from "./active.ts";
import { UsageError } from "./args.ts";

/**
 * Command context helpers shared by the noun modules: resolving the
 * active workspace (--workspace flag → CLI-local marker → usage error)
 * and the srs 4.1.1 task identifier rule (ULID direct, key within the
 * workspace context — served by the daemon's nova_task_resolve; the
 * CLI never opens the store).
 */

export type WorkspaceCtx = {
  id: string;
  slug: string;
  rootPath: string;
  status: string;
};

type WorkspaceListRow = {
  id: string;
  slug: string;
  root_path: string;
  status: string;
};

/**
 * The active workspace: `--workspace <slug|id>` overrides the CLI-local
 * marker for one command. Without either, a workspace-scoped command is
 * a usage error (the operator runs `nova workspace switch` first).
 * An unknown slug/id surfaces as not_found (exit 4).
 */
export async function workspaceContext(override?: string): Promise<WorkspaceCtx> {
  const want = override ?? readActiveWorkspace();
  if (want === null || want === "") {
    throw new UsageError(
      "no active workspace — run 'nova workspace switch <slug>' or pass --workspace <slug|id>",
    );
  }
  const data = (await daemonRequest("nova_workspace_list")) as { workspaces: WorkspaceListRow[] };
  const row = data.workspaces.find((w) => w.slug === want || w.id === want);
  if (row === undefined) {
    throw new OpFailureError("not_found", `no such workspace: ${want}`);
  }
  return { id: row.id, slug: row.slug, rootPath: row.root_path, status: row.status };
}

type TaskRow = {
  id: string;
  key: string;
  state: string;
};

/**
 * srs 4.1.1: "Accept either the ULID id or the human key; the key is
 * resolved first within the active project context." Implementation
 * (documented): a bare/`tsk_`-prefixed ULID resolves directly; anything
 * else is a KEY resolved within the ACTIVE WORKSPACE (--workspace
 * override or marker) across its projects — the workspace is the CLI's
 * project context in v1 (there is no per-project marker; a key that
 * repeats across projects is refused as ambiguous, never silently
 * picked). Resolution is the daemon's op; not_found → exit 4.
 */
export async function resolveTaskIdent(
  ident: string,
  workspaceOverride?: string,
): Promise<{ id: string; key: string; state: string }> {
  const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(ident.replace(/^tsk_/, ""));
  const args: Record<string, unknown> = { ident };
  if (!looksLikeUlid) {
    const ctx = await workspaceContext(workspaceOverride);
    args["workspace_id"] = ctx.id;
  }
  const data = (await daemonRequest("nova_task_resolve", args)) as { task: TaskRow };
  return data.task;
}

/** The triggering identity for audit-carrying commands (documented). */
export function operatorActor(): string {
  return process.env["USER"] ?? "operator";
}
