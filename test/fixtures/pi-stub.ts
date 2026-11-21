#!/usr/bin/env node
/**
 * Stub pi binary for the get_state catalog-handshake tests
 * (novaflow-v1/architecture 8.1 catalog validation mechanism).
 *
 * Usage: node test/fixtures/pi-stub.ts <ok|silent|garbage|wrongid> [pidfile]
 *
 * Reads one JSONL frame from stdin; on a get_state command:
 *   - ok       writes a valid response frame (api.md §4 shape) to stdout
 *   - silent   never responds (exercises the 5 s timeout path)
 *   - garbage  writes a non-JSON line (exercises the parse-failure path)
 *   - wrongid  writes a success response frame whose echoed id is bogus
 *              (exercises the command-id correlation path)
 *
 * The stub exits on stdin EOF. When a pidfile path is given it records its
 * pid on start and appends "SIGTERM" when it takes a SIGTERM, so tests can
 * assert the child was terminated via the spec's named path and reaped.
 */

import { appendFileSync, writeFileSync } from "node:fs";

const mode: string | undefined = process.argv[2];
const pidfile: string | undefined =
  process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;

if (mode !== "ok" && mode !== "silent" && mode !== "garbage" && mode !== "wrongid") {
  process.stderr.write(`pi-stub: unknown mode ${String(mode)}\n`);
  process.exit(2);
}
if (pidfile) writeFileSync(pidfile, `${process.pid}\n`);

process.on("SIGTERM", () => {
  if (pidfile) appendFileSync(pidfile, "SIGTERM\n");
  process.exit(0);
});

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    let cmd: { id?: unknown; type?: unknown } | undefined;
    try {
      cmd = JSON.parse(line) as { id?: unknown; type?: unknown };
    } catch {
      continue; // not a frame; keep reading
    }
    if (cmd?.type !== "get_state") continue;
    if (mode === "ok") {
      // api.md §4 response frame shape: {"type":"response","command":...,
      // "id":<echoed command id>,"success":true,"data":{...}}
      process.stdout.write(
        JSON.stringify({
          type: "response",
          command: "get_state",
          id: typeof cmd.id === "string" ? cmd.id : null,
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
  }
});
process.stdin.on("end", () => process.exit(0));
