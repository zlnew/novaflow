/**
 * FR-SCH-01 AC1: the hand-rolled 5-field cron parser and next-run math.
 * NO dependencies (v1 constraint). Everything is evaluated in UTC —
 * the `schedules.timezone` column stores UTC only in v1 (see the
 * attach op's UTC-only ruling).
 *
 * The v1 syntax subset per field (the minimal-convention reading of
 * srs "standard 5-field cron expressions"; names — MON, JAN, … — are
 * OUT of scope and rejected with a truthful error), writing STEPPED
 * forms as star/n and range/n:
 *   `*` | star/n (stepped star) | `a` | `a-b` | `a-b/n` | comma lists
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month
 * (1-12), day-of-week (0-7; BOTH 0 and 7 are Sunday).
 *
 * THE VIXIE DOM/DOW OR RULE (the classic trap, implemented and
 * tested): when BOTH day-of-month and day-of-week are restricted
 * (neither field is literally `*`), a day matches if EITHER field
 * matches; when only one is restricted, it alone governs. Note the
 * documented v1 ruling: a STEPPED star (star/n) in a day field counts
 * as RESTRICTED
 * (the rule is read off the literal token `*`, per the card/man-page
 * wording — Vixie's implementation flag treats a `*`-PREFIXED field
 * as starred, a known quirk v1 does not inherit).
 *
 * nextRun(expr, fromMs) is the next occurrence STRICTLY AFTER fromMs,
 * minute-aligned, in UTC. A scan bound of 10 years covers the widest
 * legal gap (Feb 29 across a skipped leap century, 8 years); an
 * expression that never matches a calendar date (e.g. `0 0 31 2 *`)
 * returns null — the attach op refuses such expressions rather than
 * storing a dead schedule.
 */

export const CRON_FIELD_NAMES = [
  "minute",
  "hour",
  "day-of-month",
  "month",
  "day-of-week",
] as const;

export type ParsedCron = {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** The field text was literally `*` (the OR-rule's "restricted" test). */
  domStar: boolean;
  dowStar: boolean;
};

export type CronParse = { ok: true; fields: ParsedCron } | { ok: false; error: string };

const FIELD_RANGES: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/** The scan bound for nextRun: 10 years covers the widest legal gap. */
const SCAN_BOUND_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function fieldError(name: string, token: string, problem: string): string {
  return `cron ${name}: token "${token}" — ${problem}`;
}

/**
 * Parse one field into a sorted, deduplicated value list. `star` is
 * true only for the literal `*` token (the OR-rule's definition of
 * "unrestricted"; a stepped star stays restricted — documented v1 ruling).
 */
function parseField(
  name: string,
  text: string,
  min: number,
  max: number,
): { ok: true; values: number[]; star: boolean } | { ok: false; error: string } {
  if (text === "*") {
    const all: number[] = [];
    for (let v = min; v <= max; v++) all.push(v);
    return { ok: true, values: all, star: true };
  }
  const parts = text.split(",");
  const out = new Set<number>();
  for (const part of parts) {
    // `*`-prefixed forms: `*/n` (the full range stepped)
    if (part.startsWith("*")) {
      const rest = part.slice(1);
      let step = 1;
      if (rest !== "") {
        if (!rest.startsWith("/") || !/^\d+$/.test(rest.slice(1))) {
          return { ok: false, error: fieldError(name, part, "expected `*` or `*/n`") };
        }
        step = Number(rest.slice(1));
        if (step < 1) {
          return { ok: false, error: fieldError(name, part, "the step must be an integer >= 1") };
        }
      }
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    // `a`, `a-b`, or `a-b/n` (`a/n` is NOT in the v1 subset)
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    const singleMatch = rangeMatch === null ? /^(\d+)$/.exec(part) : null;
    if (rangeMatch === null && singleMatch === null) {
      // the truthful name rejection (MON etc. are out of scope for v1)
      if (/^[A-Za-z]{2,4}$/.test(part)) {
        return {
          ok: false,
          error: fieldError(
            name,
            part,
            "names are not supported in v1 — use the numeric range" +
              (name === "day-of-week" ? " 0-7 (both 0 and 7 are Sunday)" : ` ${min}-${max}`),
          ),
        };
      }
      return {
        ok: false,
        error: fieldError(name, part, "expected `*`, `*/n`, or a numeric `a`, `a-b`, `a-b/n`"),
      };
    }
    let lo: number;
    let hi: number | null;
    let step = 1;
    if (rangeMatch !== null) {
      lo = Number(rangeMatch[1]);
      hi = Number(rangeMatch[2]);
      const stepRaw = rangeMatch[3];
      if (stepRaw !== undefined && Number(stepRaw) < 1) {
        return { ok: false, error: fieldError(name, part, "the step must be an integer >= 1") };
      }
      step = stepRaw === undefined ? 1 : Number(stepRaw);
    } else {
      lo = Number(singleMatch![1]);
      hi = null;
    }
    if (lo < min || lo > max) {
      return { ok: false, error: fieldError(name, String(lo), `values must be ${min}-${max}`) };
    }
    if (hi === null) {
      out.add(lo);
      continue;
    }
    if (hi < min || hi > max) {
      return { ok: false, error: fieldError(name, String(hi), `values must be ${min}-${max}`) };
    }
    if (hi < lo) {
      return { ok: false, error: fieldError(name, part, "a descending range is not valid") };
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) {
    return { ok: false, error: fieldError(name, text, "the field matches no values") };
  }
  return { ok: true, values: [...out].sort((a, b) => a - b), star: false };
}

/** Parse a 5-field cron expression (errors name the field + token). */
export function parseCron(expr: string): CronParse {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => f === "")) {
    return {
      ok: false,
      error:
        `a cron expression has exactly 5 fields (minute hour day-of-month month ` +
        `day-of-week), got ${fields.length === 1 && fields[0] === "" ? 0 : fields.length}`,
    };
  }
  const parsed: number[][] = [];
  const stars: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const spec = FIELD_RANGES[i]!;
    const res = parseField(spec.name, fields[i]!, spec.min, spec.max);
    if (!res.ok) return { ok: false, error: res.error };
    let values = res.values;
    if (spec.name === "day-of-week" && values.includes(7)) {
      // 7 = Sunday: normalize onto 0 so the set test is one membership
      values = values.map((v) => (v === 7 ? 0 : v));
      if (values.includes(0)) values = [...new Set(values)].sort((a, b) => a - b);
    }
    parsed.push(values);
    stars.push(res.star);
  }
  return {
    ok: true,
    fields: {
      minute: parsed[0]!,
      hour: parsed[1]!,
      dom: parsed[2]!,
      month: parsed[3]!,
      dow: parsed[4]!,
      domStar: stars[2]!,
      dowStar: stars[4]!,
    },
  };
}

/** The Vixie OR rule: both restricted ⇒ EITHER matches; else the restricted one governs. */
function dayMatches(
  f: ParsedCron,
  dateMs: number,
): boolean {
  const d = new Date(dateMs);
  const domMatch = f.dom.includes(d.getUTCDate());
  const dowMatch = f.dow.includes(d.getUTCDay());
  if (f.domStar || f.dowStar) return domMatch && dowMatch; // the star side matches every day
  return domMatch || dowMatch;
}

/**
 * The next occurrence strictly after fromMs (UTC, minute-aligned),
 * or null when the expression matches no date within the 10-year
 * scan bound. Throws on an unparsable expression — callers validate
 * first; silently returning null would disable a schedule.
 */
export function nextRun(expr: string, fromMs: number): number | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(`invalid cron expression "${expr}": ${parsed.error}`);
  const f = parsed.fields;

  // candidate minutes are strictly after fromMs, minute-aligned
  let cursor = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const bound = fromMs + SCAN_BOUND_MS;

  while (cursor <= bound) {
    const d = new Date(cursor);
    if (f.month.includes(d.getUTCMonth() + 1) && dayMatches(f, cursor)) {
      // the first (hour, minute) of the day's set at or after the cursor's time-of-day
      const fromHm = d.getUTCHours() * 60 + d.getUTCMinutes();
      let hit: number | null = null;
      for (const h of f.hour) {
        for (const m of f.minute) {
          const hm = h * 60 + m;
          if (hm >= fromHm) {
            if (hit === null || hm < hit) hit = hm;
            break; // minutes are sorted: later minutes in this hour can only be larger
          }
        }
        if (hit !== null && hit === fromHm) break; // cannot do better than the cursor itself
      }
      if (hit !== null) {
        const dayStart = cursor - (d.getUTCHours() * 60 + d.getUTCMinutes()) * MINUTE_MS;
        return dayStart + hit * MINUTE_MS;
      }
    }
    // no match left in this day (or the day does not match): jump to next midnight UTC
    const dayStart = cursor - (d.getUTCHours() * 60 + d.getUTCMinutes()) * MINUTE_MS;
    cursor = dayStart + DAY_MS;
  }
  return null;
}
