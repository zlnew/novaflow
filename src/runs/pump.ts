import { appendFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { redactLine } from "./redact.ts";

/**
 * Per-frame usage tally + the agent_settled completion signal
 * (api.md §4/§5; FR-TSK-05). Extracted from the pump so boot crash
 * recovery (src/daemon/recovery.ts via src/runs/settle-replay.ts)
 * re-tallies an orphaned run's events.raw.jsonl with the SAME intake
 * logic the live stream used — never a reimplementation.
 */
export type FrameTally = {
  /** FRESH prompt tokens only (pi's `usage.input` excludes the cache side). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `usage.cacheRead` summed over the run's frames. */
  readonly cacheReadTokens: number;
  /** `usage.cacheWrite` summed over the run's frames. */
  readonly cacheWriteTokens: number;
  readonly settled: boolean;
  /** Observe one stdout line (CR stripped per api.md §2 rule 2). */
  observe(line: string): void;
};

export function createFrameTally(): FrameTally {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let settled = false;

  function observe(line: string): void {
    const stripped = line.replace(/\r$/, ""); // api.md §2 rule 2
    let frame: unknown;
    try {
      frame = JSON.parse(stripped);
    } catch {
      return; // framing noise is still logged by the pump, just not tallied
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return;
    const f = frame as { type?: unknown; usage?: unknown };
    if (f.type === "agent_settled") settled = true;
    // Usage semantics (api.md §5): frames carry per-message deltas
    // (message_update usage is 0) with the cumulative totals arriving on
    // message_end — a running sum over all frames reproduces the trace's
    // message_end totals, which is the basis for tallying this way.
    //
    // novaflow-v02/spend.md: the prompt side arrives as THREE separate
    // components — `input` (fresh), `cacheRead`, `cacheWrite` — and they are
    // summed into their own counters, never conflated (the measured failure:
    // 498,562 stored input vs 167,885 fresh + 13.65M cache read).
    const usage = f.usage;
    if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
      const u = usage as {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
      };
      const input = nonNegative(u.input);
      if (input !== undefined) inputTokens += input;
      const output = nonNegative(u.output);
      if (output !== undefined) outputTokens += output;
      const cacheRead = nonNegative(u.cacheRead);
      if (cacheRead !== undefined) cacheReadTokens += cacheRead;
      const cacheWrite = nonNegative(u.cacheWrite);
      if (cacheWrite !== undefined) cacheWriteTokens += cacheWrite;
    }
  }

  return {
    observe,
    get inputTokens(): number {
      return inputTokens;
    },
    get outputTokens(): number {
      return outputTokens;
    },
    get cacheReadTokens(): number {
      return cacheReadTokens;
    },
    get cacheWriteTokens(): number {
      return cacheWriteTokens;
    },
    get settled(): boolean {
      return settled;
    },
  };
}

/** A tally-able token count: a finite, non-negative number; anything else is
 *  ignored (a non-cache stream simply reports no cache components). */
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The two-file event pump (novaflow-v1/data 1.1; srs FR-LOG-02). Every
 * stdout line is appended VERBATIM to `events.raw.jsonl` — created
 * mode 0600 from the first byte, append-only, never served to any
 * surface — and scrubbed (NFR-SE-04) into `events.jsonl`, the only read
 * surface. Appends are synchronous, so no buffered line can be lost on
 * termination.
 *
 * Usage frames are tallied per api.md §4 (top-level usage.input / usage.output)
 * plus the cache components pi reports alongside them (usage.cacheRead /
 * usage.cacheWrite — novaflow-v02/spend.md keeps the prompt side's three
 * components apart); `agent_settled` is the completion signal (FR-TSK-05).
 */
export function createPump(rawPath: string, redactedPath: string) {
  // 0600 from the first byte: create (append-only, never truncate) with
  // the mode, then chmod so no umask can widen it.
  const fd = openSync(rawPath, "a", 0o600);
  closeSync(fd);
  chmodSync(rawPath, 0o600);

  const tally = createFrameTally();

  function consume(line: string): void {
    // raw: verbatim, byte for byte (the \r, if any, stays; only the LF is
    // the delimiter per api.md §2 rule 1)
    appendFileSync(rawPath, line + "\n");

    // redacted read surface: scrubbed, never raw
    appendFileSync(redactedPath, redactLine(line) + "\n");

    tally.observe(line);
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
      return tally.inputTokens;
    },
    get outputTokens(): number {
      return tally.outputTokens;
    },
    get cacheReadTokens(): number {
      return tally.cacheReadTokens;
    },
    get cacheWriteTokens(): number {
      return tally.cacheWriteTokens;
    },
    get settled(): boolean {
      return tally.settled;
    },
  };
}

export type Pump = ReturnType<typeof createPump>;
