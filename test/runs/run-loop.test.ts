import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition, InvalidTransitionError } from "../../src/fsm/engine.ts";
import { createTask, ENQUEUE_TRIGGER, getTask } from "../../src/tasks.ts";
import { composePrompt } from "../../src/runs/prompt.ts";
import { buildRunArgv } from "../../src/runs/spawn.ts";
import { startRun, type RunOutcome, type TaskRunRecord } from "../../src/runs/loop.ts";
import { inertPricesNote } from "../../src/runs/prices.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const BOUND_MS = 15000;
const MODEL = "claude-3-5-sonnet-20241022";

/** prices fixture: $3 / $15 per 1M in/out, plus the cache rates the
 *  cache-aware contract adds ($0.30 cache read / $3.75 cache write per 1M).
 *  The non-cache stubs report no cache tokens, so their costs are unchanged. */
const PRICES = { [MODEL]: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } };

type Seed = {
  db: Database.Database;
  wsRoot: string;
  taskId: string;
  pricesPath: string;
  pidfile: string;
};

function pricesFile(dir: string): string {
  const p = join(dir, "prices.json");
  writeFileSync(p, JSON.stringify(PRICES));
  return p;
}

/**
 * Seeded store + a REAL temp workspace root (the run dirs are written
 * there): profile with a system prompt file, task with one mapped
 * context file, already enqueued (the slot grant is startRun's caller).
 */
function seed(opts: { systemPrompt?: boolean; overrides?: string; gate?: boolean } = {}): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-ws-"));
  mkdirSync(join(wsRoot, "prompts"), { recursive: true });
  mkdirSync(join(wsRoot, "docs"), { recursive: true });
  if (opts.systemPrompt !== false) {
    writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
  }
  writeFileSync(join(wsRoot, "docs", "spec.md"), "# Spec\nImplement PKCE.\n");

  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, thinking_level, system_prompt_path,
        max_timeout_sec, max_cost_usd)
     VALUES (?, NULL, 'dev', 'anthropic', ?, 'medium', 'prompts/dev_system.md', 60, 1.5)`,
  ).run(ulid(), MODEL);
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;

  const task = createTask(db, {
    projectId,
    key: "TASK-101",
    title: "Implement PKCE",
    objective: "Implement PKCE code challenge verification.",
    profileId,
    requiresHumanGate: opts.gate === true,
    contextFiles: ["docs/spec.md"],
  });
  if (opts.overrides !== undefined) {
    db.prepare("UPDATE tasks SET overrides_json = ? WHERE id = ?").run(opts.overrides, task.id);
  }
  applyTransition(db, task.id, ENQUEUE_TRIGGER, { triggerType: "engine", actor: "test" });

  const dir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  return {
    db,
    wsRoot,
    taskId: task.id,
    pricesPath: pricesFile(dir),
    pidfile: join(dir, "stub.pid"),
  };
}

function run(s: Seed, mode: string, over: Record<string, unknown> = {}): Promise<RunOutcome> {
  return startRun(s.db, s.taskId, "engine-worker", {
    piBin: "node",
    args: [STUB, mode, s.pidfile],
    pricesPath: s.pricesPath,
    extensionPath: "/ext/novaflow.ts",
    ...over,
  });
}

function runRow(s: Seed, attempt: number): TaskRunRecord {
  const rows = s.db
    .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number")
    .all(s.taskId) as TaskRunRecord[];
  const row = rows[attempt - 1];
  assert.ok(row, `no run row for attempt ${attempt}`);
  return row;
}

function runCount(s: Seed): number {
  return (s.db
    .prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?")
    .get(s.taskId) as { n: number }).n;
}

function transitions(s: Seed): Array<Record<string, unknown>> {
  return s.db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
    .all(s.taskId) as Array<Record<string, unknown>>;
}

async function assertReaped(pid: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — the child is gone
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`stub process ${pid} is still alive after startRun resolved`);
}

function receipt(runDir: string): {
  prompt: unknown;
  context: Record<string, unknown> | null;
  novflow_run_context: string | null;
  argv: string[];
  emitted: string[];
} {
  return JSON.parse(readFileSync(join(runDir, "stub-receipt.json"), "utf8"));
}

/* -------------------------------------- run-ok -------------------------------------- */

test("run-ok: settle → validating, full run record, api.md §1 argv, FR-TSK-04 prompt, two-file logging", async (t) => {
  const s = seed();
  // thinking_level override rides tasks.overrides_json (DDL comment)
  s.db.prepare("UPDATE tasks SET overrides_json = ? WHERE id = ?").run(
    JSON.stringify({ thinking_level: "high" }),
    s.taskId,
  );
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "validating");
    assert.equal(getTask(s.db, s.taskId)?.state, "validating");

    // ---- the run record (FR-TSK-09): every column the DDL gives us ----
    const row = runRow(s, 1);
    assert.equal(runCount(s), 1);
    assert.equal(row.attempt_number, 1);
    assert.equal(row.attempt_kind, "execution");
    assert.equal(row.profile_id, (s.db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id);
    assert.equal(row.model_used, MODEL);
    assert.equal(row.thinking_level, "high"); // the level actually used
    assert.equal(row.status, "succeeded");
    assert.equal(row.preflight_status, "passed");
    assert.equal(row.pi_session_id, row.id); // bare ULID (data.md 5.1)
    assert.ok(statSync(row.pi_session_dir).isDirectory());
    assert.equal(row.pi_session_dir, join(s.wsRoot, ".novaflow", "runs", s.taskId, row.id));
    assert.equal(row.exit_code, 0);
    assert.equal(row.artifact_path, join(row.pi_session_dir, "result.json"));
    assert.ok(existsSync(row.artifact_path!));
    assert.equal(row.input_tokens, 4500);
    assert.equal(row.output_tokens, 620);
    // the non-cache stream reports no cache components (fresh input only)
    assert.equal(row.cache_read_tokens, 0);
    assert.equal(row.cache_write_tokens, 0);
    // exact cost math: 4500/1M × $3 + 620/1M × $15 = 0.0228
    assert.ok(Math.abs(row.cost_usd - 0.0228) < 1e-9, `cost ${row.cost_usd}`);
    assert.equal(typeof row.pid, "number");
    assert.ok((row.duration_ms ?? 0) >= 0);
    assert.ok(row.ended_at !== null);
    assert.equal(row.git_commits_json, "{}"); // chain/worktree diffing is later scope
    assert.equal(row.engine_verification_passed, 0); // validating-phase verification is p2c scope
    assert.equal(row.events_log_path, join(row.pi_session_dir, "events.jsonl"));
    await assertReaped(row.pid!); // no leaked child

    // ---- engine-owned fields left untouched on the validating path ----
    const artifact = JSON.parse(readFileSync(row.artifact_path!, "utf8")) as Record<string, unknown>;
    assert.equal(artifact["status"], "completed"); // recorded, not overwritten here

    // ---- two-file logging (data.md 1.1 / FR-LOG-02) ----
    const rawPath = join(row.pi_session_dir, "events.raw.jsonl");
    const redactedPath = join(row.pi_session_dir, "events.jsonl");
    const rec = receipt(row.pi_session_dir);
    // raw is VERBATIM, byte for byte against the stub's exact output
    assert.equal(readFileSync(rawPath, "utf8"), rec.emitted.join("\n") + "\n");
    // and 0600 from the first byte
    assert.equal(statSync(rawPath).mode & 0o777, 0o600);
    // the frames are the api.md §4 event shapes
    assert.ok(rec.emitted.some((l) => l.includes('"type":"message_update"')));
    assert.ok(rec.emitted.some((l) => l.includes('"type":"tool_execution_start"')));
    assert.ok(rec.emitted.some((l) => l.includes('"type":"tool_execution_end"')));
    assert.ok(rec.emitted.some((l) => l.includes('"type":"message_end"')));
    assert.ok(rec.emitted.some((l) => l.includes('"type":"agent_settled"')));
    // redacted stream: same line count, all parseable (scrubbed copy of a clean stream)
    const redacted = readFileSync(redactedPath, "utf8").trim().split("\n");
    assert.equal(redacted.length, rec.emitted.length);
    for (const line of redacted) JSON.parse(line);

    // ---- the spawn argv is EXACTLY api.md §1 ----
    assert.deepEqual(
      rec.argv,
      [
        "run-ok", s.pidfile,
        ...buildRunArgv({
          extensionPath: "/ext/novaflow.ts",
          runDir: row.pi_session_dir,
          runId: row.id,
          model: MODEL,
          thinkingLevel: "high", // profile default overridden
          systemPromptFile: join(s.wsRoot, "prompts", "dev_system.md"),
        }),
      ],
    );

    // ---- FR-TSK-04: objective + ONLY the mapped context files ----
    const expectedPrompt = composePrompt({
      objective: "Implement PKCE code challenge verification.",
      contextFiles: ["docs/spec.md"],
      workspaceRoot: s.wsRoot,
    });
    assert.equal(rec.prompt, expectedPrompt.message);
    assert.ok(String(rec.prompt).includes("# Spec\nImplement PKCE."));

    // ---- engine-context.json per api.md §6, passed via NOVAFLOW_RUN_CONTEXT ----
    assert.equal(rec.novflow_run_context, join(row.pi_session_dir, "engine-context.json"));
    const ctx = JSON.parse(readFileSync(rec.novflow_run_context!, "utf8"));
    assert.deepEqual(ctx, rec.context);
    assert.equal(ctx.task_id, s.taskId);
    assert.equal(ctx.run_id, row.id);
    assert.equal(ctx.attempt_kind, "execution");
    assert.deepEqual(ctx.scopes, []); // no target scopes → empty structures
    assert.deepEqual(ctx.output_schema, { id: "1.0.0", inline: null });
    assert.deepEqual(ctx.budget, { max_timeout_sec: 60, max_cost_usd: 1.5 });
    assert.deepEqual(ctx.verification_commands, []);

    // ---- the audit trail: queued→running, running→validating ----
    const tr = transitions(s);
    assert.deepEqual(
      tr.map((x) => [x["from_state"], x["to_state"], x["trigger_type"]]),
      [
        ["draft", "queued", "engine"], // seed enqueue
        ["queued", "running", "engine"],
        ["running", "validating", "engine"],
      ],
    );
    assert.equal(tr[2]?.["run_id"], row.id);
    assert.equal(tr[2]?.["actor"], "engine-worker");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ------------------------------- cache-aware accounting ------------------------------ */

test("run-cache: fresh input, cache read and cache write are stored separately and priced; the sums reconcile with the raw stream", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-cache"));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s, 1);

    // the stub's cache-aware message_end: input 10_000 (FRESH prompt tokens),
    // cacheRead 500_000, cacheWrite 80_000, output 2_000
    assert.equal(row.input_tokens, 10_000); // fresh only — never the conflated total
    assert.equal(row.cache_read_tokens, 500_000);
    assert.equal(row.cache_write_tokens, 80_000);
    assert.equal(row.output_tokens, 2_000);

    // exact cost: 10_000×$3 + 500_000×$0.30 + 80_000×$3.75 + 2_000×$15 per 1M
    //             = 0.03 + 0.15 + 0.30 + 0.03 = $0.51
    assert.equal(row.cost_usd.toFixed(2), "0.51");
    assert.ok(Math.abs(row.cost_usd - 0.51) < 1e-9, `cost ${row.cost_usd}`);

    // reconciliation with the run's own streams: both files carry the same
    // usage frames, and the stored columns are exactly their per-column sums
    const streams = ["events.raw.jsonl", "events.jsonl"];
    for (const name of streams) {
      const lines = readFileSync(join(row.pi_session_dir, name), "utf8")
        .split("\n")
        .filter((l) => l !== "");
      let input = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const line of lines) {
        const frame = JSON.parse(line) as {
          usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
        };
        input += frame.usage?.input ?? 0;
        cacheRead += frame.usage?.cacheRead ?? 0;
        cacheWrite += frame.usage?.cacheWrite ?? 0;
      }
      assert.equal(input, row.input_tokens, `${name}: fresh input sum`);
      assert.equal(cacheRead, row.cache_read_tokens, `${name}: cache read sum`);
      assert.equal(cacheWrite, row.cache_write_tokens, `${name}: cache write sum`);
      assert.equal(
        input + cacheRead + cacheWrite,
        row.input_tokens + row.cache_read_tokens + row.cache_write_tokens,
        `${name}: the prompt side reconciles as one sum of three components`,
      );
    }
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ----------------------------------- run-blocked ------------------------------------ */

test("run-blocked: agent status blocked → the gate row → awaiting_gate", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-blocked"));
    assert.equal(outcome.finalState, "awaiting_gate");
    const row = runRow(s, 1);
    assert.equal(row.status, "succeeded");
    assert.equal(JSON.parse(readFileSync(row.artifact_path!, "utf8")).status, "blocked");
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["to_state"], "awaiting_gate");
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("requires_human_gate + a completed artifact → the gate row → awaiting_gate", async (t) => {
  const s = seed({ gate: true });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "awaiting_gate");
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["to_state"], "awaiting_gate");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ------------------------------------- repair --------------------------------------- */

test("run-repair-ok: execution settles missing → FR-TSK-06 repair run → validating (max 1 repair)", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-repair-ok"));
    assert.equal(outcome.finalState, "validating");
    assert.equal(outcome.runs.length, 2);

    const first = runRow(s, 1);
    assert.equal(first.attempt_kind, "execution");
    assert.equal(first.status, "failed"); // no valid artifact
    assert.equal(first.error_summary, "result.json missing after agent_settled");
    assert.equal(first.exit_code, 0); // the process itself was fine

    const repair = runRow(s, 2);
    assert.equal(repair.attempt_kind, "repair");
    assert.equal(repair.attempt_number, 2);
    assert.equal(repair.status, "succeeded");
    assert.ok(existsSync(repair.artifact_path!));

    // the repair prompt carries the failure feedback (FR-TSK-06)
    const rec = receipt(repair.pi_session_dir);
    const expected = composePrompt({
      objective: "Implement PKCE code challenge verification.",
      contextFiles: ["docs/spec.md"],
      workspaceRoot: s.wsRoot,
      repairFeedback: "result.json missing after agent_settled",
    });
    assert.equal(rec.prompt, expected.message);
    // DEBT-014: an in-place attempt (worktree_root NULL) adds NO pointer —
    // the one repair sentence is absent, not merely empty
    assert.equal(first.worktree_root, null);
    assert.equal(String(rec.prompt).includes("read-only evidence"), false);
    // and the repair run's engine-context says attempt_kind repair
    assert.equal((rec.context as Record<string, unknown>)["attempt_kind"], "repair");

    // audit trail: queued→running, running→running (repair), running→validating
    const tr = transitions(s);
    assert.deepEqual(
      tr.map((x) => [x["from_state"], x["to_state"]]),
      [
        ["draft", "queued"],
        ["queued", "running"],
        ["running", "running"],
        ["running", "validating"],
      ],
    );
    assert.equal(tr[2]?.["run_id"], first.id); // the causative attempt is logged
    await assertReaped(first.pid!);
    await assertReaped(repair.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-missing twice: repair also missing → running→failed via the invalid-JSON row", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-missing"));
    assert.equal(outcome.finalState, "failed");
    assert.equal(runCount(s), 2); // exactly one repair, no more
    assert.equal(runRow(s, 1).status, "failed");
    assert.equal(runRow(s, 2).status, "failed");
    assert.equal(runRow(s, 2).attempt_kind, "repair");
    const tr = transitions(s);
    assert.deepEqual(
      tr.map((x) => [x["from_state"], x["to_state"]]),
      [
        ["draft", "queued"],
        ["queued", "running"],
        ["running", "running"],
        ["running", "failed"],
      ],
    );
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-invalid twice: schema-invalid result.json both times → failed", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-invalid"));
    assert.equal(outcome.finalState, "failed");
    assert.equal(runCount(s), 2);
    const second = runRow(s, 2);
    assert.match(second.error_summary ?? "", /result\.json failed structural validation/);
    assert.match(second.error_summary ?? "", /status/);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ------------------------------- budget & timeout kill ------------------------------- */

test("run-hang: max_timeout_sec override → SIGTERM→3 s grace→SIGKILL backstop, run timed_out, task failed", async (t) => {
  const s = seed({ overrides: JSON.stringify({ timeout_sec: 1 }) });
  try {
    const started = Date.now();
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-hang"));
    const elapsed = Date.now() - started;
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "timed_out");
    assert.match(row.error_summary ?? "", /timeout: exceeded max_timeout_sec 1s/);
    assert.ok(elapsed < 8000, `timeout path must not stall, took ${elapsed} ms`);
    // the kill was SIGTERM (the stub records taking it)
    assert.match(readFileSync(s.pidfile, "utf8"), /SIGTERM/);
    await assertReaped(row.pid!);
    // the transition is the verbatim budget-or-timeout row, trigger_type timeout
    const tr = transitions(s);
    const last = tr[tr.length - 1]!;
    assert.equal(last["to_state"], "failed");
    assert.equal(last["trigger_type"], "timeout");
    // usage frames before the kill are still recorded
    assert.equal(row.input_tokens, 0);
    assert.equal(row.output_tokens, 0);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-overspend: budget breach → killed, run failed with budget_exceeded, tokens/cost recorded", async (t) => {
  const s = seed({ overrides: JSON.stringify({ max_cost_usd: 0.05 }) });
  try {
    // huge usage on the stub's message_end, priced by the fixture table
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-overspend"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "failed");
    assert.match(row.error_summary ?? "", /budget_exceeded/);
    // the breach frame was tallied before the kill (2M in at $3 + 1M out at $15 = $21)
    assert.equal(row.input_tokens, 2_000_000);
    assert.equal(row.output_tokens, 1_000_000);
    assert.ok(Math.abs(row.cost_usd - 21) < 1e-9, `cost ${row.cost_usd}`);
    assert.match(readFileSync(s.pidfile, "utf8"), /SIGTERM/);
    await assertReaped(row.pid!);
    assert.equal(transitions(s)[2]?.["to_state"], "failed");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* --------------------------- group kill & escalation -------------------------------- */

test("run-fork-grandchild: a timeout kill signals the whole process group — the grandchild takes the SIGTERM too (killpg, architecture 8.4)", async (t) => {
  const s = seed({ overrides: JSON.stringify({ timeout_sec: 1 }) });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-fork-grandchild"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "timed_out");
    const pidfile = readFileSync(s.pidfile, "utf8");
    assert.match(pidfile, /SIGTERM/); // the direct child took it
    assert.match(pidfile, /GRANDCHILD-SIGTERM/); // and so did the forked grandchild
    // the grandchild was reaped too (group kill, no orphan)
    const m = pidfile.match(/GRANDCHILD (\d+)/);
    assert.ok(m, pidfile);
    await assertReaped(Number(m[1]));
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-settle-linger: a settled run is never killed by the run clock — intake wins, process reaped", async (t) => {
  const s = seed({ overrides: JSON.stringify({ timeout_sec: 1 }) });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-settle-linger"));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s, 1);
    assert.equal(row.status, "succeeded");
    assert.ok(existsSync(row.artifact_path!));
    assert.doesNotMatch(row.error_summary ?? "", /timeout/);
    // the lingering process was still reaped by the time startRun resolved
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-hang-ignore-term: SIGTERM taken and ignored → the grace backstop escalates to group SIGKILL", async (t) => {
  const s = seed({ overrides: JSON.stringify({ timeout_sec: 1 }) });
  try {
    const started = Date.now();
    const outcome = await withBound(
      t.signal,
      BOUND_MS,
      run(s, "run-hang-ignore-term", { killGraceMs: 500 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "timed_out");
    // the stub records taking (and ignoring) the SIGTERM…
    assert.match(readFileSync(s.pidfile, "utf8"), /SIGTERM-IGNORED/);
    // …and only the SIGKILL backstop ended it, fast
    assert.ok(elapsed < 4000, `escalation must be prompt, took ${elapsed} ms`);
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-fork-grandchild lingering: a grandchild holding the stdout pipe cannot hang finalization", async (t) => {
  const s = seed({ overrides: JSON.stringify({ timeout_sec: 1 }) });
  try {
    // the grandchild takes the group SIGTERM but lingers 20 s holding the
    // inherited stdout pipe — the run must still finalize without the
    // stdout close event
    const outcome = await withBound(
      t.signal,
      BOUND_MS,
      run(s, "run-fork-grandchild", {
        killGraceMs: 500,
        env: { STUB_GRANDCHILD_LINGER_MS: "20000" },
      }),
    );
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "timed_out");
    const pidfile = readFileSync(s.pidfile, "utf8");
    assert.match(pidfile, /GRANDCHILD-SIGTERM/);
    await assertReaped(row.pid!);
    // The masking cleanup is gone: the grandchild ignores SIGTERM's effect
    // and lingers 20 s. ONLY the still-armed group SIGKILL backstop can
    // reap it — this assertion fails if the backstop is cleared on leader
    // exit (re-judge finding 1).
    const m = pidfile.match(/GRANDCHILD (\d+)/);
    assert.ok(m, pidfile);
    await assertReaped(Number(m[1]));
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* -------------------------------------- crash --------------------------------------- */

test("run-crash: nonzero exit before settle → run failed with exit_code, task failed", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-crash"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "failed");
    assert.equal(row.exit_code, 3);
    assert.match(row.error_summary ?? "", /exited before agent_settled/);
    assert.equal(runCount(s), 1); // a crash is NOT a repair trigger
    const tr = transitions(s);
    assert.equal(tr[tr.length - 1]?.["to_state"], "failed");
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("run-crash-stderr: the crash path captures stderr into error_summary and events.jsonl only — never events.raw.jsonl", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-crash-stderr"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.exit_code, 3);
    // the scrubbed stderr tail lands in error_summary — with the fake
    // token masked, not copied verbatim
    assert.match(row.error_summary ?? "", /pi-stub crash marker/);
    assert.match(row.error_summary ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(row.error_summary ?? "", /sk-abcdef/);
    // one engine failure frame in the REDACTED read surface…
    const redacted = readFileSync(join(row.pi_session_dir, "events.jsonl"), "utf8").trim().split("\n");
    const failure = redacted.filter((l) => l.includes("novaflow_run_failure"));
    assert.equal(failure.length, 1);
    const frame = JSON.parse(failure[0]!) as Record<string, unknown>;
    assert.equal(frame["type"], "novaflow_run_failure");
    assert.equal(frame["reason"], "crash");
    assert.equal(frame["exit"], 3);
    assert.match(String(frame["stderr_tail"]), /pi-stub crash marker/);
    assert.match(String(frame["stderr_tail"]), /\[REDACTED\]/);
    // …and NOT a byte of it in the verbatim raw file
    const raw = readFileSync(join(row.pi_session_dir, "events.raw.jsonl"), "utf8");
    assert.doesNotMatch(raw, /novaflow_run_failure|crash marker|sk-abcdef/);
    await assertReaped(row.pid!);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("unspawnable pi binary → AC3 preflight failure (DEBT-002), exit_code null, task failed, zero spawns", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(
      t.signal,
      BOUND_MS,
      startRun(s.db, s.taskId, "engine-worker", {
        piBin: "/no/such/pi-binary",
        pricesPath: s.pricesPath,
      }),
    );
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "failed");
    assert.equal(row.exit_code, null);
    // FR-TSK-10 AC3 (DEBT-002): an unresolvable pi binary is now caught
    // at PREFLIGHT — zero tokens, never a spawn attempt
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /pi binary "\/no\/such\/pi-binary" is not executable/);
    assert.equal(existsSync(s.pidfile), false);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* --------------------------------- prices absence ----------------------------------- */

test("missing prices.json + a budget → the run still succeeds, but records that cost enforcement is inert", async (t) => {
  const s = seed();
  try {
    const pricesPath = join(s.pidfile, "..", "no-such-prices.json");
    const outcome = await withBound(
      t.signal,
      BOUND_MS,
      run(s, "run-ok", { pricesPath }),
    );
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s, 1);
    assert.equal(row.status, "succeeded");
    assert.ok(
      row.error_summary?.includes(inertPricesNote("missing", pricesPath)),
      row.error_summary ?? "",
    );
    assert.equal(row.cost_usd, 0); // all-zero pricing — pricing never took the run down
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("a priced run with prices.json present → no inert note, error_summary stays null", async (t) => {
  const s = seed();
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "validating");
    const row = runRow(s, 1);
    assert.equal(row.status, "succeeded");
    assert.equal(row.error_summary, null);
    // and the cost math is live (4500/1M × $3 + 620/1M × $15)
    assert.ok(Math.abs(row.cost_usd - 0.0228) < 1e-9);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ------------------------------------ preflight -------------------------------------- */

test("missing system prompt file → preflight failure, NOT a spawn; run + task failed", async (t) => {
  const s = seed({ systemPrompt: false });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.status, "failed");
    assert.equal(row.preflight_status, "failed");
    assert.equal(row.pid, null);
    assert.match(row.error_summary ?? "", /system prompt file missing/);
    // the stub was never spawned — no pidfile was written
    assert.equal(existsSync(s.pidfile), false);
    assert.equal(transitions(s)[2]?.["to_state"], "failed");
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("an unreadable mapped context file is a hard preflight failure naming the path", async (t) => {
  const s = seed();
  rmSync(join(s.wsRoot, "docs", "spec.md")); // mapped but gone
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.match(row.error_summary ?? "", /unreadable context file "docs\/spec\.md"/);
    assert.equal(existsSync(s.pidfile), false);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

test("a malformed overrides_json is a preflight failure with a full audit trail", async (t) => {
  const s = seed({ overrides: '{"timeout_sec": "soon"}' });
  try {
    const outcome = await withBound(t.signal, BOUND_MS, run(s, "run-ok"));
    assert.equal(outcome.finalState, "failed");
    const row = runRow(s, 1);
    assert.equal(row.preflight_status, "failed");
    assert.match(row.error_summary ?? "", /overrides_json invalid/);
    assert.equal(row.thinking_level, null); // unknown until overrides resolve
    assert.equal(existsSync(s.pidfile), false);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});

/* ----------------------------------- matrix guard ------------------------------------ */

test("startRun refuses a non-queued task (matrix guard) with no side effects", async (t) => {
  const s = seed();
  try {
    await withBound(t.signal, BOUND_MS, run(s, "run-ok")); // queued → validating
    const pidfileBefore = existsSync(s.pidfile) ? readFileSync(s.pidfile, "utf8") : "";
    await assert.rejects(
      withBound(t.signal, BOUND_MS, run(s, "run-ok")),
      InvalidTransitionError,
    );
    assert.equal(runCount(s), 1); // no second run row
    // and no second spawn either — the pidfile is untouched
    assert.equal(
      existsSync(s.pidfile) ? readFileSync(s.pidfile, "utf8") : "",
      pidfileBefore,
    );
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
    rmSync(join(s.pidfile, ".."), { recursive: true, force: true });
  }
});
