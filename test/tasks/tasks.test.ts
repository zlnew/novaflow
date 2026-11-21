import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openDb } from "../../src/store/db.ts";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl, extractMatrix } from "../helpers/spec.ts";
import { withBound } from "../helpers/bound.ts";
import { ulid, isUlid } from "../../src/store/ids.ts";
import { ProfileValidationError } from "../../src/profiles.ts";
import { ProfileUnresolvedError } from "../../src/catalog.ts";
import { InvalidTransitionError } from "../../src/fsm/engine.ts";
import {
  createTask,
  enqueueTask,
  getTask,
  listTasks,
  ENQUEUE_TRIGGER,
} from "../../src/tasks.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "pi-stub.ts");
const BOUND_MS = 8000;

/** In-memory store seeded per the novaflow-v1/data DDL: workspace, project, profile. */
function seededDb(overrides: { toolsAllowlistJson?: string } = {}) {
  const db = new Database(":memory:");
  db.exec(extractDdl());
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, ?, ?)",
  ).run(ulid(), "ws", "ws", "/tmp/ws");
  const workspaceId = (db.prepare("SELECT id AS id FROM workspaces").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), workspaceId, "prj", "prj", "o");
  const projectId = (db.prepare("SELECT id AS id FROM projects").get() as { id: string }).id;
  db.prepare(
    `INSERT INTO agent_profiles
       (id, workspace_id, name, provider, model, system_prompt_path, tools_allowlist_json)
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022',
             'prompts/dev_system.md', ?)`,
  ).run(ulid(), overrides.toolsAllowlistJson ?? '["read","bash"]');
  const profileId = (db.prepare("SELECT id AS id FROM agent_profiles").get() as { id: string }).id;
  return { db, projectId, profileId };
}

function logCount(db: Database.Database, taskId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS n FROM state_transition_logs WHERE task_id = ?")
    .get(taskId) as { n: number }).n;
}

test("createTask inserts a draft row with a ULID id and the DDL defaults", () => {
  const { db, projectId, profileId } = seededDb();
  try {
    const row = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "Implement PKCE",
      objective: "Implement PKCE code challenge verification",
      profileId,
    });
    assert.ok(isUlid(row.id));
    assert.equal(row.project_id, projectId);
    assert.equal(row.key, "TASK-101");
    assert.equal(row.profile_id, profileId);
    assert.equal(row.state, "draft");
    assert.equal(row.priority, 3);
    assert.equal(row.max_retries, 3);
    assert.equal(row.retry_count, 0);
    assert.equal(row.requires_human_gate, 0);
    assert.equal(row.side_effect_class, "pure_code");
    assert.equal(row.output_schema_version, "1.0.0");
    assert.deepEqual(JSON.parse(row.context_files_json), []);
    assert.equal(row.chain_run_id, null);
    assert.equal(logCount(db, row.id), 0);
  } finally {
    db.close();
  }
});

test("createTask accepts optional priority, gate flag, and context files", () => {
  const { db, projectId, profileId } = seededDb();
  try {
    const row = createTask(db, {
      projectId,
      key: "TASK-102",
      title: "Gate task",
      objective: "A task that requires a human gate",
      profileId,
      priority: 2,
      requiresHumanGate: true,
      contextFiles: ["docs/spec.md"],
    });
    assert.equal(row.priority, 2);
    assert.equal(row.requires_human_gate, 1);
    assert.deepEqual(JSON.parse(row.context_files_json), ["docs/spec.md"]);
  } finally {
    db.close();
  }
});

test("createTask enforces UNIQUE(project_id, key)", () => {
  const { db, projectId, profileId } = seededDb();
  try {
    const input = {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    };
    createTask(db, input);
    assert.throws(() => createTask(db, input), /UNIQUE/);
  } finally {
    db.close();
  }
});

test("getTask returns the row or undefined", () => {
  const { db, projectId, profileId } = seededDb();
  try {
    const row = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    });
    assert.equal(getTask(db, row.id)?.key, "TASK-101");
    assert.equal(getTask(db, "01HJ8ZABC0NONEXISTENT0000000"), undefined);
  } finally {
    db.close();
  }
});

test("listTasks filters by project and orders by ULID creation order", () => {
  const { db, projectId, profileId } = seededDb();
  try {
    const otherProjectId = ulid();
    db.prepare(
      "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, 'other', 'other', 'o')",
    ).run(otherProjectId, (db.prepare("SELECT id AS id FROM workspaces").get() as { id: string }).id);

    const a = createTask(db, { projectId, key: "A", title: "t", objective: "o", profileId });
    const b = createTask(db, { projectId, key: "B", title: "t", objective: "o", profileId });
    const c = createTask(db, { projectId: otherProjectId, key: "C", title: "t", objective: "o", profileId });

    const inProject = listTasks(db, projectId);
    assert.deepEqual(inProject.map((r) => r.key), ["A", "B"]);
    assert.ok(a.id < b.id, "ULID order is creation order");

    const all = listTasks(db);
    assert.deepEqual(all.map((r) => r.key).sort(), ["A", "B", "C"]);
    assert.ok(c.id !== a.id);
  } finally {
    db.close();
  }
});

test("golden: ENQUEUE_TRIGGER is the verbatim 8.1 draft→queued trigger", () => {
  const rows = extractMatrix().filter(
    (r) => r.state === "draft" && r.target === "queued",
  );
  assert.equal(rows.length, 1);
  assert.equal(ENQUEUE_TRIGGER, rows[0]?.trigger);
  assert.equal(
    ENQUEUE_TRIGGER,
    "operator/agent enqueues (CLI `task run`, MCP `nova_task_run`)",
  );
});

test("enqueueTask: resolvable profile → draft becomes queued with one audit log row", async (t) => {
  const { db, projectId, profileId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    const task = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    });
    const pidfile = join(dir, "stub.pid");
    const row = await withBound(
      t.signal,
      BOUND_MS,
      enqueueTask(db, task.id, "maul", {
        piBin: "node",
        args: [STUB, "ok", pidfile],
        timeoutMs: 5000,
      }),
    );
    assert.equal(row.state, "queued");
    assert.equal(getTask(db, task.id)?.state, "queued");

    const logs = db
      .prepare("SELECT * FROM state_transition_logs WHERE task_id = ?")
      .all(task.id) as Array<Record<string, unknown>>;
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.["from_state"], "draft");
    assert.equal(logs[0]?.["to_state"], "queued");
    assert.equal(logs[0]?.["trigger_type"], "human");
    assert.equal(logs[0]?.["actor"], "maul");

    // The catalog handshake really ran: the stub child was spawned and
    // SIGTERMed per the 8.1 mechanism.
    assert.match(readFileSync(pidfile, "utf8"), /SIGTERM/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueTask: profile_unresolved leaves the task in draft with no log row", async (t) => {
  const { db, projectId, profileId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    const task = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    });
    const pidfile = join(dir, "stub.pid");
    await assert.rejects(
      withBound(
        t.signal,
        BOUND_MS,
        enqueueTask(db, task.id, "maul", {
          piBin: "node",
          args: [STUB, "silent", pidfile],
          timeoutMs: 300,
        }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProfileUnresolvedError, String(err));
        assert.equal(err.code, "profile_unresolved");
        return true;
      },
    );
    assert.equal(getTask(db, task.id)?.state, "draft");
    assert.equal(logCount(db, task.id), 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueTask: an invalid stored profile row is rejected before any transition", async (t) => {
  const { db, projectId, profileId } = seededDb({ toolsAllowlistJson: '[42]' });
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    const task = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    });
    const pidfile = join(dir, "stub.pid");
    await assert.rejects(
      withBound(
        t.signal,
        BOUND_MS,
        enqueueTask(db, task.id, "maul", {
          piBin: "node",
          args: [STUB, "ok", pidfile],
          timeoutMs: 5000,
        }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProfileValidationError, String(err));
        assert.equal(err.key, "tools_allowlist");
        return true;
      },
    );
    assert.equal(getTask(db, task.id)?.state, "draft");
    assert.equal(logCount(db, task.id), 0);
    // No probe was spent on a row that already failed validation: the
    // stub was never spawned, so no pidfile exists.
    assert.equal(existsSync(pidfile), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueTask: unknown task id throws", async (t) => {
  const { db } = seededDb();
  try {
    await assert.rejects(
      withBound(
        t.signal,
        BOUND_MS,
        enqueueTask(db, "01HJ8ZABC0NONEXISTENT0000000", "maul"),
      ),
      /no such task/,
    );
  } finally {
    db.close();
  }
});

test("enqueueTask: an already-queued task refuses a second enqueue (matrix guard)", async (t) => {
  const { db, projectId, profileId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    const task = createTask(db, {
      projectId,
      key: "TASK-101",
      title: "t",
      objective: "o",
      profileId,
    });
    const opts = {
      piBin: "node",
      args: [STUB, "ok", join(dir, "stub.pid")],
      timeoutMs: 5000,
    };
    await withBound(t.signal, BOUND_MS, enqueueTask(db, task.id, "maul", opts));
    await assert.rejects(
      withBound(t.signal, BOUND_MS, enqueueTask(db, task.id, "maul", opts)),
      InvalidTransitionError,
    );
    assert.equal(getTask(db, task.id)?.state, "queued");
    assert.equal(logCount(db, task.id), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FK discipline: createTask with a bogus profile id is rejected under openDb's foreign_keys=ON", () => {
  const db = openDb(":memory:"); // the real boot path, not a bare sqlite handle
  db.exec(extractDdl());
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, root_path) VALUES (?, ?, ?, ?)",
  ).run(ulid(), "ws", "ws", "/tmp/ws");
  db.prepare(
    "INSERT INTO projects (id, workspace_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), db.prepare("SELECT id FROM workspaces").get()?.["id"], "prj", "prj", "o");
  assert.throws(
    () =>
      createTask(db, {
        projectId: db.prepare("SELECT id FROM projects").get()?.["id"] as string,
        key: "TASK-FK",
        title: "t",
        objective: "o",
        profileId: ulid(), // not in agent_profiles
      }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /FOREIGN KEY constraint failed/i.test(msg);
    },
    "tasks.profile_id FK (ON DELETE RESTRICT) must be enforced",
  );
  db.close();
});

test("enqueueTask: triggerType surfaces are logged (human default, mcp for nova_task_run)", async (t) => {
  const { db, projectId, profileId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    for (const [i, triggerType] of [
      [0, "human"],
      [1, "mcp"],
    ] as const) {
      const task = createTask(db, {
        projectId,
        key: `TASK-SURF-${i}`,
        title: "t",
        objective: "o",
        profileId,
      });
      await enqueueTask(db, task.id, "operator", {
        piBin: "node",
        args: [STUB, "ok"],
        triggerType,
      });
      const log = db
        .prepare("SELECT trigger_type FROM state_transition_logs WHERE task_id = ?")
        .get(task.id) as { trigger_type: string };
      assert.equal(log.trigger_type, triggerType);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueTask: the matrix guard runs BEFORE the catalog probe — a non-draft task is refused without spawning pi", async () => {
  const { db, projectId, profileId } = seededDb();
  const dir = mkdtempSync(join(tmpdir(), "novaflow-tasks-"));
  try {
    const task = createTask(db, {
      projectId,
      key: "TASK-GUARD",
      title: "t",
      objective: "o",
      profileId,
    });
    await enqueueTask(db, task.id, "operator", {
      piBin: "node",
      args: [STUB, "ok"],
    }); // draft -> queued
    // Second enqueue: the FSM refuses first; a nonexistent piBin proves no
    // subprocess was ever spent (an unspawnable binary would surface as
    // ProfileUnresolvedError instead of the FSM's InvalidTransitionError).
    await assert.rejects(
      enqueueTask(db, task.id, "operator", { piBin: "/nonexistent/pi-binary" }),
      (err: unknown) => err instanceof InvalidTransitionError,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
