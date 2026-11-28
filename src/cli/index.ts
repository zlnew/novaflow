/**
 * CLI entry point.
 *
 * P1 placeholder: version and help only. The full command grammar
 * (`novaflow-v100/cli` §3) replaces this in the CLI card.
 */
import { readFileSync } from 'node:fs';
import { toNovaError } from '../store/errors.js';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

const HELP = `novaflow ${VERSION} — deterministic agent task orchestration

Usage: novaflow <noun> <verb> [args] [flags]

Commands (not yet available in this build):
  workspace create|list|show|update|register|unregister
  project   create|list|show|update|archive
  task      create|list|next|status|context|update|start|complete|block|unblock|cancel|reopen
  skill     install|status|uninstall
  status | events | export | mcp

Global flags: --workspace/-w  --project/-p  --json  --quiet/-q  --dry-run  --help/-h  --version/-V
`;

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`novaflow ${VERSION}\n`);
    return 0;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const attempted = argv.join(' ');
  process.stderr.write(`novaflow: unknown command "${attempted}"\n`);
  process.stderr.write(HELP);
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  const novaError = toNovaError(error);
  process.stderr.write(`novaflow: ${novaError.message}\n`);
  if (novaError.hint !== undefined) process.stderr.write(`novaflow: ${novaError.hint}\n`);
  process.exitCode = novaError.exitCode;
}
