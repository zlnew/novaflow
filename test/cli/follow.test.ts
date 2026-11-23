import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../daemon/client.ts";
import { formatTransitionLine, type TransitionRow } from "../../src/cli/watch.ts";

/**
 * The live follow surfaces through the ACTUAL CLI binary against a real
 * detached daemon (novaflow-v02/watch.md, frozen 2026-11-23):
 *
 *   - `nova task logs <id> --follow` — the run-log follow, which must EXIT on
 *     a run whose log is already closed (never sit there), printing every
 *     line the redacted events.jsonl holds;
 *   - `nova task status <id> --watch` — one line per transition
 *     (`HH:MM:SS UTC KEY from→to (trigger, actor) run=<id>`) until terminal,
 *     then the unchanged v1 status block;
 *   - `nova chain status <id> --watch` — member transitions until every member
 *     AND the chain row are terminal (completion is inferred: chain runs have
 *     no transition rows of their own).
 *
 * Every wait here is bounded twice: the harness polls with waitFor(...), and
 * each spawned CLI carries a hard timeout. Nothing in this file can hang the
 * suite on a follow that misses its exit condition.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>, timeoutMs = 60_000): Run {
  const res = spawnSync(NOVA, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The same binary, but awaited while the test drives the daemon alongside it. */
function runNovaAsync(args: string[], env: Record<string, string>, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(NOVA, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      // bounded: a follow that never exits fails the assertion below with the
      // output it did produce, instead of hanging the suite
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

type Home = { dir: string; home: string; wsRoot: string; env: Record<string, string> };

function makeHome(runMode = "run-ok"): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-follow-cli-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot);
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, runMode]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
    NOVAFLOW_WATCH_MS: "200",
  };
  return { dir, home, wsRoot, env };
}

async function forceStopDaemon(h: Home): Promise<void> {
  const sock = join(h.home, "novaflow.sock");
  if (existsSync(sock)) {
    try {
      const { TestClient } = await import("../daemon/client.ts");
      const client = await TestClient.connect(sock, 1500);
      await client.request({ id: "cleanup", op: "nova_daemon_stop", args: {} });
      client.close();
    } catch {
      // fall through to the pid kill
    }
    try {
      await waitFor(() => !existsSync(sock), 5000);
    } catch {
      // fall through
    }
  }
  const pidFile = join(h.home, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(-pid, sig);
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  rmSync(h.dir, { recursive: true, force: true });
}

/** daemon + workspace + profile + project, the shared operator preamble. */
function bootstrap(h: Home): void {
  assert.equal(runNova(["daemon", "start"], h.env).code, 0, "daemon start");
  assert.equal(runNova(["workspace", "create", "alpha", "--path", h.wsRoot], h.env).code, 0);
  assert.equal(runNova(["workspace", "switch", "alpha"], h.env).code, 0);
  const profileSrc = join(h.dir, "dev.json");
  writeFileSync(
    profileSrc,
    JSON.stringify({
      name: "dev",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      thinking_level: "medium",
      system_prompt_path: "prompts/dev_system.md",
      tools_allowlist: ["bash", "read"],
      limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
    }),
  );
  mkdirSync(join(h.wsRoot, "prompts"), { recursive: true });
  writeFileSync(join(h.wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
  assert.equal(runNova(["profile", "create", "--file", profileSrc], h.env).code, 0);
  mkdirSync(join(h.dir, "target"), { recursive: true });
  const proj = runNova(
    ["project", "create", "app", "--objective", "Ship it.", "--target", `code=${join(h.dir, "target")}`],
    h.env,
  );
  assert.equal(proj.code, 0, proj.stderr);
}

function createTask(h: Home, key: string): void {
  const res = runNova(
    ["task", "create", key, "--title", key, "--objective", "Do the work.", "--profile", "dev", "--project", "app", "--scope", "code"],
    h.env,
  );
  assert.equal(res.code, 0, res.stderr);
}

function taskState(h: Home, key: string): string {
  const res = runNova(["task", "status", key, "--json"], h.env, 15_000);
  if (res.code !== 0) return "unknown";
  return (JSON.parse(res.stdout) as { task: { state: string } }).task.state;
}

/* ---------------------- the one transition-line format --------------------- */

test("the shared transition formatter pins the WHOLE line, zone label included", () => {
  // Both `--watch` verbs print through this one formatter, so a literal pin of
  // the complete line is what stops the zone label (or any other field) from
  // drifting on one side. DEBT-012: the clock stays UTC — the timestamp is the
  // store's own stamp — and the line now SAYS so.
  const row: TransitionRow = {
    cursor: 7,
    task_id: "01M81ZZZZZZZZZZZZZZZZZZZZZ",
    run_id: "01M81ABZ6Q8N4T2V9C3X5K7MD1",
    chain_run_id: null,
    task_key: "WC2",
    chain_slug: null,
    from_state: "queued",
    to_state: "running",
    trigger_type: "engine",
    actor: "daemon-dispatch",
    reason: null,
    created_at: "2026-11-23T12:06:54.123Z",
  };
  assert.equal(
    formatTransitionLine(row),
    "12:06:54 UTC WC2 queued→running (engine, daemon-dispatch) run=01M81ABZ6Q8N4T2V9C3X5K7MD1",
  );
  // a row that names no run still carries the zone, and prints run=-
  assert.equal(
    formatTransitionLine({ ...row, run_id: null }),
    "12:06:54 UTC WC2 queued→running (engine, daemon-dispatch) run=-",
  );
});

/* ------------------------- nova task logs --follow ------------------------- */

test("nova task logs --follow on a CLOSED run prints every line and exits at once", async () => {
  const h = makeHome();
  try {
    bootstrap(h);
    createTask(h, "T1");
    assert.equal(runNova(["task", "run", "T1"], h.env).code, 0);
    await waitFor(() => taskState(h, "T1") === "completed", 30_000);

    // the same file the v1 tail op reads: the follow starts at the file's head,
    // so with a short log the two outputs are identical
    const tail = runNova(["task", "logs", "T1", "--lines", "1000"], h.env);
    assert.equal(tail.code, 0, tail.stderr);
    const tailLines = tail.stdout.split("\n").filter((l) => l !== "");
    assert.ok(tailLines.length >= 2, `the run wrote a log: ${tail.stdout}`);

    const follow = runNova(["task", "logs", "T1", "--follow"], h.env, 20_000);
    assert.equal(follow.code, 0, `a done run must not wait: stdout=${follow.stdout} stderr=${follow.stderr}`);
    const followLines = follow.stdout.split("\n").filter((l) => l !== "");
    // PRESERVE: the log follow prints the run's lines verbatim — it carries no
    // clock of its own and gains no zone label from the transition-line change
    assert.deepEqual(followLines, tailLines, "the follow serves the same redacted lines the tail does");
    assert.match(follow.stderr, /closed|nothing more|new run/, "the follow says why it stopped");

    // --json emits the op's raw envelope rows instead of bare lines
    const json = runNova(["task", "logs", "T1", "--follow", "--json"], h.env, 20_000);
    assert.equal(json.code, 0, json.stderr);
    const pages = json.stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { lines: string[]; offset: number; has_more: boolean; done: boolean });
    assert.ok(pages.length >= 1, "at least the first page is emitted");
    assert.equal(pages[0]!.offset, 0, "the follow starts at the head of the run's log");
    assert.deepEqual(
      pages.flatMap((p) => p.lines),
      tailLines,
      "the JSON pages carry the same lines, none duplicated",
    );
    assert.equal(pages[pages.length - 1]!.done, true, "the closed run reports done");
    assert.equal(pages[pages.length - 1]!.has_more, false);
  } finally {
    await forceStopDaemon(h);
  }
});

/* -------------------- nova task run --watch (v1, untouched) ------------------ */

test("PRESERVE: nova task run --watch keeps its v1 snapshot line and gains no zone label", async () => {
  const h = makeHome();
  try {
    bootstrap(h);
    createTask(h, "T3");
    const watch = runNova(["task", "run", "T3", "--watch"], h.env, 30_000);
    assert.equal(watch.code, 0, `stdout=${watch.stdout} stderr=${watch.stderr}`);
    // v1's snapshot watch, byte for byte: `[HH:MM:SS] tsk_<ulid> <state>` — the
    // transition-line zone label must NOT leak into this surface
    assert.match(
      watch.stdout,
      /^\[\d{2}:\d{2}:\d{2}\] tsk_[0-9A-HJKMNP-TV-Z]{26} (queued|running|completed)$/m,
      `the v1 snapshot line is unchanged: ${watch.stdout}`,
    );
    assert.doesNotMatch(watch.stdout, / UTC /, "--watch's zone label belongs to the transition line only");
    // v1 snapshot semantics: the closing line, no status block on this verb
    assert.match(watch.stdout, /^SUCCESS task completed$/m);
  } finally {
    await forceStopDaemon(h);
  }
});

/* ------------------------- nova task status --watch ------------------------- */

test("nova task status --watch on a terminal task prints the unchanged v1 status block and exits", async () => {
  const h = makeHome();
  try {
    bootstrap(h);
    createTask(h, "T1");
    assert.equal(runNova(["task", "run", "T1"], h.env).code, 0);
    await waitFor(() => taskState(h, "T1") === "completed", 30_000);

    const watch = runNova(["task", "status", "T1", "--watch"], h.env, 20_000);
    assert.equal(watch.code, 0, `stdout=${watch.stdout} stderr=${watch.stderr}`);
    // the v1 final block, intact: the kv record the plain `status` prints
    assert.match(watch.stdout, /^id: tsk_[0-9A-HJKMNP-TV-Z]{26}$/m);
    assert.match(watch.stdout, /^key: T1$/m);
    assert.match(watch.stdout, /^state: completed$/m);
    assert.match(watch.stdout, /^run_status: succeeded$/m);
    assert.match(watch.stdout, /^verification: passed$/m);
    assert.match(watch.stdout, /SUCCESS task completed/);
    // and the transition lines the head page offered (watched, not polled);
    // each assertion pins the WHOLE line, zone label included
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC T1 running→validating \(engine, daemon-dispatch\) run=[0-9A-HJKMNP-TV-Z]{26}$/m,
      "one line per transition, in the pinned format, carrying the run id the row names",
    );
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC T1 validating→completed \(engine, daemon-verify\) run=-$/m,
      "a row that names no run prints run=- rather than inventing one",
    );
  } finally {
    await forceStopDaemon(h);
  }
});

test("a --watch that sees a transition land and then the terminal state exits 0", async () => {
  const h = makeHome();
  try {
    bootstrap(h);
    createTask(h, "T2");

    // hold the scheduler so the task is enqueued but not dispatched: the watch
    // starts against a live (non-terminal) task and must observe the later move
    assert.equal(runNova(["daemon", "pause"], h.env).code, 0);
    assert.equal(runNova(["task", "run", "T2"], h.env).code, 0);
    await waitFor(() => taskState(h, "T2") === "queued", 15_000);

    const watching = runNovaAsync(["task", "status", "T2", "--watch"], h.env, 40_000);
    await new Promise((r) => setTimeout(r, 800)); // let it print the head page and poll
    assert.equal(runNova(["daemon", "resume"], h.env).code, 0);

    const watch = await watching;
    assert.equal(watch.code, 0, `stdout=${watch.stdout} stderr=${watch.stderr}`);
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC T2 queued→running \(engine, daemon-dispatch\) run=-$/m,
      "the transition that landed AFTER the watch started is printed",
    );
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC T2 \S+→completed \(engine, [\w-]+\) run=(?:-|[0-9A-HJKMNP-TV-Z]{26})$/m,
      "and so is the terminal one, on the same whole pinned line",
    );
    assert.match(watch.stdout, /^state: completed$/m, "the v1 block closes the watch");
    assert.match(watch.stdout, /SUCCESS task completed/);
  } finally {
    await forceStopDaemon(h);
  }
});

/* ------------------------ nova chain status --watch ------------------------ */

test("nova chain status --watch prints member transitions and exits on the inferred chain completion", async () => {
  const h = makeHome();
  try {
    bootstrap(h);
    const dag = join(h.dir, "chain.json");
    writeFileSync(
      dag,
      JSON.stringify({
        version: "1.0.0",
        project_slug: "app",
        tasks: [
          { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
          { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
        ],
        edges: [{ source_key: "A", target_key: "B", edge_type: "depends_on" }],
      }),
    );
    assert.equal(runNova(["project", "import-dag", dag], h.env).code, 0);
    const chains = JSON.parse(runNova(["chain", "list", "--json"], h.env).stdout) as {
      chains: Array<{ id: string; member_count: number; state: string }>;
    };
    const chain = chains.chains.find((c) => c.member_count === 2 && c.state === "active")!;
    assert.ok(chain !== undefined, "the imported chain is active");

    assert.equal(runNova(["task", "run", "A"], h.env).code, 0);
    await waitFor(
      () => {
        const probe = runNova(["chain", "status", chain.id, "--json"], h.env, 15_000);
        if (probe.code !== 0) return false;
        return (JSON.parse(probe.stdout) as { chain: { state: string } }).chain.state === "completed";
      },
      40_000,
    );

    const watch = runNova(["chain", "status", chain.id, "--watch"], h.env, 20_000);
    assert.equal(watch.code, 0, `stdout=${watch.stdout} stderr=${watch.stderr}`);
    // member transitions for the chain run, same line format as the task watch
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC A queued→running \(engine, daemon-dispatch\) run=-$/m,
      "a member's transition line is chain-scoped and greppable",
    );
    assert.match(
      watch.stdout,
      /^\d{2}:\d{2}:\d{2} UTC B \S+→completed \(engine, [\w-]+\) run=(?:-|[0-9A-HJKMNP-TV-Z]{26})$/m,
      "the downstream member's too, on the same whole pinned line",
    );
    // then the unchanged v1 chain block
    assert.match(watch.stdout, new RegExp(`^id: ${chain.id}$`, "m"));
    assert.match(watch.stdout, /^state: completed$/m);
    assert.match(watch.stdout, /^A\s+completed\s+root/m);
    assert.match(watch.stdout, /^B\s+completed\s+/m);
  } finally {
    await forceStopDaemon(h);
  }
});
