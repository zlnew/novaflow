import { connect, type Socket } from "node:net";

/**
 * Minimal JSONL socket client for daemon tests — the same wire contract
 * src/daemon/server.ts documents (one request per line, one response
 * per line, per-connection serialization).
 */
export class TestClient {
  private buf = "";
  private waiters: Array<(line: string) => void> = [];

  private constructor(private readonly sock: Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) return;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const w = this.waiters.shift();
        if (w !== undefined) w(line);
      }
    });
  }

  static connect(socketPath: string, timeoutMs = 2000): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect to ${socketPath} timed out`));
      }, timeoutMs);
      const sock = connect(socketPath, () => {
        clearTimeout(timer);
        resolve(new TestClient(sock));
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Send one request object; resolve the parsed response envelope. */
  async request(payload: unknown): Promise<Record<string, unknown>> {
    this.sock.write(JSON.stringify(payload) + "\n");
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response line within 2 s")), 2000);
      this.waiters.push((l) => {
        clearTimeout(timer);
        resolve(l);
      });
    });
    return JSON.parse(line) as Record<string, unknown>;
  }

  /** Send a raw (possibly invalid) line; resolve the raw response line. */
  sendRaw(line: string): Promise<string> {
    this.sock.write(line + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response line within 2 s")), 2000);
      this.waiters.push((l) => {
        clearTimeout(timer);
        resolve(l);
      });
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

/** Poll a predicate until it holds (bounded — never a hanging test). */
export async function waitFor(
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await probe()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
