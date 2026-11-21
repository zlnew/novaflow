import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../store/db.ts";
import { getChainRun, listChainMembers } from "./import.ts";
import { novaflowDir } from "../workspaces.ts";

/**
 * FR-PRJ-05 — the consolidated project report: when a chain run reaches
 * `completed` (the terminal rule in src/chain/readiness.ts), the engine
 * aggregates every completed member's result.json payload into
 * `<workspace_root>/.novaflow/projects/<slug>/PROJECT_SUMMARY.md`
 * (the data.md 5.2 layout's project directory — the same directory the
 * p3b project scaffold creates; FR-PRJ-05 names the report path
 * `projects/<slug>/PROJECT_SUMMARY.md`).
 *
 * Contract:
 *   - written ONCE per chain completion — the no-op guard is the file's
 *     own existence (a regeneration on re-completion never touches it;
 *     the guarded terminal move already guarantees one completion);
 *   - a member whose result.json is missing or unreadable gets a
 *     MARKED section + a warn — the report is still written and the
 *     chain state is never corrupted (the terminal move already
 *     applied; this module must never throw past it);
 *   - a member that is somehow not completed at chain completion (a
 *     state no legal path can produce — the terminal rule required all
 *     members completed) is reported honestly, never fabricated.
 *
 * Spec-silent choices (documented): the report is markdown with one
 * `## <key> — <title>` section per member carrying the member key,
 * title, result summary, assumptions, open questions, and artifact
 * paths (artifacts_modified entries plus the result.json's own
 * workspace-root-relative path); the member order is ULID creation
 * order (data.md 5.1).
 */

export const PROJECT_SUMMARY_FILENAME = "PROJECT_SUMMARY.md";

export type ProjectSummaryOutcome =
  | { written: true; path: string; members: number; marked: number }
  | { written: false; path: string | null; reason: string };

type ChainJoinRow = { slug: string; root: string };

function chainProject(db: Db, chainRunId: string): ChainJoinRow | undefined {
  return db
    .prepare(
      `SELECT p.slug AS slug, w.root_path AS root
         FROM chain_runs c JOIN projects p ON p.id = c.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE c.id = ?`,
    )
    .get(chainRunId) as ChainJoinRow | undefined;
}

/** The canonical report path, or null when the chain/project rows are missing. */
export function projectSummaryPath(db: Db, chainRunId: string): string | null {
  const row = chainProject(db, chainRunId);
  if (row === undefined) return null;
  return join(novaflowDir(row.root), "projects", row.slug, PROJECT_SUMMARY_FILENAME);
}

function warn(message: string): void {
  console.warn(`[novaflow-chain] ${message}`);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string") ? (value as string[]) : [];
}

type ModifiedItem = { target_alias?: unknown; path?: unknown; action?: unknown };

function memberSection(
  member: { key: string; title: string; state: string },
  artifact: Record<string, unknown> | null,
  artifactRelPath: string | null,
): string[] {
  const lines: string[] = [];
  lines.push(`## ${member.key} — ${member.title}`, "");
  if (artifact === null) {
    lines.push(
      `> ⚠ result.json unavailable for member ${member.key} — the completed run's artifact is missing or unreadable; this section is marked, not fabricated.`,
      "",
    );
    return lines;
  }
  lines.push(`- State: ${member.state}`);
  lines.push(`- Result artifact: ${artifactRelPath ?? "(artifact path not recorded)"}`);
  lines.push(`- Summary: ${typeof artifact["summary"] === "string" ? artifact["summary"] : "(no summary)"}`);
  lines.push("");
  const assumptions = asStringArray(artifact["assumptions_made"]);
  lines.push("Assumptions:");
  if (assumptions.length === 0) lines.push("- (none)");
  else for (const a of assumptions) lines.push(`- ${a}`);
  lines.push("");
  const questions = asStringArray(artifact["open_questions"]);
  lines.push("Open questions:");
  if (questions.length === 0) lines.push("- (none)");
  else for (const q of questions) lines.push(`- ${q}`);
  lines.push("");
  const modified = Array.isArray(artifact["artifacts_modified"])
    ? (artifact["artifacts_modified"] as ModifiedItem[])
    : [];
  lines.push("Artifacts modified:");
  if (modified.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of modified) {
      lines.push(
        `- \`${typeof item.path === "string" ? item.path : "?"}\` (${
          typeof item.action === "string" ? item.action : "?"
        }${typeof item.target_alias === "string" ? `, ${item.target_alias}` : ""})`,
      );
    }
  }
  lines.push("");
  return lines;
}

/**
 * Write the consolidated report. NEVER THROWS: an impossible input is a
 * typed refusal outcome; a member-level aggregation failure is a warn +
 * a marked section. The caller (the terminal rule) has already moved
 * the chain to `completed` — this module must never corrupt that.
 */
export function writeProjectSummary(db: Db, chainRunId: string): ProjectSummaryOutcome {
  const chain = getChainRun(db, chainRunId);
  if (chain === undefined) {
    return { written: false, path: null, reason: `no such chain run: ${chainRunId}` };
  }
  const project = chainProject(db, chainRunId);
  if (project === undefined) {
    return { written: false, path: null, reason: "the chain run's project/workspace row is missing" };
  }
  const path = join(novaflowDir(project.root), "projects", project.slug, PROJECT_SUMMARY_FILENAME);
  // the no-op guard (documented): regeneration never overwrites
  if (existsSync(path)) {
    return { written: false, path, reason: "already-exists" };
  }

  const members = listChainMembers(db, chainRunId);
  const root = project.root;
  const lines: string[] = [
    `# PROJECT_SUMMARY — ${project.slug}`,
    "",
    `Consolidated project report (FR-PRJ-05): every completed member's result.json payload from chain run \`${chainRunId}\`.`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];
  let marked = 0;
  for (const m of members) {
    if (m.state !== "completed") {
      // no legal path reaches here (the terminal rule required every
      // member completed) — honest reporting, never fabricated
      marked += 1;
      lines.push(`## ${m.key} — ${m.title}`, "");
      lines.push(`> ⚠ member is ${m.state} at chain completion — not aggregated.`, "");
      continue;
    }
    let artifact: Record<string, unknown> | null = null;
    let artifactRelPath: string | null = null;
    const run = db
      .prepare(
        "SELECT artifact_path FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1",
      )
      .get(m.id) as { artifact_path: string | null } | undefined;
    if (run !== undefined && run.artifact_path !== null) {
      try {
        artifact = JSON.parse(readFileSync(run.artifact_path, "utf8")) as Record<string, unknown>;
        artifactRelPath = run.artifact_path.startsWith(root)
          ? run.artifact_path.slice(root.length + 1)
          : run.artifact_path;
      } catch (err) {
        warn(`PROJECT_SUMMARY: result.json of member ${m.key} is unreadable — ${(err as Error).message}`);
      }
    }
    if (artifact === null) {
      marked += 1;
      warn(`PROJECT_SUMMARY: result.json of member ${m.key} is missing — marking the section`);
    }
    lines.push(...memberSection({ key: m.key, title: m.title, state: m.state }, artifact, artifactRelPath));
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n");
  } catch (err) {
    warn(`PROJECT_SUMMARY: the report for chain ${chainRunId} could not be written — ${(err as Error).message}`);
    return { written: false, path, reason: (err as Error).message };
  }
  return { written: true, path, members: members.length, marked };
}
