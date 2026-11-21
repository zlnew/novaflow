import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextRun } from "../../src/sched/cron.ts";

/**
 * FR-SCH-01 AC1: the hand-rolled 5-field cron parser and its next-run
 * math (no dependencies, UTC only). The battery pins:
 *   - the per-field syntax subset: `*`, stepped star (star/n), `a`,
 *     `a-b`, `a-b/n`, comma lists of those; day-of-week 0–7 with
 *     BOTH 0 and 7 = Sunday
 *   - the VIXIE DOM/DOW OR RULE (the classic trap): when BOTH
 *     day-of-month and day-of-week are restricted (neither field is
 *     literally `*`), the day matches if EITHER matches; when only one
 *     is restricted, it alone governs
 *   - validation errors name the field and the offending token
 *   - names (MON, JAN, …) are OUT of scope for v1 — rejected truthfully
 */

const MINUTE = 60_000;

function utc(parts: TemplateStringsArray): number {
  return Date.parse(parts[0]!);
}

/* --------------------------------- parseCron --------------------------------- */

test("parseCron: the minimal-convention syntax subset parses", () => {
  for (const expr of [
    "* * * * *",
    "*/5 * * * *",
    "30 * * * *",
    "0 0 15 * 1",
    "0-30/5 * * * *",
    "1,15,30 * * * *",
    "*/15 0-23/2 * * *",
    "0 12 1-7 */2 1",
    "5,10-15/2,20 * * * *",
    "0 0 * * 0",
    "0 0 * * 7", // 7 = Sunday, same as 0
  ]) {
    const res = parseCron(expr);
    assert.equal(res.ok, true, `${expr}: ${res.ok === false ? res.error : ""}`);
  }
});

test("parseCron: day-of-week 0 and 7 are both Sunday (normalized to one set)", () => {
  const zero = parseCron("0 0 * * 0");
  const seven = parseCron("0 0 * * 7");
  assert.equal(zero.ok && seven.ok, true);
  if (zero.ok && seven.ok) {
    assert.deepEqual(zero.fields.dow, seven.fields.dow);
    assert.deepEqual(zero.fields.dow, [0]);
  }
});

test("parseCron: field count is exactly 5 (any whitespace between fields is fine)", () => {
  for (const expr of ["* * * *", "* * * * * *", ""]) {
    const res = parseCron(expr);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /5 fields/);
  }
  // doubled spaces BETWEEN fields are ordinary cron whitespace
  assert.equal(parseCron("*  * * * *").ok, true);
});

test("parseCron: names are out of scope for v1 — rejected with a truthful error", () => {
  const dow = parseCron("0 0 * * MON");
  assert.equal(dow.ok, false);
  if (!dow.ok) {
    assert.match(dow.error, /day-of-week/);
    assert.match(dow.error, /MON/);
    assert.match(dow.error, /not supported in v1/);
  }
  const month = parseCron("0 0 1 JAN *");
  assert.equal(month.ok, false);
  if (!month.ok) {
    assert.match(month.error, /month/);
    assert.match(month.error, /JAN/);
  }
});

test("parseCron: out-of-range and malformed tokens name the field and token", () => {
  const cases: Array<[string, RegExp]> = [
    ["61 * * * *", /minute.*"61".*0-59/],
    ["* 24 * * *", /hour.*"24".*0-23/],
    ["* * 0 * *", /day-of-month.*"0".*1-31/],
    ["* * * 13 *", /month.*"13".*1-12/],
    ["* * * * 8", /day-of-week.*"8".*0-7/],
    ["5-1 * * * *", /minute.*"5-1".*descending/],
    ["*/0 * * * *", /minute.*"\*\/0".*>= 1/],
    ["a * * * *", /minute.*"a".*numeric/],
    ["1/5 * * * *", /minute.*"1\/5"/], // a/n is not in the v1 subset
  ];
  for (const [expr, re] of cases) {
    const res = parseCron(expr);
    assert.equal(res.ok, false, expr);
    if (!res.ok) assert.match(res.error, re);
  }
});

/* ---------------------------------- nextRun ---------------------------------- */

test("nextRun: minute rollover — strictly after, minute-aligned", () => {
  // */5 fires at :00 :05 :10 … from 12:03:30 → 12:05:00
  const next = nextRun("*/5 * * * *", utc`2026-06-01T12:03:30.500Z`);
  assert.equal(next, Date.parse("2026-06-01T12:05:00Z"));
  // from EXACTLY a fire minute → the next one, never the same instant
  const same = nextRun("*/5 * * * *", utc`2026-06-01T12:05:00.000Z`);
  assert.equal(same, Date.parse("2026-06-01T12:10:00Z"));
});

test("nextRun: a fixed minute fires in the NEXT hour once the minute has passed", () => {
  assert.equal(
    nextRun("30 * * * *", utc`2026-06-01T12:31:00Z`),
    Date.parse("2026-06-01T13:30:00Z"),
  );
});

test("nextRun: hour boundaries and midnight rollover", () => {
  assert.equal(
    nextRun("0 0 * * *", utc`2026-06-01T23:59:59.999Z`),
    Date.parse("2026-06-02T00:00:00Z"),
  );
  assert.equal(
    nextRun("59 23 * * *", utc`2026-06-01T23:59:00Z`),
    Date.parse("2026-06-02T23:59:00Z"),
  );
});

test("nextRun: month lengths — a 31st that the month does not have is skipped", () => {
  // April has 30 days: `0 0 31 4 *` (dom restricted, dow unrestricted)
  // never fires in April; after April it waits for the next April…
  // within the 10-year scan bound it fires 2027-04-? — no: the 31st of
  // April does not exist, so the NEXT occurrence is the next leap-free
  // month boundary the expression can match, i.e. never in April; the
  // scan finds the first match only if one exists — there is none, so
  // the expression can only fire in months that HAVE a 31st… but the
  // month field restricts to April. Result: never → null.
  assert.equal(nextRun("0 0 31 4 *", utc`2026-01-01T00:00:00Z`), null);
  // unrestricted month: from April 1 2026 the next 31st is May 31
  assert.equal(
    nextRun("0 0 31 * *", utc`2026-04-01T00:00:00Z`),
    Date.parse("2026-05-31T00:00:00Z"),
  );
});

test("nextRun: Feb 29 in a non-leap year rolls to the next leap year", () => {
  assert.equal(
    nextRun("0 0 29 2 *", utc`2026-01-01T00:00:00Z`),
    Date.parse("2028-02-29T00:00:00Z"), // 2027 is not leap
  );
});

test("nextRun: year rollover", () => {
  assert.equal(
    nextRun("0 0 1 1 *", utc`2026-12-31T23:59:00Z`),
    Date.parse("2027-01-01T00:00:00Z"),
  );
});

test("nextRun: THE VIXIE OR RULE — both dom and dow restricted ⇒ EITHER matches", () => {
  // October 2026: the 15th is a Thursday; Mondays are 5, 12, 19, 26.
  // `0 0 15 * 1` = the 15th OR any Monday.
  // From Sat Oct 10 → Monday Oct 12 (NOT the 15th — a dom-only reading
  // would wait until Oct 15 and be WRONG).
  assert.equal(
    nextRun("0 0 15 * 1", utc`2026-10-10T00:00:00Z`),
    Date.parse("2026-10-12T00:00:00Z"),
  );
  // From Tue Oct 13 → the 15th (a Thursday, NOT a Monday — a dow-only
  // reading would wait until Oct 19 and be WRONG).
  assert.equal(
    nextRun("0 0 15 * 1", utc`2026-10-13T00:00:00Z`),
    Date.parse("2026-10-15T00:00:00Z"),
  );
  // From Fri Oct 16 → Monday Oct 19 (a Monday, not the 15th).
  assert.equal(
    nextRun("0 0 15 * 1", utc`2026-10-16T00:00:00Z`),
    Date.parse("2026-10-19T00:00:00Z"),
  );
  // Both restricted AND month-restricted: same OR rule within October.
  assert.equal(
    nextRun("0 0 15 10 1", utc`2026-10-13T00:00:00Z`),
    Date.parse("2026-10-15T00:00:00Z"),
  );
  assert.equal(
    nextRun("0 0 15 10 1", utc`2026-10-16T00:00:00Z`),
    Date.parse("2026-10-19T00:00:00Z"),
  );
});

test("nextRun: only ONE of dom/dow restricted ⇒ it alone governs (the AND reading collapses)", () => {
  // dom only: fires exactly on the 15th, whatever the weekday
  assert.equal(
    nextRun("0 0 15 * *", utc`2026-10-10T00:00:00Z`),
    Date.parse("2026-10-15T00:00:00Z"), // not the Monday the 12th
  );
  // dow only: fires exactly on Mondays
  assert.equal(
    nextRun("0 0 * * 1", utc`2026-10-13T00:00:00Z`),
    Date.parse("2026-10-19T00:00:00Z"), // not the Thursday the 15th
  );
});

test("nextRun: */n stepping inside the day and the hour", () => {
  assert.equal(
    nextRun("*/15 * * * *", utc`2026-06-01T00:07:00Z`),
    Date.parse("2026-06-01T00:15:00Z"),
  );
  assert.equal(
    nextRun("0 */6 * * *", utc`2026-06-01T07:00:00Z`),
    Date.parse("2026-06-01T12:00:00Z"),
  );
});

test("nextRun: a step beyond the field range degenerates to the range start", () => {
  // `*/90` in minutes steps 0, 90(>59 stop) ⇒ only minute 0
  assert.equal(
    nextRun("*/90 * * * *", utc`2026-06-01T00:01:00Z`),
    Date.parse("2026-06-01T01:00:00Z"),
  );
});

test("nextRun: comma lists pick the first member that is still ahead", () => {
  assert.equal(
    nextRun("10,20,30 * * * *", utc`2026-06-01T12:25:00Z`),
    Date.parse("2026-06-01T12:30:00Z"),
  );
  assert.equal(
    nextRun("10,20,30 * * * *", utc`2026-06-01T12:31:00Z`),
    Date.parse("2026-06-01T13:10:00Z"),
  );
});

test("nextRun: a never-matching date returns null (dead expressions are detectable)", () => {
  assert.equal(nextRun("0 0 31 2 *", utc`2026-01-01T00:00:00Z`), null);
});

test("nextRun: never lags behind the boundary year rollover into the next matching month", () => {
  // from Dec 15 2026, `0 0 1 star/6 *` (1st of Jan and Jul) → Jan 1 2027
  assert.equal(
    nextRun("0 0 1 */6 *", utc`2026-12-15T00:00:00Z`),
    Date.parse("2027-01-01T00:00:00Z"),
  );
});

test("nextRun: rejects an invalid expression instead of silently disabling", () => {
  assert.throws(() => nextRun("not cron", 0), /5 fields/);
});

test("nextRun: everything is minute-aligned UTC (a whole-minute result)", () => {
  const next = nextRun("* * * * *", utc`2026-06-01T12:03:30.999Z`);
  assert.notEqual(next, null);
  assert.equal(next! % MINUTE, 0);
});

test("the documented stepped-star-is-restricted ruling has its own OR-rule regression pin (review round)", () => {
  // `*/2` in day-of-month = the stepped range {1,3,5,…,31} (field min 1) —
  // RESTRICTED per the in-code ruling (Vixie's star-prefix quirk NOT
  // inherited). With day-of-week also restricted, the OR rule applies.
  // March 2026: Mar 2 = Monday; odd days = 1,3,5,….
  // AND-semantics (real Vixie quirk) would wait for Monday-on-an-odd-day
  // (Mar 9); OR semantics must return the next odd day (Mar 3).
  assert.equal(
    nextRun("0 0 */2 * 1", Date.parse("2026-03-02T00:00:01Z")),
    Date.parse("2026-03-03T00:00:00Z"),
  );
  // from Wed Mar 4 (even day, not Monday) → next odd day Mar 5
  assert.equal(
    nextRun("0 0 */2 * 1", Date.parse("2026-03-04T00:00:01Z")),
    Date.parse("2026-03-05T00:00:00Z"),
  );
  // from Sun Mar 8 (even, not Monday) → Mon Mar 9 (matches BOTH arms)
  assert.equal(
    nextRun("0 0 */2 * 1", Date.parse("2026-03-08T00:00:01Z")),
    Date.parse("2026-03-09T00:00:00Z"),
  );
  // month rollover: from Mon Mar 30 (odd, matches) → Tue Mar 31 (odd)
  assert.equal(
    nextRun("0 0 */2 * 1", Date.parse("2026-03-30T00:00:01Z")),
    Date.parse("2026-03-31T00:00:00Z"),
  );
});
