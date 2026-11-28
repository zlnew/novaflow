/**
 * Server version for the MCP `initialize` handshake.
 *
 * Read from `package.json` next to the compiled entry point, exactly like the
 * CLI's `--version`, so the server and the binary can never disagree.
 */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'novaflow';
export const SERVER_VERSION = readVersion();
