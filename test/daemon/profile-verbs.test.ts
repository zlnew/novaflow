import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient } from "./client.ts";
import { readConnection } from "./seed.ts";

/**
 * DEBT-008 (v0.2.0 P5): the profile LIFECYCLE verbs over the real control
 * server — `nova_profile_update` and `nova_profile_delete`.
 *
 * The contract under test (the card's deviation from the frozen roadmap:
 * there is no archived column, so the verbs are update + delete):
 *   - update validates with the SAME §4.2 validator and the SAME live
 *     catalog probe the enqueue gate spends, refuses a file whose `name`
 *     differs from `<name>`, and rewrites the row + the canonical file in
 *     one transaction;
 *   - update of an unchanged profile is refused as `duplicate` ("no
 *     change") and writes nothing;
 *   - delete is FK-safe by an EXPLICIT count: a pinned profile is refused
 *     naming the count and is never deleted; an unpinned one loses its row
 *     AND its canonical file;
 *   - both resolve scope exactly as the engine does (workspace-scoped row
 *     wins over a global row of the same name) and REPORT the scope acted
 *     on.
 */

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const OLD_MODEL = "claude-3-5-sonnet-20241022";
const NEW_MODEL = "claude-3-7-sonnet-20250219";

type Env = {
  dir: string;
  dbPath: string;
  handle: DaemonHandle;
  client: TestClient;
  wsId: string;
  wsRoot: string;
};

/** Boot the real daemon; `probeMode` is the pi-stub get_state behavior. */
async function boot(probeMode = "ok"): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-plc-"));
  const dbPath = join(dir, "state.db");
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  const handle = await startDaemon({
    dbPath,
    socketPath: join(dir, "novaflow.sock"),
    daemonConfigPath: join(dir, "cfg.yaml"),
    probePiBin: "node",
    probeArgs: [STUB, probeMode],
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

const DEV = {
  name: "dev",
  provider: "anthropic",
  model: OLD_MODEL,
  thinking_level: "medium",
  system_prompt_path: "prompts/dev_system.md",
  tools_allowlist: ["bash", "read"],
  limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
};

type ProfileDoc = typeof DEV & { role?: string };

function writeProfile(env: Env, doc: Record<string, unknown>, file: string): string {
  const path = join(env.dir, file);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

function canonical(env: Env, name: string): string {
  return join(env.wsRoot, ".novaflow", "profiles", `${name}.json`);
}

async function ok(
  env: Env,
  id: string,
  op: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await env.client.request({ id, op, args });
  assert.equal(res["ok"], true, `${op}: ${JSON.stringify(res)}`);
  return res["data"] as Record<string, unknown>;
}

async function fail(
  env: Env,
  id: string,
  op: string,
  args: Record<string, unknown>,
): Promise<{ code: string; message: string }> {
  const res = await env.client.request({ id, op, args });
  assert.equal(res["ok"], false, `${op} must refuse: ${JSON.stringify(res)}`);
  return res["error"] as { code: string; message: string };
}

/** Create the workspace-scoped fixture profile through the real create op. */
async function seedProfile(env: Env, doc: Record<string, unknown> = DEV, file = "create.json"): Promise<void> {
  const src = writeProfile(env, doc, file);
  await ok(env, `create-${String(doc["name"])}`, "nova_profile_create", {
    workspace_id: env.wsId,
    file_path: src,
  });
}

/** Freeze a file's mtime to a sentinel so any rewrite is detectable. */
function pinMtime(path: string): number {
  utimesSync(path, 1_600_000_000, 1_600_000_000);
  return statSync(path).mtimeMs;
}

function profileRow(
  env: Env,
  name: string,
  workspaceId: string | null = env.wsId,
): Record<string, unknown> | undefined {
  const ro = readConnection(env.dbPath);
  try {
    return ro
      .prepare("SELECT * FROM agent_profiles WHERE name = ? AND workspace_id IS ?")
      .get(name, workspaceId) as Record<string, unknown> | undefined;
  } finally {
    ro.close();
  }
}

/* ---------------------------------- update ---------------------------------- */

test("nova_profile_update: row + canonical file rewritten together, the old model gone from both", async () => {
  const env = await boot();
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    assert.ok(existsSync(file), "create wrote the canonical copy");
    assert.match(readFileSync(file, "utf8"), new RegExp(OLD_MODEL));

    const next: ProfileDoc = {
      ...DEV,
      model: NEW_MODEL,
      thinking_level: "high",
      role: "reviewer",
      tools_allowlist: ["read", "grep"],
      limits: { max_timeout_sec: 900, max_cost_usd: 1.25 },
    };
    const data = await ok(env, "upd", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: next,
    });

    // the answer reports the scope it acted on and the canonical home
    assert.equal(data["scope"], "workspace");
    assert.equal(data["workspace_id"], env.wsId);
    assert.equal(data["canonical_path"], file);
    assert.equal(data["changed"], true);
    const answered = data["profile"] as Record<string, unknown>;
    assert.equal(answered["model"], NEW_MODEL);

    // the canonical file: the rewritten document, old model GONE
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(OLD_MODEL), "the old model must leave the canonical file");
    assert.equal(
      text,
      JSON.stringify(next, null, 2) + "\n",
      "the canonical file carries the operator's document, pretty-printed",
    );

    // the row: every §4.2 column moved, old model GONE
    const row = profileRow(env, "dev")!;
    assert.equal(row["model"], NEW_MODEL);
    assert.equal(row["thinking_level"], "high");
    assert.equal(row["role"], "reviewer");
    assert.deepEqual(JSON.parse(String(row["tools_allowlist_json"])), ["read", "grep"]);
    assert.equal(row["system_prompt_path"], "prompts/dev_system.md");
    assert.equal(row["max_timeout_sec"], 900);
    assert.equal(row["max_cost_usd"], 1.25);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(OLD_MODEL));

    // /list and /validate still see the ONE updated profile
    const listed = await ok(env, "list", "nova_profile_list", { workspace_id: env.wsId });
    const profiles = listed["profiles"] as Array<Record<string, unknown>>;
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!["model"], NEW_MODEL);
    await ok(env, "val", "nova_profile_validate", { profile_id: row["id"] });
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_update refuses a file whose name differs from <name> — nothing written", async () => {
  const env = await boot();
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    const marker = pinMtime(file);
    const contentBefore = readFileSync(file, "utf8");
    const rowBefore = profileRow(env, "dev");

    const err = await fail(env, "rename", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: { ...DEV, name: "other", model: NEW_MODEL },
    });
    assert.equal(err.code, "schema_invalid");
    assert.match(err.message, /renaming is not an update/);
    assert.match(err.message, /"other"/);
    assert.match(err.message, /"dev"/);

    // NOTHING was written: neither the row nor the canonical file
    assert.equal(statSync(file).mtimeMs, marker, "the canonical file must not be touched");
    assert.equal(readFileSync(file, "utf8"), contentBefore);
    assert.deepEqual(profileRow(env, "dev"), rowBefore);
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_update refuses an invalid §4.2 profile — nothing written", async () => {
  const env = await boot();
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    const marker = pinMtime(file);
    const rowBefore = profileRow(env, "dev");

    // duplicate tools_allowlist entries (schema uniqueItems: true)
    const dupTools = await fail(env, "duptools", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: { ...DEV, tools_allowlist: ["read", "read"] },
    });
    assert.equal(dupTools.code, "schema_invalid");
    assert.match(dupTools.message, /unique/);

    // out-of-bounds limits.max_timeout_sec (schema: integer >= 1)
    const badLimit = await fail(env, "badlimit", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: { ...DEV, limits: { max_timeout_sec: 0, max_cost_usd: 5 } },
    });
    assert.equal(badLimit.code, "schema_invalid");
    assert.match(badLimit.message, /max_timeout_sec/);

    // a missing required key (§4.2 `required`)
    const missing = await fail(env, "missing", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: { name: "dev", provider: "anthropic", model: NEW_MODEL },
    });
    assert.equal(missing.code, "schema_invalid");
    assert.match(missing.message, /missing required key/);

    assert.equal(statSync(file).mtimeMs, marker);
    assert.deepEqual(profileRow(env, "dev"), rowBefore);
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_update refuses an unresolvable model (the live catalog probe) — nothing written", async () => {
  // this daemon's probe never produces a response frame (the pi-stub
  // "garbage" mode) — exactly the architecture 8.1 rejection
  const env = await boot("garbage");
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    const marker = pinMtime(file);
    const rowBefore = profileRow(env, "dev");

    const err = await fail(env, "unresolved", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: { ...DEV, model: "no-such-model-9" },
    });
    // the catalog probe's own code (the enqueue gate's rejection)
    assert.equal(err.code, "profile_unresolved");

    assert.equal(statSync(file).mtimeMs, marker, "the canonical file must not be touched");
    assert.deepEqual(profileRow(env, "dev"), rowBefore);
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_update of an unchanged profile is refused as duplicate (“no change”) and writes nothing", async () => {
  const env = await boot();
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    const marker = pinMtime(file);
    const rowBefore = profileRow(env, "dev");

    // the very same document the profile was created from
    const err = await fail(env, "nochange", "nova_profile_update", {
      name: "dev",
      workspace_id: env.wsId,
      profile: DEV,
    });
    assert.equal(err.code, "duplicate");
    assert.match(err.message, /no change/);
    assert.match(err.message, /"dev"/);

    assert.equal(statSync(file).mtimeMs, marker, "an unchanged update must not rewrite the file");
    assert.deepEqual(profileRow(env, "dev"), rowBefore);
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_update of a missing profile is not_found", async () => {
  const env = await boot();
  try {
    const err = await fail(env, "ghost", "nova_profile_update", {
      name: "ghost",
      workspace_id: env.wsId,
      profile: { ...DEV, name: "ghost" },
    });
    assert.equal(err.code, "not_found");
    assert.match(err.message, /ghost/);
    assert.ok(!existsSync(canonical(env, "ghost")));
  } finally {
    await shutdown(env);
  }
});

/* ---------------------------------- delete ---------------------------------- */

test("nova_profile_delete refuses a profile pinned by tasks, naming the count — nothing deleted", async () => {
  const env = await boot();
  try {
    await seedProfile(env);
    const file = canonical(env, "dev");
    const row = profileRow(env, "dev");
    const project = await ok(env, "prj", "nova_project_create", {
      workspace_id: env.wsId,
      name: "app",
      objective: "Ship it.",
    });
    const projectId = (project["project"] as Record<string, unknown>)["id"];
    for (const key of ["TASK-1", "TASK-2"]) {
      await ok(env, `t-${key}`, "nova_task_create", {
        project_id: projectId,
        key,
        title: key,
        objective: "Do the work.",
        profile_name: "dev",
      });
    }

    const err = await fail(env, "pinned", "nova_profile_delete", {
      name: "dev",
      workspace_id: env.wsId,
    });
    assert.equal(err.code, "schema_invalid");
    assert.match(err.message, /pinned by 2 tasks/, "the refusal NAMES the pinning count");
    assert.match(err.message, /"dev"/, "the refusal names the profile");
    assert.match(err.message, /never deleted/);

    // NOTHING was deleted: the row, the canonical file and the pinning tasks
    assert.equal(profileRow(env, "dev")!["id"], row!["id"]);
    assert.ok(existsSync(file));
    const ro = readConnection(env.dbPath);
    try {
      const n = (ro.prepare("SELECT COUNT(*) AS n FROM tasks WHERE profile_id = ?").get(row!["id"]) as {
        n: number;
      }).n;
      assert.equal(n, 2);
    } finally {
      ro.close();
    }
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_delete removes an unpinned profile: the row AND the canonical file", async () => {
  const env = await boot();
  try {
    await seedProfile(env, { ...DEV, name: "spare" }, "spare.json");
    const file = canonical(env, "spare");
    assert.ok(existsSync(file));

    const data = await ok(env, "del", "nova_profile_delete", {
      name: "spare",
      workspace_id: env.wsId,
    });
    assert.equal(data["deleted"], true);
    assert.equal(data["scope"], "workspace");
    assert.equal(data["workspace_id"], env.wsId);
    assert.equal(data["canonical_path"], file);
    assert.equal(data["file_removed"], true);
    assert.equal(data["file_removal_error"], null);

    assert.equal(profileRow(env, "spare"), undefined, "the row is gone");
    assert.ok(!existsSync(file), "the canonical file is gone");

    // already deleted: not_found (never a silent success)
    const again = await fail(env, "del2", "nova_profile_delete", {
      name: "spare",
      workspace_id: env.wsId,
    });
    assert.equal(again.code, "not_found");
  } finally {
    await shutdown(env);
  }
});

test("nova_profile_delete refuses a task that pins a GLOBAL profile too (the count is scope-blind)", async () => {
  const env = await boot();
  try {
    const globalSrc = writeProfile(env, { ...DEV, name: "gdev" }, "gdev.json");
    await ok(env, "gcreate", "nova_profile_create", { file_path: globalSrc });
    const project = await ok(env, "prj", "nova_project_create", {
      workspace_id: env.wsId,
      name: "app",
      objective: "o",
    });
    await ok(env, "t", "nova_task_create", {
      project_id: (project["project"] as Record<string, unknown>)["id"],
      key: "TASK-1",
      title: "t",
      objective: "o",
      profile_name: "gdev",
    });

    const err = await fail(env, "pinned", "nova_profile_delete", { name: "gdev" });
    assert.equal(err.code, "schema_invalid");
    assert.match(err.message, /pinned by 1 task —/);
    assert.match(err.message, /\(global\)/);
    assert.equal(profileRow(env, "gdev", null)!["name"], "gdev");
  } finally {
    await shutdown(env);
  }
});

/* ------------------------- scope resolution (engine rule) ------------------------- */

test("scope resolution: the workspace-scoped row wins over a global row of the same name — and update REPORTS it", async () => {
  const env = await boot();
  try {
    const globalDoc = { ...DEV, name: "shared", model: "global-model-a", thinking_level: "low" };
    const localDoc = { ...DEV, name: "shared", model: "local-model-b", thinking_level: "low" };
    await ok(env, "g", "nova_profile_create", {
      file_path: writeProfile(env, globalDoc, "global.json"),
    });
    await ok(env, "l", "nova_profile_create", {
      workspace_id: env.wsId,
      file_path: writeProfile(env, localDoc, "local.json"),
    });
    const ro = readConnection(env.dbPath);
    const rows = ro
      .prepare("SELECT id, workspace_id FROM agent_profiles WHERE name = 'shared'")
      .all() as Array<{ id: string; workspace_id: string | null }>;
    ro.close();
    const globalRow = rows.find((r) => r.workspace_id === null)!;
    const localRow = rows.find((r) => r.workspace_id === env.wsId)!;
    assert.ok(globalRow && localRow, "both scopes carry a row of the same name");

    // workspace-scoped request → the WORKSPACE row (the engine's rule)
    const data = await ok(env, "u1", "nova_profile_update", {
      name: "shared",
      workspace_id: env.wsId,
      profile: { ...DEV, name: "shared", model: "update-c", thinking_level: "low" },
    });
    assert.equal(data["scope"], "workspace");
    assert.equal(data["workspace_id"], env.wsId);
    assert.equal((data["profile"] as Record<string, unknown>)["id"], localRow.id);
    // the canonical file belongs to the workspace row
    assert.match(readFileSync(canonical(env, "shared"), "utf8"), /update-c/);

    // the global row is untouched
    const ro2 = readConnection(env.dbPath);
    const g = ro2.prepare("SELECT model FROM agent_profiles WHERE id = ?").get(globalRow.id) as {
      model: string;
    };
    ro2.close();
    assert.equal(g.model, "global-model-a", "the shadowed global row must not move");

    // no workspace context → the GLOBAL row, reported as global
    const data2 = await ok(env, "u2", "nova_profile_update", {
      name: "shared",
      profile: { ...DEV, name: "shared", model: "update-d", thinking_level: "low" },
    });
    assert.equal(data2["scope"], "global");
    assert.equal(data2["workspace_id"], null);
    assert.equal(data2["canonical_path"], null, "a global profile has no canonical file in v1");
    const ro3 = readConnection(env.dbPath);
    assert.equal(
      (ro3.prepare("SELECT model FROM agent_profiles WHERE id = ?").get(globalRow.id) as { model: string }).model,
      "update-d",
    );
    assert.equal(
      (ro3.prepare("SELECT model FROM agent_profiles WHERE id = ?").get(localRow.id) as { model: string }).model,
      "update-c",
      "the workspace row keeps the workspace-scoped update",
    );
    ro3.close();
  } finally {
    await shutdown(env);
  }
});

test("scope resolution: delete acts on the workspace-scoped row and reports it; the global namesake survives", async () => {
  const env = await boot();
  try {
    await ok(env, "g", "nova_profile_create", {
      file_path: writeProfile(env, { ...DEV, name: "shared" }, "global.json"),
    });
    await ok(env, "l", "nova_profile_create", {
      workspace_id: env.wsId,
      file_path: writeProfile(env, { ...DEV, name: "shared" }, "local.json"),
    });
    const file = canonical(env, "shared");

    const data = await ok(env, "d", "nova_profile_delete", {
      name: "shared",
      workspace_id: env.wsId,
    });
    assert.equal(data["scope"], "workspace");
    assert.equal(data["workspace_id"], env.wsId);
    assert.equal(data["file_removed"], true);
    assert.ok(!existsSync(file));

    const ro = readConnection(env.dbPath);
    const left = ro
      .prepare("SELECT workspace_id FROM agent_profiles WHERE name = 'shared'")
      .all() as Array<{ workspace_id: string | null }>;
    ro.close();
    assert.deepEqual(left, [{ workspace_id: null }], "only the global namesake survives");

    // and it is reachable only through a global (unscoped) delete
    const g = await ok(env, "d2", "nova_profile_delete", { name: "shared" });
    assert.equal(g["scope"], "global");
    assert.equal(g["canonical_path"], null);
    assert.equal(profileRow(env, "shared", null), undefined);
  } finally {
    await shutdown(env);
  }
});

/* -------------------------------- PRESERVE pins -------------------------------- */

test("PRESERVE: nova_task_create still resolves profile_name by the engine rule (workspace-scoped over a shadowing global row)", async () => {
  // the p5 refactor moved the ORDER BY rule into src/profiles.ts; the
  // enqueue path must still pick the workspace row, never the global one
  const env = await boot();
  try {
    await seedProfile(env); // workspace-scoped "dev"
    // a STALE global namesake with the same name: the engine's rule (and
    // therefore the enqueue path) must never pick it
    await ok(env, "g", "nova_profile_create", {
      file_path: writeProfile(env, { ...DEV, name: "dev", model: "stale-global" }, "stale.json"),
    });
    const localRow = profileRow(env, "dev");
    assert.equal(localRow!["workspace_id"], env.wsId);
    const project = await ok(env, "prj", "nova_project_create", {
      workspace_id: env.wsId,
      name: "app",
      objective: "o",
    });
    const task = await ok(env, "t", "nova_task_create", {
      project_id: (project["project"] as Record<string, unknown>)["id"],
      key: "TASK-1",
      title: "t",
      objective: "o",
      profile_name: "dev",
    });
    assert.equal(
      (task["task"] as Record<string, unknown>)["profile_id"],
      localRow!["id"],
      "the workspace-scoped row must win over the stale global namesake",
    );
    assert.equal(profileRow(env, "dev")!["model"], OLD_MODEL, "the workspace row is the one seedProfile wrote");
  } finally {
    await shutdown(env);
  }
});
