#!/usr/bin/env node
/**
 * Stub pi binary for tests.
 *
 * Usage: node test/fixtures/pi-stub.ts <mode> [pidfile] [engine flags…]
 *
 * get_state catalog-handshake modes (novaflow-v1/architecture 8.1):
 *   ok | silent | garbage | wrongid
 *   Reads one JSONL frame from stdin; on a get_state command:
 *     - ok       writes a valid response frame (api.md §4 shape) to stdout
 *     - silent   never responds (exercises the 5 s timeout path)
 *     - garbage  writes a non-JSON line (exercises the parse-failure path)
 *     - wrongid  writes a success response frame whose echoed id is bogus
 *
 * run-loop modes (spawned with the engine's full api.md §1 argv):
 *   run-ok         message_update/tool pair/message_end with usage, a valid
 *                  result.json written into --session-dir, then agent_end +
 *                  agent_settled
 *   run-blocked    same stream, result.json with status "blocked"
 *   run-missing    settles, writes no result.json
 *   run-invalid    settles, writes a schema-invalid result.json
 *   run-hang       emits one frame, never settles (timeout path)
 *   run-overspend  emits a message_end whose usage blows the budget, holds
 *   run-crash      emits one frame, then exits 3 mid-stream
 *   run-repair-ok  writes result.json ONLY when the engine-context (read via
 *                  NOVAFLOW_RUN_CONTEXT) says attempt_kind === "repair";
 *                  the first (execution) attempt behaves like run-missing
 *
 * Run modes wait for the engine's `prompt` frame, then write
 * `<session-dir>/stub-receipt.json` recording the prompt message, the
 * engine-context, NOVAFLOW_RUN_CONTEXT, the received argv, and the exact
 * lines they will emit — so tests can assert argv, prompt, context and
 * the verbatim raw stream. All modes exit on stdin EOF. When a pidfile
 * path is given, the stub records its pid on start and appends "SIGTERM"
 * when it takes a SIGTERM, so tests can assert the child was terminated
 * via the spec's named path and reaped.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GET_STATE_MODES = new Set(["ok", "silent", "garbage", "wrongid"]);
const RUN_MODES = new Set([
  "run-ok", "run-blocked", "run-missing", "run-invalid",
  "run-hang", "run-overspend", "run-crash", "run-repair-ok",
]);

const mode: string | undefined = process.argv[2];
const pidfile: string | undefined =
  process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;

if (mode === undefined || (!GET_STATE_MODES.has(mode) && !RUN_MODES.has(mode))) {
  process.stderr.write(`pi-stub: unknown mode ${String(mode)}\n`);
  process.exit(2);
}
if (pidfile) writeFileSync(pidfile, `${process.pid}\n`);

process.on("SIGTERM", () => {
  if (pidfile) appendFileSync(pidfile, "SIGTERM\n");
  process.exit(0);
});

function readStdinLines(onFrame: (frame: Record<string, unknown>) => void): void {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      try {
        onFrame(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a frame; keep reading
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

/* ---------------------------------- get_state handshake modes --------------------------------- */

if (GET_STATE_MODES.has(mode)) {
  readStdinLines((cmd) => {
    if (cmd["type"] !== "get_state") return;
    if (mode === "ok") {
      // api.md §4 response frame shape: {"type":"response","command":...,
      // "id":<echoed command id>,"success":true,"data":{...}}
      process.stdout.write(
        JSON.stringify({
          type: "response",
          command: "get_state",
          id: typeof cmd["id"] === "string" ? cmd["id"] : null,
          success: true,
          data: { pid: process.pid, argv: process.argv.slice(2) },
        }) + "\n",
      );
    } else if (mode === "garbage") {
      process.stdout.write("this is not json\n");
    } else if (mode === "wrongid") {
      // a response frame whose echoed id does not match the sent command
      process.stdout.write(
        JSON.stringify({
          type: "response",
          command: "get_state",
          id: "cmd_bogus",
          success: true,
          data: {},
        }) + "\n",
      );
    }
    // silent: never respond
  });
  // (kept) exit on stdin EOF is wired inside readStdinLines
}

/* -------------------------------------- run-loop modes --------------------------------------- */

if (RUN_MODES.has(mode)) {
  const argValue = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
  };
  const sessionDir = argValue("--session-dir");
  const sessionId = argValue("--session-id");
  if (sessionDir === undefined || sessionId === undefined) {
    process.stderr.write("pi-stub: run modes require --session-dir and --session-id\n");
    process.exit(2);
  }

  // engine-context via NOVAFLOW_RUN_CONTEXT (api.md §6)
  let context: Record<string, unknown> | null = null;
  const contextPath = process.env["NOVAFLOW_RUN_CONTEXT"];
  if (contextPath !== undefined) {
    try {
      context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
    } catch {
      context = null;
    }
  }

  // run-repair-ok is run-ok only on the repair attempt; the execution
  // attempt behaves like run-missing (exercises FR-TSK-06 end to end).
  let effective = mode;
  if (mode === "run-repair-ok") {
    effective = context?.["attempt_kind"] === "repair" ? "run-ok" : "run-missing";
  }

  // api.md §4-shaped frames. Emitted verbatim; tests pin the raw stream
  // against this exact list via stub-receipt.json.
  const messageUpdate = JSON.stringify({
    type: "message_update",
    usage: { input: 0, output: 0 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reading current auth implementation." },
  });
  const toolStart = JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "call_001",
    toolName: "read",
    args: { path: "src/auth.rs" },
  });
  const toolEnd = JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call_001",
    toolName: "read",
    result: { content: [{ type: "text", text: "pub fn handle_auth() { todo!() }" }] },
    isError: false,
    durationMs: 8,
  });
  const messageEnd = (usage: { input: number; output: number }) =>
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Refactoring completed per spec." }] },
      usage,
    });
  const agentEnd = JSON.stringify({ type: "agent_end", willRetry: false });
  const agentSettled = JSON.stringify({ type: "agent_settled", aborted: false });

  const fullStream = (): string[] => [
    messageUpdate,
    toolStart,
    toolEnd,
    messageEnd({ input: 4500, output: 620 }),
    agentEnd,
    agentSettled,
  ];

  const emitted: string[] =
    effective === "run-hang" || effective === "run-crash"
      ? [messageUpdate]
      : effective === "run-overspend"
        ? [messageUpdate, messageEnd({ input: 2_000_000, output: 1_000_000 })]
        : fullStream();

  const taskId = sessionDir.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";

  function writeResult(): void {
    if (effective === "run-ok" || effective === "run-blocked") {
      const artifact = {
        schema_version: "1.0.0",
        task_id: taskId,
        run_id: sessionId,
        status: effective === "run-blocked" ? "blocked" : "completed",
        summary: "Implemented the requested objective end to end.",
        assumptions_made: ["none worth noting"],
        open_questions: [],
        artifacts_modified: [
          { target_alias: "app", path: "src/auth.rs", action: "modified", diff_summary: "rewrote the handler" },
        ],
        feedback_items: [],
        next_recommended_action: effective === "run-blocked" ? "human_review" : "proceed_to_next",
      };
      writeFileSync(join(sessionDir, "result.json"), JSON.stringify(artifact, null, 2) + "\n");
    } else if (effective === "run-invalid") {
      // schema-invalid on purpose: bad status, too-short summary, missing keys
      writeFileSync(join(sessionDir, "result.json"), JSON.stringify({ status: "done", summary: "short" }) + "\n");
    }
  }

  let started = false;
  readStdinLines((frame) => {
    if (started || frame["type"] !== "prompt") return;
    started = true;

    // the receipt records everything the engine handed us, before any output
    writeFileSync(
      join(sessionDir, "stub-receipt.json"),
      JSON.stringify(
        {
          prompt: frame["message"] ?? null,
          context,
          novflow_run_context: contextPath ?? null,
          argv: process.argv.slice(2),
          emitted,
        },
        null,
        2,
      ) + "\n",
    );

    if (effective === "run-ok" || effective === "run-blocked") {
      // result.json is written before the settle signal, like the real extension
      writeResult();
      for (const line of emitted.slice(0, 4)) process.stdout.write(line + "\n");
      for (const line of emitted.slice(4)) process.stdout.write(line + "\n");
    } else if (effective === "run-missing") {
      writeResult(); // no-op: run-missing writes nothing
      for (const line of emitted) process.stdout.write(line + "\n");
    } else if (effective === "run-invalid") {
      writeResult();
      for (const line of emitted) process.stdout.write(line + "\n");
    } else if (effective === "run-hang" || effective === "run-overspend") {
      for (const line of emitted) process.stdout.write(line + "\n");
      // never settles; holds until the engine kills it
    } else if (effective === "run-crash") {
      for (const line of emitted) process.stdout.write(line + "\n");
      process.exit(3);
    }
  });
}
