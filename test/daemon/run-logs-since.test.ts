import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogsSince } from "../../src/daemon/readops.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { createPump } from "../../src/runs/pump.ts";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { ulid } from "../../src/store/ids.ts";
import { OpError } from "../../src/opcodes.ts";

/**
 * `nova_run_logs_since` — the run-log follow op (novaflow-v02/watch.md,
 * frozen 2026-11-23).
 *
 * The edges that ARE this card: `offset: 0` means the HEAD of the file (line
 * 0 — a caller wanting the tail asks `tail_lines`), the returned `offset` is
 * the window's START (so `has_more` is "more lines exist past offset + len"
 * and the caller advances by `offset + lines.length`), `has_more`'s
 * exact-boundary behavior, `done` when the run's log is closed, and the
 * REDACTION reuse: the served lines are the scrubbed `events.jsonl` the pump
 * wrote, byte for byte, and a secret that only exists in `events.raw.jsonl`
 * can never leave the process.
 *
 * Cases are observed through the op itself (the same body the socket op and
 * the MCP store fallback call), plus one socket round-trip proving the daemon
 * routes the op with the identical envelope.
 */

type Fixture = {
  dir: string;
  db: Database.Database;
  dbPath: string;
  socketPath: string;
  projectId: string;
  profileId: string;
  taskId: string;
};

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-logs-since-"));
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot, { recursive: true });
  const dbPath = join(dir, "state.db");
  const db = openDb(dbPath);
  migrate(db);
  const workspaceId = ulid();
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(
    workspaceId,
    wsRoot,
  );
  const projectId = ulid();
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(projectId, workspaceId);
  const profileId = ulid();
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, ?, 'dev', 'anthropic', 'm', 'medium', 'p.md', 3600, 5)`,
  ).run(profileId, workspaceId);
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T1', 'title', 'objective', ?)",
  ).run(taskId, projectId, profileId);
  return {
    dir,
    db,
    dbPath,
    socketPath: join(dir, "novaflow.sock"),
    projectId,
    profileId,
    taskId,
  };
}

function cleanup(fx: Fixture): void {
  try {
    fx.db.close();
  } catch {
    // already closed
  }
  rmSync(fx.dir, { recursive: true, force: true });
}

type Run = { runId: string; eventsPath: string; rawPath: string };

/**
 * A run directory written the way the engine writes it: the two files come
 * from the REAL pump (`src/runs/pump.ts`), so the redacted side is produced
 * by the shipped scrubber, never by a test-local imitation.
 */
function addRun(
  fx: Fixture,
  opts: { status?: string; lines?: string[]; writeFile?: boolean },
): Run {
  const runId = ulid();
  const runDir = join(fx.dir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = join(runDir, "events.jsonl");
  const rawPath = join(runDir, "events.raw.jsonl");
  if (opts.writeFile !== false) {
    appendLines({ runId, eventsPath, rawPath }, opts.lines ?? []);
  }
  fx.db
    .prepare(
      `INSERT INTO task_runs
         (id, task_id, attempt_number, pi_session_id, pi_session_dir, status,
          preflight_status, model_used, events_log_path)
       VALUES (?, ?, ?, ?, ?, ?, 'passed', 'm', ?)`,
    )
    .run(
      runId,
      fx.taskId,
      (fx.db
        .prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM task_runs WHERE task_id = ?")
        .get(fx.taskId) as { n: number }).n,
      runId,
      runDir,
      opts.status ?? "running",
      eventsPath,
    );
  return { runId, eventsPath, rawPath };
}

/** Append stdout lines through the pump (raw verbatim + redacted read surface). */
function appendLines(run: Pick<Run, "runId" | "eventsPath" | "rawPath">, lines: string[]): void {
  const pump = createPump(run.rawPath, run.eventsPath);
  for (const line of lines) pump.onLine(line);
}

type Page = {
  run_id?: string;
  lines: string[];
  offset: number;
  has_more: boolean;
  done: boolean;
};

function poll(fx: Fixture, args: Record<string, unknown>): Page {
  return runLogsSince(fx.db, { task_id: fx.taskId, ...args }) as Page;
}

/* ------------------------------- head semantics ------------------------------- */

test("offset 0 reads from the HEAD of the file and advancing by offset + len serves each line exactly once", () => {
  const fx = fixture();
  try {
    const run = addRun(fx, {
      status: "running",
      lines: ["L0", "L1", "L2", "L3", "L4"],
    });

    const first = poll(fx, { run_id: run.runId, limit: 2 });
    assert.deepEqual(first.lines, ["L0", "L1"], "offset 0 is the file's head, not its tail");
    assert.equal(first.offset, 0, "the window starts at line 0");
    assert.equal(first.has_more, true, "three lines remain past offset + len");
    assert.equal(first.done, false, "a running run's log is not closed");
    assert.equal(first.run_id, run.runId, "the envelope names the followed run");

    // the caller re-polls with offset + lines.length (watch.md: has_more means
    // "more lines exist past offset + len")
    const second = poll(fx, { run_id: run.runId, offset: 2, limit: 2 });
    assert.deepEqual(second.lines, ["L2", "L3"]);
    assert.equal(second.offset, 2);
    assert.equal(second.has_more, true);

    const third = poll(fx, { run_id: run.runId, offset: 4, limit: 2 });
    assert.deepEqual(third.lines, ["L4"]);
    assert.equal(third.offset, 4);
    assert.equal(third.has_more, false, "exactly the remaining lines: nothing more behind");

    // the run keeps streaming: same offset-arithmetic picks up ONLY the new lines
    appendLines(run, ["L5", "L6"]);
    const fourth = poll(fx, { run_id: run.runId, offset: 5, limit: 10 });
    assert.deepEqual(fourth.lines, ["L5", "L6"], "no duplicate line is ever re-delivered");
    assert.equal(fourth.has_more, false);
    assert.equal(fourth.done, false);

    // re-polling the same offset is idempotent (the log is append-only, the
    // run directory immutable — watch.md: "line offsets are stable")
    const repeat = poll(fx, { run_id: run.runId, offset: 5, limit: 10 });
    assert.deepEqual(repeat.lines, fourth.lines);
  } finally {
    cleanup(fx);
  }
});

test("has_more is exact at the boundary and a window past the end is empty, not an error", () => {
  const fx = fixture();
  try {
    const run = addRun(fx, { status: "running", lines: ["A", "B", "C", "D"] });

    const exact = poll(fx, { run_id: run.runId, offset: 0, limit: 4 });
    assert.deepEqual(exact.lines, ["A", "B", "C", "D"]);
    assert.equal(exact.has_more, false, "limit == remaining lines is NOT has_more");

    const oneLess = poll(fx, { run_id: run.runId, offset: 0, limit: 3 });
    assert.deepEqual(oneLess.lines, ["A", "B", "C"]);
    assert.equal(oneLess.has_more, true, "one line past the page makes has_more true");

    const pastEnd = poll(fx, { run_id: run.runId, offset: 4 });
    assert.deepEqual(pastEnd.lines, []);
    assert.equal(pastEnd.offset, 4, "the reported offset is the window start (here: EOF)");
    assert.equal(pastEnd.has_more, false);

    const wayPast = poll(fx, { run_id: run.runId, offset: 99 });
    assert.deepEqual(wayPast.lines, []);
    assert.equal(wayPast.offset, 4, "an overshooting offset reports the clamped start, never a phantom line");
    assert.equal(wayPast.has_more, false);
  } finally {
    cleanup(fx);
  }
});

/* ------------------------------------ done ------------------------------------ */

test("done flips exactly when the run is terminal, and the closed log stays fully readable", () => {
  const fx = fixture();
  try {
    const running = addRun(fx, { status: "running", lines: ["1", "2"] });
    assert.equal(poll(fx, { run_id: running.runId }).done, false, "running is not closed");

    const succeeded = addRun(fx, { status: "succeeded", lines: ["1", "2"] });
    const okPage = poll(fx, { run_id: succeeded.runId });
    assert.equal(okPage.done, true, "a succeeded run's log is closed");
    assert.deepEqual(okPage.lines, ["1", "2"], "closed does not mean unreadable");

    const failed = addRun(fx, { status: "failed", lines: ["boom"] });
    assert.equal(poll(fx, { run_id: failed.runId }).done, true, "any terminal run status closes the log");

    const timedOut = addRun(fx, { status: "timed_out", lines: ["tick"] });
    assert.equal(poll(fx, { run_id: timedOut.runId }).done, true);

    // the default run is the task's LATEST run (v1 runLogs' rule, reused)
    const cancelled = addRun(fx, { status: "cancelled", lines: ["stop"] });
    const latest = poll(fx, {});
    assert.equal(latest.run_id, cancelled.runId, "an absent run_id follows the latest attempt");
    assert.equal(latest.done, true);
  } finally {
    cleanup(fx);
  }
});

/* --------------------------------- tail_lines --------------------------------- */

test("tail_lines floors the window start, and the returned offset moves with that floor", () => {
  const fx = fixture();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const run = addRun(fx, { status: "running", lines });

    // "a caller that wants the tail asks tail_lines" (watch.md)
    const tail = poll(fx, { run_id: run.runId, tail_lines: 4 });
    assert.deepEqual(tail.lines, ["L6", "L7", "L8", "L9"]);
    assert.equal(tail.offset, 6, "the returned offset reports where the window really started");
    assert.equal(tail.has_more, false);
    assert.equal(tail.done, false);

    // an earlier offset cannot pull the window back before the tail floor
    const floored = poll(fx, { run_id: run.runId, offset: 2, tail_lines: 4 });
    assert.deepEqual(floored.lines, ["L6", "L7", "L8", "L9"]);
    assert.equal(floored.offset, 6, "tail_lines is a floor, so the reported offset is the floor");

    // a LATER offset is respected: the follow continues from where it was
    const later = poll(fx, { run_id: run.runId, offset: 8, tail_lines: 4 });
    assert.deepEqual(later.lines, ["L8", "L9"]);
    assert.equal(later.offset, 8);
    assert.equal(later.has_more, false);

    // tail + limit page the tail instead of returning it in one shot
    const page = poll(fx, { run_id: run.runId, tail_lines: 4, limit: 2 });
    assert.deepEqual(page.lines, ["L6", "L7"]);
    assert.equal(page.offset, 6);
    assert.equal(page.has_more, true, "more lines exist past offset + len");
    const next = poll(fx, { run_id: run.runId, offset: page.offset + page.lines.length, tail_lines: 4 });
    assert.deepEqual(next.lines, ["L8", "L9"]);

    // without tail_lines the window start is the caller's offset again
    const plain = poll(fx, { run_id: run.runId, offset: 6 });
    assert.deepEqual(plain.lines, ["L6", "L7", "L8", "L9"]);
    assert.equal(plain.offset, 6);
  } finally {
    cleanup(fx);
  }
});

test("a limit above the max CLAMPS at 1000 (a follow drain is never refused)", () => {
  const fx = fixture();
  try {
    const lines = Array.from({ length: 1001 }, (_, i) => `L${i}`);
    const run = addRun(fx, { status: "running", lines });

    const page = poll(fx, { run_id: run.runId, limit: 5000 });
    assert.equal(page.lines.length, 1000, "the page is capped, the call succeeds");
    assert.equal(page.lines[0], "L0");
    assert.equal(page.lines[999], "L999");
    assert.equal(page.has_more, true);

    const rest = poll(fx, { run_id: run.runId, offset: 1000, limit: 5000 });
    assert.deepEqual(rest.lines, ["L1000"]);
    assert.equal(rest.has_more, false);
  } finally {
    cleanup(fx);
  }
});

/* ------------------------------- error taxonomy ------------------------------- */

test("bad args are schema_invalid; an unknown task, run, or log file is not_found", () => {
  const fx = fixture();
  try {
    const run = addRun(fx, { status: "running", lines: ["x"] });
    const isCode = (code: string) => (err: unknown) => err instanceof OpError && err.code === code;

    for (const offset of [-1, 1.5, "3", null]) {
      assert.throws(
        () => poll(fx, { run_id: run.runId, offset }),
        isCode("schema_invalid"),
        `offset ${JSON.stringify(offset)} must be schema_invalid`,
      );
    }
    for (const limit of [0, -2, 2.5, "5"]) {
      assert.throws(
        () => poll(fx, { run_id: run.runId, limit }),
        isCode("schema_invalid"),
        `limit ${JSON.stringify(limit)} must be schema_invalid`,
      );
    }
    for (const tail of [0, 1001, 1.5, "7"]) {
      assert.throws(
        () => poll(fx, { run_id: run.runId, tail_lines: tail }),
        isCode("schema_invalid"),
        `tail_lines ${JSON.stringify(tail)} must be schema_invalid (the v1 1..1000 rule)`,
      );
    }

    assert.throws(
      () => runLogsSince(fx.db, { task_id: ulid() }),
      isCode("not_found"),
      "an unknown task is not_found",
    );
    assert.throws(
      () => poll(fx, { run_id: ulid() }),
      isCode("not_found"),
      "an unknown run is not_found",
    );

    // a task with no runs at all
    const bareTask = ulid();
    fx.db
      .prepare(
        "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T2', 't', 'o', ?)",
      )
      .run(bareTask, fx.projectId, fx.profileId);
    assert.throws(
      () => runLogsSince(fx.db, { task_id: bareTask }),
      isCode("not_found"),
      "a task with no run is not_found",
    );

    // a run row whose redacted log file was never written
    const noFile = addRun(fx, { status: "running", writeFile: false });
    assert.throws(
      () => poll(fx, { run_id: noFile.runId }),
      isCode("not_found"),
      "a missing events.jsonl is not_found (no invented empty log)",
    );
  } finally {
    cleanup(fx);
  }
});

/* ---------------------------------- redaction ---------------------------------- */

test("the op serves the REDACTED events.jsonl: a raw-only secret never appears (NFR-SE-04)", () => {
  const fx = fixture();
  try {
    // assembled at runtime so the literal never sits in the source tree
    const SECRET = ["sk", "liveSECRETabcdefgh12345678"].join("-");
    const run = addRun(fx, {
      status: "running",
      lines: [
        JSON.stringify({ type: "message_update", text: "hello" }),
        JSON.stringify({ type: "tool_call", message: `export KEY=${SECRET} # do not leak` }),
        "a plain non-JSON line with no secret",
      ],
    });

    // the fixture is DISCRIMINATING: the raw file holds the token verbatim…
    const raw = readFileSync(run.rawPath, "utf8");
    assert.ok(raw.includes(SECRET), "the raw stream really carries the secret");
    assert.equal(
      statSync(run.rawPath).mode & 0o777,
      0o600,
      "events.raw.jsonl stays mode 0600 (data 1.1)",
    );
    // …and the scrubbed file the pump wrote does not
    const redactedText = readFileSync(run.eventsPath, "utf8");
    assert.ok(!redactedText.includes(SECRET), "the redacted file the pump wrote is clean");
    const redactedLines = redactedText.split("\n").filter((l) => l !== "");
    assert.equal(redactedLines.length, 3);

    // drain the whole log exactly as `nova task logs --follow` would
    const seen: string[] = [];
    let offset = 0;
    for (let polls = 0; polls < 10; polls++) {
      const page = poll(fx, { run_id: run.runId, offset, limit: 1 });
      assert.equal(page.offset, offset, "the window starts where the caller asked");
      seen.push(...page.lines);
      offset = page.offset + page.lines.length;
      if (!page.has_more) break;
    }
    assert.equal(seen.length, 3, "every line served exactly once");

    const joined = seen.join("\n");
    assert.ok(!joined.includes(SECRET), "the raw secret must never leave the process");
    assert.ok(!joined.includes("liveSECRET"), "not even the token's middle segment survives");
    assert.match(joined, /\[REDACTED\]/i, "the follower sees the scrubber's mask");
    assert.deepEqual(seen, redactedLines, "the served lines ARE the redacted file, line for line");

    // the pointer the op read is the redacted surface, never the raw one
    const pointer = fx.db
      .prepare("SELECT events_log_path FROM task_runs WHERE id = ?")
      .get(run.runId) as { events_log_path: string };
    assert.match(pointer.events_log_path, /events\.jsonl$/);
    assert.doesNotMatch(pointer.events_log_path, /events\.raw\.jsonl$/);
  } finally {
    cleanup(fx);
  }
});

/* --------------------------------- over the socket --------------------------------- */

test("the daemon routes nova_run_logs_since: same envelope, same taxonomy codes", async () => {
  const fx = fixture();
  let handle: DaemonHandle | undefined;
  let client: TestClient | undefined;
  try {
    // a terminal run: boot recovery only reconciles status='running' rows,
    // so a finished fixture is untouched by the daemon's own bookkeeping
    const run = addRun(fx, { status: "succeeded", lines: ["one", "two", "three"] });
    const unknownTask = ulid();
    fx.db.close();

    handle = await startDaemon({ dbPath: fx.dbPath, socketPath: fx.socketPath, tickMs: 30 });
    client = await TestClient.connect(handle.socketPath);

    const ok = await client.request({
      id: "page",
      op: "nova_run_logs_since",
      args: { task_id: fx.taskId, run_id: run.runId, offset: 1, limit: 1 },
    });
    assert.equal(ok["ok"], true, `op must succeed: ${JSON.stringify(ok)}`);
    assert.deepEqual(ok["data"], {
      run_id: run.runId,
      lines: ["two"],
      offset: 1,
      has_more: true,
      done: true,
    });

    const missing = await client.request({
      id: "missing",
      op: "nova_run_logs_since",
      args: { task_id: unknownTask },
    });
    assert.equal(missing["ok"], false);
    assert.equal((missing["error"] as { code: string }).code, "not_found");

    const invalid = await client.request({
      id: "invalid",
      op: "nova_run_logs_since",
      args: { task_id: fx.taskId, offset: -1 },
    });
    assert.equal(invalid["ok"], false);
    assert.equal(
      (invalid["error"] as { code: string }).code,
      "schema_invalid",
      "the op body validates, not a per-surface schema",
    );
  } finally {
    client?.close();
    await handle?.stop();
    cleanup(fx);
  }
});
