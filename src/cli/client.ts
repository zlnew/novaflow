import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The thin socket transport (srs 4.3 / architecture 8.1): one request
 * line in, one response line out, over the loopback Unix domain socket.
 * The CLI NEVER opens the SQLite store — every command is one op call.
 *
 * Paths (documented):
 *   - NOVAFLOW_HOME  overrides the ~/.novaflow base directory (marker,
 *     pidfile, daemon log, default state.db location).
 *   - NOVAFLOW_SOCK  overrides the socket path outright (tests).
 * The daemon honors the same knobs via its foreground entry (the
 * lifecycle's own socketPath/dbPath options remain the injection seam).
 */

export function novaHome(): string {
  return process.env["NOVAFLOW_HOME"] ?? join(homedir(), ".novaflow");
}

/** The control socket (srs 4.3: ~/.novaflow/novaflow.sock). */
export function socketPath(): string {
  return process.env["NOVAFLOW_SOCK"] ?? join(novaHome(), "novaflow.sock");
}

/** The daemon's default store location (data.md 1.1: ~/.novaflow/state.db). */
export function defaultDbPath(): string {
  return process.env["NOVAFLOW_DB"] ?? join(novaHome(), "state.db");
}

export class DaemonUnreachableError extends Error {
  readonly code = "daemon_unreachable";
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}

/** A structured op failure carrying the wire taxonomy code. */
export class OpFailureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpFailureError";
  }
}

export type OpResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

const CONNECT_TIMEOUT_MS = 2000;
/** Generous: some ops spawn bounded subprocess work (catalog probe ≤ 5 s). */
const RESPONSE_TIMEOUT_MS = 60_000;

let requestId = 0;

/**
 * Send one op, read one response. Throws DaemonUnreachableError (exit 5)
 * when the socket is missing or refuses; throws OpFailureError (exit by
 * the taxonomy map) when the daemon answers with an error frame.
 */
export async function daemonRequest(
  op: string,
  args: Record<string, unknown> = {},
  opts: { socketPath?: string } = {},
): Promise<unknown> {
  const path = opts.socketPath ?? socketPath();
  if (!existsSync(path)) {
    throw new DaemonUnreachableError(
      `no socket at ${path} — is the daemon running? (nova daemon start)`,
    );
  }
  const line = await sendOneLine(path, JSON.stringify({ id: `cli-${++requestId}`, op, args, surface: "human" }));
  let parsed: OpResponse;
  try {
    parsed = JSON.parse(line) as OpResponse;
  } catch {
    throw new Error(`daemon sent a non-JSON response: ${line.slice(0, 200)}`);
  }
  if (parsed.ok === false) {
    throw new OpFailureError(parsed.error.code, parsed.error.message);
  }
  return parsed.data;
}

function sendOneLine(path: string, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      fn();
    };
    const fail = (err: Error): void =>
      done(() => {
        sock.destroy();
        reject(err);
      });
    const sock: Socket = connect(path, () => {
      sock.write(request + "\n");
    });
    sock.setEncoding("utf8");
    const connectTimer = setTimeout(
      () => fail(new DaemonUnreachableError(`connecting to ${path} timed out`)),
      CONNECT_TIMEOUT_MS,
    );
    const responseTimer = setTimeout(
      () => fail(new DaemonUnreachableError(`no response from ${path} within ${RESPONSE_TIMEOUT_MS} ms`)),
      RESPONSE_TIMEOUT_MS,
    );
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        done(() => {
          sock.end();
          resolve(line);
        });
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED etc: a socket FILE without a live daemon
      fail(
        new DaemonUnreachableError(
          `cannot reach the daemon at ${path} (${err.code ?? err.message}) — is it running? (nova daemon start)`,
        ),
      );
    });
  });
}
