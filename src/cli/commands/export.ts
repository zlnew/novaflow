/**
 * `novaflow export` — portable JSON snapshot (`novaflow-v100/cli` §3.5).
 *
 * With `--out` the file is written atomically (temp file in the same directory,
 * then `rename`), and `--dry-run` reports the plan without touching the disk.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { toNovaError } from '../../core/errors.js';
import { exportWorkspace } from '../../core/workspace.js';
import { afterExport } from '../next-actions.js';
import type { CommandModule, VerbSpec } from '../types.js';

const exportVerb: VerbSpec = {
  verb: null,
  command: 'export',
  summary: 'Export projects, tasks, deps, notes, artifacts and events as a portable JSON snapshot',
  usage: 'novaflow export [--project <p>] [--out <file>]',
  positionals: [],
  flags: [
    { name: 'out', kind: 'string', placeholder: '<file>', description: 'Write the snapshot to this file instead of stdout' },
  ],
  examples: ['novaflow export', 'novaflow export --out .archive/snapshot.json', 'novaflow export --dry-run --out snapshot.json'],
  run: (ctx) => {
    const snapshot = exportWorkspace({
      workspace: ctx.options.workspace ?? null,
      project: ctx.options.project ?? null,
      env: ctx.env,
      cwd: ctx.cwd,
      now: ctx.now,
    });

    const requested = ctx.args.get('out');
    if (requested === undefined) {
      return {
        data: snapshot,
        human: `${JSON.stringify(snapshot, null, 2)}\n`,
        quiet: `${JSON.stringify(snapshot)}\n`,
        next_actions: afterExport(null),
      };
    }

    const target = resolve(ctx.cwd, requested);
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');

    if (ctx.options.dryRun) {
      return {
        data: { out: target, bytes, written: false, dry_run: true },
        human: `Dry run: would write ${bytes} bytes to ${target}\nNo files written.\n`,
        quiet: `${target}\n`,
        next_actions: [],
      };
    }

    const directory = dirname(target);
    const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temp, serialized, 'utf8');
      renameSync(temp, target);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best effort cleanup; the write error is what the caller must see.
      }
      throw toNovaError(error, `Unable to write snapshot to ${target}.`);
    }

    return {
      data: { out: target, bytes, written: true, dry_run: false },
      human: `Wrote ${bytes} bytes to ${target}\n`,
      quiet: `${target}\n`,
      next_actions: afterExport(target),
    };
  },
};

export const exportModule: CommandModule = {
  name: 'export',
  summary: 'Export the workspace (or one project) as a portable JSON snapshot.',
  verbs: [exportVerb],
};
