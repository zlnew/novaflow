/**
 * novaflow.ts — the NovaFlow Pi extension (novaflow-v1/api §6).
 *
 * RED SCAFFOLD (p6 commit 1): this file pins the module's public
 * surface — every export the p6 test suite drives — with signatures
 * only. Every behavior throws; test/extensions/*.test.ts is red
 * against this stub BY DESIGN. The implementation commit replaces
 * the bodies wholesale.
 *
 * Shape (per the card):
 *   - ONE self-contained module (the install path
 *     ~/.pi/agent/extensions/novaflow.ts is a COPY of this file, not
 *     engine state — it must never import repo `src/` modules).
 *   - RUN MODE (NOVAFLOW_RUN_CONTEXT set): session_start loads the
 *     engine context; tool_call enforces scopes; the
 *     novaflow_submit_result tool is the completion signal.
 *   - OPERATOR MODE (no run context): the /nova slash command family
 *     over the daemon socket (surface "human").
 *   - pure exported helpers so tests drive the seams directly.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/* --------------------------------- constants ---------------------------------- */

export const SUBMIT_TOOL_NAME = "novaflow_submit_result";
export const RESULT_FILENAME = "result.json";
export const SNAPSHOT_FILENAME = "protected-digests.json";
export const MAX_RESULT_PAYLOAD_BYTES = 262_144;

/* --------------------------------- run context --------------------------------- */

export type RunScope = {
  target_id: string;
  alias: string;
  access_mode: "read_only" | "read_write";
  write_scope_globs: string[];
  protected_test_globs: string[];
  root_path: string;
  target_type: "git_repo" | "directory";
};

export type RunContext = {
  taskId: string;
  runId: string;
  runDir: string;
  scopes: RunScope[];
  loadError: string | null;
};

export function loadRunContext(contextPath: string): RunContext {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

/* -------------------------------- glob matching --------------------------------- */

export function globMatch(pattern: string, relPath: string): boolean {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function globMatchAny(patterns: readonly string[], relPath: string): boolean {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

/* ------------------------------ scope enforcement ------------------------------- */

export type CheckResult = { ok: true } | { ok: false; reason: string };

export function resolveToolPath(cwd: string, rawPath: string): string {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function checkWritePath(scopes: RunScope[], absPath: string): CheckResult {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function bashWriteTargets(command: string): string[] {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function checkBashWriteScope(scopes: RunScope[], cwd: string, command: string): CheckResult {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

/* ----------------------------- artifact validation ------------------------------ */

export type ArtifactValidation =
  | { ok: true; artifact: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function validateArtifactStructure(value: unknown): ArtifactValidation {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export type SubmitResult =
  | { ok: true; path: string }
  | { ok: false; errors: string[] };

export function validateAndWriteResult(runDir: string, input: unknown): SubmitResult {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

/* ------------------------------ operator (socket) ------------------------------- */

export function novaHome(): string {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function socketPath(): string {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function readActiveWorkspace(): string | null {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export function operatorActor(): string {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export class DaemonUnreachableError extends Error {
  readonly code = "daemon_unreachable";
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}

export class OpFailureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpFailureError";
  }
}

export async function daemonRequest(
  op: string,
  args: Record<string, unknown> = {},
  opts: { socketPath?: string } = {},
): Promise<unknown> {
  throw new Error("novaflow: not implemented (RED scaffold)");
}

export async function runNovaCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  void args;
  void ctx;
  throw new Error("novaflow: not implemented (RED scaffold)");
}

/* ----------------------------------- factory ------------------------------------ */

export const SUBMIT_TOOL_PARAMS: TSchema = {
  type: "object",
  additionalProperties: false,
} as unknown as TSchema;

export default function novaflowExtension(pi: ExtensionAPI): void {
  void pi;
  throw new Error("novaflow: not implemented (RED scaffold)");
}
