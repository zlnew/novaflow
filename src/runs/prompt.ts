import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Prompt composition per FR-TSK-04 (novaflow-v1/srs): inject ONLY the
 * explicitly configured task objective and the files mapped in
 * `tasks.context_files_json` (paths resolved under the workspace root).
 * Nothing else enters the prompt — upstream handoffs ride in as mapped
 * context files per the feedback routing rule. An unreadable mapped
 * file is a hard error naming the path; it is never silently skipped.
 *
 * The repair attempt's message (FR-TSK-06) additionally carries the
 * failure feedback from the previous attempt.
 */

export type PromptFile = {
  /** The mapped, workspace-root-relative path (as configured). */
  path: string;
  /** Absolute resolved path under the workspace root. */
  resolvedPath: string;
  content: string;
};

export type ComposePromptInput = {
  objective: string;
  contextFiles: string[];
  workspaceRoot: string;
  /** Present only on repair attempts. */
  repairFeedback?: string;
  /**
   * Present only when the PREVIOUS attempt ran in a worktree (its
   * `task_runs.worktree_root` is non-null). The repair starts from a fresh
   * tree, so the prompt points at the prior work instead of redoing it
   * (DEBT-014).
   */
  repairWorktree?: RepairWorktreePointer | undefined;
};

/** Where the previous attempt's work — and its persisted diff — live. */
export type RepairWorktreePointer = {
  /** The previous attempt's worktree root (migration 0004). */
  worktreeRoot: string;
  /** The previous attempt's `workspace_diff.patch` in its run dir. */
  patchPath: string;
};

/**
 * The one repair pointer sentence (DEBT-014): exactly three facts — the
 * tree's path, its persisted diff's path, and that the tree is read-only
 * evidence. No guidance beyond them.
 */
export function repairWorktreeClause(pointer: RepairWorktreePointer): string {
  return (
    `The previous attempt's worktree is ${pointer.worktreeRoot}, ` +
    `its workspace_diff.patch is ${pointer.patchPath}; ` +
    `that tree is read-only evidence — inspect it; do not write to it.`
  );
}

export type ComposedPrompt = {
  message: string;
  files: PromptFile[];
};

/** Deterministic, line-exact message format (asserted in tests). */
export function composePrompt(input: ComposePromptInput): ComposedPrompt {
  const files: PromptFile[] = [];
  const root = resolve(input.workspaceRoot);
  for (const rel of input.contextFiles) {
    const resolved = resolve(root, rel);
    // containment: a mapped path may resolve ANYWHERE via .. or an
    // absolute path — anything outside the workspace root is a hard
    // error naming the path, same as an unreadable file (never read)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`context file "${rel}" escapes the workspace root`);
    }
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch (err) {
      throw new Error(
        `unreadable context file "${rel}": ${(err as Error).message}`,
      );
    }
    files.push({ path: rel, resolvedPath: resolved, content });
  }

  let message = `Objective:\n${input.objective}\n\nContext files:\n`;
  if (files.length === 0) {
    message += "(none)";
  } else {
    for (const f of files) {
      message += `--- ${f.path} ---\n${f.content}`;
      if (!f.content.endsWith("\n")) message += "\n";
      message += `--- end ${f.path} ---\n`;
    }
    message = message.slice(0, -1); // no trailing newline on the message
  }

  if (input.repairFeedback !== undefined) {
    message += `\n\nRepair feedback from the previous attempt:\n${input.repairFeedback}`;
    // DEBT-014: an in-place previous attempt (worktree_root NULL) adds
    // nothing — the sentence is ABSENT, never an empty clause
    if (input.repairWorktree !== undefined) {
      message += `\n\n${repairWorktreeClause(input.repairWorktree)}`;
    }
  }

  return { message, files };
}
