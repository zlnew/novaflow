/**
 * NFR-SE-04 secret scrubber for the `events.jsonl` read surface
 * (novaflow-v1/nfr NFR-SE-04; novaflow-v1/data 1.1). The verbatim
 * `events.raw.jsonl` is mode 0600 and never served — this module must
 * NEVER be applied to it. Only the redacted stream passes through here.
 *
 * Documented minimal pattern set (deliberately small and explicit):
 *   - `sk-…`          OpenAI-style API keys
 *   - `ghp_…`/`gho_…` GitHub personal / OAuth tokens
 *   - `AKIA…`         AWS access key ids
 *   - `xoxb-…`        Slack bot tokens
 *   - `Bearer <tok>`  authorization header values
 *   - long hex/base64 runs (≥ 32 chars) under authorization/token/secret/
 *     password/api-key-ish JSON keys — masked whole-value
 */

/** The single mask every rule replaces secrets with. */
export const REDACTION_MASK = "[REDACTED]";

/** Literal token shapes scrubbed anywhere in a line (case where noted). */
const LITERAL_PATTERNS: ReadonlyArray<{ re: RegExp; replace: string }> = [
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replace: REDACTION_MASK },
  { re: /gh[po]_[A-Za-z0-9]{16,}/g, replace: REDACTION_MASK },
  { re: /AKIA[0-9A-Z]{16}/g, replace: REDACTION_MASK },
  { re: /xoxb-[A-Za-z0-9-]{10,}/g, replace: REDACTION_MASK },
  // bearer header VALUE (the scheme word itself is kept)
  { re: /\b([Bb]earer)[ \t]+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 " + REDACTION_MASK },
];

/** Keys whose VALUES are sensitive regardless of shape. */
const SENSITIVE_KEY_RE = /(authorization|token|secret|password|api[-_]?key|credential)/i;

/** A long run of hex/base64-ish characters — the "long hex/base64 run". */
const LONG_RUN_RE = /^[A-Za-z0-9+/=_.-]{32,}$/;

/** String-level pass over free text (and over serialized JSON). */
export function redactText(text: string): string {
  let out = text;
  for (const { re, replace } of LITERAL_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** Key-aware pass over a parsed frame: masks long secret-ish values. */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof v === "string" &&
        SENSITIVE_KEY_RE.test(k) &&
        LONG_RUN_RE.test(v)
      ) {
        out[k] = REDACTION_MASK;
      } else {
        out[k] = redactJson(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Scrub one stdout line for the read surface. A JSON frame is walked
 * key-aware first, then the re-serialized text gets the literal-pattern
 * pass (catches tokens embedded in tool results and prose). A non-JSON
 * line is string-scrubbed, never dropped. The input line is never
 * mutated — the raw stream keeps its verbatim bytes.
 */
export function redactLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return redactText(line);
  }
  const walked = redactJson(parsed);
  return redactText(JSON.stringify(walked));
}
