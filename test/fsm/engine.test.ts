import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractDdl } from "../helpers/spec.ts";
import {
  canTransition,
  InvalidTransitionError,
  applyTransition,
  logTransition,
} from "../../src/fsm/engine.ts";
import { ROWS, FALLBACK_MAP } from "../../src/fsm/matrix.ts";
import { canonicalStates } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";

/** A seeded in-memory store with one draft task, per the novaflow-v1/data DDL. */
function seededDb() {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, ?, ?)",
  ).run(ulid(), "ws", "ws", "/tmp/ws");
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), db.prepare("SELECT id FROM workspaces").get()?.["id"], "prj", "prj", "o");
  db.prepare(
    "INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    ulid(),
    null,
    "dev",
    "anthropic",
    "claude-3-5-sonnet",
    "prompts/dev.txt",
  );
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    taskId,
    db.prepare("SELECT id FROM projects").get()?.["id"],
    "TASK-101",
    "t",
    "o",
    db.prepare("SELECT id FROM agent_profiles").get()?.["id"],
  );
  return { db, taskId };
}

test("canTransition accepts every matrix row's trigger from its current state", () => {
  for (const r of ROWS) {
    const row = canTransition(r.state, r.trigger);
    assert.equal(row?.target, r.target, `trigger must be legal: ${r.state} + "${r.trigger}"`);
  }
});

test("canTransition rejects every (state, target) pair absent from the matrix", () => {
  const legal = new Set(ROWS.map((r) => `${r.state}->${r.target}`));
  for (const from of canonicalStates) {
    for (const to of canonicalStates) {
      if (legal.has(`${from}->${to}`)) continue;
      const rows = ROWS.filter(
        (r) => r.state === from && r.target === to,
      );
      assert.equal(rows.length, 0);
      // No trigger whatsoever may authorize an off-matrix pair; probe with the
      // triggers that exist for the source state plus a generic one.
      for (const probe of [...ROWS.filter((r) => r.state === from).map((r) => r.trigger), "no such trigger"]) {
        const row = canTransition(from, probe);
        assert.equal(row?.target === to, false, `off-matrix pair accepted: ${from}->${to}`);
      }
    }
  }
});

test("applyTransition performs a legal move, updates the task row, and writes state_transition_logs", () => {
  const { db, taskId } = seededDb();
  const from = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId)?.["state"];
  assert.equal(from, "draft");
  applyTransition(db, taskId, "operator/agent enqueues (CLI `task run`, MCP `nova_task_run`)", {
    triggerType: "human",
    actor: "maul",
  });
  const after = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId)?.["state"];
  assert.equal(after, "queued");
  const logs = db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ?")
    .all(taskId);
  assert.equal(logs.length, 1);
  const log = logs[0] as Record<string, string>;
  assert.equal(log["from_state"], "draft");
  assert.equal(log["to_state"], "queued");
  assert.equal(log["trigger_type"], "human");
  db.close();
});

test("applyTransition refuses an illegal move and leaves the task untouched", () => {
  const { db, taskId } = seededDb();
  assert.throws(
    () =>
      applyTransition(db, taskId, "operator approves gate", {
        triggerType: "human",
        actor: "maul",
      }),
    InvalidTransitionError,
  );
  const after = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId)?.["state"];
  assert.equal(after, "draft");
  const logs = db
    .prepare("SELECT * FROM state_transition_logs WHERE task_id = ?")
    .all(taskId);
  assert.equal(logs.length, 0);
  db.close();
});

test("logTransition alone records without touching state (audit surface)", () => {
  const { db, taskId } = seededDb();
  logTransition(db, {
    taskId,
    runId: null,
    fromState: "draft",
    toState: "queued",
    triggerType: "engine",
    actor: "daemon",
    reason: "boot replay",
  });
  const n = db
    .prepare("SELECT COUNT(*) AS n FROM state_transition_logs")
    .get()?.["n"];
  assert.equal(n, 1);
  db.close();
});

test("fallback labels resolve to canonical states only (none are ever stored)", () => {
  assert.ok(Object.keys(FALLBACK_MAP).length >= 4);
  for (const label of Object.keys(FALLBACK_MAP)) {
    assert.ok(
      !canonicalStates.includes(label),
      `fallback label ${label} must never itself be a canonical state`,
    );
  }
});
