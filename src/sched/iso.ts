/**
 * FR-SCH-01 AC1, the ISO-8601 one-shot half: a SINGLE timestamp
 * attached as `schedules.run_at`. Validation rules (documented):
 *   - the value must be a real, finite INSTANT: date + time + explicit
 *     zone (`Z`, or a numeric ±HH:MM offset — canonicalized to UTC).
 *     A calendar date without a time is REJECTED: the schedules DDL
 *     stores a moment (an execution instant), not a day; a naive
 *     (zone-less) timestamp is likewise rejected — v1 evaluates in
 *     UTC only, and a wall-clock without a zone is not an instant.
 *   - impossible calendar dates (Feb 30, Feb 29 of a non-leap year)
 *     are rejected — never silently normalized by the Date parser.
 *   - the `T` separator (RFC-3339 form) is required: a space is not
 *     accepted; second/millisecond parts are optional, but sub-ms
 *     precision is out of the v1 subset (the store keeps
 *     millisecond timestamps).
 *
 * `run_at` is stored via canonicalTimestamp — the DDL's canonical
 * `strftime('%Y-%m-%dT%H:%M:%fZ')` form, the same convention every
 * other store writer uses (new Date(...).toISOString()).
 */

export type IsoParse = { ok: true; ms: number } | { ok: false; error: string };

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function fail(input: string, problem: string): { ok: false; error: string } {
  return { ok: false, error: `run_at "${input}" — ${problem}` };
}

/**
 * Validate one ISO-8601 execution instant. Returns its UTC epoch ms,
 * or a truthful error (the message quotes the offending input).
 */
export function parseIsoRunAt(input: string): IsoParse {
  if (typeof input !== "string" || input.trim() === "") {
    return fail(String(input), "a single ISO-8601 timestamp is required");
  }
  const m = ISO_RE.exec(input);
  if (m === null) {
    // distinguish the two documented rejections for a truthful message
    if (/^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:?\d{2})?$/.test(input)) {
      return fail(input, "a calendar date without a time is not a moment — include THH:MM[:SS] and a zone");
    }
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input)) {
      return fail(input, "a zone-less timestamp is not an instant — v1 evaluates in UTC; make it explicit (Z or ±HH:MM)");
    }
    return fail(
      input,
      "not a valid ISO-8601 timestamp in the v1 subset (YYYY-MM-DDTHH:MM[:SS[.mmm]][Z|±HH:MM])",
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const msPart = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));

  if (year < 100) {
    // ECMA-262: Date.UTC remaps years 0-99 to 1900+year — reject instead of
    // silently normalizing (review finding: a validator that never silently
    // normalizes must not let this one through)
    return fail(input, "years below 0100 are not supported (ECMA remaps them)");
  }
  if (month < 1 || month > 12) return fail(input, "the month must be 01-12");
  const days = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  if (day < 1 || day > days) {
    return fail(input, `invalid calendar date — ${year}-${String(month).padStart(2, "0")} has ${days} days`);
  }
  if (hour > 23) return fail(input, "the hour must be 00-23");
  if (minute > 59) return fail(input, "the minute must be 00-59");
  if (second > 59) return fail(input, "the second must be 00-59");

  const zone = m[8]!;
  let offsetMs = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return fail(input, "invalid UTC offset");
    offsetMs = sign * (zh * 60 + zm) * 60_000;
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, msPart) - offsetMs;
  if (!Number.isFinite(utcMs)) return fail(input, "not a finite instant");
  return { ok: true, ms: utcMs };
}

/**
 * The store's canonical timestamp form (the DDL's
 * `strftime('%Y-%m-%dT%H:%M:%fZ')` convention — millisecond-precision
 * UTC, e.g. 2026-06-01T12:34:56.123Z).
 */
export function canonicalTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
