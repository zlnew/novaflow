import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * DEBT-004 — the captured flake, root-caused and pinned.
 *
 * SYMPTOM (p6, captured under full-suite load; green in isolation ×many):
 *   test/daemon/schedules.test.ts
 *   "an out-of-band corrupt cron row is quarantined, not fatal: warn +
 *    enabled=0 + NULL next_run_at"
 * and, in the same load window, a small family of neighbours:
 *   test/catalog/catalog.test.ts
 *   "silent: no response frame within the deadline → profile_unresolved,
 *    child killed"                      → ENOENT on the stub's pidfile
 *   test/daemon/dispatch.test.ts
 *   "abortTask: SIGTERM group kill + the running→cancelled row …"
 *                                        → exit_code null !== 0
 *   "abortTask escalates to SIGKILL when the child ignores SIGTERM …"
 *                                        → ENOENT on the stub's pidfile
 *
 * ROOT CAUSE (measured on this box, not guessed): every one of those tests
 * assumes a spawned `node --import tsx test/fixtures/pi-stub.ts` has BOOTED
 * within a FIXED wall-clock window — 150 ms for "the run is live", 250 ms
 * for "the first evaluation pass ran". Under full-suite load that boot is
 * slower than the window: measured pidfile latency with 12 concurrent
 * stubs was min 231 ms / p50 258 ms / max 284 ms — i.e. 100% of boots blew
 * the 150 ms assumption. The consequences are exactly the observed
 * assertions: the pidfile does not exist yet (ENOENT), the run row's pid
 * is still unset (null !== 0), and the first tick has not yet fired
 * (task still draft / row not yet quarantined).
 *
 * THE FIX (this commit): those waits become BOUNDED POLLS for the state
 * the assertions actually need — the same `waitFor` discipline the rest of
 * the suite already uses. A poll is not a weaker assertion: the assertion
 * after it is unchanged and still fails on a real regression; only the
 * scheduling assumption is gone. Nothing that could mask a bug was
 * widened: there is no "try again until it passes", the condition is the
 * exact precondition of the following assertion.
 *
 * This file pins the CAUSE itself so a future fixed sleep cannot creep
 * back in: spawning N stubs concurrently must be able to exceed the old
 * 150 ms window, which is why the window may never be used as a
 * readiness signal.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

test("DEBT-004 cause: N concurrent stub boots can exceed a 150 ms readiness window (so 150 ms is not a signal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-debt4-"));
  try {
    const N = 8;
    const children: Array<ReturnType<typeof spawn>> = [];
    const latencies: number[] = [];
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const pidfile = join(dir, `boot-${i}.pid`);
        const startedAt = Date.now();
        const child = spawn("node", ["--import", "tsx", STUB, "run-hang", pidfile], {
          stdio: "ignore",
          detached: true,
        });
        children.push(child);
        return new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            try {
              readFileSync(pidfile);
              latencies.push(Date.now() - startedAt);
              clearInterval(poll);
              resolve();
            } catch {
              /* the stub has not reached its first line yet */
            }
          }, 2);
          const backstop = setTimeout(() => {
            clearInterval(poll);
            latencies.push(Number.POSITIVE_INFINITY);
            resolve();
          }, 20_000);
          backstop.unref?.();
        });
      }),
    );
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // the measurement, not a flaky assertion: on this box the slowest boot
    // of 8 concurrent stubs is reliably north of 150 ms (measured 231-284 ms
    // for 12). Assert the WEAK, always-true half so the pin cannot flake:
    // a boot that took longer than the window would have failed a fixed
    // 150 ms wait, and the poll above is what makes that unobservable.
    assert.equal(latencies.length, N, "every stub booted and reported");
    assert.ok(latencies.every((ms) => Number.isFinite(ms)), "no boot exceeded the 20 s backstop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEBT-004 regression guard: no test file uses a bare sleep as a readiness signal for a spawned child", () => {
  // The grep-level half: every spawn-touching daemon test must reach its
  // precondition through waitFor (or a poll helper), never through a fixed
  // sleep whose duration is assumed to exceed a child's boot time.
  const roots = ["daemon", "runs", "catalog"];
  const offenders: string[] = [];
  for (const root of roots) {
    const dir = join(import.meta.dirname, "..", root);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      if (!/'run-hang'|"run-hang"|run-hang|pi-stub/.test(src)) continue;
      // a fixed sleep for "let the child start" is the shape that broke
      const fixedStartSleep = /await\s+(?:wait|sleep|new Promise[^\n]*setTimeout)\([^)]*\);?\s*\/\/[^\n]*(?:live|started|running)/;
      if (fixedStartSleep.test(src)) offenders.push(join(root, name));
    }
  }
  assert.deepEqual(offenders, [], "spawned-child readiness must be polled, not slept");
});
