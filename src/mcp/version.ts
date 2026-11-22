import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The package version, reported in the MCP `initialize` handshake as the
 * server's implementation version. Read from package.json at startup (the
 * same offline approach src/cli/main.ts uses — no JSON import assertion,
 * no build step). A missing/unreadable package.json degrades to "0.0.0"
 * rather than failing the handshake.
 */
export function version(): string {
  try {
    return String(
      (
        JSON.parse(
          readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
        ) as { version: string }
      ).version,
    );
  } catch {
    return "0.0.0";
  }
}
