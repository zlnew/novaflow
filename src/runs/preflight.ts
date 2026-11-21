import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Db } from "../store/db.ts";
import { loadWorkspaceConfig } from "../config.ts";

/**
 * DEBT-002 closure — the FR-TSK-10 pre-flight zero-token readiness
 * checks the run loop calls BEFORE any spawn (srs FR-TSK-10; the
 * srs ~:459 review note: pre-flight is LOCAL-ONLY — no network fetch,
 * no base-branch freshness):
 *
 *   AC1 every task_target_scopes row's project_targets.root_path
 *      exists and is accessible — W_OK for read_write scopes, R_OK for
 *      read_only scopes;
 *   AC2 for `git_repo` targets, `git status --porcelain` is empty at
 *      pre-flight; non-empty output names the dirty paths (bounded
 *      list);
 *   AC3 tool dependency: the pi binary must resolve (X_OK on a literal
 *      path, or found on PATH for a bare name). Env-var validation:
 *      the spec pins NO required variables in v1 — REQUIRED_ENV_VARS is
 *      the (empty, documented) hook;
 *   AC4 the budget ceiling: workspace budgets.daily_usd/monthly_usd
 *      (src/config.ts) vs the sum of task_runs.cost_usd since the
 *      current UTC day/month start. The daemon's GLOBAL budgets apply
 *      when the workspace defines none (documented precedence:
 *      workspace value > daemon global > unlimited).
 *
 * Every check returns null on success or a one-line failure reason;
 * the loop turns any non-null into a preflight_failed run row with
 * ZERO tokens spent (AC5).
 *
 * Spec-silent choices (documented, minimal-convention readings):
 *   - spend attribution is by run START time (task_runs.started_at is
 *     NOT NULL; ended_at may be null mid-run) over the run's workspace;
 *   - day/month boundaries are UTC;
 *   - "exhausted" means spend >= ceiling (a new run would push past it);
 *   - a broken workspace config.yaml is a preflight failure (the
 *     ceiling cannot be verified — config.ts leaves the policy to
 *     callers);
 *   - the git check is bounded (10 s) and treats a non-zero git exit
 *     as a preflight failure (the base cleanliness cannot be
 *     confirmed).
 */

export type GlobalBudgets = { dailyUsd: number | null; monthlyUsd: number | null };

type ScopeRow = {
  alias: string;
  target_type: "git_repo" | "directory";
  root_path: string;
  access_mode: "read_only" | "read_write";
};

/** AC1 + AC2: scoped target roots exist, are accessible, and git_repo bases are clean. */
export function checkTargetScopes(db: Db, taskId: string): string | null {
  const scopes = db
    .prepare(
      `SELECT pt.alias, pt.target_type, pt.root_path, tts.access_mode
         FROM task_target_scopes tts
         JOIN project_targets pt ON pt.id = tts.target_id
        WHERE tts.task_id = ?`,
    )
    .all(taskId) as ScopeRow[];
  for (const scope of scopes) {
    if (!existsSync(scope.root_path)) {
      return `target "${scope.alias}" root_path "${scope.root_path}" does not exist`;
    }
    try {
      accessSync(
        scope.root_path,
        scope.access_mode === "read_write" ? constants.W_OK : constants.R_OK,
      );
    } catch {
      return `target "${scope.alias}" root_path "${scope.root_path}" is not ${
        scope.access_mode === "read_write" ? "writable" : "readable"
      } (access ${scope.access_mode})`;
    }
    if (scope.target_type !== "git_repo") continue;
    // AC2: the base worktree must be clean (local check only)
    const git = spawnSync("git", ["status", "--porcelain"], {
      cwd: scope.root_path,
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (git.error !== undefined) {
      return `git_repo target "${scope.alias}": git status failed (${git.error.message})`;
    }
    if (git.status !== 0) {
      const stderrTail = String(git.stderr ?? "").trim().slice(0, 200);
      return `git_repo target "${scope.alias}": git status exited ${git.status}${
        stderrTail === "" ? "" : ` — ${stderrTail}`
      }`;
    }
    const entries = String(git.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (entries.length > 0) {
      const bounded = entries.slice(0, 10).map((e) => e.replace(/\s+/g, " "));
      const more = entries.length - bounded.length;
      return `git_repo target "${scope.alias}" has a dirty base worktree (git status --porcelain: ${entries.length} entries): ${bounded.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
    }
  }
  return null;
}

/**
 * AC3 tool dependency: the pi binary must resolve — X_OK on a literal
 * path, or an executable file on PATH for a bare name.
 */
export function checkPiBinary(piBin: string): string | null {
  if (piBin.includes("/")) {
    try {
      accessSync(piBin, constants.X_OK);
      return null;
    } catch {
      return `pi binary "${piBin}" is not executable (FR-TSK-10 AC3 tool dependency check)`;
    }
  }
  const path = process.env["PATH"] ?? "";
  const dirs = path.split(":").filter((d) => d !== "");
  for (const dir of dirs) {
    const candidate = `${dir}/${piBin}`;
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return null; // resolvable on PATH
    } catch {
      continue;
    }
  }
  return `pi binary "${piBin}" not found on PATH (FR-TSK-10 AC3 tool dependency check)`;
}

/**
 * AC3 env-var validation hook. The spec pins NO required environment
 * variables in v1 (srs FR-TSK-10 AC3 "validates required environment
 * variables and tool dependencies" — the v1 env set is empty), so this
 * is the documented hook: add a variable name here and preflight fails
 * naming it when absent. Never a silent requirement.
 */
export const REQUIRED_ENV_VARS: readonly string[] = [];

export function checkRequiredEnvVars(): string | null {
  const missing = REQUIRED_ENV_VARS.filter((name) => process.env[name] === undefined);
  if (missing.length === 0) return null;
  return `missing required environment variables: ${missing.join(", ")}`;
}

/** Spend over the workspace's runs since the current UTC day/month start. */
function workspaceSpendSince(db: Db, workspaceId: string): { today: number; month: number } {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const q = (since: Date): number =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(r.cost_usd), 0) AS s
             FROM task_runs r
             JOIN tasks t ON t.id = r.task_id
             JOIN projects p ON p.id = t.project_id
            WHERE p.workspace_id = ? AND r.started_at >= ?`,
        )
        .get(workspaceId, since.toISOString()) as { s: number }
    ).s;
  return { today: q(dayStart), month: q(monthStart) };
}

/**
 * AC4: the budget ceiling. Precedence (documented): the workspace's
 * own budgets value when its config defines one; otherwise the
 * daemon's global budget; otherwise unlimited.
 */
export function checkBudgetCeiling(
  db: Db,
  input: {
    workspaceId: string;
    workspaceRoot: string;
    /** The daemon config's global budgets (dispatch passes them). */
    globalBudgets?: GlobalBudgets | undefined;
  },
): string | null {
  const load = loadWorkspaceConfig(input.workspaceRoot);
  if (!load.ok) {
    return `workspace config unreadable: ${load.error} — the budget ceiling cannot be verified`;
  }
  const effective = (
    workspaceValue: number | null,
    globalValue: number | null,
  ): { usd: number | null; source: "workspace" | "daemon global" | null } => {
    if (workspaceValue !== null) return { usd: workspaceValue, source: "workspace" };
    if (globalValue !== null) return { usd: globalValue, source: "daemon global" };
    return { usd: null, source: null };
  };
  const daily = effective(load.config.budgets.dailyUsd, input.globalBudgets?.dailyUsd ?? null);
  const monthly = effective(load.config.budgets.monthlyUsd, input.globalBudgets?.monthlyUsd ?? null);
  if (daily.usd === null && monthly.usd === null) return null;

  const spend = workspaceSpendSince(db, input.workspaceId);
  if (daily.usd !== null && spend.today >= daily.usd) {
    return `budget_exceeded at preflight: daily spend $${spend.today.toFixed(2)} >= daily_usd $${daily.usd}${
      daily.source === "daemon global" ? " (daemon global budget)" : ""
    } (monthly spend $${spend.month.toFixed(2)})`;
  }
  if (monthly.usd !== null && spend.month >= monthly.usd) {
    return `budget_exceeded at preflight: monthly spend $${spend.month.toFixed(2)} >= monthly_usd $${monthly.usd}${
      monthly.source === "daemon global" ? " (daemon global budget)" : ""
    } (daily spend $${spend.today.toFixed(2)})`;
  }
  return null;
}
