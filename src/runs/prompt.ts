import { readFileSync } from "node:fs";
import { join } from "node:path";

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
};

export type ComposedPrompt = {
  message: string;
  files: PromptFile[];
};

/** Deterministic, line-exact message format (asserted in tests). */
export function composePrompt(input: ComposePromptInput): ComposedPrompt {
  const files: PromptFile[] = [];
  for (const rel of input.contextFiles) {
    const resolved = join(input.workspaceRoot, rel);
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
  }

  return { message, files };
}
