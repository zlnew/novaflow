/**
 * Slug, prefix, and task-key derivation (`novaflow-v100/data` §1.1).
 *
 * Everything here is pure and deterministic: no clock, no database, no I/O.
 * Collision handling is passed in as the set of already-taken values so callers
 * stay in control of the transaction that reserves the result.
 */
import { NovaError } from './errors.js';

/** Project/workspace slug shape: lowercase kebab-case, 1-64 characters. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Project prefix shape: uppercase alphanumeric, 2-8 characters, letter first. */
export const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;

/** Maximum characters in a project prefix. */
export const MAX_PREFIX_LENGTH = 8;

/** Highest collision suffix tried before prefix derivation gives up. */
export const MAX_PREFIX_SUFFIX = 99;

/** Highest collision suffix tried before an auto-derived slug gives up. */
export const MAX_SLUG_SUFFIX = 99;

/** Maximum characters in a slug. */
export const MAX_SLUG_LENGTH = 64;

const TASK_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,7})-([1-9][0-9]*)$/;
const TASK_KEY_INPUT_PATTERN = /^\s*([A-Za-z][A-Za-z0-9]{1,7})-([1-9][0-9]*)\s*$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function isValidPrefix(value: string): boolean {
  return PREFIX_PATTERN.test(value);
}

function invalid(message: string, hint: string): NovaError {
  return new NovaError('VALIDATION_ERROR', message, { hint });
}

/**
 * Converts arbitrary text into lowercase kebab-case, capped at 64 characters.
 *
 * Throws `VALIDATION_ERROR` (exit 2) when nothing slug-worthy survives, so the
 * caller can ask for an explicit `--slug` instead of inventing one.
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  if (!SLUG_PATTERN.test(slug)) {
    throw invalid(`Cannot derive a slug from ${JSON.stringify(value)}.`, 'Pass an explicit --slug matching ^[a-z][a-z0-9-]{0,63}$.');
  }
  return slug;
}

/** Slug derived from a title or explicit value; empty input is exit 2. */
export function deriveSlug(source: string): string {
  return slugify(source);
}

/**
 * Appends `-2`, `-3`, ... until the slug is free (`novaflow-v100/data` §1.1).
 *
 * Used only for auto-derived slugs; an explicit duplicate is a `STATE_CONFLICT`.
 * The base is truncated so the suffixed slug still fits in 64 characters.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>, maxSuffix = MAX_SLUG_SUFFIX): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= maxSuffix; n += 1) {
    const suffix = `-${n}`;
    const head = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '');
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw invalid(`Every auto-derived slug for "${base}" is taken.`, 'Pass an explicit --slug.');
}

/**
 * Deterministic 2-4 character uppercase base for a project prefix.
 *
 * Word initials carry the identity, digits are appended when they are not part
 * of the initials, and a single-letter base is filled out from its first word:
 * `novaflow-v3` -> `NV3`, `jwt-auth` -> `JA`, `backend` -> `BAC`.
 */
export function derivePrefixBase(slug: string): string {
  const tokens = slug
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return 'NF';

  let base = tokens.map((token) => token.charAt(0)).join('').toUpperCase();

  for (const digit of slug.match(/[0-9]/g) ?? []) {
    if (!base.includes(digit)) base += digit;
  }

  if (base.length < 2) {
    // A one-word slug contributes its own letters: `backend` -> `BAC`.
    base = `${base}${(tokens[0] ?? '').slice(1)}`.toUpperCase().slice(0, 3);
  }
  if (base.length < 2) base = `${base}${tokens.join('').toUpperCase()}`.padEnd(2, 'X');
  if (!/^[A-Z]/.test(base)) base = `N${base}`;
  base = base.replace(/[^A-Z0-9]/g, '');

  return base.slice(0, 4);
}

/**
 * Every prefix candidate for a base, in resolution order: the base itself, then
 * `base2`, `base3`, ... `base99`, each truncated to the 8-character maximum.
 */
export function prefixCandidates(base: string): string[] {
  const candidates = [base.replace(/[^A-Z0-9]/g, '').slice(0, MAX_PREFIX_LENGTH)];
  for (let n = 2; n <= MAX_PREFIX_SUFFIX; n += 1) {
    const suffix = String(n);
    const head = base.slice(0, MAX_PREFIX_LENGTH - suffix.length);
    candidates.push(`${head}${suffix}`);
  }
  return candidates;
}

/**
 * First free prefix for `slug`: `NV3`, then `NV32`..`NV39`, then `NV310`..
 *
 * Exhaustion is exit 2 (`VALIDATION_ERROR`) with a hint to pass `--prefix`.
 */
export function derivePrefix(slug: string, taken: ReadonlySet<string>): string {
  const base = derivePrefixBase(slug);
  for (const candidate of prefixCandidates(base)) {
    if (isValidPrefix(candidate) && !taken.has(candidate)) return candidate;
  }
  throw invalid(`No free project prefix left in the "${base}" family.`, 'Pass an explicit --prefix (^[A-Z][A-Z0-9]{1,7}$).');
}

/** `<PREFIX>-<N>` task key. */
export function formatTaskKey(prefix: string, seq: number): string {
  return `${prefix}-${seq}`;
}

/** Uppercases a key so lookups are case-insensitive (`nv3-1` -> `NV3-1`). */
export function normalizeTaskKey(value: string): string {
  return value.trim().toUpperCase();
}

/** Parses a canonical or lowercase task key; anything else is `null`. */
export function parseTaskKey(value: string): { prefix: string; seq: number } | null {
  const match = TASK_KEY_INPUT_PATTERN.exec(value);
  if (match === null) return null;
  const prefix = (match[1] ?? '').toUpperCase();
  const seq = Number(match[2]);
  if (!TASK_KEY_PATTERN.test(`${prefix}-${seq}`)) return null;
  return { prefix, seq };
}
