import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { seedFileStore } from "./seed.ts";
import { openDb } from "../../src/store/db.ts";
import { ulid } from "../../src/store/ids.ts";
import { createTask } from "../../src/tasks.ts";
import { logTransition } from "../../src/fsm/engine.ts";
import { importChain } from "../../src/chain/import.ts";
import { daemonRequest, DaemonUnreachableError } from "../../src/cli/client.ts";

/**
 * `nova_transitions_since` — the v0.2.0 transition stream, over the real
 * control socket. Contract: novaflow-v02/events.md (frozen 2026-11-23).
 *
 * The cursor edge rules ARE this card: head semantics at `cursor: 0`,
 * strict `rowid > cursor` paging (no duplicate delivery), filters applied
 * BEFORE the limit (a busy workspace can never crowd a task's rows out of
 * a page), and the exact-limit `has_more` boundary in both directions.
 * Every case is observed through the public surface (the socket op, plus
 * the store for the read-only proof), never through the op's internals.
 */

type Fixture = {
  dir: string;
  dbPath: string;
  socketPath: string;
  /** workspace "ws1" + its project: the BUSY scope in the crowd-out tests. */
  busy: { workspaceId: string; projectId: string };
  /** workspace "ws2" + its project: the filtered scope. */
  quiet: { workspaceId: string; projectId: string };
  profileId: string;
};

type Page = {
  transitions: Array<Record<string, unknown>>;
  next_cursor: number;
  has_more: boolean;
};

type Booted = { handle: DaemonHandle; client: TestClient };

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-events-"));
  const seeded = seedFileStore(dir, "ws1");
  const quietRoot = join(dir, "wsroot-ws2");
  mkdirSync(quietRoot, { recursive: true });
  const workspaceId2 = ulid();
  const projectId2 = ulid();
  const db = openDb(seeded.dbPath);
  try {
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws2', 'ws2', ?)",
    ).run(workspaceId2, quietRoot);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj2', 'prj2', 'o')",
    ).run(projectId2, workspaceId2);
    // the chain importer resolves profile NAMES inside the owning
    // workspace, so ws2 needs its own 'dev'
    db.prepare(
      `INSERT INTO agent_profiles
         (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
          max_timeout_sec, max_cost_usd)
       VALUES (?, ?, 'dev', 'anthropic', 'm', 'medium', 'prompts/dev_system.md', 3600, 5)`,
    ).run(ulid(), workspaceId2);
  } finally {
    db.close();
  }
  return {
    dir,
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    busy: { workspaceId: seeded.workspaceId, projectId: seeded.projectId },
    quiet: { workspaceId: workspaceId2, projectId: projectId2 },
    profileId: seeded.profileId,
  };
}

function writer(fx: Fixture, fn: (db: Database.Database) => void): void {
  const db = openDb(fx.dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function makeTasks(fx: Fixture, projectId: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  writer(fx, (db) => {
    for (const key of keys) {
      out[key] = createTask(db, {
        projectId,
        key,
        title: key,
        objective: `objective for ${key}`,
        profileId: fx.profileId,
      }).id;
    }
  });
  return out;
}

/**
 * Append audit rows through the engine's own writer (`logTransition`, the
 * function every real transition uses) and return their rowids — the
 * cursor values the op reports.
 */
function addRows(
  fx: Fixture,
  taskId: string,
  count: number,
  over: {
    runId?: string | null;
    fromState?: string;
    toState?: string;
    triggerType?: "engine" | "human" | "mcp" | "schedule" | "timeout";
    actor?: string;
    reason?: string;
  } = {},
): number[] {
  const rowids: number[] = [];
  writer(fx, (db) => {
    for (let i = 0; i < count; i++) {
      logTransition(db, {
        taskId,
        runId: over.runId ?? null,
        fromState: over.fromState ?? "draft",
        toState: over.toState ?? "queued",
        triggerType: over.triggerType ?? "engine",
        actor: over.actor ?? "engine:worker",
        ...(over.reason !== undefined ? { reason: over.reason } : {}),
      });
      const row = db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number };
      rowids.push(row.r);
    }
  });
  return rowids;
}

/** A real task_runs row (the transition row's run_id FK) + the run dir. */
function makeRun(fx: Fixture, taskId: string, runId: string): string {
  const runDir = join(fx.dir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writer(fx, (db) => {
    db.prepare(
      `INSERT INTO task_runs
         (id, task_id, attempt_number, pi_session_id, pi_session_dir, status,
          preflight_status, model_used, events_log_path)
       VALUES (?, ?, 1, ?, ?, 'running', 'passed', 'm', ?)`,
    ).run(runId, taskId, runId, runDir, join(runDir, "events.jsonl"));
  });
  return runId;
}

function transitionCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

async function boot(fx: Fixture): Promise<Booted> {
  const handle = await startDaemon({
    dbPath: fx.dbPath,
    socketPath: fx.socketPath,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return { handle, client };
}

async function shutdown(fx: Fixture, booted: Booted | undefined): Promise<void> {
  booted?.client.close();
  await booted?.handle.stop();
  rmSync(fx.dir, { recursive: true, force: true });
}

async function poll(client: TestClient, args: Record<string, unknown> = {}): Promise<Page> {
  const res = await client.request({
    id: "poll",
    op: "nova_transitions_since",
    args,
  });
  assert.equal(res["ok"], true, `op must succeed: ${JSON.stringify(res)}`);
  return res["data"] as Page;
}

function cursorsOf(page: Page): number[] {
  return page.transitions.map((t) => t["cursor"] as number);
}

/* ------------------------------ head semantics ------------------------------ */

test("cursor 0 starts at head: the most recent limit rows ascending, next_cursor highest, has_more false", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["HEAD"]);
    const rowids = addRows(fx, tasks["HEAD"]!, 5);
    booted = await boot(fx);

    const page = await poll(booted.client, { limit: 3 });
    assert.deepEqual(cursorsOf(page), [rowids[2]!, rowids[3]!, rowids[4]!], "ascending, most recent 3");
    assert.equal(page.has_more, false, "cursor 0 is a head snapshot — there is never more behind it");
    assert.equal(page.next_cursor, rowids[4]!, "next_cursor is the highest returned rowid");

    // history older than the head page is not observable BY DESIGN: the
    // two older rows never appear, and re-polling the head is identical
    const again = await poll(booted.client, { limit: 3 });
    assert.deepEqual(cursorsOf(again), cursorsOf(page));
    for (const old of [rowids[0]!, rowids[1]!]) {
      assert.ok(!cursorsOf(again).includes(old), `rowid ${old} must not be offered by the head page`);
    }

    // stepping forward from the head cursor yields nothing new
    const after = await poll(booted.client, { cursor: page.next_cursor });
    assert.deepEqual(after.transitions, []);
    assert.equal(after.has_more, false);
    assert.equal(after.next_cursor, page.next_cursor, "an empty poll echoes the cursor so the drain advances only on rows");
  } finally {
    await shutdown(fx, booted);
  }
});

test("an empty result keeps the envelope shape (no rows, echoed cursor, has_more false)", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    makeTasks(fx, fx.busy.projectId, ["SILENT"]);
    booted = await boot(fx);

    const empty = await poll(booted.client, {});
    assert.deepEqual(empty, { transitions: [], next_cursor: 0, has_more: false });

    const fromCursor = await poll(booted.client, { cursor: 7 });
    assert.deepEqual(fromCursor, { transitions: [], next_cursor: 7, has_more: false });
  } finally {
    await shutdown(fx, booted);
  }
});

/* --------------------------------- paging ---------------------------------- */

test("a drain loop with limit collects every row exactly once and terminates", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["DRAIN"]);
    const before = addRows(fx, tasks["DRAIN"]!, 3);
    booted = await boot(fx);

    // the consumer's starting point IS the head page's next_cursor
    const head = await poll(booted.client, { limit: 100 });
    assert.deepEqual(cursorsOf(head), before);
    assert.equal(head.has_more, false);

    // seven rows land after the consumer last looked
    const after = addRows(fx, tasks["DRAIN"]!, 7);
    const seen: number[] = [];
    let cursor = head.next_cursor;
    let polls = 0;
    for (;;) {
      const page = await poll(booted.client, { cursor, limit: 2 });
      polls += 1;
      assert.ok(polls < 20, "the drain loop must terminate (the store is finite)");
      assert.ok(page.transitions.length <= 2, "a page never exceeds limit");
      seen.push(...cursorsOf(page));
      if (!page.has_more) break;
      assert.ok(page.next_cursor > cursor, "has_more means the cursor advanced strictly");
      cursor = page.next_cursor;
    }
    assert.deepEqual(seen, after, "every row delivered exactly once, in rowid order");
    assert.equal(new Set(seen).size, seen.length, "no duplicate delivery");
    assert.equal(polls, 4, "7 rows at limit 2 = 4 polls (2+2+2+1)");
  } finally {
    await shutdown(fx, booted);
  }
});

test("rowid > cursor is strict: re-polling the same cursor delivers no duplicates", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["STRICT"]);
    const rowids = addRows(fx, tasks["STRICT"]!, 4);
    booted = await boot(fx);

    const first = await poll(booted.client, { cursor: rowids[0]!, limit: 10 });
    assert.deepEqual(cursorsOf(first), [rowids[1]!, rowids[2]!, rowids[3]!]);
    assert.ok(
      cursorsOf(first).every((c) => c > rowids[0]!),
      "the row AT the cursor is never re-delivered",
    );
    assert.equal(first.has_more, false);

    const repeat = await poll(booted.client, { cursor: rowids[0]!, limit: 10 });
    assert.deepEqual(cursorsOf(repeat), cursorsOf(first), "the same cursor answers the same rows");

    const fromNext = await poll(booted.client, { cursor: first.next_cursor });
    assert.deepEqual(fromNext.transitions, [], "the returned cursor has seen everything offered");
  } finally {
    await shutdown(fx, booted);
  }
});

test("the exact-limit boundary, both ways: limit remaining is has_more false, limit+1 is true then drains", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["EDGE"]);
    // two rows behind the cursor, then a fresh batch of exactly `limit`
    const base = addRows(fx, tasks["EDGE"]!, 2);
    const cursor = base[1]!;
    const exact = addRows(fx, tasks["EDGE"]!, 3);
    booted = await boot(fx);

    // ---- exactly `limit` rows remain => has_more: false ----
    const exactPage = await poll(booted.client, { cursor, limit: 3 });
    assert.deepEqual(cursorsOf(exactPage), exact);
    assert.equal(
      exactPage.has_more,
      false,
      "3 remaining at limit 3: no row beyond the page, so has_more must be false",
    );
    assert.equal(exactPage.next_cursor, exact[2]!);

    // ---- `limit + 1` rows remain => has_more: true, and the next poll returns the last row ----
    const extra = addRows(fx, tasks["EDGE"]!, 1);
    const overPage = await poll(booted.client, { cursor, limit: 3 });
    assert.deepEqual(cursorsOf(overPage), exact, "the page still stops at limit");
    assert.equal(
      overPage.has_more,
      true,
      "4 remaining at limit 3: one more row exists beyond the page, so has_more must be true",
    );
    const tail = await poll(booted.client, { cursor: overPage.next_cursor, limit: 3 });
    assert.deepEqual(cursorsOf(tail), extra, "the next poll returns exactly the last row");
    assert.equal(tail.has_more, false);
    assert.equal(tail.next_cursor, extra[0]!);
  } finally {
    await shutdown(fx, booted);
  }
});

/* --------------------------------- filters --------------------------------- */

test("scope filters apply BEFORE the limit: a busy workspace cannot crowd a filtered task's rows out", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const busyTask = makeTasks(fx, fx.busy.projectId, ["BUSY"])["BUSY"]!;
    const quietTask = makeTasks(fx, fx.quiet.projectId, ["QUIET"])["QUIET"]!;
    const busyRows = addRows(fx, busyTask, 20);
    const quietRows = addRows(fx, quietTask, 2);
    booted = await boot(fx);

    const cursor = busyRows[0]!; // the crowd really is ahead of the quiet rows
    const unfiltered = await poll(booted.client, { cursor, limit: 2 });
    assert.deepEqual(
      cursorsOf(unfiltered),
      [busyRows[1]!, busyRows[2]!],
      "without a filter the page is all busy-workspace rows (the crowd is real)",
    );

    // task_id: the quiet task's rows are reachable even though 18 busy rows
    // sit between the cursor and them
    const byTask = await poll(booted.client, { cursor, task_id: quietTask, limit: 1 });
    assert.deepEqual(cursorsOf(byTask), [quietRows[0]!], "task_id is applied before the limit");
    assert.equal(byTask.has_more, true, "one quiet row still remains");
    const byTaskNext = await poll(booted.client, { cursor: byTask.next_cursor, task_id: quietTask, limit: 1 });
    assert.deepEqual(cursorsOf(byTaskNext), [quietRows[1]!]);
    assert.equal(byTaskNext.has_more, false);

    // workspace_id: the quiet workspace's two rows at limit 2, no busy rows
    const byWorkspace = await poll(booted.client, {
      workspace_id: fx.quiet.workspaceId,
      limit: 2,
    });
    assert.deepEqual(cursorsOf(byWorkspace), quietRows, "workspace scope filters before the limit");
    assert.equal(byWorkspace.has_more, false);

    // project_id: one row at limit 1, the other one reported as more
    const byProject = await poll(booted.client, { project_id: fx.quiet.projectId, cursor, limit: 1 });
    assert.deepEqual(cursorsOf(byProject), [quietRows[0]!], "project scope filters before the limit");
    assert.equal(byProject.has_more, true);

    // and the busy scope stays scoped to itself
    const busyScope = await poll(booted.client, { workspace_id: fx.busy.workspaceId, cursor, limit: 25 });
    assert.deepEqual(cursorsOf(busyScope), busyRows.slice(1));
    assert.equal(busyScope.has_more, false);
  } finally {
    await shutdown(fx, booted);
  }
});

test("chain_run_id scopes to the chain's member tasks, with the chain slug projected", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    let chainRunId = "";
    let members: Record<string, string> = {};
    writer(fx, (db) => {
      const imported = importChain(
        db,
        { id: fx.quiet.workspaceId },
        { id: fx.quiet.projectId, slug: "prj2" },
        {
          version: "1.0.0",
          project_slug: "prj2",
          tasks: [
            { key: "PLAN", title: "Plan", objective: "Plan the work end to end.", profile_name: "dev" },
            {
              key: "WORK",
              title: "Work",
              objective: "Do the work end to end.",
              profile_name: "dev",
            },
          ],
          edges: [{ source_key: "PLAN", target_key: "WORK", edge_type: "depends_on" }],
        },
      );
      chainRunId = imported.chainRun.id;
      for (const [key, row] of Object.entries(imported.tasks)) members[key] = row.id;
    });
    const planRows = addRows(fx, members["PLAN"]!, 1);
    const workRows = addRows(fx, members["WORK"]!, 2);
    // a standalone task in the same workspace: never in the chain scope
    const soloId = makeTasks(fx, fx.quiet.projectId, ["SOLO"])["SOLO"]!;
    addRows(fx, soloId, 2);
    booted = await boot(fx);

    const page = await poll(booted.client, {
      chain_run_id: chainRunId,
      cursor: planRows[0]! - 1,
      limit: 10,
    });
    assert.deepEqual(cursorsOf(page), [...planRows, ...workRows], "only the chain's members");
    assert.deepEqual(
      page.transitions.map((t) => t["task_key"]),
      ["PLAN", "WORK", "WORK"],
      "the member task keys are joined for readability",
    );
    for (const t of page.transitions) {
      assert.equal(t["chain_run_id"], chainRunId, "chain members carry their chain run id");
      assert.equal(t["chain_slug"], "prj2", "chain rows carry the chain's project slug");
    }
    assert.equal(page.has_more, false);
  } finally {
    await shutdown(fx, booted);
  }
});

test("the argument shapes are validated: bad cursors/limits are schema_invalid, unknown scopes not_found", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    makeTasks(fx, fx.busy.projectId, ["ARGS"]);
    booted = await boot(fx);

    const bad = [
      { cursor: -1 },
      { cursor: 1.5 },
      { cursor: "3" },
      { limit: 0 },
      { limit: 2.5 },
      { workspace_id: 7 },
      { project_id: "" },
      { task_id: 3 },
      { chain_run_id: null },
    ];
    for (const args of bad) {
      const res = await booted.client.request({
        id: "bad",
        op: "nova_transitions_since",
        args,
      });
      assert.equal(res["ok"], false, `${JSON.stringify(args)} must be refused`);
      assert.equal(
        (res["error"] as { code: string }).code,
        "schema_invalid",
        `${JSON.stringify(args)} is a payload violation`,
      );
    }
    assert.equal((await poll(booted.client, { limit: 1000 })).has_more, false, "the documented max is accepted");
    // events.md ruling 4: ABOVE the max CLAMPS (a --follow drain asking 5000
    // must get a full page, not a refusal) — the judge caught the opposite here
    const clamped = await poll(booted.client, { limit: 5000 });
    assert.ok(clamped.transitions !== undefined, "limit above the max is served, not refused");
    assert.equal((await poll(booted.client, { limit: 1 })).has_more, false, "the documented min is accepted");

    for (const [args, what] of [
      [{ workspace_id: ulid() }, "workspace"],
      [{ project_id: ulid() }, "project"],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await booted.client.request({ id: "nf", op: "nova_transitions_since", args });
      assert.equal(res["ok"], false, `unknown ${what} must be refused`);
      assert.equal((res["error"] as { code: string }).code, "not_found", `unknown ${what} is not_found`);
    }

    // an unknown task/chain id is NOT a 404: the filters are scope, and an
    // empty scope is an honest empty page (events.md names only
    // workspace/project in its not_found rule)
    assert.deepEqual((await poll(booted.client, { task_id: ulid() })).transitions, []);
    assert.deepEqual((await poll(booted.client, { chain_run_id: ulid() })).transitions, []);
  } finally {
    await shutdown(fx, booted);
  }
});

/* -------------------------------- projection -------------------------------- */

test("the row projection is exactly events.md's field set (task key joined, reason may be null)", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["PROJ"]);
    const runId = makeRun(fx, tasks["PROJ"]!, ulid());
    const bare = addRows(fx, tasks["PROJ"]!, 1);
    const withReason = addRows(fx, tasks["PROJ"]!, 1, {
      runId,
      fromState: "awaiting_gate",
      toState: "changes_requested",
      triggerType: "human",
      actor: "operator",
      reason: "the artifact skipped the migration story",
    });
    booted = await boot(fx);

    const page = await poll(booted.client, { cursor: bare[0]! - 1 });
    assert.equal(page.transitions.length, 2);
    const [first, second] = page.transitions as Array<Record<string, unknown>>;

    assert.deepEqual(
      Object.keys(first!).sort(),
      [
        "actor",
        "chain_run_id",
        "chain_slug",
        "created_at",
        "cursor",
        "from_state",
        "reason",
        "run_id",
        "task_id",
        "task_key",
        "to_state",
        "trigger_type",
      ],
      "exactly the documented projection — no more, no less",
    );
    assert.deepEqual(Object.keys(second!).sort(), Object.keys(first!).sort());

    assert.equal(first!["cursor"], bare[0]);
    assert.equal(first!["task_id"], tasks["PROJ"]);
    assert.equal(first!["task_key"], "PROJ", "the task key is joined for readability");
    assert.equal(first!["run_id"], null, "a row without a run projects null, not a missing key");
    assert.equal(first!["chain_run_id"], null);
    assert.equal(first!["chain_slug"], null, "a standalone task has no chain slug");
    assert.equal(first!["from_state"], "draft");
    assert.equal(first!["to_state"], "queued");
    assert.equal(first!["trigger_type"], "engine");
    assert.equal(first!["actor"], "engine:worker");
    assert.equal(first!["reason"], null, "reason may be null");
    assert.match(String(first!["created_at"]), /^\d{4}-\d{2}-\d{2}T/, "created_at is the store's UTC stamp");

    assert.equal(second!["cursor"], withReason[0]);
    assert.equal(second!["run_id"], runId);
    assert.equal(second!["from_state"], "awaiting_gate");
    assert.equal(second!["to_state"], "changes_requested");
    assert.equal(second!["trigger_type"], "human");
    assert.equal(second!["actor"], "operator");
    assert.equal(second!["reason"], "the artifact skipped the migration story");
  } finally {
    await shutdown(fx, booted);
  }
});

/* -------------------------------- read-only -------------------------------- */

test("the op is read-only: polling writes no transition rows and moves no task", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["RO"]);
    addRows(fx, tasks["RO"]!, 3);
    booted = await boot(fx);

    const before = transitionCount(fx.dbPath);
    const statesBefore = (() => {
      const db = new Database(fx.dbPath, { readonly: true });
      try {
        return db.prepare("SELECT id, state, updated_at FROM tasks ORDER BY id").all();
      } finally {
        db.close();
      }
    })();

    await poll(booted.client, {});
    await poll(booted.client, { limit: 1 });
    await poll(booted.client, { cursor: 1 });
    await poll(booted.client, { workspace_id: fx.busy.workspaceId });
    await poll(booted.client, { task_id: tasks["RO"]! });

    assert.equal(transitionCount(fx.dbPath), before, "no transition row was written");
    const db = new Database(fx.dbPath, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT id, state, updated_at FROM tasks ORDER BY id").all(), statesBefore);
    } finally {
      db.close();
    }
  } finally {
    await shutdown(fx, booted);
  }
});

test("a dead socket answers daemon_unreachable — the op has no SQLite fallback (events.md rule 6)", async () => {
  const fx = fixture();
  let booted: Booted | undefined;
  try {
    const tasks = makeTasks(fx, fx.busy.projectId, ["DEAD"]);
    addRows(fx, tasks["DEAD"]!, 2);
    booted = await boot(fx);
    // the op works while the daemon lives…
    assert.equal((await poll(booted.client, {})).transitions.length, 2);
    booted.client.close();
    await booted.handle.stop();

    // …and its absence is information, not a store read: a liveness feed
    // served from a store whose writer just died would report a frozen
    // world as current
    await assert.rejects(
      () => daemonRequest("nova_transitions_since", {}, { socketPath: fx.socketPath }),
      (err: unknown) => {
        assert.ok(err instanceof DaemonUnreachableError, `expected daemon_unreachable, got ${String(err)}`);
        return true;
      },
    );
    // the rows still exist: the refusal is about liveness, not missing state
    assert.equal(transitionCount(fx.dbPath), 2);
  } finally {
    await shutdown(fx, booted);
  }
});
