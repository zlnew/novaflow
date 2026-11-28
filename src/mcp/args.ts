/**
 * Typed reader for untrusted `tools/call` arguments (`novaflow-v100/mcp` §2).
 *
 * JSON arrives from an agent, so every value is checked before it reaches
 * `src/core/`: a wrong type is a `VALIDATION_ERROR` naming the tool and the
 * parameter, never a silent coercion. `null` is meaningful — it clears a
 * nullable field — so absence and `null` are distinct everywhere.
 */
import type { ArtifactInput } from '../core/task.js';
import { validationError } from '../core/errors.js';

/** Why a value was rejected, phrased for an agent to fix on the next call. */
function invalid(tool: string, name: string, expected: string): Error {
  return validationError(
    `Invalid "${name}" for ${tool}: expected ${expected}.`,
    `Pass "${name}" as ${expected} in the tool arguments.`,
  );
}

/** Reads one tool call's `arguments` object. */
export class ToolArgs {
  constructor(
    private readonly raw: Record<string, unknown>,
    private readonly tool: string,
  ) {}

  /** True when the key is present, even with an explicit `null`. */
  has(name: string): boolean {
    return Object.hasOwn(this.raw, name);
  }

  /** Raw value, for diagnostics only. */
  value(name: string): unknown {
    return this.raw[name];
  }

  /** A required string; empty strings are accepted where the domain accepts them. */
  requiredString(name: string): string {
    const value = this.raw[name];
    if (typeof value !== 'string') throw invalid(this.tool, name, 'a string');
    return value;
  }

  /** Optional string; `null` passes through so callers can clear a field. */
  nullableString(name: string): string | null | undefined {
    const value = this.raw[name];
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string') throw invalid(this.tool, name, 'a string or null');
    return value;
  }

  /** Optional boolean. */
  boolean(name: string): boolean | undefined {
    const value = this.raw[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw invalid(this.tool, name, 'a boolean');
    return value;
  }

  /** Optional integer with an inclusive minimum. */
  integer(name: string, minimum: number): number | undefined {
    const value = this.raw[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
      throw invalid(this.tool, name, `an integer >= ${minimum}`);
    }
    return value;
  }

  /**
   * Optional string list; a single comma-separated string is accepted because
   * agents frequently send `"NV3-1,NV3-2"` where the CLI accepts the same.
   */
  stringList(name: string): string[] | undefined {
    const value = this.raw[name];
    if (value === undefined) return undefined;
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw invalid(this.tool, name, 'an array of strings');
    }
    return value as string[];
  }

  /** Optional string list where `null` clears the whole list. */
  nullableStringList(name: string): string[] | null | undefined {
    if (this.raw[name] === null) return null;
    return this.stringList(name);
  }

  /**
   * Optional artifact list for `task complete`: each entry is a URI string or
   * `{ uri, label?, kind? }` (`novaflow-v100/cli` §3.3).
   */
  artifacts(name: string): ArtifactInput[] | null | undefined {
    const value = this.raw[name];
    if (value === undefined || value === null) return value;
    if (!Array.isArray(value)) throw invalid(this.tool, name, 'an array of artifact URIs or objects');

    return value.map((entry) => {
      if (typeof entry === 'string') return { uri: entry };
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw invalid(this.tool, name, 'an array of artifact URIs or objects');
      }
      const record = entry as Record<string, unknown>;
      const uri = record.uri;
      if (typeof uri !== 'string') throw invalid(`${this.tool}.${name}[]`, 'uri', 'a string');
      const artifact: ArtifactInput = { uri };
      if (typeof record.label === 'string') artifact.label = record.label;
      if (typeof record.kind === 'string') artifact.kind = record.kind;
      return artifact;
    });
  }

  /** One of a fixed set of strings. */
  oneOf<T extends string>(name: string, allowed: readonly T[]): T | null | undefined {
    const value = this.nullableString(name);
    if (value === undefined || value === null) return value;
    if (!(allowed as readonly string[]).includes(value)) {
      throw invalid(this.tool, name, `one of: ${allowed.join(', ')}`);
    }
    return value as T;
  }
}
