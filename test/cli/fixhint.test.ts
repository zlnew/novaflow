import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import { enqueueTask } from "../../src/tasks.ts";
import { validateChainGraph } from "../../src/chain/graph.ts";
import { inertPricesNote } from "../../src/runs/prices.ts";
import { FIX_HINT_SEPARATOR, hasFixHint, withFixHint } from "../../src/fixhint.ts";

/**
 * R4.3: every error names the fix. The convention is one marker
 * (` — fix: `, src/fixhint.ts) and, in P12, three refusals that carry it: the
 * graph-import schema_invalid family, the DEBT-010 unscoped-run refusal, and
 * the inert-prices note. Each is asserted through the REAL code path here
 * (the validator, the guarded enqueue, the note builder) — and the two
 * negative assertions pin that the marker is for refusals, not sprinkled on
 * every string.
 */

function seededDb(): { db: Database.Database; workspaceId: string; projectId: string; profileId: string } {
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
  return { db, workspaceId, projectId, profileId };
}

test("withFixHint appends the operator's next move once, and hasFixHint is the audit's only test", () => {
  const hinted = withFixHint("task is unscoped", "add a scope");
  assert.equal(hinted, `task is unscoped${FIX_HINT_SEPARATOR}add a scope`);
  assert.equal(withFixHint(hinted, "another move"), hinted, "a second hint never stacks");
  assert.equal(hasFixHint(hinted), true);
  assert.equal(hasFixHint("task is unscoped"), false);
  assert.equal(FIX_HINT_SEPARATOR, " — fix: ");
});

test("the DEBT-010 unscoped-run refusal names the fix and leaves the task draft, unlogged", async () => {
  const { db, projectId, profileId } = seededDb();
  const taskId = ulid();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'K1', 'K1', 'o', ?)",
  ).run(taskId, projectId, profileId);

  await assert.rejects(
    () => enqueueTask(db, taskId, "operator", {}),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "schema_invalid");
      assert.match(err.message, /no target_scopes/, "the refusal still names the mechanism");
      assert.ok(hasFixHint(err.message), `no fix hint:\n${err.message}`);
      assert.match(err.message, /--scope <repo_alias>/, "the fix names the CLI flag");
      assert.match(err.message, /nova task run/, "the fix names the command to re-run");
      return true;
    },
  );
  // the refused enqueue wrote nothing: the task is still draft, no log row
  assert.equal((db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state, "draft");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM state_transition_logs").get() as { n: number }).n, 0);
});

/** Run `fn` and return the error it threw (assert.throws discards it). */
function captureError(fn: () => unknown): Error & { code: string } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code: string };
  }
  throw new Error("expected the call to throw");
}

test("every graph-import schema_invalid refusal names the fix; a non-schema refusal does not", () => {
  const { db, workspaceId } = seededDb();

  const missingKey = captureError(() =>
    validateChainGraph(db, workspaceId, { version: "1.0.0", tasks: [] }),
  );
  assert.equal(missingKey.code, "schema_invalid");
  assert.match(missingKey.message, /project_slug/, "the refusal names the missing key");
  assert.ok(hasFixHint(missingKey.message), `no fix hint:\n${missingKey.message}`);
  assert.match(missingKey.message, /nova project import-dag/, "the fix names the command to re-run");

  const notAnObject = captureError(() => validateChainGraph(db, workspaceId, [1, 2]));
  assert.equal(notAnObject.code, "schema_invalid");
  assert.ok(hasFixHint(notAnObject.message), `no fix hint:\n${notAnObject.message}`);

  // a refusal that is NOT a schema rejection keeps its own message: the
  // marker marks a fix, not a style
  const unknownProfile = captureError(() =>
    validateChainGraph(db, workspaceId, {
      version: "1.0.0",
      project_slug: "prj",
      tasks: [
        {
          key: "A",
          title: "Task A",
          objective: "The objective of task A.",
          profile_name: "nope",
          target_scopes: [{ repo_alias: "code", access_mode: "read_write" }],
        },
      ],
      edges: [],
    }),
  );
  assert.notEqual(unknownProfile.code, "schema_invalid");
  assert.equal(hasFixHint(unknownProfile.message), false, "only schema refusals carry the import fix");
});

test("the inert-prices note names the price file to write and the command to re-run", () => {
  const missing = inertPricesNote("missing", "/tmp/op/prices.json");
  assert.match(missing, /^prices\.json missing — cost budget enforcement inert/);
  assert.ok(hasFixHint(missing));
  assert.ok(missing.includes("/tmp/op/prices.json"), "the fix names the exact path to write");
  assert.match(missing, /cacheRead/);
  assert.match(missing, /nova task retry/);

  const invalid = inertPricesNote("invalid", "/tmp/op/prices.json");
  assert.match(invalid, /^prices\.json unparseable/);
  assert.ok(hasFixHint(invalid));

  // an armed table never produces the note (the default path is used when none is given)
  assert.match(inertPricesNote("missing"), / — fix: .*prices\.json/);
});
