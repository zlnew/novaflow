import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFileStore, MODEL } from "./seed.ts";
import { createTask } from "../../src/tasks.ts";
import { ulid } from "../../src/store/ids.ts";
import { loadPricesDetailed, type PriceTable } from "../../src/runs/prices.ts";
import { spendBlock } from "../../src/daemon/lifecycle.ts";

/**
 * novaflow-v02/spend.md — the `nova_daemon_status` spend block.
 *
 *   "spend": {
 *     "prices_armed": true, "inert_models": ["…"],
 *     "today": {"cost_usd": …, "runs": …},   // UTC day boundary
 *     "month": {"cost_usd": …, "runs": …},   // UTC calendar month
 *     "by_model": [{"model": "…", "cost_usd": …, "runs": …}]
 *   }
 *
 * "Numbers derive from `task_runs` (no new table, no new writes); a run still
 * in flight counts once it has a `cost_usd`." Day/month boundaries are UTC —
 * an operator-local boundary would make two daemons disagree.
 */

/** A `now` chosen so a "yesterday 23:59 UTC" row is unambiguous. */
const NOW = new Date("2026-03-15T10:00:00.000Z");

type RunSeed = {
  model: string;
  startedAt: string;
  cost: number;
  status?: string;
};

/** Insert task_runs rows the way the loop leaves them (values verbatim). */
function insertRuns(db: Database.Database, taskId: string, runs: RunSeed[]): void {
  const stmt = db.prepare(
    `INSERT INTO task_runs
       (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir, status,
        preflight_status, model_used, input_tokens, output_tokens, cost_usd,
        events_log_path, started_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'passed', ?, 10, 5, ?, ?, ?)`,
  );
  runs.forEach((r, i) => {
    const id = ulid();
    stmt.run(
      id,
      taskId,
      i + 1,
      id,
      `/nonexistent/${id}`,
      r.status ?? "succeeded",
      r.model,
      r.cost,
      `/nonexistent/${id}/events.jsonl`,
      r.startedAt,
    );
  });
}

function withStore(fn: (db: Database.Database, taskId: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-spend-"));
  const seeded = seedFileStore(dir);
  const db = new Database(seeded.dbPath);
  try {
    const task = createTask(db, {
      projectId: seeded.projectId,
      key: "TASK-SPEND",
      title: "spend fixture",
      objective: "spend fixture",
      profileId: seeded.profileId,
    });
    fn(db, task.id, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const PRICE_FILE: PriceTable = {
  "model-a": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  "model-b": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
};

function loaded(dir: string, table: PriceTable = PRICE_FILE) {
  const path = join(dir, "prices.json");
  writeFileSync(path, JSON.stringify(table));
  return loadPricesDetailed(path);
}

test("spend: UTC day and month windows — a run stamped yesterday 23:59 UTC counts yesterday, not today", () => {
  withStore((db, taskId, dir) => {
    insertRuns(db, taskId, [
      // yesterday, one minute before the UTC day boundary
      { model: "model-a", startedAt: "2026-03-14T23:59:00.000Z", cost: 0.25 },
      // today, one minute after it
      { model: "model-a", startedAt: "2026-03-15T00:01:00.000Z", cost: 0.5 },
      // still in flight: counted (it has a cost_usd) but has not accrued cost
      { model: "model-a", startedAt: "2026-03-15T00:00:30.000Z", cost: 0, status: "running" },
      // this UTC month, not today
      { model: "model-b", startedAt: "2026-03-01T00:00:00.000Z", cost: 1 },
      // previous UTC month, last millisecond — neither window
      { model: "model-b", startedAt: "2026-02-28T23:59:59.999Z", cost: 3 },
    ]);

    const spend = spendBlock(db, loaded(dir), NOW);
    assert.deepEqual(spend.today, { cost_usd: 0.5, runs: 2 });
    assert.deepEqual(spend.month, { cost_usd: 1.75, runs: 4 });
  });
});

test("spend: by_model groups the month window by model_used (cost desc, model asc)", () => {
  withStore((db, taskId, dir) => {
    insertRuns(db, taskId, [
      { model: "model-a", startedAt: "2026-03-14T23:59:00.000Z", cost: 0.25 },
      { model: "model-a", startedAt: "2026-03-15T00:01:00.000Z", cost: 0.5 },
      { model: "model-a", startedAt: "2026-03-15T00:00:30.000Z", cost: 0, status: "running" },
      { model: "model-b", startedAt: "2026-03-01T00:00:00.000Z", cost: 1 },
      // outside the window: absent from by_model
      { model: "model-b", startedAt: "2026-02-28T23:59:59.999Z", cost: 3 },
    ]);

    const spend = spendBlock(db, loaded(dir), NOW);
    assert.deepEqual(spend.by_model, [
      { model: "model-b", cost_usd: 1, runs: 1 },
      { model: "model-a", cost_usd: 0.75, runs: 3 },
    ]);
  });
});

test("spend: an unpriced model in use is never a free zero — prices_armed false + inert_models names it", () => {
  withStore((db, taskId, dir) => {
    insertRuns(db, taskId, [
      { model: "model-a", startedAt: "2026-03-15T00:01:00.000Z", cost: 0.5 },
      { model: "stub-model", startedAt: "2026-03-15T02:00:00.000Z", cost: 0 },
    ]);

    // model-a is fully priced, stub-model has no row at all
    const spend = spendBlock(db, loaded(dir), NOW);
    assert.equal(spend.prices_armed, false);
    assert.deepEqual(spend.inert_models, ["stub-model"]);

    // once every model in use has a complete row, the breaker is armed
    const armed = spendBlock(
      db,
      loaded(dir, { ...PRICE_FILE, "stub-model": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 } }),
      NOW,
    );
    assert.equal(armed.prices_armed, true);
    assert.deepEqual(armed.inert_models, []);
  });
});

test("spend: a missing prices.json reports inert for every model in use (never zero-as-free)", () => {
  withStore((db, taskId, dir) => {
    insertRuns(db, taskId, [{ model: MODEL, startedAt: "2026-03-15T00:01:00.000Z", cost: 0.5 }]);
    const spend = spendBlock(db, loadPricesDetailed(join(dir, "absent.json")), NOW);
    assert.equal(spend.prices_armed, false);
    assert.deepEqual(spend.inert_models, [MODEL]);
    // the recorded cost is still reported: it is what the store knows
    assert.deepEqual(spend.today, { cost_usd: 0.5, runs: 1 });
  });
});

test("spend: an entry that predates the cache amendment does not arm the breaker (its cache would price as zero)", () => {
  withStore((db, taskId, dir) => {
    insertRuns(db, taskId, [{ model: "model-a", startedAt: "2026-03-15T00:01:00.000Z", cost: 0.5 }]);
    const spend = spendBlock(db, loaded(dir, { "model-a": { input: 3, output: 15 } }), NOW);
    assert.equal(spend.prices_armed, false);
    assert.deepEqual(spend.inert_models, ["model-a"]);
  });
});

test("spend: an empty store reports zero windows and no models (shape, not a crash)", () => {
  withStore((db, _taskId, dir) => {
    const spend = spendBlock(db, loaded(dir), NOW);
    assert.deepEqual(spend, {
      prices_armed: true,
      inert_models: [],
      today: { cost_usd: 0, runs: 0 },
      month: { cost_usd: 0, runs: 0 },
      by_model: [],
    });
  });
});

test("spend: the block is part of the live nova_daemon_status payload", async () => {
  const { startDaemon } = await import("../../src/daemon/lifecycle.ts");
  const dir = mkdtempSync(join(tmpdir(), "novaflow-spend-live-"));
  const seeded = seedFileStore(dir);
  const pricesPath = join(dir, "prices.json");
  writeFileSync(pricesPath, JSON.stringify(PRICE_FILE));
  const db = new Database(seeded.dbPath);
  try {
    const task = createTask(db, {
      projectId: seeded.projectId,
      key: "TASK-LIVE",
      title: "live spend",
      objective: "live spend",
      profileId: seeded.profileId,
    });
    // stamped relative to the real clock: the live payload uses `new Date()`
    insertRuns(db, task.id, [
      { model: "stub-model", startedAt: new Date(Date.now() - 60_000).toISOString(), cost: 0.42 },
    ]);
  } finally {
    db.close();
  }
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    pricesPath,
    tickMs: 30,
  });
  try {
    const status = handle.status() as unknown as Record<string, unknown>;
    const spend = status["spend"] as Record<string, unknown>;
    assert.ok(spend !== undefined, "nova_daemon_status must carry the spend block");
    // old rows in the store are the only "models in use"; the price table
    // covers model-a/model-b, so the run's model is inert
    assert.deepEqual(spend["inert_models"], ["stub-model"]);
    assert.equal(spend["prices_armed"], false);
    assert.equal((spend["month"] as Record<string, unknown>)["cost_usd"], 0.42);
    // PRESERVE: the v1 budget counters read the SAME window (one source), so
    // they can never disagree with the spend block about the month's cost
    const budgets = status["budgets"] as Record<string, unknown>;
    assert.equal(budgets["spend_month_usd"], 0.42);
    assert.equal(budgets["spend_today_usd"], (spend["today"] as Record<string, unknown>)["cost_usd"]);
  } finally {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
