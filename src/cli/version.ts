/** Binary version, read once from `package.json` (`novaflow-v100/cli` §2). */
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

export const VERSION = readVersion();

/** Exact `--version` output line. */
export const VERSION_LINE = `novaflow ${VERSION}`;
