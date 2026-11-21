import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Spawn argv per novaflow-v1/api §1 (Invocation Syntax) — EXACTLY the
 * spec's flags, in the spec's order. Golden tests re-parse the spec's
 * invocation block live and pin this builder to it.
 */

/** The §1 tools allowlist: pi's builtins plus the extension tool. */
export const PI_TOOLS = "read,bash,edit,write,novaflow_submit_result";

/** The §1 example extension path (a version-pinned install, not workspace state). */
export function defaultExtensionPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "novaflow.ts");
}

/** `<workspace_root>/.novaflow/runs/<task_id>/<run_id>/` (data.md 5.1/5.2, bare ULIDs). */
export function runDirPath(workspaceRoot: string, taskId: string, runId: string): string {
  return join(workspaceRoot, ".novaflow", "runs", taskId, runId);
}

export type RunArgvInput = {
  extensionPath: string;
  runDir: string;
  runId: string;
  model: string;
  thinkingLevel: string;
  /** Resolved profile system prompt file (workspace-root-relative per data.md). */
  systemPromptFile: string;
};

/**
 * The engine flags, in api.md §1 order:
 *   --mode rpc · -e <ext> · --tools … · --session-dir <run dir> ·
 *   --session-id <run_id> · --model <model> · --thinking <level> ·
 *   --append-system-prompt <prompt file> · --no-approve
 */
export function buildRunArgv(input: RunArgvInput): string[] {
  return [
    "--mode", "rpc",
    "-e", input.extensionPath,
    "--tools", PI_TOOLS,
    "--session-dir", input.runDir,
    "--session-id", input.runId,
    "--model", input.model,
    "--thinking", input.thinkingLevel,
    "--append-system-prompt", input.systemPromptFile,
    "--no-approve",
  ];
}
