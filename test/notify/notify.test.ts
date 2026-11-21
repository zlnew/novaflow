import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid } from "../../src/store/ids.ts";
import {
  notifyHalt,
  taskHaltNotifier,
  DEFAULT_NTFY_BASE_URL,
  type PostFn,
} from "../../src/notify.ts";

/**
 * ntfy ops alerts (architecture 3.1 Notification Channel, RSK-07):
 * HTTPS POST with a JSON payload; fire-and-forget; a failed notify NEVER
 * fails engine work. Base URL and transport are injectable for tests.
 */

const ALERT = { title: "NovaFlow task failed", message: "task abc failed engine validation" };

test("notifyHalt POSTs a JSON payload to <base>/<topic> and reports ok", async () => {
  const posts: Array<{ url: string; body: string }> = [];
  const post: PostFn = async (url, body) => {
    posts.push({ url, body });
  };
  const res = await withBound(
    testSignal(),
    5000,
    notifyHalt("ops-halts", ALERT, {
      baseUrl: "https://ntfy.example.com/",
      post,
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.url, "https://ntfy.example.com/ops-halts");
  assert.equal(posts.length, 1);
  const sent = JSON.parse(posts[0]!.body) as Record<string, unknown>;
  assert.equal(sent["topic"], "ops-halts");
  assert.equal(sent["title"], ALERT.title);
  assert.equal(sent["message"], ALERT.message);
});

test("a baseUrl without a trailing slash is normalized", async () => {
  const posts: Array<{ url: string; body: string }> = [];
  const post: PostFn = async (url, body) => {
    posts.push({ url, body });
  };
  const res = await notifyHalt("t", ALERT, { baseUrl: "https://ntfy.internal", post });
  assert.equal(res.ok, true);
  assert.equal(posts[0]?.url, "https://ntfy.internal/t");
});

test("the default base URL is ntfy.sh (spec-silent, documented in-code)", () => {
  assert.equal(DEFAULT_NTFY_BASE_URL, "https://ntfy.sh/");
});

test("a throwing transport is swallowed into a not-ok result — never an exception", async () => {
  const post: PostFn = async () => {
    throw new Error("boom: connection refused");
  };
  const res = await notifyHalt("ops-halts", ALERT, { post });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /boom/);
});

test("a rejecting (async) transport is swallowed the same way", async () => {
  const post: PostFn = async () => {
    return Promise.reject(new Error("dns broke"));
  };
  const res = await notifyHalt("ops-halts", ALERT, { post });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /dns broke/);
});

test("a transport that never settles is bounded by the notify timeout — never hangs", async () => {
  const post: PostFn = () =>
    new Promise<void>(() => {
      /* never settles */
    });
  const res = await withBound(
    testSignal(),
    5000,
    notifyHalt("ops-halts", ALERT, { post, timeoutMs: 100 }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /100 ms/);
});

test("an empty topic dispatches nothing and reports not-ok", async () => {
  let called = 0;
  const post: PostFn = async () => {
    called++;
  };
  const res = await notifyHalt("", ALERT, { post });
  assert.equal(res.ok, false);
  assert.equal(called, 0);
});

/* ------------------------------ the task-level wiring ---------------------------- */

type Seed = { db: Database.Database; taskId: string; wsRoot: string };

function seedTask(): Seed {
  const wsRoot = mkdtempSync(join(tmpdir(), "novaflow-notify-"));
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
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run(taskId, projectId, profileId);
  return { db, taskId, wsRoot };
}

test("taskHaltNotifier: no workspace config → no notifier (alerts are opt-in)", () => {
  const s = seedTask();
  try {
    assert.equal(taskHaltNotifier(s.db, s.taskId), null);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("taskHaltNotifier: alerts.ntfy_topic in the workspace config yields a posting notifier", async () => {
  const s = seedTask();
  const posts: Array<{ url: string; body: string }> = [];
  try {
    mkdirSync(join(s.wsRoot, ".novaflow"), { recursive: true });
    writeFileSync(
      join(s.wsRoot, ".novaflow", "config.yaml"),
      "alerts:\n  ntfy_topic: ops-alerts\n",
    );
    const notifier = taskHaltNotifier(s.db, s.taskId, {
      post: async (url, body) => {
        posts.push({ url, body });
      },
    });
    assert.ok(notifier, "notifier must exist when the topic is configured");
    const res = await notifier(ALERT);
    assert.equal(res.ok, true);
    assert.match(posts[0]?.url ?? "", /ops-alerts$/);
    assert.equal(posts[0]?.body.includes("task failed"), true);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

test("taskHaltNotifier: a broken config.yaml yields no notifier (best-effort, never a crash)", () => {
  const s = seedTask();
  try {
    mkdirSync(join(s.wsRoot, ".novaflow"), { recursive: true });
    writeFileSync(join(s.wsRoot, ".novaflow", "config.yaml"), "alerts:\n  ntfy_topic: [not, a, string]\n");
    assert.equal(taskHaltNotifier(s.db, s.taskId), null);
  } finally {
    s.db.close();
    rmSync(s.wsRoot, { recursive: true, force: true });
  }
});

/** A plain AbortSignal stand-in helper (node:test exposes one per test). */
function testSignal(): AbortSignal {
  return AbortSignal.timeout(5000);
}
