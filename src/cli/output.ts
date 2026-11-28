/**
 * Stream discipline and JSON envelopes (`novaflow-v100/cli` §2.1, §2.2).
 *
 * `stdout` carries exactly one thing: the success envelope, the `--quiet`
 * identifiers, or the human rendering. Errors go to `stderr` only — and under
 * `--json` they are a single-line envelope, so `novaflow ... --json | jq` never
 * sees error text and agent harnesses reading `stderr` still get structured JSON.
 */
import { toNovaError, type NovaError } from '../core/errors.js';
import type { CommandResult, NextAction } from './types.js';

export interface Streams {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processStreams: Streams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface SuccessEnvelope {
  ok: true;
  command: string;
  data: unknown;
  next_actions: NextAction[];
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: ReturnType<NovaError['toJSON']>;
}

/** Wraps a result in the documented success envelope. */
export function successEnvelope(command: string, result: CommandResult): SuccessEnvelope {
  return {
    ok: true,
    command,
    data: result.data ?? null,
    next_actions: result.next_actions ?? [],
  };
}

/** Wraps a failure in the documented error envelope. */
export function errorEnvelope(command: string, error: NovaError): ErrorEnvelope {
  return { ok: false, command, error: error.toJSON() };
}

/** Writes exactly one envelope, or the quiet/human rendering, to stdout. */
export function writeSuccess(
  command: string,
  result: CommandResult,
  options: { json: boolean; quiet: boolean },
  streams: Streams = processStreams,
): void {
  if (options.json) {
    streams.stdout(`${JSON.stringify(successEnvelope(command, result))}\n`);
    return;
  }
  if (options.quiet) {
    if (result.quiet !== undefined && result.quiet !== '') streams.stdout(result.quiet);
    return;
  }
  if (result.human !== undefined && result.human !== '') streams.stdout(result.human);
}

/**
 * Writes the failure to `stderr` and returns the exit code to use.
 *
 * Under `--json` nothing at all is written to `stdout`.
 */
export function writeFailure(
  command: string,
  error: unknown,
  options: { json: boolean },
  streams: Streams = processStreams,
): number {
  const novaError = toNovaError(error);
  if (options.json) {
    streams.stderr(`${JSON.stringify(errorEnvelope(command, novaError))}\n`);
  } else {
    streams.stderr(`novaflow: ${novaError.message}\n`);
    if (novaError.hint !== undefined) streams.stderr(`novaflow: hint: ${novaError.hint}\n`);
  }
  return novaError.exitCode;
}

/** Joins identifier lines and always ends with a newline, or returns `''`. */
export function identifiers(values: readonly (string | null | undefined)[]): string {
  const lines = values.filter((value): value is string => typeof value === 'string' && value !== '');
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
