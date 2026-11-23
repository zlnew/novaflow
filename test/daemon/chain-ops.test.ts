import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, type SeededStore } from "./seed.ts";
import { applyTransition } from "../../src/fsm/engine.ts";
import { openDb } from "../../src/store/db.ts";
import { importChain } from "../../src/chain/import.ts";
import { VERIFY_FAILED_TRIGGER } from "../../src/fsm/triggers.ts";
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

/** The seeded workspace target's scope — every member that can be
 *  enqueued carries it (DEBT-010: the guarded draft→queued row refuses
 *  a task with zero target_scopes). */
const SCOPES = [{ repo_alias: "ws-app", access_mode: "read_write" as const }];

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
      { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev", target_scopes: SCOPES },
      { key: "B", title: "Task B", objective: "The objective of task B.", profile_name: "dev", target_scopes: SCOPES },
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
    target_scopes:
      - repo_alias: ${SCOPES[0]!.repo_alias}
        access_mode: read_write
  - key: B
    title: Task B
    objective: The objective of task B.
    profile_name: dev
    target_scopes:
      - repo_alias: ${SCOPES[0]!.repo_alias}
        access_mode: read_write
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
      { key: "J1", title: "Task one", objective: "The objective of task one.", profile_name: "dev", target_scopes: SCOPES },
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
      tasks: [{ key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "twin", target_scopes: SCOPES }],
      edges: [],
    }));
    assert.equal(ambiguous["ok"], false);
    const aerr = ambiguous["error"] as Record<string, unknown>;
    assert.equal(aerr["code"], "profile_unresolved");
    assert.match(String(aerr["message"]), /twin/);

    // DEBT-011: a member without target_scopes → schema_invalid over the
    // wire, naming the member and the fix (never a chain that can never run)
    const scopeless = await importVia(env, chainGraph({
      tasks: [{ key: "NS", title: "No scope", objective: "The objective of task NS.", profile_name: "dev" }],
      edges: [],
    }));
    assert.equal(scopeless["ok"], false);
    const serr = scopeless["error"] as Record<string, unknown>;
    assert.equal(serr["code"], "schema_invalid");
    assert.match(String(serr["message"]), /add target_scopes to member NS/);

    // every refusal above was atomic: no chain row was ever created
    const ro = readConnection(env.dbPath);
    assert.equal(
      (ro.prepare("SELECT COUNT(*) AS n FROM chain_runs").get() as { n: number }).n,
      0,
      "a refused import leaves no chain_runs row behind",
    );
    ro.close();
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
        { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev", requires_human_gate: true, target_scopes: SCOPES },
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
        { key: "A", title: "Task A", objective: "The objective of task A.", profile_name: "dev", target_scopes: SCOPES },
        { key: "DONE", title: "Done already", objective: "A member that finished already.", profile_name: "dev", target_scopes: SCOPES },
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

/* -------------------- p4b: feedback routing over the wire -------------------- */

test("review path end to end: a reviewer-shaped emitter re-enters its completed target, delivers the validated artifact, and the chain finishes", async () => {
  const env = await boot({ runMode: "run-review" });
  try {
    const res = await importVia(env, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        { key: "R", title: "Reviewer", objective: "The objective of task R.", profile_name: "dev", target_scopes: SCOPES },
        { key: "W", title: "Worker", objective: "The objective of task W.", profile_name: "dev", target_scopes: SCOPES },
      ],
      edges: [{ source_key: "R", target_key: "W", edge_type: "on_changes_requested" }],
    });
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const r = String(tasks["R"]!["id"]);
    const w = String(tasks["W"]!["id"]);
    const chainRunId = String(data["chain_run_id"]);

    // the worker completed earlier (DAG ordering) — test-side rows
    const rw = new Database(env.dbPath);
    applyTransition(rw, w, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(rw, w, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, w, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, w, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
    rw.close();

    // the reviewer runs: settles with a changes_requested artifact →
    // validating → engine verification → completed → review routing.
    // The durable evidence is the re-entry row — the queued state itself
    // races the target's fast re-run (the loop can complete in < 500 ms).
    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: r, actor: "maul" } });
    await waitFor(() => {
      const logs = transitionsOf(env, w);
      return logs.some((t) => t["to_state"] === "changes_requested" && t["actor"] === "chain-engine");
    }, 10_000);

    // the re-entry: the verbatim completed→changes_requested row + requeue
    const logs = transitionsOf(env, w);
    const entry = logs.find((t) => t["to_state"] === "changes_requested");
    assert.equal(entry?.["from_state"], "completed");
    assert.equal(entry?.["trigger_type"], "engine");
    assert.equal(entry?.["actor"], "chain-engine");
    const requeue = logs.find((t) => t["from_state"] === "changes_requested" && t["to_state"] === "queued");
    assert.match(String(requeue?.["reason"]), /\.novaflow\/runs\/.+\/feedback\/.+\.json/);

    // the delivered artifact is the emitter's VALIDATED result.json
    const rel = `.novaflow/runs/${w}/feedback/${r}.json`;
    const delivered = JSON.parse(readFileSync(join(env.wsRoot, rel), "utf8")) as Record<string, unknown>;
    assert.equal(delivered["status"], "changes_requested");
    assert.equal(delivered["engine_verified"], true);
    const ro = readConnection(env.dbPath);
    const wRow = ro.prepare("SELECT context_files_json, retry_count FROM tasks WHERE id = ?").get(w) as {
      context_files_json: string;
      retry_count: number;
    };
    ro.close();
    assert.deepEqual(JSON.parse(wRow.context_files_json), [rel], "FR-TSK-04: the delivered path is recorded on the target's context");
    assert.equal(wRow.retry_count, 1, "retry_count incremented EXACTLY on the re-entry");

    // the target re-runs with the feedback injected (the one sanctioned
    // upstream handoff beyond its configured context), and the chain
    // finishes — W's re-run + the terminal move land before the receipt
    // is read (the stub writes it when the prompt arrives)
    await waitFor(() => {
      const status = chainStatusSync(env, chainRunId);
      return String((status["chain"] as Record<string, unknown>)["state"]) === "completed";
    }, 15_000);
    const ro2 = readConnection(env.dbPath);
    const rerun = ro2
      .prepare("SELECT pi_session_dir FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(w) as { pi_session_dir: string };
    ro2.close();
    const receipt = JSON.parse(
      readFileSync(join(rerun.pi_session_dir, "stub-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.match(
      String(receipt["prompt"]),
      new RegExp(`--- ${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ---`),
      "the feedback file entered the re-run's prompt as an input context file",
    );
    assert.match(String(receipt["prompt"]), /The auth handler does not refresh tokens\./);

    // the consolidated project report is written
    const summary = join(env.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md");
    assert.ok(existsSync(summary), "FR-PRJ-05: the report rides the chain's completed move");
    const summaryText = readFileSync(summary, "utf8");
    assert.match(summaryText, /## R — Reviewer/);
    assert.match(summaryText, /## W — Worker/);

    // the status surface shows the delivered feedback (derived, no new state)
    const status = await env.client.request({
      id: "cs",
      op: "nova_chain_status",
      args: { chain_run_id: chainRunId },
    });
    const members = (status["data"] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    assert.deepEqual(members.find((m) => m["id"] === w)!["feedback"], [rel]);
    assert.deepEqual(members.find((m) => m["id"] === r)!["feedback"], []);
  } finally {
    await shutdown(env);
  }
});

test("failure path over the wire: confirm-failure enqueues the on_failure fallback with synthesized context; the chain records failed while routing continues", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        {
          key: "F",
          title: "Flaky",
          objective: "The objective of task F.",
          profile_name: "dev",
          requires_human_gate: true,
          target_scopes: SCOPES,
        },
        { key: "T", title: "Fallback", objective: "The objective of task T.", profile_name: "dev", target_scopes: SCOPES },
      ],
      edges: [{ source_key: "F", target_key: "T", edge_type: "on_failure" }],
    });
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const f = String(tasks["F"]!["id"]);
    const t = String(tasks["T"]!["id"]);
    const chainRunId = String(data["chain_run_id"]);

    // F runs, settles, and lands at the gate
    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: f, actor: "maul" } });
    await waitForState(env, f, "awaiting_gate");
    const confirm = await env.client.request({
      id: "confirm",
      op: "nova_gate_confirm_failure",
      args: { task_id: f, approved_by: "maul", note: "not salvageable" },
    });
    assert.equal(confirm["ok"], true, JSON.stringify(confirm));
    assert.deepEqual(
      (confirm["data"] as Record<string, unknown>)["fallback_enqueued"],
      [t],
      "the fallback ride is reported by the op",
    );

    // the fallback enqueued via the guarded row (engine / chain-engine) —
    // the enqueue is synchronous with the confirm response; the queued
    // state itself races the target's fast re-run
    const entry = transitionsOf(env, t).find((tr) => tr["to_state"] === "queued");
    assert.equal(entry?.["from_state"], "draft");
    assert.equal(entry?.["trigger_type"], "engine");
    assert.equal(entry?.["actor"], "chain-engine");

    // the synthesized failure context: the member's result.json + error summary
    const rel = `.novaflow/runs/${t}/feedback/${f}.json`;
    const fb = JSON.parse(readFileSync(join(env.wsRoot, rel), "utf8")) as Record<string, unknown>;
    assert.equal(fb["kind"], "novaflow-failure-feedback");
    assert.equal(fb["failed_task_id"], f);
    assert.equal((fb["result"] as Record<string, unknown>)["status"], "completed");
    const ro = readConnection(env.dbPath);
    const tCtx = ro.prepare("SELECT context_files_json FROM tasks WHERE id = ?").get(t) as {
      context_files_json: string;
    };
    ro.close();
    assert.deepEqual(JSON.parse(tCtx.context_files_json), [rel]);

    // the chain-failed rule fired too (unordered — both happen)
    const statusNow = chainStatusSync(env, chainRunId);
    assert.equal(String((statusNow["chain"] as Record<string, unknown>)["state"]), "failed");

    // nothing halts members on chain state: the fallback runs to completion
    await waitForState(env, t, "completed", 15_000);
  } finally {
    await shutdown(env);
  }
});

test("the gate-approved verification driver (p4a residual): approving the gate runs the SAME pipeline — member completes, chain finishes, report written", async () => {
  const env = await boot();
  try {
    const res = await importVia(env, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        {
          key: "A",
          title: "Gated",
          objective: "The objective of task A.",
          profile_name: "dev",
          requires_human_gate: true,
          target_scopes: SCOPES,
        },
        { key: "B", title: "Follow-up", objective: "The objective of task B.", profile_name: "dev", target_scopes: SCOPES },
      ],
      edges: [{ source_key: "A", target_key: "B", edge_type: "depends_on" }],
    });
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const a = String(tasks["A"]!["id"]);
    const b = String(tasks["B"]!["id"]);
    const chainRunId = String(data["chain_run_id"]);

    // A runs, settles at the gate (requires_human_gate)
    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: a, actor: "maul" } });
    await waitForState(env, a, "awaiting_gate");
    const ro = readConnection(env.dbPath);
    const liveRun = ro
      .prepare("SELECT id FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(a) as { id: string };
    ro.close();

    // the approval moves awaiting_gate→validating AND drives the engine
    // verification (before p4b the task dead-ended in validating)
    const approve = await env.client.request({
      id: "approve",
      op: "nova_gate_approve",
      args: { task_id: a, run_id: liveRun.id, approved_by: "maul", note: "looks right" },
    });
    assert.equal(approve["ok"], true, JSON.stringify(approve));
    assert.equal((approve["data"] as Record<string, unknown>)["final_state"], "validating");

    // the SAME pipeline the settle seam uses decides the verdict
    await waitForState(env, a, "completed", 10_000);
    const tr = transitionsOf(env, a);
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "validating");
    assert.equal(last["to_state"], "completed");
    assert.equal(last["trigger_type"], "engine");
    assert.match(String(last["reason"]), /engine verification passed/);

    // readiness rides the same seam: B runs and the chain completes
    await waitForState(env, b, "completed", 15_000);
    await waitFor(() => {
      const status = chainStatusSync(env, chainRunId);
      return String((status["chain"] as Record<string, unknown>)["state"]) === "completed";
    }, 10_000);
    const summary = join(env.wsRoot, ".novaflow", "projects", "prj", "PROJECT_SUMMARY.md");
    assert.ok(existsSync(summary));
    assert.match(readFileSync(summary, "utf8"), /## A — Gated/);
  } finally {
    await shutdown(env);
  }
});

test("the gate-approved driver: a FAILING engine verification still decides — changes_requested with retry_count++ (approving never bypasses verification)", async () => {
  const env = await boot();
  try {
    // a directory target whose verification command FAILS
    const targetRoot = join(env.dir, "targetroot");
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "note.txt"), "clean tree\n");
    const rw = new Database(env.dbPath);
    rw.prepare(
      `INSERT INTO project_targets (id, project_id, alias, target_type, root_path)
       VALUES (?, ?, 'app', 'directory', ?)`,
    ).run(ulid(), env.projectId, targetRoot);
    rw.close();

    const res = await importVia(env, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        {
          key: "G",
          title: "Gated flaky",
          objective: "The objective of task G.",
          profile_name: "dev",
          requires_human_gate: true,
          target_scopes: [
            { repo_alias: "app", access_mode: "read_write", verification_commands: ["exit 1"] },
          ],
        },
      ],
      edges: [],
    });
    const data = res["data"] as Record<string, unknown>;
    const tasks = data["tasks"] as Record<string, Record<string, unknown>>;
    const g = String(tasks["G"]!["id"]);
    const chainRunId = String(data["chain_run_id"]);

    await env.client.request({ id: "run", op: "nova_task_run", args: { task_id: g, actor: "maul" } });
    await waitForState(env, g, "awaiting_gate");
    const ro = readConnection(env.dbPath);
    const liveRun = ro
      .prepare("SELECT id FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
      .get(g) as { id: string };
    ro.close();

    // the operator approved the GATE — the ENGINE still verifies
    // (FR-TSK-12: verification overrides self-reports of success)
    const approve = await env.client.request({
      id: "approve",
      op: "nova_gate_approve",
      args: { task_id: g, run_id: liveRun.id, approved_by: "maul", note: "looks right" },
    });
    assert.equal(approve["ok"], true, JSON.stringify(approve));

    // the failed verdict: the SELF path now retries itself (the p4b fix —
    // the requeue row previously had no caller). A GATED task re-enters its
    // gate on every rerun: approve → verify fails → requeue → rerun → back
    // to awaiting_gate with the budget honored — the operator approves
    // again or confirms failure.
    // wait for the SECOND gate arrival: awaiting_gate again AND the entry
    // already counted (the first arrival predates the approval)
    await waitFor(async () => {
      const ro = readConnection(env.dbPath);
      const row = ro
        .prepare("SELECT state, retry_count FROM tasks WHERE id = ?")
        .get(g) as { state: string; retry_count: number };
      ro.close();
      return row.state === "awaiting_gate" && row.retry_count >= 1;
    }, 30_000);
    const ro2 = readConnection(env.dbPath);
    const gRow = ro2
      .prepare("SELECT retry_count, context_files_json FROM tasks WHERE id = ?")
      .get(g) as { retry_count: number; context_files_json: string };
    ro2.close();
    assert.equal(gRow.retry_count, 1, "retry_count increments EXACTLY once per changes_requested entry");
    // discriminating evidence: the self-path requeue row with the delivered
    // feedback artifact recorded, then the rerun's own gate row
    const tr = transitionsOf(env, g);
    const requeueRows = tr.filter(
      (r) => r["from_state"] === "changes_requested" && r["to_state"] === "queued",
    );
    assert.equal(requeueRows.length, 1, "the engine-verification feedback drove one self-path requeue");
    assert.match(
      String(requeueRows[0]!["reason"]),
      /feedback artifact delivered to next attempt: .*engine-verification/,
    );
    assert.match(gRow.context_files_json, /feedback\/engine-verification\.json/);
    assert.ok(
      existsSync(join(env.wsRoot, ".novaflow", "runs", g, "feedback", "engine-verification.json")),
      "the engine-verification feedback file exists",
    );
    const last = tr[tr.length - 1]!;
    assert.equal(last["from_state"], "running");
    assert.equal(last["to_state"], "awaiting_gate"); // the RERUN's gate row — the cycle is honest

    // a verification failure is NOT a confirmed gate failure: the chain stays active
    assert.equal(String((chainStatusSync(env, chainRunId)["chain"] as Record<string, unknown>)["state"]), "active");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------- boot-order + self-path recovery (review round) ------------------------- */


/** Offline chain import onto a seeded store (the same service the op uses). */
function importChainOffline(
  seeded: { dbPath: string; workspaceId: string; projectId: string },
  dir: string,
  graph: Record<string, unknown>,
): { chainRun: { id: string }; tasks: Record<string, { id: string }> } {
  const db = openDb(seeded.dbPath);
  try {
    const out = importChain(
      db,
      { id: seeded.workspaceId },
      { id: seeded.projectId, slug: "prj" },
      graph as Parameters<typeof importChain>[3],
    );
    return { chainRun: out.chainRun, tasks: out.tasks };
  } finally {
    db.close();
  }
}

/** Boot a daemon onto a PRE-CONSTRUCTED store (crash-state tests). */
async function bootOn(dir: string, dbPath: string, wsRoot: string): Promise<Env> {
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const handle = await startDaemon({
    dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok"],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(handle.socketPath);
  return {
    dir, dbPath, wsRoot,
    workspaceId: "", projectId: "", profileId: "",
    handle, client,
  };
}

/** Drive a task to completed via the legal guarded rows (seed helper). */
function driveToCompleted(db: Database.Database, taskId: string): void {
  applyTransition(db, taskId, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(db, taskId, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(db, taskId, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(db, taskId, VERIFY_PASSED_TRIGGER, { triggerType: "engine", actor: "seed" });
}

test("boot order: an unrouted review occurrence survives the crash window — routing sweeps BEFORE chains (judge-proven fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-bootord-"));
  const seeded = seedFileStore(dir);
  const { chainRun, tasks } = importChainOffline(seeded, dir, {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [
      { key: "E", title: "Emitter", objective: "The objective of the emitter task.", profile_name: "dev", target_scopes: SCOPES },
      { key: "T", title: "Target", objective: "The objective of the target task.", profile_name: "dev", target_scopes: SCOPES },
    ],
    edges: [{ source_key: "E", target_key: "T", edge_type: "on_changes_requested" }],
  });
  const e = tasks["E"]!.id;
  const t = tasks["T"]!.id;
  // THE CRASH STATE (constructed BEFORE boot — the sweep runs once at
  // daemon start): both members completed, the emitter's artifact says
  // changes_requested, the occurrence unrouted — what a kill between
  // completeValidation(E) and routeReviewPath leaves behind.
  const rw = new Database(seeded.dbPath);
  driveToCompleted(rw, e);
  driveToCompleted(rw, t);
    // the emitter's run row + its validated result.json (status changes_requested)
    const runDir = join(seeded.wsRoot, ".novaflow", "runs", e);
    mkdirSync(join(runDir, "run1"), { recursive: true });
    const artifactPath = join(runDir, "run1", "result.json");
    writeFileSync(artifactPath, JSON.stringify({
      schema_version: "1.0.0", task_id: e, run_id: "run1", status: "changes_requested",
      summary: "The target needs rework.", assumptions_made: [], open_questions: [],
      artifacts_modified: [], feedback_items: [], next_recommended_action: "retry",
    }, null, 2));
    rw.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, pi_session_id, pi_session_dir, status, artifact_path, events_log_path, model_used)
       VALUES (?, ?, 1, 'run1', ?, 'succeeded', ?, 'events.jsonl', 'stub')`,
    ).run("01ARZ3NDEKTSV4RRFFQ69G5FAVR", e, join(runDir, "run1"), artifactPath);
    rw.close();

    // NOW boot onto the crash state — the sweep must route before chains
    const env = await bootOn(dir, seeded.dbPath, seeded.wsRoot);
    try {
    // pre-fix behavior: chains.bootScan completed the chain first and the
    // routing sweep skipped it — the review round silently vanished.
    const chainRow = (reason: string) => {
      const ro = new Database(seeded.dbPath);
      const chain = ro.prepare("SELECT state FROM chain_runs WHERE id = ?").get(chainRun.id) as { state: string };
      const entries = ro
        .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND from_state = 'completed' AND to_state = 'changes_requested'")
        .get(t) as { n: number };
      const retry = ro.prepare("SELECT retry_count FROM tasks WHERE id = ?").get(t) as { retry_count: number };
      ro.close();
      void reason;
      return { chain: chain.state, entries: entries.n, retry: retry.retry_count };
    };
    await new Promise((r) => setTimeout(r, 400));
    const after = chainRow("post-boot");
    assert.equal(after.entries, 1, "the target re-entered EXACTLY once at boot");
    assert.equal(after.retry, 1, "the re-entry consumed exactly one budget unit");
    // the steady state is honest EITHER way: the chain may complete — but
    // only over the RERUN, never over the unrouted occurrence. Order-proof:
    // the chain's completed_at (when present) is strictly AFTER the
    // re-entry row; pre-fix, the chain completed with ZERO re-entries.
    if (after.chain === "completed") {
      const ro2 = new Database(seeded.dbPath);
      const chainAt = (ro2.prepare("SELECT completed_at FROM chain_runs WHERE id = ?").get(chainRun.id) as { completed_at: string }).completed_at;
      const entryAt = (ro2
        .prepare("SELECT created_at FROM state_transition_logs WHERE task_id = ? AND from_state = 'completed' AND to_state = 'changes_requested' LIMIT 1")
        .get(t) as { created_at: string }).created_at;
      ro2.close();
      // `>` would flake on created_at's ms resolution: the chain's
      // completed_at may land in the same millisecond as the re-entry.
      // The synchronous sweep order IS the guarantee (routing completes
      // before the chain sweep evaluates); the timestamps corroborate.
      assert.ok(
        chainAt !== null && entryAt !== null && chainAt >= entryAt,
        `the chain closed only after the routed rerun (entry ${entryAt}, chain ${chainAt})`,
      );
    }
    } finally {
      await shutdown(env);
    }
    rmSync(dir, { recursive: true, force: true });
  });

test("self-path boot recovery: a member wedged in changes_requested by a crash requeues at boot (judge A finding)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-selfrec-"));
  const seeded = seedFileStore(dir);
  const { tasks } = importChainOffline(seeded, dir, {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [{ key: "S", title: "Self", objective: "The objective of the self task.", profile_name: "dev", target_scopes: SCOPES }],
    edges: [],
  });
  const s = tasks["S"]!.id;
  // THE CRASH STATE (constructed BEFORE boot): the verification-failure
  // ENTRY happened, the requeue driver never ran (no feedback file), and
  // the member's latest run row carries the error summary the recovery
  // synthesizes from.
  const rw = new Database(seeded.dbPath);
    applyTransition(rw, s, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
    applyTransition(rw, s, START_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, s, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
    applyTransition(rw, s, VERIFY_FAILED_TRIGGER, { triggerType: "engine", actor: "seed", reason: "engine verification failed" });
    // the ENTRY's production side effect: enterChangesRequested increments
    // retry_count — the test drives the row directly, so replicate it
    // (a crash mid-entry leaves the increment applied)
    rw.prepare("UPDATE tasks SET retry_count = 1 WHERE id = ?").run(s);
    rw.prepare(
      `INSERT INTO task_runs (id, task_id, attempt_number, pi_session_id, pi_session_dir, status, error_summary, events_log_path, model_used)
       VALUES (?, ?, 1, 'run1', ?, 'failed', 'command "exit 1" failed', 'events.jsonl', 'stub')`,
    ).run("01ARZ3NDEKTSV4RRFFQ69G5FAVS", s, join(seeded.wsRoot, ".novaflow", "runs", s, "run1"));
    rw.close();

    // NOW boot onto the crash state
    const env = await bootOn(dir, seeded.dbPath, seeded.wsRoot);
    try {
    await new Promise((r) => setTimeout(r, 400));
    const ro = new Database(seeded.dbPath);
    const row = ro
      .prepare("SELECT state, retry_count, context_files_json FROM tasks WHERE id = ?")
      .get(s) as { state: string; retry_count: number; context_files_json: string };
    const requeues = ro
      .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND from_state = 'changes_requested' AND to_state = 'queued'")
      .get(s) as { n: number };
    // the recovery finished the interrupted delivery: requeued (or already
    // rerunning/rerun), budget honored, the feedback file delivered
    assert.notEqual(row.state, "changes_requested", "the member was unwedged");
    assert.equal(row.retry_count, 1);
    assert.equal(requeues.n, 1, "exactly one self-path requeue at boot");
    assert.match(row.context_files_json, /feedback\/engine-verification\.json/);
    assert.ok(
      existsSync(join(seeded.wsRoot, ".novaflow", "runs", s, "feedback", "engine-verification.json")),
      "the synthesized feedback file exists",
    );
    } finally {
      await shutdown(env);
    }
    rmSync(dir, { recursive: true, force: true });
  });

test("self-path boot recovery, budget spent: the ESCALATION arm (re-judge finding 1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-selfesc-"));
  const seeded = seedFileStore(dir);
  const { tasks } = importChainOffline(seeded, dir, {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [{ key: "S", title: "Self", objective: "The objective of the self task.", profile_name: "dev", target_scopes: SCOPES }],
    edges: [],
  });
  const s = tasks["S"]!.id;
  const rw = new Database(seeded.dbPath);
  applyTransition(rw, s, ENQUEUE_TRIGGER, { triggerType: "human", actor: "seed" });
  applyTransition(rw, s, START_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(rw, s, VALIDATING_TRIGGER, { triggerType: "engine", actor: "seed" });
  applyTransition(rw, s, VERIFY_FAILED_TRIGGER, { triggerType: "engine", actor: "seed", reason: "engine verification failed" });
  // the entry's side effect + a SPENT budget: retry_count floored at max
  rw.prepare("UPDATE tasks SET retry_count = 1, max_retries = 1 WHERE id = ?").run(s);
  rw.close();

  const env = await bootOn(dir, seeded.dbPath, seeded.wsRoot);
  try {
    await new Promise((r) => setTimeout(r, 400));
    const ro = new Database(seeded.dbPath);
    const row = ro.prepare("SELECT state FROM tasks WHERE id = ?").get(s) as { state: string };
    const escalations = ro
      .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND from_state = 'changes_requested' AND to_state = 'awaiting_gate'")
      .get(s) as { n: number };
    const requeues = ro
      .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ? AND from_state = 'changes_requested' AND to_state = 'queued'")
      .get(s) as { n: number };
    ro.close();
    assert.equal(row.state, "awaiting_gate", "the escalation arm fired — the gate owns the spent budget");
    assert.equal(escalations.n, 1, "exactly one escalation row");
    assert.equal(requeues.n, 0, "no requeue on a spent budget");
  } finally {
    await shutdown(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boot summary recovery: present → untouched, deleted → rewritten (re-judge finding 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-sumrec-"));
  const seeded = seedFileStore(dir);
  const { chainRun, tasks } = importChainOffline(seeded, dir, {
    version: "1.0.0",
    project_slug: "prj",
    tasks: [{ key: "M", title: "Member", objective: "The objective of the member task.", profile_name: "dev", target_scopes: SCOPES }],
    edges: [],
  });
  const m = tasks["M"]!.id;
  const rw = new Database(seeded.dbPath);
  driveToCompleted(rw, m);
  // the chain's guarded completed move + an EXISTING summary file
  rw.prepare("UPDATE chain_runs SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'active'")
    .run(new Date().toISOString(), chainRun.id);
  rw.close();
  const summaryDir = join(seeded.wsRoot, ".novaflow", "projects", "prj");
  mkdirSync(summaryDir, { recursive: true });
  const summaryFile = join(summaryDir, "PROJECT_SUMMARY.md");
  writeFileSync(summaryFile, "the original report\n");

  // ARM 1: file present → boot must not touch it
  const env = await bootOn(dir, seeded.dbPath, seeded.wsRoot);
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readFileSync(summaryFile, "utf8"), "the original report\n", "present summary untouched at boot");
  } finally {
    // stop WITHOUT the dir cleanup (shutdown wipes it) — arm 2 reuses the store
    env.client.close();
    await env.handle.stop();
  }

  // ARM 2: file deleted → boot recovers it
  rmSync(summaryFile);
  const env2 = await bootOn(dir, seeded.dbPath, seeded.wsRoot);
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(existsSync(summaryFile), "the deleted summary was recovered at boot");
    const content = readFileSync(summaryFile, "utf8");
    assert.match(content, /Member/); // the aggregated member section
  } finally {
    env2.client.close();
    await env2.handle.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
