import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPump } from "../../src/runs/pump.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "novaflow-pump-"));
}

test("the raw file is 0600 from the first byte, even before any line", () => {
  const d = dir();
  try {
    createPump(join(d, "events.raw.jsonl"), join(d, "events.jsonl"));
    const mode = statSync(join(d, "events.raw.jsonl")).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("every stdout line lands VERBATIM in raw and scrubbed in the read surface (FR-LOG-02 / NFR-SE-04)", () => {
  const d = dir();
  try {
    const pump = createPump(join(d, "events.raw.jsonl"), join(d, "events.jsonl"));
    const secretFrame = JSON.stringify({
      type: "tool_execution_end",
      result: { content: [{ text: `sk-${"abc123"}XYZ${"definitelyfake"}99` }] },
      usage: { input: 4500, output: 620 },
    });
    const plainFrame = JSON.stringify({ type: "agent_settled", aborted: false });
    pump.onLine(secretFrame);
    pump.onLine(plainFrame);

    const raw = readFileSync(join(d, "events.raw.jsonl"), "utf8");
    assert.equal(raw, secretFrame + "\n" + plainFrame + "\n"); // byte for byte
    assert.ok(raw.includes(`sk-${"abc123"}XYZ${"definitelyfake"}99`)); // raw keeps the secret

    const redactedLines = readFileSync(join(d, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(redactedLines.length, 2);
    assert.equal(redactedLines[0]?.includes(`sk-${"abc123"}XYZ${"definitelyfake"}99`), false);
    const scrubbed = JSON.parse(redactedLines[0]!) as Record<string, unknown>; // still valid JSON
    assert.ok(scrubbed["type"] === "tool_execution_end");
    JSON.parse(redactedLines[1]!); // parses

    // usage tallied from the frames (api.md §4 top-level usage)
    assert.equal(pump.inputTokens, 4500);
    assert.equal(pump.outputTokens, 620);
    // agent_settled is the completion signal
    assert.equal(pump.settled, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("usage accumulates across multiple frames; message_update zero-usage adds nothing", () => {
  const d = dir();
  try {
    const pump = createPump(join(d, "events.raw.jsonl"), join(d, "events.jsonl"));
    pump.onLine(JSON.stringify({ type: "message_update", usage: { input: 0, output: 0 } }));
    pump.onLine(JSON.stringify({ type: "message_end", usage: { input: 1850, output: 420 } }));
    pump.onLine(JSON.stringify({ type: "message_end", usage: { input: 100, output: 30 } }));
    assert.equal(pump.inputTokens, 1950);
    assert.equal(pump.outputTokens, 450);
    assert.equal(pump.settled, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a non-JSON line is logged verbatim in raw and string-scrubbed in redacted, never dropped", () => {
  const d = dir();
  try {
    const pump = createPump(join(d, "events.raw.jsonl"), join(d, "events.jsonl"));
    pump.onLine("noise with token " + `sk-${"abc123"}XYZ${"definitelyfake"}99` + " inside");
    assert.equal(
      readFileSync(join(d, "events.raw.jsonl"), "utf8"),
      "noise with token sk-abc123XYZdefinitelyfake99 inside\n",
    );
    assert.equal(
      readFileSync(join(d, "events.jsonl"), "utf8"),
      "noise with token [REDACTED] inside\n",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a trailing partial line at stream close is flushed into both files", () => {
  const d = dir();
  try {
    const pump = createPump(join(d, "events.raw.jsonl"), join(d, "events.jsonl"));
    pump.onLine(JSON.stringify({ type: "agent_settled", aborted: false }));
    pump.flushPartial('{"type":"message_upd');
    const raw = readFileSync(join(d, "events.raw.jsonl"), "utf8");
    assert.ok(raw.endsWith('{"type":"message_upd\n'));
    assert.equal(readFileSync(join(d, "events.jsonl"), "utf8").trim().split("\n").length, 2);
    // flushPartial with an empty buffer is a no-op
    pump.flushPartial("");
    assert.equal(existsSync(join(d, "events.raw.jsonl")), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
