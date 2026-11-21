import { spawn } from "node:child_process";
import { ulid } from "./store/ids.ts";

/**
 * The get_state catalog-validation handshake
 * (novaflow-v1/architecture 8.1, "Catalog validation mechanism (profiles)"):
 *
 *   spawn `pi --mode rpc --model <model>`, send the `get_state` command, and
 *   await its `response` frame — zero LLM tokens, no prompt is sent; then
 *   SIGTERM the probe. No `response` within 5 s, a non-zero exit, or an
 *   error frame means the model is unresolvable: rejection code
 *   `profile_unresolved`.
 */

/** Spec: "No `response` within 5 s" (architecture 8.1). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * SIGTERM is the spec's probe termination; the SIGKILL backstop uses the
 * spec's only named kill escalation (FR-TSK-08: SIGTERM → 3 s grace → SIGKILL).
 */
export const PROBE_KILL_GRACE_MS = 3000;

export type ProbeIdentity = {
  provider: string;
  model: string;
  thinking_level?: string | undefined;
};

export type ProbeOptions = {
  /** Pi binary to spawn; default "pi". Tests point this at a stub. */
  piBin?: string | undefined;
  /** Extra argv placed before the engine flags (stub script + mode). */
  args?: string[] | undefined;
  /** Deadline for the response frame; default 5000 ms per the spec. */
  timeoutMs?: number | undefined;
};

export type ProbeResult =
  | { ok: true; data: unknown }
  | { ok: false; code: "profile_unresolved"; reason: string };

/** The spec's rejection label for an unresolvable model (architecture 8.1). */
export class ProfileUnresolvedError extends Error {
  readonly code = "profile_unresolved";
  constructor(readonly reason: string) {
    super(`profile_unresolved: ${reason}`);
    this.name = "ProfileUnresolvedError";
  }
}

/**
 * Probe the live Pi model catalog: spawn pi in RPC mode, send `get_state`
 * (api.md §3), await the `response` frame (api.md §4), then SIGTERM. Always
 * resolves — never rejects, never leaves a live child. Failure of any kind
 * (timeout, non-response or error frame, parse failure, non-zero exit, spawn
 * error) resolves as the spec's `profile_unresolved` result, and the child
 * is killed and reaped first.
 */
export function probeCatalog(
  identity: ProbeIdentity,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const piBin = opts.piBin ?? "pi";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Exactly the flags the spec names for the handshake: `--mode rpc` plus
  // `--model <model>` (architecture 8.1 / 5.2). Nothing else.
  const argv = [...(opts.args ?? []), "--mode", "rpc", "--model", identity.model];
  const commandId = `cmd_${ulid()}`;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let buf = "";
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(piBin, argv, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    // Resolves when the child is fully gone — probeCatalog never settles
    // before this, so no caller can observe a live child.
    const exited = new Promise<void>((r) => child.once("exit", () => r()));

    const teardown = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      // The spec names SIGTERM as the probe termination; SIGKILL is the
      // backstop after the spec's grace if the child ignores it.
      child.kill("SIGTERM");
      const killSwitch = setTimeout(
        () => child.kill("SIGKILL"),
        PROBE_KILL_GRACE_MS,
      );
      void exited.then(() => {
        clearTimeout(killSwitch);
        resolve(result);
      });
    };

    const fail = (reason: string): void =>
      teardown({ ok: false, code: "profile_unresolved", reason });

    // An unspawnable child: no process to reap, resolve directly.
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      resolve({
        ok: false,
        code: "profile_unresolved",
        reason: `spawn failed: ${err.message}`,
      });
    });

    // A dead child can never produce a response frame.
    child.once("exit", (code, signal) => {
      if (!settled) {
        fail(
          `pi exited before a response frame (exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""})`,
        );
      }
    });

    deadline = setTimeout(() => {
      fail(`no response frame within ${timeoutMs} ms`);
    }, timeoutMs);

    // EPIPE after an early child death surfaces through exit/error above.
    child.stdin!.on("error", () => {});
    // api.md §3 outbound command frame; §2 rule 1: LF-framed JSON.
    child.stdin!.write(
      JSON.stringify({ id: commandId, type: "get_state" }) + "\n",
    );

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        // api.md §2 rule 2: strip trailing CR before parsing.
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue; // blank lines are framing noise

        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          fail(`non-JSON line from pi stdout: ${JSON.stringify(line.slice(0, 120))}`);
          return;
        }
        const f = frame as { type?: unknown; success?: unknown; id?: unknown; data?: unknown };
        if (f.type !== "response") {
          fail(`frame is not a response frame (type=${JSON.stringify(f.type)})`);
          return;
        }
        if (f.success !== true) {
          fail(`error frame from pi (success=${JSON.stringify(f.success)})`);
          return;
        }
        // Error frames carry no echoed id (api.md: only response frames echo
        // it) — correlate only on the success path.
        if (f.id !== commandId) {
          fail(
            `response frame id mismatch: sent ${JSON.stringify(commandId)}, got ${JSON.stringify(f.id)}`,
          );
          return;
        }
        teardown({ ok: true, data: f.data });
        return;
      }
    });
  });
}
