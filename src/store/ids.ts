import { randomBytes } from "node:crypto";

/** Crockford base32 — the ULID alphabet. */
export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ULID_RE = new RegExp(`^[${ULID_ALPHABET}]{26}$`);

let lastTime = -1;
let lastRandom = "";

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ULID_ALPHABET.charAt(ms % 32) + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Random part (16 chars), incremented in place for same-millisecond monotonicity. */
function randomPart(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += ULID_ALPHABET.charAt(bytes[i]! % 32);
  return out;
}

function incrementPart(part: string): string {
  const chars = part.split("");
  let i = 15;
  for (; i >= 0; i--) {
    const idx = ULID_ALPHABET.indexOf(chars[i]!);
    if (idx < 31) {
      chars[i] = ULID_ALPHABET.charAt(idx + 1);
      break;
    }
    chars[i] = "0";
  }
  if (i < 0) throw new Error("ULID random part overflow within one millisecond");
  return chars.join("");
}

/**
 * Bare 26-character ULID — the stored and transmitted form
 * (novaflow-v1/data 5.1, Stored id form). Monotonic within the process.
 */
export function ulid(now: number = Date.now()): string {
  let timePart = encodeTime(now);
  let random = randomPart();
  if (now === lastTime) {
    timePart = encodeTime(lastTime);
    random = incrementPart(lastRandom);
  }
  lastTime = now;
  lastRandom = random;
  return timePart + random;
}

export function isUlid(id: string): boolean {
  return ULID_RE.test(id);
}

/**
 * Display form: tasks may render with a `tsk_` prefix for readability only
 * (novaflow-v1/data 5.1). No other entity gets an invented prefix.
 */
export function displayId(kind: "task", bare: string): string {
  if (!isUlid(bare)) throw new Error(`not a bare ULID: ${bare}`);
  return kind === "task" ? `tsk_${bare}` : bare;
}

/** Accepts both the bare ULID and the `tsk_` display form; returns the bare form. */
export function bareId(id: string): string {
  const stripped = id.startsWith("tsk_") ? id.slice(4) : id;
  if (!isUlid(stripped)) throw new Error(`not a ULID or tsk_-prefixed ULID: ${id}`);
  return stripped;
}
