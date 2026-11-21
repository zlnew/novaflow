import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIsoRunAt, canonicalTimestamp } from "../../src/sched/iso.ts";

/**
 * FR-SCH-01 AC1, single ISO-8601 one-shot timestamps: a real,
 * finite instant, UTC-explicit (Z or a numeric offset — canonicalized
 * to UTC), and NEVER a calendar date without a time (the schedules
 * DDL stores a moment, not a day).
 */

test("parseIsoRunAt: valid instants parse to their UTC milliseconds", () => {
  const cases: Array<[string, number]> = [
    ["2026-06-01T12:34:56Z", Date.parse("2026-06-01T12:34:56Z")],
    ["2026-06-01T12:34Z", Date.parse("2026-06-01T12:34:00Z")], // minute precision is a moment
    ["2026-06-01T12:34:56.123Z", Date.parse("2026-06-01T12:34:56.123Z")],
    ["2026-06-01T12:34:56.5Z", Date.parse("2026-06-01T12:34:56.500Z")],
    ["2028-02-29T00:00:00Z", Date.parse("2028-02-29T00:00:00Z")], // a real leap day
  ];
  for (const [input, ms] of cases) {
    const res = parseIsoRunAt(input);
    assert.equal(res.ok, true, `${input}: ${res.ok === false ? res.error : ""}`);
    if (res.ok) assert.equal(res.ms, ms);
  }
});

test("parseIsoRunAt: a numeric offset is an explicit zone — canonicalized to UTC", () => {
  const res = parseIsoRunAt("2026-06-01T14:34:56+02:00");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.ms, Date.parse("2026-06-01T12:34:56Z"));
  const neg = parseIsoRunAt("2026-06-01T10:34:56-02:00");
  assert.equal(neg.ok, true);
  if (neg.ok) assert.equal(neg.ms, Date.parse("2026-06-01T12:34:56Z"));
});

test("parseIsoRunAt: calendar dates without a time are REJECTED (the DDL stores a moment)", () => {
  for (const input of ["2026-06-01", "2026-06-01Z"]) {
    const res = parseIsoRunAt(input);
    assert.equal(res.ok, false, input);
    if (!res.ok) {
      assert.match(res.error, /time/);
      assert.match(res.error, /moment/);
    }
  }
});

test("parseIsoRunAt: zone-less timestamps are REJECTED — v1 evaluates in UTC, and a naive wall-clock is not an instant", () => {
  const res = parseIsoRunAt("2026-06-01T12:34:56");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /zone|UTC/);
});

test("parseIsoRunAt: impossible calendar dates are REJECTED (no silent normalization)", () => {
  for (const input of [
    "2026-02-30T00:00:00Z",
    "2027-02-29T00:00:00Z", // 2027 is not a leap year
    "2026-06-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-06-00T00:00:00Z",
    "2026-06-01T24:00:00Z",
    "2026-06-01T12:60:00Z",
    "2026-06-01T12:34:60Z",
  ]) {
    const res = parseIsoRunAt(input);
    assert.equal(res.ok, false, input);
    if (!res.ok) assert.match(res.error, /2026-|2027-|invalid/);
  }
});

test("parseIsoRunAt: malformed shapes are rejected truthfully", () => {
  for (const input of [
    "",
    "not a timestamp",
    "2026-06", // month-only: neither a date nor a moment
    "26-06-01T12:34:56Z", // 2-digit year
    "2026-6-1T12:34:56Z", // unpadded
    "2026-06-01 12:34:56Z", // space separator is not ISO-8601 in v1 (documented)
    "2026-06-01T12:34:56.12345Z", // sub-millisecond precision is not stored
    "2026-06-01T12:34:56+0200", // basic-format offset (no colon) is out of the v1 subset
  ]) {
    const res = parseIsoRunAt(input);
    assert.equal(res.ok, false, JSON.stringify(input));
  }
});

test("canonicalTimestamp: the store's canonical DDL form (strftime '%Y-%m-%dT%H:%M:%fZ')", () => {
  const out = canonicalTimestamp(Date.parse("2026-06-01T12:34:56.123Z"));
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(out, "2026-06-01T12:34:56.123Z");
  // sub-minute precision is preserved, never truncated to the minute
  const coarse = canonicalTimestamp(Date.parse("2026-06-01T12:34:00.500Z"));
  assert.equal(coarse, "2026-06-01T12:34:00.500Z");
});
