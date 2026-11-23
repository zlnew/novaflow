import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFileStore, MODEL } from "./seed.ts";
import { createTask } from "../../src/tasks.ts";
import { ulid } from "../../src/store/ids.ts";
import { taskStatus } from "../../src/daemon/readops.ts";

/**
 * novaflow-v02/spend.md: "History is not rewritten: rows written before the
 * migration keep their values and are reported as `cost_basis: "legacy"`."
 *
 * The pinned migration carries no marker column (its two statements are
 * fixed), so the marker is the store's own migration record: a run row whose
 * `started_at` predates `schema_migrations.applied_at` for 0003 was written by
 * earlier code and reports "legacy"; anything at or after it was written by
 * the cache-aware loop and reports "priced".
 *
 * Legacy rows are READ, never rewritten: their recorded cost_usd and token
 * sums stay exactly as the old code left them.
 */

type Seed = {
  dir: string;
  dbPath: string;
  projectId: string;
  profileId: string;
};

function seed(): Seed {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cost-basis-"));
  const seeded = seedFileStore(dir);
  return {
    dir,
    dbPath: seeded.dbPath,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
  };
}

/** One task with one run row; `startedAt` explicit so the marker decides. */
function runFor(
  db: Database.Database,
  s: Seed,
  key: string,
  startedAt: string,
  costUsd: number,
): string {
  const task = createTask(db, {
    projectId: s.projectId,
    key,
    title: key,
    objective: key,
    profileId: s.profileId,
  });
  const runId = ulid();
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir, status,
        preflight_status, model_used, input_tokens, output_tokens, cost_usd,
        events_log_path, started_at)
     VALUES (?, ?, ?, 1, ?, ?, 'succeeded', 'passed', ?, 498562, 2000, ?, ?, ?)`,
  ).run(runId, task.id, s.profileId, runId, `/nonexistent/${runId}`, MODEL, costUsd, `/nonexistent/${runId}/events.jsonl`, startedAt);
  return task.id;
}

test("cost_basis: a row stamped before migration 0003 applied is legacy; a row written after it is priced", () => {
  const s = seed();
  const db = new Database(s.dbPath);
  try {
    // the old code wrote this row: started_at is BEFORE the migration ran
    const legacyTask = runFor(db, s, "TASK-LEGACY", "2020-01-01T00:00:00.000Z", 0);
    // the cache-aware loop wrote this one: started_at is its insert time
    const pricedTask = runFor(db, s, "TASK-PRICED", new Date().toISOString(), 0.42);

    const legacy = taskStatus(db, { task_id: legacyTask })["current_run"] as Record<string, unknown>;
    assert.equal(legacy["cost_basis"], "legacy");
    // never rewritten: the old values survive verbatim
    assert.equal(legacy["cost_usd"], 0);
    assert.equal(legacy["input_tokens"], 498562);
    assert.equal(legacy["cache_read_tokens"], 0);
    assert.equal(legacy["cache_write_tokens"], 0);

    const priced = taskStatus(db, { task_id: pricedTask })["current_run"] as Record<string, unknown>;
    assert.equal(priced["cost_basis"], "priced");
    assert.equal(priced["cost_usd"], 0.42);
  } finally {
    db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("cost_basis: a store with no 0003 migration record cannot claim priced costs (conservative legacy)", () => {
  const s = seed();
  const db = new Database(s.dbPath);
  try {
    const taskId = runFor(db, s, "TASK-NO-MARKER", new Date().toISOString(), 0.1);
    db.prepare("DELETE FROM schema_migrations WHERE filename = ?").run("0003_cache_tokens.sql");
    const run = taskStatus(db, { task_id: taskId })["current_run"] as Record<string, unknown>;
    assert.equal(run["cost_basis"], "legacy");
  } finally {
    db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
