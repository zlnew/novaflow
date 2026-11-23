import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import novaflowFactory, {
  DaemonUnreachableError,
  WAKE_DEFAULT_INTERVAL_MS,
  createWakeWatcher,
  loadWakeConfig,
  newWakeState,
  parseWakeConfig,
  pollWakeStep,
  wakeIntervalMs,
  type WakePage,
  type WakeRequest,
  type WakeScheduler,
  type WakeTransitionRow,
} from "../../extensions/novaflow.ts";

/**
 * The wake watcher (novaflow-v02/wake.md, frozen): a ~2 s cursor poll of
 * `nova_transitions_since` that injects one follow-up message per
 * human-attention transition.
 *
 * DETERMINISM: every test drives the exported poll step (or the watcher's own
 * `poll()`) with an injected request seam — no daemon, no sockets — and the
 * timer seam is a fake scheduler, so nothing here waits on a wall clock. The
 * only real scheduling is `flush()`, which drains the microtask/macrotask
 * queue AFTER an action that must have done nothing.
 */

/* --------------------------------- fixtures --------------------------------- */

const taskId = (n: number): string => `01HZWAKE${String(n).padStart(18, "0")}`;
const runId = (n: number): string => `01HZRUNX${String(n).padStart(18, "0")}`;
const chainId = (n: number): string => `01HZCHAI${String(n).padStart(18, "0")}`;

const TASK_A = taskId(1);
const TASK_B = taskId(2);
const TASK_C = taskId(3);
const TASK_D = taskId(4);
const TASK_E = taskId(5);
const RUN_A = runId(1);
const CHAIN_1 = chainId(1);

function row(cursor: number, toState: string, over: Partial<WakeTransitionRow> = {}): WakeTransitionRow {
  return {
    cursor,
    task_id: TASK_A,
    run_id: RUN_A,
    chain_run_id: null,
    task_key: "WC1",
    chain_slug: null,
    from_state: "running",
    to_state: toState,
    trigger_type: "engine",
    actor: "daemon-dispatch",
    reason: null,
    created_at: "2026-11-23T10:00:00.000Z",
    ...over,
  };
}

function page(transitions: WakeTransitionRow[], nextCursor: number, hasMore = false): WakePage {
  return { transitions, next_cursor: nextCursor, has_more: hasMore };
}

type Call = { op: string; args: Record<string, unknown> };

/** A request seam that records every op and answers from the handler. */
function stubRequest(handler: (op: string, args: Record<string, unknown>) => unknown): {
  calls: Call[];
  request: WakeRequest;
} {
  const calls: Call[] = [];
  const request: WakeRequest = async (op, args) => {
    calls.push({ op, args });
    return handler(op, args);
  };
  return { calls, request };
}

type Note = { message: string; severity: string | undefined };

function fakeCtx(): { ctx: Pick<ExtensionContext, "ui">; notes: Note[] } {
  const notes: Note[] = [];
  const ctx = {
    ui: {
      notify: (message: string, severity?: "info" | "warning" | "error"): void => {
        notes.push({ message, severity });
      },
    },
  };
  return { ctx: ctx as unknown as Pick<ExtensionContext, "ui">, notes };
}

type Sent = { content: unknown; options: unknown };

/** The minimal pi double the watcher's default injection rides. */
function fakePi(): { api: ExtensionAPI; sent: Sent[] } {
  const sent: Sent[] = [];
  const api = {
    on: () => () => undefined,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    sendUserMessage: (content: unknown, options?: unknown): void => {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  return { api, sent };
}

type FakeTimer = { id: number; ms: number; fn: () => void };

/** The timer seam: records intervals, so a test drives ticks explicitly. */
function fakeScheduler(): {
  scheduler: WakeScheduler;
  timers: FakeTimer[];
  cleared: number[];
} {
  const timers: FakeTimer[] = [];
  const cleared: number[] = [];
  let next = 1;
  const scheduler: WakeScheduler = {
    setInterval: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ id, ms, fn });
      return id;
    },
    clearInterval: (handle: unknown) => {
      const id = Number(handle);
      cleared.push(id);
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    },
  };
  return { scheduler, timers, cleared };
}

/** Drain the microtask + one macrotask turn: for assertions about NOTHING happening. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A page queue keyed by call order — the transitions seam for a two-poll test. */
/* --------------------------------- the tests --------------------------------- */

test("wake: the first poll seeds at head — pre-existing transitions wake on NOTHING", async () => {
  const { calls, request } = stubRequest((op) => {
    assert.equal(op, "nova_transitions_since");
    return page(
      [
        row(9, "awaiting_gate", { task_key: "WC1" }),
        row(10, "failed", { task_key: "WC2", task_id: TASK_B }),
        row(11, "completed", { task_key: "WC3", task_id: TASK_C, chain_run_id: CHAIN_1 }),
      ],
      11,
    );
  });
  const state = newWakeState();
  const res = await pollWakeStep(state, { request });

  assert.equal(res.polled, true);
  assert.equal(res.seeded, true);
  assert.deepEqual(res.wakes, [], "pre-existing transitions are history, not news");
  assert.equal(state.cursor, 11, "the seed cursor is the head page's highest rowid");
  assert.equal(calls.length, 1, "no artifact/chain reads on the seed page");
  assert.equal(calls[0]!.args["cursor"], 0, "the seed asks cursor 0 (start at head)");
  assert.equal("workspace_id" in calls[0]!.args, false, "no wake.workspace = every workspace");
});

test("wake: a new awaiting_gate row wakes exactly once, naming the task and the follow-up calls", async () => {
  const gate = row(13, "awaiting_gate", {
    task_key: "WC1",
    from_state: "running",
    trigger_type: "engine",
    actor: "daemon-settle",
  });
  const { calls, request } = stubRequest((op, args) => {
    if (op === "nova_transitions_since") {
      return Number(args["cursor"]) === 0 ? page([row(11, "validating")], 11) : page([gate], 13);
    }
    if (op === "nova_result_get") {
      assert.equal(args["task_id"], TASK_A);
      return { run_id: RUN_A, artifact: { status: "blocked" } };
    }
    throw new Error(`unexpected op ${op}`);
  });
  const state = newWakeState();
  assert.equal((await pollWakeStep(state, { request })).wakes.length, 0, "the seed wakes nothing");

  const res = await pollWakeStep(state, { request });
  assert.equal(res.wakes.length, 1, "exactly one wake for one transition row");
  const wake = res.wakes[0]!;
  assert.equal(wake.kind, "awaiting_gate");
  assert.equal(wake.task_id, TASK_A);
  assert.equal(wake.cursor, 13);
  for (const needle of [
    "[novaflow]",
    "WC1",
    TASK_A,
    "awaiting_gate",
    `nova_task_status ${TASK_A}`,
    `nova_result_get ${TASK_A}`,
    `nova_gate_approve ${TASK_A}`,
    `nova_gate_reject ${TASK_A}`,
    "blocked",
    "refusal to fix",
  ]) {
    assert.ok(wake.text.includes(needle), `the wake message names ${needle}: ${JSON.stringify(wake.text)}`);
  }
  assert.equal(calls.filter((c) => c.op === "nova_result_get").length, 1, "one artifact read per gate wake");

  // the second poll of the same (advanced) cursor sees no new rows
  const again = await pollWakeStep(state, { request });
  assert.equal(again.wakes.length, 0);
});

test("wake: failed wakes; queued/running/validating/changes_requested and a standalone completed do not", async () => {
  const noisy = [
    row(6, "queued", { task_key: "WC2", task_id: TASK_B }),
    row(7, "running", { task_key: "WC3", task_id: TASK_C }),
    row(8, "validating", { task_key: "WC4", task_id: TASK_D }),
    row(9, "changes_requested", { task_key: "WC5", task_id: TASK_E }),
    row(10, "completed", { task_key: "WC6", task_id: taskId(6) }),
  ];
  const failed = row(11, "failed", { task_key: "WC7", task_id: taskId(7) });
  let transitionsCalls = 0;
  const { request } = stubRequest((op) => {
    assert.equal(op, "nova_transitions_since");
    transitionsCalls++;
    return transitionsCalls === 1 ? page([], 0) : page([...noisy, failed], 11);
  });
  const state = newWakeState();
  await pollWakeStep(state, { request });

  const res = await pollWakeStep(state, { request });
  assert.equal(res.wakes.length, 1, "only the failed row wakes (a standalone completed never does)");
  assert.equal(res.wakes[0]!.kind, "failed");
  assert.equal(res.wakes[0]!.task_id, taskId(7));
  assert.ok(res.wakes[0]!.text.includes("WC7"));
  assert.ok(res.wakes[0]!.text.includes(`nova_task_status ${taskId(7)}`));
});

test("wake: a chain member's completed wakes once, inferred from nova_chain_status", async () => {
  const member = row(21, "completed", {
    task_key: "WC9",
    task_id: TASK_C,
    chain_run_id: CHAIN_1,
    chain_slug: "prj",
  });
  let transitionsCalls = 0;
  const { calls, request } = stubRequest((op, args) => {
    if (op === "nova_transitions_since") {
      transitionsCalls++;
      return transitionsCalls === 1 ? page([], 0) : page([member], 21);
    }
    if (op === "nova_chain_status") {
      assert.equal(args["chain_run_id"], CHAIN_1);
      return {
        chain: { id: CHAIN_1, state: "completed" },
        members: [
          { id: TASK_A, state: "completed" },
          { id: TASK_C, state: "completed" },
        ],
      };
    }
    throw new Error(`unexpected op ${op}`);
  });
  const state = newWakeState();
  await pollWakeStep(state, { request });

  const res = await pollWakeStep(state, { request });
  assert.equal(res.wakes.length, 1, "chain completion is ONE wake, not one per member");
  const wake = res.wakes[0]!;
  assert.equal(wake.kind, "chain_completed");
  assert.equal(wake.chain_run_id, CHAIN_1);
  for (const needle of [CHAIN_1, "prj", "WC9", `nova_chain_status ${CHAIN_1}`]) {
    assert.ok(wake.text.includes(needle), `the chain wake names ${needle}: ${JSON.stringify(wake.text)}`);
  }
  assert.equal(calls.filter((c) => c.op === "nova_chain_status").length, 1);

  // a later poll never repeats it
  const again = await pollWakeStep(state, { request });
  assert.equal(again.wakes.length, 0);
});

test("wake: the chain row landing a beat after the member's row still wakes, exactly once", async () => {
  const member = row(21, "completed", { task_key: "WC9", task_id: TASK_C, chain_run_id: CHAIN_1 });
  let chainState = "active";
  let transitionsCalls = 0;
  const { request } = stubRequest((op) => {
    if (op === "nova_transitions_since") {
      transitionsCalls++;
      return transitionsCalls === 1 ? page([], 0) : page([member], 21);
    }
    if (op === "nova_chain_status") {
      return {
        chain: { id: CHAIN_1, state: chainState },
        members:
          chainState === "completed"
            ? [{ id: TASK_A, state: "completed" }, { id: TASK_C, state: "completed" }]
            : [{ id: TASK_A, state: "running" }, { id: TASK_C, state: "completed" }],
      };
    }
    throw new Error(`unexpected op ${op}`);
  });
  const state = newWakeState();
  await pollWakeStep(state, { request });

  const racing = await pollWakeStep(state, { request });
  assert.equal(racing.wakes.length, 0, "an active chain is not a chain completion");
  assert.equal(state.pendingChains.size, 1, "the chain stays pending for the next poll");

  chainState = "completed";
  const settled = await pollWakeStep(state, { request });
  assert.equal(settled.wakes.length, 1, "the deferred check delivers the wake exactly once");
  assert.equal(settled.wakes[0]!.kind, "chain_completed");
  assert.equal(state.pendingChains.size, 0);

  const after = await pollWakeStep(state, { request });
  assert.equal(after.wakes.length, 0, "never re-woken");
});

test("wake: a re-served page never wakes twice (the cursor is the dedupe)", async () => {
  let transitionsCalls = 0;
  const { calls, request } = stubRequest((op, args) => {
    if (op === "nova_transitions_since") {
      transitionsCalls++;
      // the seed sees an empty store; every later poll re-serves the SAME page
      return transitionsCalls === 1 ? page([], 0) : page([row(13, "awaiting_gate")], 13);
    }
    if (op === "nova_result_get") return { run_id: RUN_A, artifact: { status: "completed" } };
    throw new Error(`unexpected op ${op}`);
  });
  const state = newWakeState();
  await pollWakeStep(state, { request });

  const first = await pollWakeStep(state, { request });
  assert.equal(first.wakes.length, 1);
  const second = await pollWakeStep(state, { request });
  assert.equal(second.wakes.length, 0, "the same transition row never wakes a second time");
  const lastTransitions = calls.filter((c) => c.op === "nova_transitions_since").at(-1)!;
  assert.equal(lastTransitions.args["cursor"], 13, "the poll asks above the row it already consumed");
});

test("wake: a disabled config or NOVAFLOW_WAKE=off starts no watcher at all", async () => {
  const sched = fakeScheduler();
  const pi = fakePi();
  const { calls, request } = stubRequest(() => {
    throw new Error("a disabled watcher must not poll");
  });
  const watcher = createWakeWatcher(pi.api, {
    request,
    config: { enabled: false, workspace: null },
    scheduler: sched.scheduler,
  });
  const { ctx } = fakeCtx();
  await watcher.start(ctx);
  assert.equal(calls.length, 0);
  assert.equal(sched.timers.length, 0, "no interval is created");

  const home = mkdtempSync(join(tmpdir(), "novaflow-wake-cfg-"));
  try {
    writeFileSync(join(home, "config.yaml"), "wake:\n  enabled: true\n  workspace: my-ws\n");
    assert.deepEqual(loadWakeConfig({ home, env: {} }), { enabled: true, workspace: "my-ws" });
    assert.deepEqual(loadWakeConfig({ home, env: { NOVAFLOW_WAKE: "off" } }), {
      enabled: false,
      workspace: "my-ws",
    });
    assert.deepEqual(loadWakeConfig({ home, env: { NOVAFLOW_WAKE: "ON" } }), {
      enabled: true,
      workspace: "my-ws",
    });
    assert.deepEqual(loadWakeConfig({ home: join(home, "missing"), env: {} }), {
      enabled: true,
      workspace: null,
    });
    // the env gate alone disables a real watcher: no file, no timer
    const envSched = fakeScheduler();
    const envWatcher = createWakeWatcher(fakePi().api, {
      request: stubRequest(() => {
        throw new Error("must not poll");
      }).request,
      scheduler: envSched.scheduler,
    });
    const prevHome = process.env["NOVAFLOW_HOME"];
    const prevWake = process.env["NOVAFLOW_WAKE"];
    process.env["NOVAFLOW_HOME"] = join(home, "missing");
    process.env["NOVAFLOW_WAKE"] = "off";
    try {
      await envWatcher.start(ctx);
      assert.equal(envSched.timers.length, 0, "NOVAFLOW_WAKE=off creates no interval");
    } finally {
      if (prevHome === undefined) delete process.env["NOVAFLOW_HOME"];
      else process.env["NOVAFLOW_HOME"] = prevHome;
      if (prevWake === undefined) delete process.env["NOVAFLOW_WAKE"];
      else process.env["NOVAFLOW_WAKE"] = prevWake;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("wake: session_shutdown clears the interval and a late tick polls nothing", async () => {
  const sched = fakeScheduler();
  const { calls, request } = stubRequest((op) => {
    assert.equal(op, "nova_transitions_since");
    return page([], 0);
  });
  const watcher = createWakeWatcher(fakePi().api, {
    request,
    config: { enabled: true, workspace: null },
    scheduler: sched.scheduler,
    intervalMs: 17,
  });
  const { ctx } = fakeCtx();
  await watcher.start(ctx);
  assert.equal(sched.timers.length, 1, "one interval is pinned");
  assert.equal(sched.timers[0]!.ms, 17);
  const firstTimer = sched.timers[0]!;

  // every session_start reason re-pins without doubling
  await watcher.start(ctx);
  assert.equal(sched.timers.length, 1, "a second session_start never double-pins");
  assert.deepEqual(sched.cleared, [firstTimer.id], "the previous interval was cleared first");
  const timer = sched.timers[0]!;

  const before = calls.length;
  watcher.stop();
  assert.deepEqual(sched.cleared, [firstTimer.id, timer.id], "shutdown clears the interval");
  assert.equal(sched.timers.length, 0);

  timer.fn(); // a tick the cleared interval had already queued
  await flush();
  assert.equal(calls.length, before, "a late tick after shutdown polls nothing");
  await watcher.poll();
  assert.equal(calls.length, before, "the public poll step is inert after shutdown");
});

test("wake: a throwing sendUserMessage (stale session ctx) never propagates", async () => {
  let transitionsCalls = 0;
  const { request } = stubRequest((op) => {
    if (op === "nova_transitions_since") {
      transitionsCalls++;
      return transitionsCalls === 1 ? page([], 0) : page([row(13, "awaiting_gate")], 13);
    }
    if (op === "nova_result_get") return { run_id: RUN_A, artifact: { status: "completed" } };
    throw new Error(`unexpected op ${op}`);
  });
  const sched = fakeScheduler();
  const pi = fakePi();
  const sent: Sent[] = pi.sent;
  const api = {
    ...(pi.api as unknown as Record<string, unknown>),
    sendUserMessage: () => {
      throw new Error("pi is stale after session_shutdown");
    },
  } as unknown as ExtensionAPI;
  const watcher = createWakeWatcher(api, {
    request,
    config: { enabled: true, workspace: null },
    scheduler: sched.scheduler,
  });
  const { ctx, notes } = fakeCtx();
  await watcher.start(ctx);
  await watcher.poll(); // must resolve, not reject

  assert.equal(sent.length, 0);
  const warnings = notes.filter((n) => n.severity === "warning").map((n) => n.message);
  assert.equal(warnings.length, 1, `one warn for the undeliverable wake: ${JSON.stringify(notes)}`);
  assert.ok(/stale/.test(warnings[0]!), warnings[0]);
});

test("wake: a daemon-down poll never throws, warns once, and resumes from its cursor", async () => {
  let down = false;
  const { calls, request } = stubRequest((op, args) => {
    assert.equal(op, "nova_transitions_since");
    if (down) throw new DaemonUnreachableError("no socket at /tmp/x.sock — is it running?");
    return Number(args["cursor"]) === 0 ? page([row(4, "running")], 4) : page([row(5, "failed", { task_key: "WC5", task_id: TASK_D })], 5);
  });
  const warns: string[] = [];
  const deps = { request, warn: (m: string) => warns.push(m) };
  const state = newWakeState();

  const seeded = await pollWakeStep(state, deps);
  assert.equal(seeded.wakes.length, 0);
  assert.equal(state.cursor, 4);

  down = true;
  const first = await pollWakeStep(state, deps);
  assert.equal(first.polled, false);
  assert.deepEqual(first.wakes, []);
  assert.equal(warns.length, 1, `the daemon-down warn fires once: ${JSON.stringify(warns)}`);
  assert.ok(/wake poll failed/.test(warns[0]!), warns[0]);

  const second = await pollWakeStep(state, deps);
  assert.equal(second.polled, false);
  assert.equal(warns.length, 1, "one warn per session — the down poll silences");
  assert.equal(state.cursor, 4, "a failed poll never moves the cursor");

  down = false;
  const resumed = await pollWakeStep(state, deps);
  assert.equal(resumed.wakes.length, 1, "the pending transition is delivered once the daemon returns");
  assert.equal(resumed.wakes[0]!.kind, "failed");
  assert.equal(calls.at(-1)!.args["cursor"], 4, "the resumed poll asks from the cursor it held");
});

test("wake: the injected message is a followUp user message and wake.workspace narrows the poll", async () => {
  let transitionsCalls = 0;
  const seen: Call[] = [];
  const request: WakeRequest = async (op, args) => {
    seen.push({ op, args });
    if (op === "nova_workspace_list") {
      return { workspaces: [{ id: "01HZWSID0000000000000000W1", slug: "my-ws" }] };
    }
    if (op === "nova_transitions_since") {
      transitionsCalls++;
      return transitionsCalls === 1
        ? page([], 0)
        : page([row(3, "failed", { task_key: "WC3", task_id: TASK_E })], 3);
    }
    throw new Error(`unexpected op ${op}`);
  };
  const sched = fakeScheduler();
  const pi = fakePi();
  const watcher = createWakeWatcher(pi.api, {
    request,
    config: { enabled: true, workspace: "my-ws" },
    scheduler: sched.scheduler,
  });
  const { ctx } = fakeCtx();
  await watcher.start(ctx);
  await watcher.poll();

  assert.equal(pi.sent.length, 1);
  assert.deepEqual(pi.sent[0]!.options, { deliverAs: "followUp" }, "the wake is queued, never an interrupt");
  assert.ok(String(pi.sent[0]!.content).startsWith("[novaflow] "));
  assert.ok(String(pi.sent[0]!.content).includes(TASK_E));
  const polls = seen.filter((c) => c.op === "nova_transitions_since");
  assert.equal(polls.length, 2);
  for (const p of polls) {
    assert.equal(p.args["workspace_id"], "01HZWSID0000000000000000W1", "the slug is resolved to the id");
  }
  assert.equal(sched.timers.length, 1);
  assert.equal(sched.timers[0]!.ms, WAKE_DEFAULT_INTERVAL_MS, "the default poll interval is ~2 s");
});

test("wake: the config parser is defensive — defaults, block form, flow form, junk", () => {
  assert.deepEqual(parseWakeConfig(""), { enabled: true, workspace: null });
  assert.deepEqual(parseWakeConfig("wake:\n  enabled: false\n  workspace: my-ws\n"), {
    enabled: false,
    workspace: "my-ws",
  });
  assert.deepEqual(parseWakeConfig("wake:\n  enabled: off\n  workspace: null\n  surprise: 1\n"), {
    enabled: false,
    workspace: null,
  });
  assert.deepEqual(parseWakeConfig('wake: { enabled: false, workspace: "my-ws" }\n'), {
    enabled: false,
    workspace: "my-ws",
  });
  // other sections are not ours, and a later wake block still reads
  assert.deepEqual(parseWakeConfig("concurrency:\n  global: 2\n  enabled: false\nwake:\n  enabled: yes\n"), {
    enabled: true,
    workspace: null,
  });
  // malformed values and junk lines keep the defaults rather than throwing
  assert.deepEqual(parseWakeConfig("wake:\n  enabled: sometimes\n  workspace:\n"), {
    enabled: true,
    workspace: null,
  });
  assert.deepEqual(parseWakeConfig(":\n::: \n\twake: [1,2]\n"), { enabled: true, workspace: null });
  assert.deepEqual(parseWakeConfig("\u0000not: [valid"), { enabled: true, workspace: null });
  assert.equal(wakeIntervalMs({}), WAKE_DEFAULT_INTERVAL_MS);
  assert.equal(wakeIntervalMs({ NOVAFLOW_WAKE_MS: "25" }), 25);
  assert.equal(wakeIntervalMs({ NOVAFLOW_WAKE_MS: "nope" }), WAKE_DEFAULT_INTERVAL_MS);
  assert.equal(wakeIntervalMs({ NOVAFLOW_WAKE_MS: "0" }), WAKE_DEFAULT_INTERVAL_MS);
});

test("wake: operator mode wires the watcher to session_start/session_shutdown", async () => {
  const home = mkdtempSync(join(tmpdir(), "novaflow-wake-lifecycle-"));
  const prevHome = process.env["NOVAFLOW_HOME"];
  const prevWake = process.env["NOVAFLOW_WAKE"];
  process.env["NOVAFLOW_HOME"] = home;
  process.env["NOVAFLOW_WAKE"] = "off"; // deterministic: start() returns before any timer/socket
  try {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const api = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
        return () => undefined;
      },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      sendUserMessage: () => undefined,
    } as unknown as ExtensionAPI;
    novaflowFactory(api);
    assert.ok(handlers.has("session_start"), "operator mode subscribes to session_start");
    assert.ok(handlers.has("session_shutdown"), "operator mode subscribes to session_shutdown");

    const { ctx } = fakeCtx();
    // all five session_start reasons fire the same handler; none of them throws
    for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
      await handlers.get("session_start")!({ type: "session_start", reason }, ctx);
    }
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    if (prevHome === undefined) delete process.env["NOVAFLOW_HOME"];
    else process.env["NOVAFLOW_HOME"] = prevHome;
    if (prevWake === undefined) delete process.env["NOVAFLOW_WAKE"];
    else process.env["NOVAFLOW_WAKE"] = prevWake;
    rmSync(home, { recursive: true, force: true });
  }
});

/* --------------------- judge P4 findings 1 and 2: the holes --------------------- */

test("wake: a has_more drain across pages wakes once per row, no duplicates (judge P4 f2)", async () => {
  const state = newWakeState();
  state.seeded = true;
  state.cursor = 0;
  const pages = [
    page([row(1, "validating"), row(2, "awaiting_gate")], 2, true),
    page([row(3, "failed"), row(4, "completed")], 4, false),
  ];
  const { request, calls } = stubRequest((op) => (op === "nova_transitions_since" ? pages.shift() : {}));
  const res = await pollWakeStep(state, { request });
  assert.deepEqual(
    res.wakes.map((w) => w.kind),
    ["awaiting_gate", "failed"],
    "one wake per human-attention row; a standalone completed does not wake",
  );
  const reads = calls.filter((c) => c.op === "nova_transitions_since");
  assert.equal(reads.length, 2, "the drain read both pages");
  assert.equal(state.cursor, 4);
});

test("wake: a reject re-entry into awaiting_gate wakes a SECOND time (judge P4 f2)", async () => {
  const state = newWakeState();
  state.seeded = true;
  state.cursor = 0;
  const pages = [
    page([row(10, "awaiting_gate")], 10),
    page([row(11, "failed"), row(12, "awaiting_gate")], 12),
  ];
  const { request } = stubRequest((op) => (op === "nova_transitions_since" ? pages.shift() : {}));
  const first = await pollWakeStep(state, { request });
  const second = await pollWakeStep(state, { request });
  assert.equal(first.wakes.filter((w) => w.kind === "awaiting_gate").length, 1);
  assert.equal(second.wakes.filter((w) => w.kind === "awaiting_gate").length, 1, "the re-entry is a NEW transition");
});

test("wake: a stalled chain's sticky re-check BACKS OFF instead of one read per poll (judge P4 f1)", async () => {
  const state = newWakeState();
  state.seeded = true;
  state.cursor = 0;
  let chainReads = 0;
  let first = true;
  const { request } = stubRequest((op) => {
    if (op === "nova_transitions_since") {
      if (!first) return page([], 20);
      first = false;
      return page([row(20, "completed", { chain_run_id: chainId(9) })], 20);
    }
    if (op === "nova_chain_status") {
      chainReads++;
      return { chain: { state: "active" }, members: [{ state: "completed" }] };
    }
    return {};
  });
  for (let n = 0; n < 40; n++) await pollWakeStep(state, { request });
  assert.ok(chainReads >= 1, "the pending chain was checked at least once");
  assert.ok(chainReads < 15, `chain_status reads must back off, not one per poll (got ${chainReads})`);
});

test("wake: an ENABLED watcher pins exactly one interval, and re-start does not double it (judge P4 f2d)", async () => {
  // The other factory-level test runs with NOVAFLOW_WAKE=off, so it would pass
  // with the wiring dead. This one drives the enabled path through the real
  // watcher with an injected scheduler: one interval, no doubling on re-pin,
  // cleared on shutdown.
  const { scheduler, timers } = fakeScheduler();
  const { api } = fakePi();
  const { request } = stubRequest((op) => (op === "nova_transitions_since" ? page([], 0) : {}));
  const watcher = createWakeWatcher(api, { scheduler, request, send: () => undefined });
  await watcher.start();
  assert.equal(timers.length, 1, "one interval after start");
  await watcher.start();
  assert.equal(timers.length, 1, "a second start re-pins rather than doubling");
  await watcher.stop();
  assert.equal(timers.length, 0, "shutdown clears it");
});
