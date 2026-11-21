import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactLine,
  redactText,
  redactJson,
  REDACTION_MASK,
} from "../../src/runs/redact.ts";

// Fake-by-construction token, assembled at runtime so secret scanners
// never see a literal key shape in this file.
const FAKE_SK = `sk-${"abc123"}XYZ${"definitelyfake"}99`;

test("redactText scrubs the documented minimal token set", () => {
  // The fixture tokens are assembled at runtime from prefix+body pieces so
  // secret scanners never see a literal key shape in this file. They are
  // fake by construction (the AWS one is the documented docs example).
  const [sk, ghp, gho, akia, xoxb] = [
    `sk-${"abc123"}XYZ${"definitelyfake"}99`,
    `ghp_${"0123456789"}${"abcdefghij"}`,
    `gho_${"0123456789"}${"abcdefghij"}`,
    `AKIA${"IOSFODNN7"}${"EXAMPLE"}`,
    `xoxb-${"123456789"}-${"abcdefghij"}`,
  ];
  const cases: Array<[string, string]> = [
    // sk-… (OpenAI-style)
    [`key was ${sk}`, `key was ${REDACTION_MASK}`],
    // ghp_/gho_ (GitHub)
    [`token ${ghp} here`, `token ${REDACTION_MASK} here`],
    [`token ${gho} here`, `token ${REDACTION_MASK} here`],
    // AKIA… (AWS access key id)
    [`aws ${akia} end`, `aws ${REDACTION_MASK} end`],
    // xoxb-… (Slack bot token)
    [`slack ${xoxb} end`, `slack ${REDACTION_MASK} end`],
    // bearer header value
    [
      "Authorization: Bearer abc123def456ghi789jkl012",
      `Authorization: Bearer ${REDACTION_MASK}`,
    ],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactText(input), expected, `input: ${input}`);
  }
});

test("redactText leaves ordinary prose and short values alone", () => {
  const untouched = [
    "the agent read src/auth/pkce.rs and edited the module",
    "usage.input=4500 usage.output=620",
    "cost 0.0228 USD per run",
  ];
  for (const s of untouched) assert.equal(redactText(s), s);
});

test("redactJson masks long hex/base64 runs under authorization/token-ish keys", () => {
  const longHex = "a".repeat(48);
  const longB64 = "AbCd+/12Ef==".repeat(6);
  const out = redactJson({
    config: {
      authorization: longHex,
      api_key: longB64,
      "X-Auth-Token": longHex.toUpperCase(),
      secret_password: longB64,
    },
    harmless: longHex, // long run, but under a non-sensitive key: kept here,
    // masked below by the string-level pass only if it matches a token
    // pattern — plain hex is not one of the documented literal patterns.
  }) as Record<string, unknown>;
  const cfg = out["config"] as Record<string, unknown>;
  assert.equal(cfg["authorization"], REDACTION_MASK);
  assert.equal(cfg["api_key"], REDACTION_MASK);
  assert.equal(cfg["X-Auth-Token"], REDACTION_MASK);
  assert.equal(cfg["secret_password"], REDACTION_MASK);
  assert.equal(out["harmless"], longHex);
});

test("redactJson leaves short or non-secret values under any key alone", () => {
  const out = redactJson({
    authorization: "none",
    token_count: 4500,
    path: "src/auth.rs",
  }) as Record<string, unknown>;
  assert.deepEqual(out, {
    authorization: "none",
    token_count: 4500,
    path: "src/auth.rs",
  });
});

test("redactLine: a JSON frame with an embedded secret comes out valid JSON, scrubbed", () => {
  const line = JSON.stringify({
    type: "tool_execution_end",
    toolName: "read",
    result: {
      content: [
        { type: "text", text: `export OPENAI_KEY=${FAKE_SK}` },
      ],
    },
    isError: false,
    durationMs: 12,
  });
  const redacted = redactLine(line);
  const parsed = JSON.parse(redacted) as {
    result: { content: Array<{ text: string }> };
  };
  assert.equal(parsed.result.content[0]?.text.includes("sk-"), false);
  assert.match(parsed.result.content[0]?.text ?? "", new RegExp(REDACTION_MASK));
  // the frame keeps its shape
  assert.equal(parsed.type, "tool_execution_end");
  assert.equal(parsed.durationMs, 12);
});

test("redactLine: a non-JSON line is string-scrubbed, never dropped", () => {
  const redacted = redactLine(`garbage line with ${FAKE_SK} inside`);
  assert.equal(redacted, `garbage line with ${REDACTION_MASK} inside`);
});

test("redactLine never mutates its input (the raw stream stays verbatim)", () => {
  const line = JSON.stringify({ authorization: "a".repeat(48) });
  const before = line;
  redactLine(line);
  assert.equal(line, before);
});
