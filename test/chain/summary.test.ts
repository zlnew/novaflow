import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER, VALIDATING_TRIGGER } from "../../src/runs/triggers.ts";
import { VERIFY_PASSED_TRIGGER } from "../../src/fsm/triggers.ts";
import { importChain, getChainRun } from "../../src/chain/import.ts";
import { createChainEvaluator } from "../../src/chain/readiness.ts";
import { writeProjectSummary, projectSummaryPath } from "../../src/chain/summary.ts";

/**
 * FR-PRJ-05 — the PROJECT_SUMMARY.md consolidation report: when a chain
 * run reaches `completed`, the engine aggregates every completed member's
 * result.json payload into
 * `<workspace_root>/.novaflow/projects/<slug>/PROJECT_SUMMARY.md`
 * (data.md 5.2 layout; the p3b project scaffold's directory). Written
 * ONCE per chain completion (regeneration is a no-op guard); a missing
 * member artifact is a marked section + warn, never a corrupted chain
 * state.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const PROBE = { piBin: "node", args: [STUB, "ok"], timeoutMs: 5000 };

type Seed = {
  db: Database.Database;
  dir: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
};

function seed(): Seed {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-summary-"));
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot, { recursive: true });
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws', 'ws', ?)").run(ulid(), wsRoot);
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
  // the FK every member's target_scopes reference (the import resolves
  // repo_alias to a project_targets row before the transaction)
  db.prepare(
    `INSERT INTO project_targets (id, project_id, alias, target_type, root_path)
     VALUES (?, ?, 'app', 'directory', ?)`,
  ).run(ulid(), projectId, join(wsRoot, "target"));
  return { db, dir, wsRoot, workspaceId, projectId, profileId };
}

type TaskSpec = { key: string; title?: string };

function importMembers(s: Seed, tasks: TaskSpec[]): { chainId: string; ids: Record<string, string> } {
  const { chainRun, tasks: created } = importChain(
    s.db,
    { id: s.workspaceId },
    { id: s.projectId, slug: "prj" },
    {
      version: "1.0.0",
      project_slug: "prj",
      tasks: tasks.map((t) => ({
        key: t.key,
        title: t.title ?? `Task ${t.key}`,
        objective: `The objective of task ${t.key}.`,
        profile_name: "dev",
        target_scopes: [{ repo_alias: "app", access_mode: "read_write" }],
      })),
      edges: [],
    },
  );
  const ids: Record<string, string> = {};
  for (const [key, row] of Object.entries(created)) ids[key] = row.id;
  return { chainId: chainRun.id, ids };
}

function completeWithArtifact(s: Seed, taskId: string): void {
  applyTransition(s.db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(s.db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
  const runId = ulid();
  const runDir = join(s.wsRoot, ".novaflow", "runs", taskId, runId);
  mkdirSync(runDir, { recursive: true });
  const artifactPath = join(runDir, "result.json");
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        schema_version: "1.0.0",
        task_id: taskId,
        run_id: runId,
        status: "completed",
        summary: `Task ${taskId.slice(0, 4)} finished the requested work end to end.`,
        assumptions_made: ["one assumption"],
        open_questions: ["a question"],
        artifacts_modified: [{ target_alias: "app", path: "src/x.rs", action: "modified" }],
        feedback_items: [],
        next_recommended_action: "proceed_to_next",
      },
      null,
      2,
    ) + "\n",
  );
  s.db
    .prepare(
      `INSERT INTO task_runs (id, task_id, profile_id, attempt_number, pi_session_id, pi_session_dir,
          status, preflight_status, model_used, events_log_path)
       VALUES (?, ?, ?, 1, ?, ?, 'succeeded', 'passed', 'm1', ?)`,
    )
    .run(runId, taskId, s.profileId, runId, runDir, join(runDir, "events.jsonl"));
  s.db.prepare("UPDATE task_runs SET artifact_path = ? WHERE id = ?").run(artifactPath, runId);
}

function complete(s: Seed, taskId: string): void {
  applyTransition(s.db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(s.db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(s.db, taskId, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
}

test("FR-PRJ-05: a completed chain aggregates every member's result.json payload into PROJECT_SUMMARY.md", () => {
  const s = seed();
  try {
    const { chainId, ids } = importMembers(s, [{ key: "A", title: "Alpha" }, { key: "B", title: "Beta" }]);
    completeWithArtifact(s, ids["A"]!);
    completeWithArtifact(s, ids["B"]!);

    const out = writeProjectSummary(s.db, chainId);
    assert.equal(out.written, true);
    if (out.written) {
      assert.equal(out.members, 2);
      assert.equal(out.marked, 0);
    }
    const expectedPath = join(s.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md");
    assert.equal(projectSummaryPath(s.db, chainId), expectedPath);
    assert.ok(existsSync(expectedPath));
    const content = readFileSync(expectedPath, "utf8");
    // the report: member key, title, summary, assumptions, open questions, artifact paths
    assert.match(content, /# PROJECT_SUMMARY — prj/);
    assert.match(content, /## A — Alpha/);
    assert.match(content, /## B — Beta/);
    for (const id of [ids["A"]!, ids["B"]!]) {
      assert.match(content, new RegExp(`Task ${id.slice(0, 4)} finished the requested work`));
    }
    assert.match(content, /- one assumption/);
    assert.match(content, /- a question/);
    assert.match(content, /src\/x\.rs/);
    assert.match(content, new RegExp(chainId));
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("FR-PRJ-05: a member with a missing artifact gets a MARKED section — the report still writes, the chain state is untouched", () => {
  const s = seed();
  try {
    const { chainId, ids } = importMembers(s, [{ key: "A" }, { key: "B" }]);
    completeWithArtifact(s, ids["A"]!);
    complete(s, ids["B"]!); // completed, but NO run row / artifact on disk

    const out = writeProjectSummary(s.db, chainId);
    assert.equal(out.written, true);
    if (out.written) {
      assert.equal(out.members, 2);
      assert.equal(out.marked, 1);
    }
    const content = readFileSync(join(s.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md"), "utf8");
    assert.match(content, /## B — Task B/);
    assert.match(content, /unavailable/);
    // the healthy member still aggregated
    assert.match(content, /- one assumption/);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("FR-PRJ-05: regeneration is a no-op guard — a second write never touches the file", () => {
  const s = seed();
  try {
    const { chainId, ids } = importMembers(s, [{ key: "A" }]);
    completeWithArtifact(s, ids["A"]!);
    const first = writeProjectSummary(s.db, chainId);
    assert.equal(first.written, true);
    const path = join(s.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md");
    const before = readFileSync(path, "utf8");

    const second = writeProjectSummary(s.db, chainId);
    assert.deepEqual(second, { written: false, path, reason: "already-exists" });
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("FR-PRJ-05 wiring: the terminal completed move itself writes the report (the ONE natural seam)", async () => {
  const s = seed();
  try {
    const { chainId, ids } = importMembers(s, [{ key: "A" }, { key: "B" }]);
    completeWithArtifact(s, ids["A"]!);
    completeWithArtifact(s, ids["B"]!);
    const evaluator = createChainEvaluator(s.db, { enqueueOptions: PROBE });

    const outcome = await evaluator.evaluateForTask(ids["B"]!);
    assert.equal(outcome?.terminal, "completed");
    assert.equal(getChainRun(s.db, chainId)?.state, "completed");
    const path = join(s.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md");
    assert.ok(existsSync(path), "the summary rides the guarded completed move");
    assert.match(readFileSync(path, "utf8"), /## A — Task A/);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("writeProjectSummary never throws on impossible inputs — typed refusal outcomes", () => {
  const s = seed();
  try {
    const bogus = writeProjectSummary(s.db, ulid());
    assert.equal(bogus.written, false);
    assert.equal(projectSummaryPath(s.db, ulid()), null);
  } finally {
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
