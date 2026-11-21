import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { ulid } from "../../src/store/ids.ts";
import { ENQUEUE_TRIGGER } from "../../src/tasks.ts";
import { START_TRIGGER, VALIDATING_TRIGGER } from "../../src/runs/triggers.ts";
import { VERIFY_PASSED_TRIGGER } from "../../src/fsm/triggers.ts";

/**
 * The CHAIN OPS over the wire (srs 4.1.1 `nova chain`
 * [list|status|abort] + FR-TSK-08's pause/resume; FR-PRJ-04
 * `nova project import-dag`): raw-text import in both formats, the
 * taxonomy mappings (cycles → schema_invalid, unknown project →
 * not_found, slug ambiguity → duplicate), readiness propagation riding
 * the daemon's verification seam, the gate terminal outcome failing a
 * chain, chain abort per the matrix rows (queued, live running, draft
 * no-abort-row, terminal untouched), pause withholding spawns, and
 * the boot sweep across a real daemon restart.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(over: { runMode?: string } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-chainops-"));
  const seeded: SeededStore = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, over.runMode ?? "run-ok"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return {
    dir,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    workspaceId: seeded.workspaceId,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    handle,
    client,
  };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

function chainGraph(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [
      { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev" },
      { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev" },
    ],
    edges: [{ source_key: "A", target_key: "B", edge_type: "depends_on" }],
    ...over,
  };
}

const CHAIN_YAML = `version: "1.0.0"
project_slug: prj
tasks:
  - key: A
    title: Task A
    objective: The objective of task A.
    profile_name: dev
  - key: B
    title: Task B
    objective: The objective of task B.
    profile_name: dev
edges:
  - source_key: A
    target_key: B
    edge_type: depends_on
`;

async function importVia(
  env: Env,
  graph: Record<string, unknown> | string,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return env.client.request({
    id: "import",
    op: "nova_project_import_dag",
    args: {
      workspace_id: env.workspaceId,
      graph_text: typeof graph === "string" ? graph : JSON.stringify(graph),
      ...(over as Record<string, unknown>),
    },
  });
}

function taskState(env: Env, taskId: string): string {
  const ro = readConnection(env.dbPath);
  try {
    return (ro.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state;
  } finally {
    ro.close();
  }
}

function transitionsOf(env: Env, taskId: string): Array<Record<string, unknown>> {
  const ro = readConnection(env.dbPath);
  try {
    return ro
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId) as Array<Record<string, unknown>>;
  } finally {
    ro.close();
  }
}

async function waitForState(env: Env, taskId: string, state: string, ms = 8000): Promise<void> {
  await waitFor(() => taskState(env, taskId) === state, ms);
}

/* ------------------------------ import-dag ------------------------------ */

test("import-dag: JSON raw text (format json) creates the chain run + draft members, roots not enqueued", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph(), { format: "json" });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const data = res["data"] as Record<string, unknown>;
    const chainRun = data["chain_run"] as Record<string, unknown>;
    assert.equal(chainRun["state"], "active");
    assert.match(String(chainRun["started_at"]), /\d/);
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(tasks).sort(), ["A", "B"]);
    for (const t of Object.values(tasks)) {
      assert.equal(t["state"], "draft");
      const ro = readConnection(env.dbPath);
      const row = ro.prepare("SELECT chain_run_id FROM tasks WHERE id = ?").get(String(t["id"])) as { chain_run_id: string };
      ro.close();
      assert.equal(row.chain_run_id, chainRun["id"]);
    }
    // roots are NOT auto-enqueued: no transitions, no edges missed
    const ro = readConnection(env.dbPath);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }).n, 0);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n, 1);
    ro.close();
  } finally {
    await shutdown(env);
  }
});

test("import-dag: YAML raw text (format yaml) and the auto format (JSON first, then YAML)", async () => {
  const env = await boot();
  try {
    const yamlGraph = CHAIN_YAML.replace(/key: A/g, "key: YA").replace(/key: B/g, "key: YB").replace(/source_key: A/g, "source_key: YA").replace(/target_key: B/g, "target_key: YB");
    const yamlRes = await importVia(env, yamlGraph, { format: "yaml" });
    assert.equal(yamlRes["ok"], true, JSON.stringify(yamlRes));
    const yamlTasks = (yamlRes["data"] as Record<string, unknown>)["tasks"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(yamlTasks).sort(), ["YA", "YB"]);

    // auto: JSON content parses as JSON
    const autoJson = await importVia(env, chainGraph({ tasks: [
      { key: "J1", title: "Task one", objective: "The objective of task one.", profile_name: "dev" },
    ], edges: [] }));
    assert.equal(autoJson["ok"], true, JSON.stringify(autoJson));

    // auto: YAML content (not JSON) falls back to the subset parser
    const autoYaml = await env.client.request({
      id: "auto",
      op: "nova_project_import_dag",
      args: {
        workspace_id: env.workspaceId,
        graph_text: CHAIN_YAML.replace(/key: A/g, "key: Z1").replace(/key: B/g, "key: Z2").replace(/source_key: A/g, "source_key: Z1").replace(/target_key: B/g, "target_key: Z2"),
      },
    });
    assert.equal(autoYaml["ok"], true, JSON.stringify(autoYaml));
  } finally {
    await shutdown(env);
  }
});

test("import-dag refusals map to the taxonomy: mismatch, unknown project, ambiguity, cycle, YAML subset", async () => {
  const env = await boot();
  try {
    // --project mismatch: the schema carries project_slug
    const mismatch = await importVia(env, chainGraph(), { project_slug: "other" });
    assert.equal(mismatch["ok"], false);
    assert.equal((mismatch["error"] as Record<string, unknown>)["code"], "schema_invalid");
    assert.match(String((mismatch["error"] as Record<string, unknown>)["message"]), /mismatch/);

    // unknown project slug
    const unknown = await importVia(env, chainGraph({ project_slug: "ghost" }));
    assert.equal(unknown["ok"], false);
    assert.equal((unknown["error"] as Record<string, unknown>)["code"], "not_found");

    // a depends_on cycle → schema_invalid naming the cycle
    const cyclic = await importVia(env, chainGraph({
      edges: [
        { source_key: "A", target_key: "B", edge_type: "depends_on" },
        { source_key: "B", target_key: "A", edge_type: "depends_on" },
      ],
    }));
    assert.equal(cyclic["ok"], false);
    const cerr = cyclic["error"] as Record<string, unknown>;
    assert.equal(cerr["code"], "schema_invalid");
    assert.match(String(cerr["message"]), /A -> B -> A|B -> A -> B/);

    // YAML outside the subset → schema_invalid naming the line
    const badYaml = await env.client.request({
      id: "badyaml",
      op: "nova_project_import_dag",
      args: { workspace_id: env.workspaceId, graph_text: "version: 1.0.0\ntasks: [A, B]", format: "yaml" },
    });
    assert.equal(badYaml["ok"], false);
    const yerr = badYaml["error"] as Record<string, unknown>;
    assert.equal(yerr["code"], "schema_invalid");
    assert.match(String(yerr["message"]), /line 2/);

    // an ambiguous profile (two global rows sharing the name)
    const rw = new Database(env.dbPath);
    for (let i = 0; i < 2; i++) {
      rw.prepare(
        `INSERT INTO agent_profiles (id, workspace_id, name, provider, model, system_prompt_path)
         VALUES (?, NULL, 'twin', 'anthropic', 'm1', 'x')`,
      ).run(ulid());
    }
    rw.close();
    const ambiguous = await importVia(env, chainGraph({
      tasks: [{ key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "twin" }],
      edges: [],
    }));
    assert.equal(ambiguous["ok"], false);
    const aerr = ambiguous["error"] as Record<string, unknown>;
    assert.equal(aerr["code"], "profile_unresolved");
    assert.match(String(aerr["message"]), /twin/);
  } finally {
    await shutdown(env);
  }
});

test("import-dag without workspace_id: unique slug resolves; an ambiguous slug refuses as duplicate", async () => {
  const env = await boot();
  try {
    // a second workspace with the SAME project slug
    const rw = new Database(env.dbPath);
    rw.prepare("INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, 'ws2', 'ws2', '/tmp/ws2')").run(
      "01HJ8Z9X01ABCDEFGHJKMNPQRAA",
    );
    rw.prepare(
      "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'prj', 'prj', 'o')",
    ).run("01HJ8Z9X01ABCDEFGHJKMNPQRBB", "01HJ8Z9X01ABCDEFGHJKMNPQRAA");
    rw.close();

    const ambiguous = await env.client.request({
      id: "amb",
      op: "nova_project_import_dag",
      args: { graph_text: JSON.stringify(chainGraph()) },
    });
    assert.equal(ambiguous["ok"], false);
    assert.equal((ambiguous["error"] as Record<string, unknown>)["code"], "duplicate");

    // workspace_id disambiguates
    const resolved = await importVia(env, chainGraph());
    assert.equal(resolved["ok"], true, JSON.stringify(resolved));
  } finally {
    await shutdown(env);
  }
});

/* --------------------- readiness through the real daemon --------------------- */

test("the full chain flow through the daemon: root runs → propagates → member runs → chain completes", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph());
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const a = String(tasks["A"]!["id"]);
    const b = String(tasks["B"]!["id"]);

    // the operator starts the chain: enqueue the root
    const run = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    assert.equal(run["ok"], true, JSON.stringify(run));
    // dispatch → run-ok stub → settle → auto-verification → completed
    await waitForState(env, a, "completed");
    // the settle seam propagates: B enqueued by the chain engine
    await waitForState(env, b, "completed");
    const bQueued = transitionsOf(env, b).find((t) => t["to_state"] === "queued");
    assert.equal(bQueued?.["trigger_type"], "engine");
    assert.equal(bQueued?.["actor"], "chain-engine");

    // all members completed → the chain completed (guarded terminal move)
    await waitFor(() => {
      const status = chainStatusSync(env, String(data["chain_run_id"]));
      return String((status["chain"] as Record<string, unknown>)["state"]) === "completed";
    }, 8000);
  } finally {
    await shutdown(env);
  }
});

function chainStatusSync(env: Env, chainRunId: string): Record<string, unknown> {
  // synchronous status read through a direct read-only connection-level
  // helper is not possible over the async client; use a fresh request
  // (kept sync-looking by the caller's waitFor polling)
  const ro = readConnection(env.dbPath);
  try {
    const chain = ro.prepare("SELECT * FROM chain_runs WHERE id = ?").get(chainRunId) as Record<string, unknown>;
    const members = ro.prepare("SELECT id, key, state FROM tasks WHERE chain_run_id = ?").all(chainRunId);
    return { chain, members };
  } finally {
    ro.close();
  }
}

test("the gate terminal outcome (confirm-failure) fails the chain over the wire", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph({
      tasks: [
        { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev", requires_human_gate: true },
      ],
      edges: [],
    }));
    const a = String(((res["data"] as Record<string, unknown>)["tasks"] as Record<string, Record<string, unknown>>)["A"]!["id"]);
    const chainRunId = String((res["data"] as Record<string, unknown>)["chain_run_id"]);

    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    await waitForState(env, a, "awaiting_gate");
    const confirm = await env.client.request({
      id: "confirm",
      op: "nova_gate_confirm_failure",
      args: { task_id: a, approved_by: "maul", note: "not salvageable" },
    });
    assert.equal(confirm["ok"], true, JSON.stringify(confirm));

    const status = await env.client.request({
      id: "status",
      op: "nova_chain_status",
      args: { chain_run_id: chainRunId },
    });
    const chain = (status["data"] as Record<string, unknown>)["chain"] as Record<string, unknown>;
    assert.equal(chain["state"], "failed");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------- pause / resume ------------------------------ */

test("chain pause withholds dispatch; resume runs the member to completion", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph());
    const data = res["data"] as Record<string, unknown>;
    const a = String(((data["tasks"] as Record<string, Record<string, unknown>>)["A"]!["id"]));
    const b = String(((data["tasks"] as Record<string, Record<string, unknown>>)["B"]!["id"]));
    const chainRunId = String(data["chain_run_id"]);

    // pause BEFORE anything runs: dispatch must skip the chain's members
    const pause = await env.client.request({ id: "p", op: "nova_chain_pause", args: { chain_run_id: chainRunId } });
    assert.equal(pause["ok"], true, JSON.stringify(pause));
    // the status surface carries the flag while the row stays 'active'
    const status = await env.client.request({ id: "s", op: "nova_chain_status", args: { chain_run_id: chainRunId } });
    const statusData = status["data"] as Record<string, unknown>;
    assert.equal(statusData["paused"], true);
    assert.equal((statusData["chain"] as Record<string, unknown>)["state"], "active");

    // enqueue the root: it stays queued — dispatch skips paused chains
    const run = await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    assert.equal(run["ok"], true, JSON.stringify(run));
    await new Promise((r) => setTimeout(r, 300)); // several dispatch ticks
    assert.equal(taskState(env, a), "queued", "a paused chain's members are never admitted");

    // resume: dispatch admits the root, the chain runs to completion
    const resume = await env.client.request({ id: "r", op: "nova_chain_resume", args: { chain_run_id: chainRunId } });
    assert.equal(resume["ok"], true, JSON.stringify(resume));
    await waitForState(env, a, "completed");
    await waitForState(env, b, "completed");
    await waitFor(() => {
      const status = chainStatusSync(env, chainRunId);
      return String((status["chain"] as Record<string, unknown>)["state"]) === "completed";
    }, 8000);
  } finally {
    await shutdown(env);
  }
});

test("a completion while paused withholds propagation; resume evaluates immediately and names the enqueued member", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph());
    const data = res["data"] as Record<string, unknown>;
    const a = String(((data["tasks"] as Record<string, Record<string, unknown>>)["A"]!["id"]));
    const b = String(((data["tasks"] as Record<string, Record<string, unknown>>)["B"]!["id"]));
    const chainRunId = String(data["chain_run_id"]);

    await env.client.request({ id: "p", op: "nova_chain_pause", args: { chain_run_id: chainRunId } });
    // A completes out-of-band while the chain is paused (test-side
    // guarded transitions — the same rows the engine applies)
    const rw = new Database(env.dbPath);
    applyTransition(rw, a, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(rw, a, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, a, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, a, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    rw.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(taskState(env, b), "draft", "a paused chain withholds propagation");

    const resume = await env.client.request({ id: "r", op: "nova_chain_resume", args: { chain_run_id: chainRunId } });
    assert.equal(resume["ok"], true, JSON.stringify(resume));
    assert.deepEqual((resume["data"] as Record<string, unknown>)["enqueued"], [b]);
    // dispatch may already have granted the slot — the durable evidence
    // is the single guarded draft->queued row
    const resumeLogs = transitionsOf(env, b).filter((t) => t["to_state"] === "queued");
    assert.equal(resumeLogs.length, 1);
    assert.notEqual(taskState(env, b), "draft");
  } finally {
    await shutdown(env);
  }
});

/* --------------------------------- chain abort -------------------------------- */

test("chain abort: queued member cancelled, draft member reported no-abort-row, terminal untouched, guarded re-abort", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph());
    const data = res["data"] as Record<string, unknown>;
    const a = String(((data["tasks"] as Record<string, Record<string, unknown>>)["A"]!["id"]));
    const b = String(((data["tasks"] as Record<string, Record<string, unknown>>)["B"]!["id"]));
    const chainRunId = String(data["chain_run_id"]);

    // freeze the scheduler so A stays queued after its enqueue
    await env.client.request({ id: "dp", op: "nova_daemon_pause", args: {} });
    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    await waitForState(env, a, "queued");

    const abort = await env.client.request({ id: "abort", op: "nova_chain_abort", args: { chain_run_id: chainRunId, actor: "maul" } });
    assert.equal(abort["ok"], true, JSON.stringify(abort));
    const abortData = abort["data"] as Record<string, unknown>;
    assert.equal(abortData["state"], "aborted");
    const outcomes = abortData["members"] as Array<Record<string, unknown>>;
    const aOut = outcomes.find((o) => o["key"] === "A")!;
    assert.equal(aOut["outcome"], "cancelled");
    assert.equal(taskState(env, a), "cancelled");
    const bOut = outcomes.find((o) => o["key"] === "B")!;
    assert.equal(bOut["outcome"], "no-abort-row"); // draft: no matrix abort row
    assert.equal(taskState(env, b), "draft");

    // the chain row is terminal; a second abort refuses invalid_transition
    const again = await env.client.request({ id: "again", op: "nova_chain_abort", args: { chain_run_id: chainRunId } });
    assert.equal(again["ok"], false);
    assert.equal((again["error"] as Record<string, unknown>)["code"], "invalid_transition");

    // pause/resume refuse on a terminal chain too
    const pause = await env.client.request({ id: "p", op: "nova_chain_pause", args: { chain_run_id: chainRunId } });
    assert.equal(pause["ok"], false);
    assert.equal((pause["error"] as Record<string, unknown>)["code"], "invalid_transition");
  } finally {
    await shutdown(env);
  }
});

test("chain abort with a LIVE running member: dispatcher.abortTask group-kills it; completed members stay untouched", async () => {
  const env = await boot({ runMode: "run-hang" });
  try {
    const res = await importVia(env, chainGraph({
      tasks: [
        { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev" },
        { key: "DONE", title: "Done already", objective: "A member that finished already.", profile_name: "dev" },
      ],
      edges: [],
    }));
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const a = String(tasks["A"]!["id"]);
    const chainRunId = String(data["chain_run_id"]);

    // drive the DONE member to completed out-of-band (test-side rows)
    const rw = new Database(env.dbPath);
    applyTransition(rw, String(tasks["DONE"]!["id"]), ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(rw, String(tasks["DONE"]!["id"]), START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, String(tasks["DONE"]!["id"]), VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, String(tasks["DONE"]!["id"]), VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    rw.close();

    // A runs live (run-hang never settles on its own)
    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    await waitForState(env, a, "running");

    const abort = await env.client.request({ id: "abort", op: "nova_chain_abort", args: { chain_run_id: chainRunId, actor: "maul" } });
    assert.equal(abort["ok"], true, JSON.stringify(abort));
    const outcomes = (abort["data"] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    const aOut = outcomes.find((o) => o["key"] === "A")!;
    assert.equal(aOut["outcome"], "cancelled");
    assert.equal(aOut["live_run"], true);
    await waitForState(env, a, "cancelled");
    const doneOut = outcomes.find((o) => o["key"] === "DONE")!;
    assert.equal(doneOut["outcome"], "already-terminal");
    assert.equal(taskState(env, String(tasks["DONE"]!["id"])), "completed");
    assert.equal(String((abort["data"] as Record<string, unknown>)["state"]), "aborted");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ list + boot sweep ----------------------------- */

test("nova_chain_list surfaces chains with member counts and the pause flag", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, chainGraph());
    const chainRunId = String((res["data"] as Record<string, unknown>)["chain_run_id"]);
    const list = await env.client.request({
      id: "l",
      op: "nova_chain_list",
      args: { workspace_id: env.workspaceId },
    });
    const chains = (list["data"] as Record<string, unknown>)["chains"] as Array<Record<string, unknown>>;
    assert.equal(chains.length, 1);
    assert.equal(chains[0]!["member_count"], 2);
    assert.equal(chains[0]!["paused"], false);
    assert.equal(chains[0]!["project_slug"], "prj");

    await env.client.request({ id: "p", op: "nova_chain_pause", args: { chain_run_id: chainRunId } });
    const list2 = await env.client.request({
      id: "l2",
      op: "nova_chain_list",
      args: { workspace_id: env.workspaceId },
    });
    const chains2 = (list2["data"] as Record<string, unknown>)["chains"] as Array<Record<string, unknown>>;
    assert.equal(chains2[0]!["paused"], true);
  } finally {
    await shutdown(env);
  }
});

test("boot sweep across a real daemon restart: a completion that happened while down propagates exactly once", async () => {
  const env = await boot();
  const res = await importVia(env, chainGraph());
  const data = res["data"] as Record<string, unknown>;
  const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
  const a = String(tasks["A"]!["id"]);
  const b = String(tasks["B"]!["id"]);
  const chainRunId = String(data["chain_run_id"]);
  // pause the chain, then stop the daemon (the flag is in-memory and dies with it)
  await env.client.request({ id: "p", op: "nova_chain_pause", args: { chain_run_id: chainRunId } });
  env.client.close();
  await env.handle.stop();

  try {
    // A completes while the daemon is down (out-of-band, test-side rows)
    const rw = new Database(env.dbPath);
    applyTransition(rw, a, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(rw, a, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, a, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, a, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    rw.close();

    // restart on the same store: the boot sweep propagates B exactly once
    const cfgPath = join(env.dir, "config.yaml");
    const handle = await startDaemon({
      dbPath: env.dbPath,
      socketPath: join(env.dir, "novaflow.sock"),
      daemonConfigPath: cfgPath,
      probePiBin: "node",
      probeArgs: [STUB, "ok"],
      probeTimeoutMs: 3000,
      runPiBin: "node",
      runArgs: [STUB, "run-ok"],
      extensionPath: "/ext/novaflow.ts",
      pricesPath: join(env.dir, "no-prices.json"),
      killGraceMs: 300,
      tickMs: 30,
    });
    const client = await TestClient.connect(handle.socketPath);
    try {
      await waitFor(() => taskState(env, b) !== "draft", 8000);
      const queuedLogs = transitionsOf(env, b).filter((t) => t["to_state"] === "queued");
      assert.equal(queuedLogs.length, 1, "the boot sweep fired the missed propagation exactly once");
      assert.equal(queuedLogs[0]!["trigger_type"], "engine");
      assert.equal(queuedLogs[0]!["actor"], "chain-engine");
      // the restarted daemon finishes the chain
      await waitForState(env, b, "completed");
      await waitFor(() => {
        const status = chainStatusSync(env, chainRunId);
        return String((status["chain"] as Record<string, unknown>)["state"]) === "completed";
      }, 8000);
    } finally {
      client.close();
      await handle.stop();
    }
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
