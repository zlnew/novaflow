/**
 * Typed domain errors for the store layer.
 *
 * Every failure that a caller may need to act on is a `NovaError` carrying a
 * stable domain code and the CLI exit code it maps to (`novaflow-v100/cli` §2.3).
 */

/** Domain error codes emitted by the store layer. */
export type NovaErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'WORKSPACE_NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'SCHEMA_TOO_NEW';

/** Exit codes pinned by `novaflow-v100/cli` §2.3. */
export type ExitCode = 1 | 2 | 3 | 4;

/** Domain code -> CLI exit code. Pinned by tests. */
export const EXIT_CODES: Record<NovaErrorCode, ExitCode> = {
  VALIDATION_ERROR: 2,
  NOT_FOUND: 4,
  WORKSPACE_NOT_FOUND: 4,
  STATE_CONFLICT: 3,
  INTERNAL_ERROR: 1,
  SCHEMA_TOO_NEW: 1,
};

export interface NovaErrorOptions {
  /** One-line remediation shown to the operator. Never part of `message`. */
  hint?: string;
  /** Original failure, kept for debugging and never serialized. */
  cause?: unknown;
}

/** Shape of the error payload inside a `--json` envelope. */
export interface NovaErrorEnvelope {
  code: NovaErrorCode;
  message: string;
  hint?: string;
}

export class NovaError extends Error {
  readonly code: NovaErrorCode;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(code: NovaErrorCode, message: string, options: NovaErrorOptions = {}) {
    super(message);
    this.name = 'NovaError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.hint = options.hint;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /** Error envelope payload for `--json` output. Omits absent fields. */
  toJSON(): NovaErrorEnvelope {
    const envelope: NovaErrorEnvelope = { code: this.code, message: this.message };
    if (this.hint !== undefined) envelope.hint = this.hint;
    return envelope;
  }
}

export function isNovaError(value: unknown): value is NovaError {
  return value instanceof NovaError;
}

/** Wraps an unknown failure as `INTERNAL_ERROR` (exit 1); NovaError passes through. */
export function toNovaError(value: unknown, message?: string): NovaError {
  if (isNovaError(value)) return value;
  if (value instanceof Error) {
    return new NovaError('INTERNAL_ERROR', message ?? value.message, { cause: value });
  }
  return new NovaError('INTERNAL_ERROR', message ?? String(value), { cause: value });
}
