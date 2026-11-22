import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { readConnection } from "./seed.ts";

/**
 * Project + profile ops over the real control server: FR-PRJ-01
 * (project create with 0..N project_targets), FR-PRJ-02 (free-text
 * phase labels, every change audited), FR-PRJ-03 (per-target base
 * branch / access mode), FR-AGT-01 (profile create through the §4.2
 * validator with the canonical file home), and the CLI's task
 * identifier resolution service (srs 4.1.1: ULID direct, key within
 * the workspace context).
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  handle: DaemonHandle;
  client: TestClient;
  wsId: string;
  wsRoot: string;
};

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-prj-"));
  const dbPath = join(dir, "state.db");
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  const handle = await startDaemon({
    dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: join(dir, "cfg.yaml"),
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
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot);
  const ws = await client.request({
    id: "ws",
    op: "nova_workspace_create",
    args: { name: "ws", root_path: wsRoot },
  });
  assert.equal(ws["ok"], true, JSON.stringify(ws));
  return {
    dir,
    dbPath,
    handle,
    client,
    wsId: (ws["data"] as { id: string }).id,
    wsRoot,
  };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

const PROFILE_FIXTURE = {
  name: "dev",
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  thinking_level: "medium",
  system_prompt_path: "prompts/dev_system.md",
  tools_allowlist: ["bash", "read", "edit"],
  limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
};

function writeProfileFile(env: Env, over: Record<string, unknown> = {}, name = "profile.json"): string {
  const path = join(env.dir, name);
  writeFileSync(path, JSON.stringify({ ...PROFILE_FIXTURE, ...over }));
  return path;
}

/* --------------------------------- FR-PRJ-01/03 --------------------------------- */

test("nova_project_create: project row + 0..N project_targets, per-target policy columns, scaffolded dir", async () => {
  const env = await boot();
  try {
    const targetRoot = join(env.dir, "target");
    mkdirSync(targetRoot);
    const res = await env.client.request({
      id: "pc",
      op: "nova_project_create",
      args: {
        workspace_id: env.wsId,
        name: "alpha-app",
        objective: "Ship the thing.",
        targets: [
          {
            alias: "app",
            root_path: targetRoot,
            target_type: "git_repo",
            base_branch: "develop",
            branch_prefix: "nova/",
            default_access: "read_only",
          },
          { alias: "notes", root_path: join(env.dir, "notes"), target_type: "directory" },
        ],
      },
    });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const project = (res["data"] as { project: Record<string, unknown> }).project;
    const targets = (res["data"] as { targets: Array<Record<string, unknown>> }).targets;
    assert.equal(project["slug"], "alpha-app");
    assert.equal(project["workspace_id"], env.wsId);
    assert.equal(project["phase"], "planning"); // DDL default
    assert.equal(targets.length, 2);
    assert.equal(targets[0]!["target_type"], "git_repo");
    assert.equal(targets[0]!["base_branch"], "develop");
    assert.equal(targets[0]!["branch_prefix"], "nova/");
    assert.equal(targets[0]!["default_access"], "read_only");
    // DDL column defaults apply for the omitted fields
    assert.equal(targets[1]!["target_type"], "directory");
    assert.equal(targets[1]!["base_branch"], "main");
    assert.equal(targets[1]!["branch_prefix"], "novaflow/");
    assert.equal(targets[1]!["default_access"], "read_write");

    // the project directory is scaffolded under the workspace layout
    assert.ok(existsSync(join(env.wsRoot, ".novaflow", "projects", "alpha-app")));

    // a project with zero targets is legal (FR-PRJ-01 AC2: 0, 1, or N)
    const zero = await env.client.request({
      id: "pc0",
      op: "nova_project_create",
      args: { workspace_id: env.wsId, name: "solo", objective: "No targets." },
    });
    assert.equal(zero["ok"], true, JSON.stringify(zero));
    assert.deepEqual((zero["data"] as { targets: unknown[] }).targets, []);
  } finally {
    await shutdown(env);
  }
});

test("nova_project_create refusals: bad name, unknown workspace, duplicate slug, bad target payloads", async () => {
  const env = await boot();
  try {
    const base = { workspace_id: env.wsId, objective: "o" };
    const ok = await env.client.request({
      id: "pc-ok",
      op: "nova_project_create",
      args: { ...base, name: "first" },
    });
    assert.equal(ok["ok"], true, JSON.stringify(ok));

    const bad: Array<[string, Record<string, unknown>, string]> = [
      ["bad name", { ...base, name: "Not A Slug" }, "schema_invalid"],
      ["unknown workspace", { ...base, name: "x", workspace_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" }, "not_found"],
      ["duplicate slug in workspace", { ...base, name: "first" }, "duplicate"],
      ["target bad type", { ...base, name: "t1", targets: [{ alias: "a", root_path: "/tmp", target_type: "svn" }] }, "schema_invalid"],
      ["target bad access", { ...base, name: "t2", targets: [{ alias: "a", root_path: "/tmp", target_type: "directory", default_access: "rw" }] }, "schema_invalid"],
      ["target unknown key", { ...base, name: "t3", targets: [{ alias: "a", root_path: "/tmp", target_type: "directory", repo: "x" }] }, "schema_invalid"],
      ["target missing alias", { ...base, name: "t4", targets: [{ root_path: "/tmp", target_type: "directory" }] }, "schema_invalid"],
      ["targets not array", { ...base, name: "t5", targets: "app" }, "schema_invalid"],
      ["objective missing", { workspace_id: env.wsId, name: "t6" }, "schema_invalid"],
    ];
    for (const [label, args, code] of bad) {
      const res = await env.client.request({ id: `bad-${label}`, op: "nova_project_create", args });
      assert.equal(res["ok"], false, label);
      assert.equal(res["error"]["code"], code, label);
    }
    const dupAlias = await env.client.request({
      id: "bad-dup-alias",
      op: "nova_project_create",
      args: {
        ...base,
        name: "t7",
        targets: [
          { alias: "a", root_path: "/tmp", target_type: "directory" },
          { alias: "a", root_path: "/var", target_type: "directory" },
        ],
      },
    });
    assert.equal(dupAlias["ok"], false);
    assert.equal(dupAlias["error"]["code"], "duplicate");

    // only the one valid project persisted
    const ro = readConnection(env.dbPath);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 1);
    ro.close();
  } finally {
    await shutdown(env);
  }
});

test("nova_project_list (workspace-scoped and global) and nova_project_status (counts + phase + targets)", async () => {
  const env = await boot();
  try {
    const profileFile = writeProfileFile(env);
    const p = await env.client.request({
      id: "prof",
      op: "nova_profile_create",
      args: { workspace_id: env.wsId, file_path: profileFile },
    });
    assert.equal(p["ok"], true, JSON.stringify(p));
    const pc = await env.client.request({
      id: "pc",
      op: "nova_project_create",
      args: {
        workspace_id: env.wsId,
        name: "alpha",
        objective: "o",
        targets: [{ alias: "app", root_path: join(env.dir, "app"), target_type: "directory" }],
      },
    });
    const projectId = (pc["data"] as { project: { id: string } }).project["id"];
    // two tasks in different states
    for (const key of ["T1", "T2"]) {
      const t = await env.client.request({
        id: `t-${key}`,
        op: "nova_task_create",
        args: { project_id: projectId, key, title: "t", objective: "o", profile_name: "dev" },
      });
      assert.equal(t["ok"], true, JSON.stringify(t));
    }

    // list scoped to the workspace
    const scoped = await env.client.request({
      id: "pl",
      op: "nova_project_list",
      args: { workspace_id: env.wsId },
    });
    assert.equal(scoped["ok"], true, JSON.stringify(scoped));
    const projects = (scoped["data"] as { projects: Array<Record<string, unknown>> }).projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!["slug"], "alpha");
    assert.equal(projects[0]!["target_count"], 1);

    // list without a workspace: every workspace's projects (documented)
    const all = await env.client.request({ id: "pl2", op: "nova_project_list", args: {} });
    assert.equal((all["data"] as { projects: unknown[] }).projects.length, 1);

    // status: the row + task counts by state + targets
    const st = await env.client.request({ id: "ps", op: "nova_project_status", args: { project_id: projectId } });
    assert.equal(st["ok"], true, JSON.stringify(st));
    const data = st["data"] as Record<string, unknown>;
    assert.equal((data["project"] as Record<string, unknown>)["phase"], "planning");
    assert.deepEqual(data["task_counts"], { draft: 2 });
    assert.equal((data["targets"] as Array<Record<string, unknown>>)[0]!["alias"], "app");

    const missing = await env.client.request({
      id: "ps2",
      op: "nova_project_status",
      args: { project_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" },
    });
    assert.equal(missing["error"]["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

/* ---------------------------------- FR-PRJ-02 ---------------------------------- */

test("nova_project_phase_set: free-text labels, no transition rules, every CHANGE audited with the actor", async () => {
  const env = await boot();
  try {
    const pc = await env.client.request({
      id: "pc",
      op: "nova_project_create",
      args: { workspace_id: env.wsId, name: "alpha", objective: "o" },
    });
    const projectId = (pc["data"] as { project: { id: string } }).project["id"];

    // free text, any label — the engine enforces no stage rules (AC1)
    const first = await env.client.request({
      id: "ph1",
      op: "nova_project_phase_set",
      args: { project_id: projectId, phase: "Brainstorming", actor: "maul" },
    });
    assert.equal(first["ok"], true, JSON.stringify(first));
    assert.equal((first["data"] as Record<string, unknown>)["changed"], true);

    const second = await env.client.request({
      id: "ph2",
      op: "nova_project_phase_set",
      args: { project_id: projectId, phase: "Implementing", actor: "maul" },
    });
    assert.equal((second["data"] as Record<string, unknown>)["changed"], true);

    // AC2: every change + the triggering identity is in the audit log
    const ro = readConnection(env.dbPath);
    const logs = ro
      .prepare("SELECT * FROM project_phase_logs WHERE project_id = ? ORDER BY id")
      .all(projectId) as Array<Record<string, unknown>>;
    ro.close();
    assert.deepEqual(
      logs.map((l) => [l["from_phase"], l["to_phase"], l["actor"]]),
      [
        ["planning", "Brainstorming", "maul"],
        ["Brainstorming", "Implementing", "maul"],
      ],
    );

    // an identical label is NOT a change: no new audit row
    const same = await env.client.request({
      id: "ph3",
      op: "nova_project_phase_set",
      args: { project_id: projectId, phase: "Implementing", actor: "maul" },
    });
    assert.equal((same["data"] as Record<string, unknown>)["changed"], false);
    const ro2 = readConnection(env.dbPath);
    assert.equal(
      (ro2.prepare("SELECT COUNT(*) AS n FROM project_phase_logs WHERE project_id = ?").get(projectId) as { n: number }).n,
      2,
    );
    ro2.close();

    // sane bounded label (spec-silent, documented): > 200 chars is refused
    const tooLong = await env.client.request({
      id: "ph4",
      op: "nova_project_phase_set",
      args: { project_id: projectId, phase: "x".repeat(201), actor: "maul" },
    });
    assert.equal(tooLong["ok"], false);
    assert.equal(tooLong["error"]["code"], "schema_invalid");

    // unknown project → not_found
    const missing = await env.client.request({
      id: "ph5",
      op: "nova_project_phase_set",
      args: { project_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS", phase: "x", actor: "maul" },
    });
    assert.equal(missing["error"]["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------------ FR-AGT-01: profiles ------------------------------ */

test("nova_profile_create: §4.2-validated row + canonical file at .novaflow/profiles/<name>.json; source never moved", async () => {
  const env = await boot();
  try {
    const src = writeProfileFile(env);
    const res = await env.client.request({
      id: "pc",
      op: "nova_profile_create",
      args: { workspace_id: env.wsId, file_path: src },
    });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const profile = (res["data"] as { profile: Record<string, unknown> }).profile;
    assert.equal(profile["workspace_id"], env.wsId);
    assert.deepEqual(JSON.parse(String(profile["tools_allowlist_json"])), ["bash", "read", "edit"]);

    // the canonical home: <root>/.novaflow/profiles/<name>.json
    const canonical = (res["data"] as { canonical_path: string }).canonical_path;
    assert.equal(canonical, join(env.wsRoot, ".novaflow", "profiles", "dev.json"));
    assert.ok(existsSync(canonical));

    // the source file is read, never moved or mutated
    assert.ok(existsSync(src));
    assert.equal(
      readFileSync(src, "utf8"),
      JSON.stringify(PROFILE_FIXTURE),
    );

    // duplicate name in the same workspace → the taxonomy's duplicate
    const dup = await env.client.request({
      id: "dup",
      op: "nova_profile_create",
      args: { workspace_id: env.wsId, file_path: src },
    });
    assert.equal(dup["ok"], false);
    assert.equal(dup["error"]["code"], "duplicate");

    // an invalid file (§4.2 violation) → schema_invalid, nothing persisted
    const badSrc = writeProfileFile(env, { model: "" }, "bad-profile.json");
    const bad = await env.client.request({
      id: "bad",
      op: "nova_profile_create",
      args: { workspace_id: env.wsId, file_path: badSrc },
    });
    assert.equal(bad["ok"], false);
    assert.equal(bad["error"]["code"], "schema_invalid");

    // an unreadable file → schema_invalid naming the path
    const missing = await env.client.request({
      id: "miss",
      op: "nova_profile_create",
      args: { workspace_id: env.wsId, file_path: join(env.dir, "nope.json") },
    });
    assert.equal(missing["error"]["code"], "schema_invalid");

    // global profiles (workspace_id omitted): workspace_id NULL
    const globalSrc = writeProfileFile(env, { name: "global-helper" }, "global-profile.json");
    const glob = await env.client.request({
      id: "glob",
      op: "nova_profile_create",
      args: { file_path: globalSrc },
    });
    assert.equal(glob["ok"], true, JSON.stringify(glob));
    assert.equal((glob["data"] as { profile: Record<string, unknown> }).profile["workspace_id"], null);
    assert.equal((glob["data"] as { canonical_path?: string }).canonical_path, null);

    // an unknown workspace → not_found
    const wsMissing = await env.client.request({
      id: "wsm",
      op: "nova_profile_create",
      args: { workspace_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS", file_path: src },
    });
    assert.equal(wsMissing["error"]["code"], "not_found");

    const ro = readConnection(env.dbPath);
    assert.equal((ro.prepare("SELECT COUNT(*) AS n FROM agent_profiles").get() as { n: number }).n, 2);
    ro.close();
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_list with workspace_id: the workspace's profiles plus globals (the resolution universe)", async () => {
  const env = await boot();
  try {
    const local = writeProfileFile(env, undefined, "local.json");
    const globalSrc = writeProfileFile(env, { name: "global-helper" }, "global.json");
    await env.client.request({ id: "p1", op: "nova_profile_create", args: { workspace_id: env.wsId, file_path: local } });
    await env.client.request({ id: "p2", op: "nova_profile_create", args: { file_path: globalSrc } });

    const scoped = await env.client.request({
      id: "pl",
      op: "nova_profile_list",
      args: { workspace_id: env.wsId },
    });
    const names = ((scoped["data"] as { profiles: Array<Record<string, unknown>> }).profiles)
      .map((x) => x["name"])
      .sort();
    assert.deepEqual(names, ["dev", "global-helper"]);

    // unknown workspace → not_found
    const missing = await env.client.request({
      id: "pl2",
      op: "nova_profile_list",
      args: { workspace_id: "01HJ8Z9X01ABCDEFGHJKMNPQRS" },
    });
    assert.equal(missing["error"]["code"], "not_found");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------- task identifier resolution (srs 4.1.1) ------------------------- */

test("nova_task_resolve: ULID direct, tsk_ display form, key within the workspace, ambiguity refused", async () => {
  const env = await boot();
  try {
    const profileFile = writeProfileFile(env);
    await env.client.request({ id: "prof", op: "nova_profile_create", args: { workspace_id: env.wsId, file_path: profileFile } });
    // two projects in the workspace, each with a task key
    const ids: string[] = [];
    for (const slug of ["prj-a", "prj-b"]) {
      const pc = await env.client.request({
        id: `pc-${slug}`,
        op: "nova_project_create",
        args: { workspace_id: env.wsId, name: slug, objective: "o" },
      });
      const projectId = (pc["data"] as { project: { id: string } }).project["id"];
      const t = await env.client.request({
        id: `t-${slug}`,
        op: "nova_task_create",
        args: { project_id: projectId, key: "TASK-1", title: "t", objective: "o", profile_name: "dev" },
      });
      ids.push((t["data"] as { task: { id: string } }).task["id"]);
    }

    // the bare ULID resolves directly — no workspace context needed
    const byUlid = await env.client.request({
      id: "r1",
      op: "nova_task_resolve",
      args: { ident: ids[0]! },
    });
    assert.equal(byUlid["ok"], true, JSON.stringify(byUlid));
    assert.equal(((byUlid["data"] as { task: Record<string, unknown> }).task)["id"], ids[0]!);

    // the tsk_ display form is accepted (data 5.1)
    const byDisplay = await env.client.request({
      id: "r2",
      op: "nova_task_resolve",
      args: { ident: `tsk_${ids[0]!}` },
    });
    assert.equal(byDisplay["ok"], true);

    // the human key resolves within the workspace context
    const byKey = await env.client.request({
      id: "r3",
      op: "nova_task_resolve",
      args: { ident: "TASK-1", workspace_id: env.wsId },
    });
    assert.equal(byKey["ok"], false); // ambiguous: two projects carry TASK-1
    assert.equal(byKey["error"]["code"], "duplicate");
    assert.match(String(byKey["error"]["message"]), /TASK-1/);

    // an unambiguous key resolves to its task
    const t2 = await env.client.request({
      id: "t2",
      op: "nova_task_create",
      args: {
        project_id: (readConnection(env.dbPath).prepare("SELECT id FROM projects WHERE slug = 'prj-a'").get() as { id: string }).id,
        key: "TASK-2",
        title: "t",
        objective: "o",
        profile_name: "dev",
      },
    });
    assert.equal(t2["ok"], true, JSON.stringify(t2));
    const byKey2 = await env.client.request({
      id: "r4",
      op: "nova_task_resolve",
      args: { ident: "TASK-2", workspace_id: env.wsId },
    });
    assert.equal(byKey2["ok"], true);
    assert.equal(((byKey2["data"] as { task: Record<string, unknown> }).task)["key"], "TASK-2");

    // an unknown key → not_found; a key with no workspace context → schema_invalid
    const noKey = await env.client.request({
      id: "r5",
      op: "nova_task_resolve",
      args: { ident: "TASK-404", workspace_id: env.wsId },
    });
    assert.equal(noKey["error"]["code"], "not_found");
    const noWs = await env.client.request({ id: "r6", op: "nova_task_resolve", args: { ident: "TASK-1" } });
    assert.equal(noWs["error"]["code"], "schema_invalid");
  } finally {
    await shutdown(env);
  }
});
