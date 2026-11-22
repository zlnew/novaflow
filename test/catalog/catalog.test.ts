import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeCatalog,
  DEFAULT_PROBE_TIMEOUT_MS,
  type ProbeResult,
} from "../../src/catalog.ts";
import { specFile } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const IDENTITY = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  thinking_level: "high",
};
/** Every handshake call is raced against a wall clock — the suite cannot hang. */
const BOUND_MS = 8000;

/**
 * DEBT-004: a spawned stub's boot (node + tsx transform) exceeds a small
 * fixed deadline under full-suite load (measured 231-284 ms for 12
 * concurrent boots), so the pidfile may legitimately not exist yet when the
 * probe's own timeout fires. Poll for it instead of assuming a boot time.
 */
async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${path}`);
}

function readPid(pidfile: string): number {
  return Number(readFileSync(pidfile, "utf8").split("\n")[0]);
}

/** The child must be reaped by the time probeCatalog resolves. */
async function assertReaped(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — the process is gone
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`stub process ${pid} is still alive after probeCatalog resolved`);
}

function unresolved(result: ProbeResult): asserts result is
  { ok: false; code: "profile_unresolved"; reason: string } {
  assert.equal(result.ok, false, `expected a failure result, got: ${JSON.stringify(result)}`);
  assert.equal(result.code, "profile_unresolved");
}

test("golden: the handshake mechanism is pinned to architecture 8.1 and api.md", () => {
  const arch = specFile("architecture.md");
  assert.match(arch, /spawn `pi --mode rpc --model <model>`/);
  assert.match(arch, /No `response` within 5 s/);
  assert.match(arch, /`profile_unresolved`/);
  const api = specFile("api.md");
  assert.match(api, /"type":"get_state"/);
  assert.match(api, /"type":"response"/);
  // The spec's 5 s default deadline.
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 5000);
});

test("ok: a response frame resolves ok with exactly the spec's spawn flags, then SIGTERM + reap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    const started = Date.now();
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: [STUB, "ok", pidfile],
        timeoutMs: 5000,
      }),
    );
    const elapsed = Date.now() - started;

    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    const data = result.data as { pid: number; argv: string[] };

    // Exactly the flags the spec names — `--mode rpc` plus `--model <model>`
    // — and nothing else (the fixture args come first).
    assert.deepEqual(data.argv, [
      "ok",
      pidfile,
      "--mode",
      "rpc",
      "--model",
      IDENTITY.model,
    ]);
    assert.equal(typeof data.pid, "number");
    assert.ok(elapsed < 5000, `handshake should be fast, took ${elapsed} ms`);

    // The response frame arrived, so the probe was SIGTERMed (spec: "then
    // SIGTERM the probe") and the child is gone before we resolved.
    assert.match(readFileSync(pidfile, "utf8"), /SIGTERM/);
    await assertReaped(data.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("silent: no response frame within the deadline → profile_unresolved, child killed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    const started = Date.now();
    // DEBT-004: the deadline must sit ABOVE a stub's boot time, because the
    // child is only observable (and only reapable) once it has executed its
    // first line. A boot measures 231-284 ms on an idle box and the old
    // 300 ms deadline therefore killed the child DURING boot under load —
    // no pidfile, nothing to reap, and the failure looked like a product
    // bug. 2 s keeps an order of magnitude of headroom while the assertion
    // still proves the timeout path (no frame was ever received).
    const deadlineMs = 2000;
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: [STUB, "silent", pidfile],
        timeoutMs: deadlineMs,
      }),
    );
    const elapsed = Date.now() - started;
    unresolved(result);
    assert.match(result.reason, new RegExp(`no response frame within ${deadlineMs} ms`));
    assert.ok(elapsed < 8000, `timeout path must not stall, took ${elapsed} ms`);
    // the stub writes its pidfile at BOOT — under full-suite load that boot
    // can outlast the probe's own 300 ms deadline, so the file may not exist
    // yet when the probe returns (DEBT-004). Poll for it, bounded; the
    // reaping assertion itself is unchanged.
    await waitForFile(pidfile);
    await assertReaped(readPid(pidfile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage: a non-JSON stdout line → profile_unresolved", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: [STUB, "garbage", pidfile],
        timeoutMs: 5000,
      }),
    );
    unresolved(result);
    assert.match(result.reason, /non-JSON/);
    await assertReaped(readPid(pidfile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a response frame with a mismatched echoed id → profile_unresolved (correlation)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: [STUB, "wrongid", pidfile],
        timeoutMs: 5000,
      }),
    );
    unresolved(result);
    assert.match(result.reason, /id mismatch/);
    await assertReaped(readPid(pidfile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-response frame on stdout → profile_unresolved", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    // Not a fixture mode: a one-shot inline stub emitting a session event
    // (message_update) instead of the awaited response frame.
    const script =
      `require("node:fs").writeFileSync(process.argv[1], process.pid + "\\n");` +
      ` process.stdout.write(JSON.stringify({type:"message_update",usage:{input:0,output:0}}) + "\\n");` +
      ` setInterval(() => {}, 1000);`;
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: ["-e", script, pidfile],
        timeoutMs: 5000,
      }),
    );
    unresolved(result);
    assert.match(result.reason, /not a response frame/);
    await assertReaped(readPid(pidfile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an error frame (response with success !== true) → profile_unresolved", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-catalog-"));
  try {
    const pidfile = join(dir, "stub.pid");
    const script =
      `require("node:fs").writeFileSync(process.argv[1], process.pid + "\\n");` +
      ` process.stdout.write(JSON.stringify({type:"response",command:"get_state",id:"cmd_x",success:false}) + "\\n");` +
      ` setInterval(() => {}, 1000);`;
    const result = await withBound(
      t.signal,
      BOUND_MS,
      probeCatalog(IDENTITY, {
        piBin: "node",
        args: ["-e", script, pidfile],
        timeoutMs: 5000,
      }),
    );
    unresolved(result);
    assert.match(result.reason, /error frame/);
    await assertReaped(readPid(pidfile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nonzero child exit before any frame → profile_unresolved", async (t) => {
  const result = await withBound(
    t.signal,
    BOUND_MS,
    probeCatalog(IDENTITY, {
      piBin: "node",
      args: ["-e", "process.exit(3)", "--"],
      timeoutMs: 5000,
    }),
  );
  unresolved(result);
  assert.match(result.reason, /exited before a response frame/);
  assert.match(result.reason, /exit=3/);
});

test("unspawnable pi binary → profile_unresolved, never an unhandled rejection", async (t) => {
  const result = await withBound(
    t.signal,
    BOUND_MS,
    probeCatalog(IDENTITY, { piBin: "/no/such/pi-binary" }),
  );
  unresolved(result);
  assert.match(result.reason, /spawn failed/);
});
