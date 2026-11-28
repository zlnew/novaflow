/**
 * 26-character Crockford base32 ULIDs (`novaflow-v100/data` §1.1).
 *
 * Monotonic within a millisecond so identifiers sort in creation order, which
 * lets `ORDER BY id` stand in for `ORDER BY created_at` on equal timestamps.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

/** True when `value` looks like a canonical 26-character ULID. */
export function isUlid(value: string): boolean {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

function freshRandom(): number[] {
  return Array.from(randomBytes(RANDOM_LEN), (byte) => byte & (ENCODING_LEN - 1));
}

function incrementRandom(random: number[]): number[] {
  const next = [...random];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const current = next[index] as number;
    if (current < ENCODING_LEN - 1) {
      next[index] = current + 1;
      return next;
    }
    next[index] = 0;
  }
  return freshRandom();
}

function encodeTime(time: number): string {
  let remaining = time;
  let encoded = '';
  for (let index = 0; index < TIME_LEN; index += 1) {
    const remainder = remaining % ENCODING_LEN;
    encoded = ENCODING.charAt(remainder) + encoded;
    remaining = (remaining - remainder) / ENCODING_LEN;
  }
  return encoded;
}

function encodeRandom(random: number[]): string {
  let encoded = '';
  for (const value of random) encoded += ENCODING.charAt(value);
  return encoded;
}

/** Generates a ULID for `now` (milliseconds). Monotonic for equal timestamps. */
export function ulid(now: number = Date.now()): string {
  const time = Math.max(Math.floor(now), lastTime);
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = freshRandom();
  }
  return encodeTime(time) + encodeRandom(lastRandom);
}
