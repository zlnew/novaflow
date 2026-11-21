import { appendFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { redactLine } from "./redact.ts";

/**
 * The two-file event pump (novaflow-v1/data 1.1; srs FR-LOG-02). Every
 * stdout line is appended VERBATIM to `events.raw.jsonl` — created
 * mode 0600 from the first byte, append-only, never served to any
 * surface — and scrubbed (NFR-SE-04) into `events.jsonl`, the only read
 * surface. Appends are synchronous, so no buffered line can be lost on
 * termination.
 *
 * Usage frames are tallied per api.md §4 (top-level usage.input /
 * usage.output); `agent_settled` is the completion signal (FR-TSK-05).
 */
export function createPump(rawPath: string, redactedPath: string) {
  // 0600 from the first byte: create (append-only, never truncate) with
  // the mode, then chmod so no umask can widen it.
  const fd = openSync(rawPath, "a", 0o600);
  closeSync(fd);
  chmodSync(rawPath, 0o600);

  let inputTokens = 0;
  let outputTokens = 0;
  let settled = false;

  function consume(line: string): void {
    // raw: verbatim, byte for byte (the \r, if any, stays; only the LF is
    // the delimiter per api.md §2 rule 1)
    appendFileSync(rawPath, line + "\n");

    // redacted read surface: scrubbed, never raw
    appendFileSync(redactedPath, redactLine(line) + "\n");

    const stripped = line.replace(/\r$/, ""); // api.md §2 rule 2
    let frame: unknown;
    try {
      frame = JSON.parse(stripped);
    } catch {
      return; // framing noise is still logged above, just not tallied
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return;
    const f = frame as { type?: unknown; usage?: unknown };
    if (f.type === "agent_settled") settled = true;
    // Usage semantics (api.md §5): frames carry per-message deltas
    // (message_update usage is 0) with the cumulative totals arriving on
    // message_end — a running sum over all frames reproduces the trace's
    // message_end totals, which is the basis for tallying this way.
    const usage = f.usage;
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as { input?: unknown; output?: unknown };
      if (typeof u.input === "number" && Number.isFinite(u.input) && u.input >= 0) {
        inputTokens += u.input;
      }
      if (typeof u.output === "number" && Number.isFinite(u.output) && u.output >= 0) {
        outputTokens += u.output;
      }
    }
  }

  return {
    /** One complete stdout line (without its trailing LF). */
    onLine(line: string): void {
      consume(line);
    },
    /** A trailing partial line at stream close — verbatim in the raw file too. */
    flushPartial(line: string): void {
      if (line.length === 0) return;
      consume(line);
    },
    /**
     * An engine-authored line (e.g. the 8.4 crash failure frame) for
     * the REDACTED read surface ONLY — never the verbatim raw file.
     */
    appendEngineLine(line: string): void {
      appendFileSync(redactedPath, redactLine(line) + "\n");
    },
    get inputTokens(): number {
      return inputTokens;
    },
    get outputTokens(): number {
      return outputTokens;
    },
    get settled(): boolean {
      return settled;
    },
  };
}

export type Pump = ReturnType<typeof createPump>;
