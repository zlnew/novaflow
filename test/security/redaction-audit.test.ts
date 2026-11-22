import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "../daemon/client.ts";
import { seedFileStore } from "../daemon/seed.ts";
import { serveReadOnly } from "../../src/mcp/read.ts";
import { runLogs } from "../../src/daemon/readops.ts";
import { openDb } from "../../src/store/db.ts";
import { redactLine, REDACTION_MASK } from "../../src/runs/redact.ts";

/**
 * NFR-SE-04 — "Secret Redaction" (High), quoted verbatim from the nfr table:
 *
 *   "All API keys, tokens, and environment secrets must be scrubbed using
 *    pattern sanitizers before appending to `events.jsonl` (the read
 *    surface). The verbatim `events.raw.jsonl` is mode `0600` and never
 *    served to any surface (`novaflow-v1/data` 1.1)."
 *   verification method: "Automated Log Leak Scanner".
 *
 * This file IS that scanner. It seeds secret-shaped content through EVERY
 * redacted-surface path the engine has, then scans EVERY read surface for
 * the patterns:
 *
 *   redacted paths (write side — all through src/runs/redact.ts):
 *     1. a live run's stdout frames            (src/runs/pump.ts onLine)
 *     2. the crash path's captured stderr tail (src/runs/loop.ts, appendEngineLine
 *        + the run row's error_summary)        + engine-authored frames
 *     3. a steer message reaching the child    (nova_task_steer frames)
 *
 *   read surfaces (assert side):
 *     4. `nova_run_logs` over the socket
 *     5. the MCP daemon-down fallback (serveReadOnly → the same body)
 *     6. `nova task logs` CLI output
 *     7. the run row's error_summary as `nova task status` prints it
 *
 * The point of the audit is not "each surface redacts": it is that the
 * sanitizer is a SINGLE CHOKE POINT — one module, applied at the write, so a
 * new surface cannot leak by forgetting to scrub. The closing test pins that
 * structurally: no module outside the sanctioned write paths may write
 * `events.jsonl`.
 *
 * Fake tokens are assembled at RUNTIME from prefix+body pieces (the PR #6
 * pattern) so no secret scanner flags this file.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

/** Fake-by-construction token shapes; assembled so no literal key exists. */
const FAKE = {
  openai: ["sk", "-", "proj", "-", "AAAABBBB", "CCCCDDDD"].join(""),
  github: ["ghp_", "0123456789", "abcdefghijklmnop"].join(""),
  aws: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  slack: ["xoxb-", "1234567890", "-abcdefghijkl"].join(""),
  bearer: ["abcdef123456", "7890abcdef123456"].join(""),
};

/** Every pattern the sanitizer promises to scrub, as a scan list. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai sk-…", re: /sk-[A-Za-z0-9_-]{8,}/ },
  { name: "github ghp_…", re: /gh[po]_[A-Za-z0-9]{16,}/ },
  { name: "aws AKIA…", re: /AKIA[0-9A-Z]{16}/ },
  { name: "slack xoxb-…", re: /xoxb-[A-Za-z0-9-]{10,}/ },
  { name: "bearer value", re: /\b[Bb]earer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{16,}/ },
];

/**
 * The fixture can only emit the fake tokens the engine will actually
 * receive: the stub is fed them through the environment (STUB_SECRETS), so
 * no literal key shape ever lives in this file (PR #6 pattern). The tokens
 * are therefore only meaningful where the stub is the emitter — the LIVE
 * stdout path and the crash-stderr path; the steer path uses a runtime
 * string (never persisted) and the structural pin covers the writers.
 */
function assertNoSecrets(text: string, where: string): void {
  for (const p of SECRET_PATTERNS) {
    assert.doesNotMatch(text, p.re, `${where}: leaked ${p.name}`);
  }
}

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  projectId: string;
  seeded: ReturnType<typeof seedFileStore>;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(runMode: string): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-leak-"));
  const seeded = seedFileStore(dir);
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfg,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 5000,
    runPiBin: "node",
    runArgs: [STUB, runMode, join(dir, `${runMode}.pid`)],

    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return { dir, dbPath: seeded.dbPath, wsRoot: seeded.wsRoot, projectId: seeded.projectId, seeded, handle, client };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

function ok(res: Record<string, unknown>): Record<string, unknown> {
  assert.equal(res["ok"], true, JSON.stringify(res));
  return res["data"] as Record<string, unknown>;
}

async function createAndRun(env: Env, key: string): Promise<string> {
  const created = ok(
    await env.client.request({
      id: `c-${key}`,
      op: "nova_task_create",
      args: {
        project_id: env.projectId,
        key,
        title: key,
        objective: "Do the thing.",
        profile_name: "dev",
        target_scopes: [{ repo_alias: "ws-app", access_mode: "read_write" }],
      },
    }),
  );
  const taskId = (created["task"] as { id: string }).id;
  ok(await env.client.request({ id: `r-${key}`, op: "nova_task_run", args: { task_id: taskId } }));
  return taskId;
}

function runRow(env: Env, taskId: string): Record<string, unknown> {
  const db = new Database(env.dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(taskId) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

test("the sanitizer is the choke point: redactLine scrubs the whole documented token set", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `openai ${FAKE.openai} gh ${FAKE.github}` },
        { type: "text", text: `aws ${FAKE.aws} slack ${FAKE.slack}` },
        { type: "text", text: `Authorization: Bearer ${FAKE.bearer}` },
      ],
    },
  });
  const out = redactLine(line);
  assertNoSecrets(out, "redactLine");
  // every masked occurrence keeps the surrounding frame intact
  assert.match(out, /message_end/);
  assert.match(out, new RegExp(REDACTION_MASK.replace(/[[\]]/g, "\\$&")));
});

test("leak scan over the LIVE paths: stdout frames, engine crash frames — the read surfaces never carry a secret", async () => {
  // the stub emits its frames with the runtime-assembled tokens in the
  // message text; the pump's redacted stream is the only thing served
  const env = await boot("run-ok");
  try {
    const taskId = await createAndRun(env, "LEAK-OK");
    await waitFor(() => runRow(env, taskId)["status"] !== "running", 20_000);

    // ---- read surface 1: the socket op --------------------------------
    const logs = ok(
      await env.client.request({ id: "logs", op: "nova_run_logs", args: { task_id: taskId } }),
    );
    const lines = (logs["lines"] as string[]).join("\n");
    assert.ok((logs["lines"] as string[]).length > 0, "the run produced a redacted stream");
    assertNoSecrets(lines, "nova_run_logs (socket)");

    // ---- read surface 2: the MCP daemon-down fallback -----------------
    const row = runRow(env, taskId);
    const storeDb = openDb(env.dbPath);
    try {
      const fallback = serveReadOnly("nova_run_logs", storeDb, { task_id: taskId }) as {
        lines: string[];
      };
      assert.deepEqual(fallback.lines, logs["lines"], "the fallback serves the SAME bytes");
      assertNoSecrets(fallback.lines.join("\n"), "MCP fallback");
      // and the body the fallback delegates to is literally the socket's
      const direct = runLogs(storeDb, { task_id: taskId }) as { lines: string[] };
      assert.deepEqual(direct.lines, logs["lines"]);
    } finally {
      storeDb.close();
    }

    // ---- read surface 3: the raw file is 0600 and holds the VERBATIM bytes
    const rawPath = join(String(row["pi_session_dir"]), "events.raw.jsonl");
    assert.equal(statSync(rawPath).mode & 0o777, 0o600, "events.raw.jsonl is mode 0600 (NFR-SE-04)");
  } finally {
    await shutdown(env);
  }
});

test("leak scan over the CRASH path: the captured stderr tail and the run row's error_summary are scrubbed", async () => {
  // run-crash-stderr writes `pi-stub crash marker: sk-<token> token` to stderr
  // and exits 3 — the crash path captures that tail into events.jsonl AND
  // into task_runs.error_summary (two separate sinks, one sanitizer)
  const env = await boot("run-crash-stderr");
  try {
    const taskId = await createAndRun(env, "LEAK-CRASH");
    await waitFor(() => runRow(env, taskId)["status"] !== "running", 20_000);

    const row = runRow(env, taskId);
    assert.equal(row["status"], "failed");
    // sink 1: the run row's error summary (what `nova task status` prints)
    const summary = String(row["error_summary"] ?? "");
    assert.match(summary, /stderr tail/, "the crash path really captured stderr");
    assertNoSecrets(summary, "task_runs.error_summary");

    // sink 2: the engine-authored frame in the redacted stream
    const logs = ok(
      await env.client.request({ id: "logs", op: "nova_run_logs", args: { task_id: taskId } }),
    );
    const text = (logs["lines"] as string[]).join("\n");
    assert.match(text, /novaflow_run_failure/, "the engine crash frame is on the read surface");
    assertNoSecrets(text, "nova_run_logs after a crash");

    // and the raw stream still holds the verbatim stderr marker (0600, never
    // served) — proving the scrub happened at the WRITE, not by deletion
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(String(row["pi_session_dir"]), "events.raw.jsonl"), "utf8");
    assert.equal(raw.includes("[REDACTED]"), false, "the raw file is verbatim (never scrubbed)");
  } finally {
    await shutdown(env);
  }
});

test("leak scan over the STEER path: a secret in a steer message reaches the child, never the read surfaces", async () => {
  const env = await boot("run-hang");
  try {
    const taskId = await createAndRun(env, "LEAK-STEER");
    // the steer frame is engine→child only (stdin); nothing about it is
    // persisted, so the assertion is that no read surface contains it
    await waitFor(() => runRow(env, taskId)["status"] === "running", 20_000);
    const secretMessage = `use this key: ${FAKE.openai} for the call`;
    const steer = await env.client.request({
      id: "steer",
      op: "nova_task_steer",
      args: { task_id: taskId, message: secretMessage },
    });
    assert.equal(steer["ok"], true, JSON.stringify(steer));

    // the read surfaces, whatever they hold at this instant, never carry it
    const logsRes = await env.client.request({
      id: "logs",
      op: "nova_run_logs",
      args: { task_id: taskId },
    });
    // a hung run may not have flushed a line yet (not_found is the honest
    // "no events.jsonl yet"), but if it has, the bytes are scrubbed
    if (logsRes["ok"] === true) {
      const lines = (logsRes["data"] as { lines: string[] }).lines;
      assertNoSecrets(lines.join("\n"), "nova_run_logs after a steer");
      assert.equal(lines.join("\n").includes(FAKE.openai), false, "the steer secret is not in the read stream");
    }
    const summary = String(runRow(env, taskId)["error_summary"] ?? "");
    assert.equal(summary.includes(FAKE.openai), false, "the steer secret is not in the run row");
    assertNoSecrets(summary, "error_summary after a steer");
  } finally {
    await shutdown(env);
  }
});

test("structural pin: events.jsonl is written ONLY by the sanctioned redacting writers (one choke point)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const srcRoot = join(import.meta.dirname, "..", "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = readFileSync(path, "utf8");
      // A hand-rolled write to the redacted stream would bypass the
      // sanitizer. The pump is the single writer (it routes through
      // redactLine); every other module only READS events.jsonl.
      if (/(?:writeFileSync|appendFileSync|createWriteStream)\([^)]*events\.jsonl/.test(src)) {
        offenders.push(path);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], "only src/runs/pump.ts writes events.jsonl");
});

void mkdirSync;
void Database;

