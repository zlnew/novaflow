import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { novaHome } from "./client.ts";

/**
 * The ACTIVE-WORKSPACE MARKER — CLI-local state, by ruling (documented):
 * srs 4.1.1 names `nova workspace switch` a CLI concern, and the daemon
 * is stateless about which workspace the operator is looking at (the
 * card's DECISION). The marker is a plain slug written to
 * `<NOVAFLOW_HOME>/active-workspace`; `--workspace <slug|id>` overrides
 * it for any single command. The daemon exposes NO switch op — pinned
 * by a test in test/daemon/workspaces.test.ts.
 */

export function activeWorkspaceFile(): string {
  return join(novaHome(), "active-workspace");
}

/** The active workspace slug, or null when no marker exists. */
export function readActiveWorkspace(): string | null {
  try {
    const slug = readFileSync(activeWorkspaceFile(), "utf8").trim();
    return slug === "" ? null : slug;
  } catch {
    return null;
  }
}

export function writeActiveWorkspace(slug: string): void {
  mkdirSync(novaHome(), { recursive: true });
  writeFileSync(activeWorkspaceFile(), slug + "\n");
}

export function activeWorkspaceExists(): boolean {
  return existsSync(activeWorkspaceFile());
}
