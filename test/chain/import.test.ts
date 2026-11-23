import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { createTask } from "../../src/tasks.ts";
import { parseYaml } from "../../src/chain/yaml.ts";
import {
  importChain,
  getChainRun,
  listChainMembers,
  ChainValidationError,
} from "../../src/chain/import.ts";

/**
 * Chain import (FR-PRJ-04 AC3; architecture 8.1 chain run ownership):
 * ALL-OR-NOTHING — one chain_runs row (state active, started_at = import
 * time) + every member task in DRAFT with chain_run_id stamped + every
 * task_edges row, in ONE transaction; a failure at any point persists
 * NOTHING. Roots are NOT auto-enqueued: the operator/orchestrator starts
 * a chain by enqueuing root members (nova_task_run); the engine
 * propagates readiness thereafter.
 */

function seed(): {
  db: Database.Database;
  workspaceId: string;
  projectId: string;
  profileId: string;
} {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', '/tmp/ws')").run(ulid());
  const workspaceId = (db.prepare("SELECT id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
  ).run(ulid(), workspaceId);
  const projectId = (db.prepare("SELECT id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
     VALUES (?, NULL, 'dev', 'anthropic', 'm1', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO project_targets (id, project_id, alias, target_type, root_path)
     VALUES (?, ?, 'code', 'directory', '/tmp/code')`,
  ).run(ulid(), projectId);
  return { db, workspaceId, projectId, profileId };
}

type Seed = ReturnType<typeof seed>;

function projectRow(s: Seed): { id: string; slug: string } {
  return { id: s.projectId, slug: "prj" };
}

function graph(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [
      {
        key: "PLAN",
        title: "Plan the work",
        objective: "Write the implementation plan end to end.",
        profile_name: "dev",
      },
      {
        key: "WORK",
        title: "Do the work",
        objective: "Implement the planned feature end to end.",
        profile_name: "dev",
        priority: 1,
        requires_human_gate: true,
        context_files: ["docs/spec.md"],
        output_schema_version: "2.0.0",
        overrides: { timeout_sec: 600, max_cost_usd: 1.5, thinking_level: "high" },
        target_scopes: [
          { repo_alias: "code", access_mode: "read_write", write_scope_globs: ["src/**"] },
        ],
      },
    ],
    edges: [
      { source_key: "PLAN", target_key: "WORK", edge_type: "depends_on" },
      {
        source_key: "WORK",
        target_key: "PLAN",
        edge_type: "on_changes_requested",
        condition_expr: "review.status == 'changes_requested'",
      },
    ],
    ...over,
  };
}

function counts(db: Database.Database): { chains: number; tasks: number; edges: number } {
  const q = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;
  return {
    chains: q("SELECT COUNT(*) AS n FROM chain_runs"),
    tasks: q("SELECT COUNT(*) AS n FROM tasks"),
    edges: q("SELECT COUNT(*) AS n FROM task_edges"),
  };
}

test("importChain creates the chain run (active, started_at = import time) and stamps every member", () => {
  const s = seed();
  try {
    const before = Date.now();
    const { chainRun, tasks } = importChain(s.db, { id: s.workspaceId }, projectRow(s), graph());
    assert.ok(chainRun.id);
    assert.equal(chainRun.project_id, s.projectId);
    assert.equal(chainRun.state, "active");
    assert.equal(chainRun.completed_at, null);
    // started_at = import time (the DDL default fills it at INSERT)
    const startedMs = Date.parse(chainRun.started_at);
    assert.ok(startedMs >= before - 1000 && startedMs <= Date.now() + 1000);

    // every member: DRAFT, chain_run_id stamped, FK to the chain run
    assert.equal(Object.keys(tasks).sort()[0], "PLAN");
    for (const row of Object.values(tasks)) {
      assert.equal(row.state, "draft");
      assert.equal(row.chain_run_id, chainRun.id);
      assert.equal(row.project_id, s.projectId);
    }
    // getChainRun / listChainMembers see the same ownership
    assert.equal(getChainRun(s.db, chainRun.id)?.state, "active");
    assert.equal(listChainMembers(s.db, chainRun.id).length, 2);
  } finally {
    s.db.close();
  }
});

test("importChain persists every §4.3 field via the createTask machinery (scopes, overrides, context files)", () => {
  const s = seed();
  try {
    const { tasks } = importChain(s.db, { id: s.workspaceId }, projectRow(s), graph());
    const plan = tasks["PLAN"]!;
    const work = tasks["WORK"]!;
    // defaults where the member omits fields (DDL defaults)
    assert.equal(plan.priority, 3);
    assert.equal(plan.requires_human_gate, 0);
    assert.equal(plan.output_schema_version, "1.0.0");
    assert.deepEqual(JSON.parse(plan.overrides_json), {});
    assert.deepEqual(JSON.parse(plan.context_files_json), []);
    // explicit §4.3 fields
    assert.equal(work.priority, 1);
    assert.equal(work.requires_human_gate, 1);
    assert.deepEqual(JSON.parse(work.context_files_json), ["docs/spec.md"]);
    assert.equal(work.output_schema_version, "2.0.0");
    assert.deepEqual(JSON.parse(work.overrides_json), {
      timeout_sec: 600,
      max_cost_usd: 1.5,
      thinking_level: "high",
    });
    // target_scopes: the resolved target row + explicit globs; column
    // defaults apply for the omitted glob/command fields
    const scopes = s.db
      .prepare("SELECT * FROM task_target_scopes WHERE task_id = ?")
      .all(work.id) as Array<Record<string, unknown>>;
    assert.equal(scopes.length, 1);
    const targetId = (s.db.prepare("SELECT id FROM project_targets WHERE alias='code'").get() as { id: string }).id;
    assert.equal(scopes[0]!["target_id"], targetId);
    assert.equal(scopes[0]!["access_mode"], "read_write");
    assert.deepEqual(JSON.parse(String(scopes[0]!["write_scope_globs_json"])), ["src/**"]);
    assert.deepEqual(JSON.parse(String(scopes[0]!["protected_test_globs_json"])), []);
    assert.deepEqual(JSON.parse(String(scopes[0]!["verification_commands_json"])), []);
  } finally {
    s.db.close();
  }
});

test("importChain persists every task_edges row (typed, condition_expr verbatim, endpoints resolved)", () => {
  const s = seed();
  try {
    const { chainRun, tasks } = importChain(s.db, { id: s.workspaceId }, projectRow(s), graph());
    const edges = s.db
      .prepare("SELECT * FROM task_edges WHERE project_id = ? ORDER BY edge_type")
      .all(s.projectId) as Array<Record<string, unknown>>;
    assert.equal(edges.length, 2);
    const dep = edges.find((e) => e["edge_type"] === "depends_on")!;
    assert.equal(dep["source_task_id"], tasks["PLAN"]!.id);
    assert.equal(dep["target_task_id"], tasks["WORK"]!.id);
    assert.equal(dep["condition_expr"], null);
    const feedback = edges.find((e) => e["edge_type"] === "on_changes_requested")!;
    assert.equal(feedback["source_task_id"], tasks["WORK"]!.id);
    assert.equal(feedback["target_task_id"], tasks["PLAN"]!.id);
    // condition_expr stored verbatim, never evaluated (p4b boundary)
    assert.equal(feedback["condition_expr"], "review.status == 'changes_requested'");
    // no other project's edges were touched
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM task_edges WHERE project_id != ?").get(s.projectId) as { n: number }).n,
      0,
    );
    void chainRun;
  } finally {
    s.db.close();
  }
});

test("roots are NOT auto-enqueued: every member lands draft, zero transition log rows", () => {
  const s = seed();
  try {
    const { tasks } = importChain(s.db, { id: s.workspaceId }, projectRow(s), graph());
    for (const row of Object.values(tasks)) assert.equal(row.state, "draft");
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }).n,
      0,
    );
  } finally {
    s.db.close();
  }
});

test("atomicity: a malformed member refuses BEFORE any write — counts unchanged", () => {
  const s = seed();
  try {
    const before = counts(s.db);
    assert.throws(
      () =>
        importChain(s.db, { id: s.workspaceId }, projectRow(s), graph({
          tasks: [
            { key: "PLAN", title: "ab", objective: "too short", profile_name: "dev" }, // title/objective violations
          ],
        })),
      ChainValidationError,
    );
    assert.deepEqual(counts(s.db), before);
  } finally {
    s.db.close();
  }
});

test("atomicity: a failure INSIDE the transaction persists NOTHING (member key collides with an existing task)", () => {
  const s = seed();
  try {
    // a pre-existing single task owns the key PLAN in this project
    createTask(s.db, {
      projectId: s.projectId,
      key: "PLAN",
      title: "pre-existing",
      objective: "already here",
      profileId: s.profileId,
    });
    const before = counts(s.db);
    assert.equal(before.tasks, 1);
    assert.throws(
      () => importChain(s.db, { id: s.workspaceId }, projectRow(s), graph()),
      (err: unknown) => err instanceof ChainValidationError && err.code === "duplicate",
    );
    // all-or-nothing: the chain run, both members, and both edges are gone
    assert.deepEqual(counts(s.db), before);
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE chain_run_id IS NOT NULL").get() as { n: number }).n,
      0,
    );
  } finally {
    s.db.close();
  }
});

test("an unknown repo_alias refuses as not_found, nothing persisted", () => {
  const s = seed();
  try {
    const before = counts(s.db);
    assert.throws(
      () =>
        importChain(s.db, { id: s.workspaceId }, projectRow(s), graph({
          tasks: [
            {
              key: "PLAN",
              title: "Plan the work",
              objective: "Write the implementation plan end to end.",
              profile_name: "dev",
              target_scopes: [{ repo_alias: "ghost", access_mode: "read_only" }],
            },
          ],
        })),
      (err: unknown) => err instanceof ChainValidationError && err.code === "not_found",
    );
    assert.deepEqual(counts(s.db), before);
  } finally {
    s.db.close();
  }
});

test("a one-task DAG with a bare `edges:` imports as a single-member chain (DEBT-013)", () => {
  const s = seed();
  try {
    // the user's own automation shape: `nova project import-dag` of a
    // YAML file whose graph has one member and no edges at all
    const yaml = [
      'version: "1.0.0"',
      "project_slug: prj",
      "tasks:",
      "  - key: SOLO",
      "    title: Do the only task",
      "    objective: The single member of a one-task chain.",
      "    profile_name: dev",
      "edges:",
    ].join("\n");
    const { chainRun, tasks } = importChain(
      s.db,
      { id: s.workspaceId },
      projectRow(s),
      parseYaml(yaml),
    );
    assert.equal(chainRun.state, "active");
    assert.deepEqual(Object.keys(tasks), ["SOLO"]);
    assert.equal(tasks["SOLO"]!.state, "draft");
    assert.equal(tasks["SOLO"]!.chain_run_id, chainRun.id);
    assert.equal(listChainMembers(s.db, chainRun.id).length, 1);
    // zero edges, zero enqueues: roots are still the operator's call
    assert.deepEqual(counts(s.db), { chains: 1, tasks: 1, edges: 0 });
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }).n,
      0,
    );
  } finally {
    s.db.close();
  }
});

test("regression: a normal two-task two-edge DAG written in YAML still imports unchanged", () => {
  const s = seed();
  try {
    const yaml = [
      '# a chain.yaml in the strict subset (data.md §4.3 shapes)',
      'version: "1.0.0"',
      "project_slug: prj",
      "tasks:",
      "  - key: PLAN",
      '    title: "Plan the work"',
      "    objective: Write the implementation plan end to end.",
      "    profile_name: dev",
      "  - key: WORK",
      "    title: Do the work",
      "    objective: Implement the planned feature end to end.",
      "    profile_name: dev",
      "    target_scopes:",
      "      - repo_alias: code",
      "        access_mode: read_write",
      "edges:",
      "  - source_key: PLAN",
      "    target_key: WORK",
      "    edge_type: depends_on",
      "  - source_key: WORK",
      "    target_key: PLAN",
      "    edge_type: on_changes_requested",
      "    condition_expr: review.status == 'changes_requested'",
    ].join("\n");
    const { tasks } = importChain(s.db, { id: s.workspaceId }, projectRow(s), parseYaml(yaml));
    assert.deepEqual(Object.keys(tasks).sort(), ["PLAN", "WORK"]);
    assert.deepEqual(counts(s.db), { chains: 1, tasks: 2, edges: 2 });
    const rows = s.db
      .prepare("SELECT * FROM task_edges WHERE project_id = ? ORDER BY edge_type")
      .all(s.projectId) as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r["edge_type"]), ["depends_on", "on_changes_requested"]);
    assert.equal(rows[1]!["condition_expr"], "review.status == 'changes_requested'");
  } finally {
    s.db.close();
  }
});

test("a project_slug mismatch refuses (the schema carries project_slug; the caller must match it)", () => {
  const s = seed();
  try {
    const before = counts(s.db);
    const other = { id: s.projectId, slug: "other-prj" };
    assert.throws(
      () => importChain(s.db, { id: s.workspaceId }, other, graph()),
      (err: unknown) =>
        err instanceof ChainValidationError &&
        err.code === "schema_invalid" &&
        /other-prj|prj/.test(err.message),
    );
    assert.deepEqual(counts(s.db), before);
  } finally {
    s.db.close();
  }
});
