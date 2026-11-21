import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDdl } from "../helpers/spec.ts";
import { ulid } from "../../src/store/ids.ts";
import {
  globMatch,
  globMatchAny,
  parseGitPorcelain,
  verifyProtectedAndScope,
  writeProtectedDigests,
  SNAPSHOT_FILENAME,
} from "../../src/verify/protected.ts";

/**
 * FR-TSK-11 AC3 + the architecture Post-Run Verifier (5.8): SHA-256
 * digests of the protected test set against the PRE-RUN snapshot, plus
 * the write-scope check over modified paths.
 */

type Seed = {
  db: Database.Database;
  taskId: string;
  projectId: string;
};

function seed(): Seed {
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
     VALUES (?, NULL, 'dev', 'anthropic', 'claude-3-5-sonnet-20241022', 'prompts/dev_system.md')`,
  ).run(ulid());
  const profileId = (db.prepare("SELECT id FROM agent_profiles").get() as { id: string }).id;
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, objective, profile_id) VALUES (?, ?, 'T-1', 't', 'o', ?)",
  ).run(ulid(), projectId, profileId);
  const taskId = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
  return { db, taskId, projectId };
}

function addTarget(
  s: Seed,
  opts: {
    alias: string;
    type?: "git_repo" | "directory";
    root: string;
    protected?: string[];
    write?: string[];
  },
): string {
  const targetId = ulid();
  s.db
    .prepare(
      "INSERT INTO project_targets (id, project_id, alias, target_type, root_path) VALUES (?, ?, ?, ?, ?)",
    )
    .run(targetId, s.projectId, opts.alias, opts.type ?? "git_repo", opts.root);
  s.db
    .prepare(
      `INSERT INTO task_target_scopes
         (id, task_id, target_id, verification_commands_json,
          protected_test_globs_json, write_scope_globs_json)
       VALUES (?, ?, ?, '[]', ?, ?)`,
    )
    .run(ulid(), s.taskId, targetId, JSON.stringify(opts.protected ?? []), JSON.stringify(opts.write ?? ["**/*"]));
  return targetId;
}

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "novaflow-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  const git = (args: string) => execSync(`git ${args}`, { cwd: root, stdio: "ignore" });
  git("init -q");
  git("config user.email test@novaflow.dev");
  git("config user.name novaflow-test");
  git("add -A");
  git("commit -qm init");
  return root;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/* ------------------------------ the minimal glob matcher ------------------------- */

test("globMatch: `**` spans directories (and may match zero segments)", () => {
  assert.equal(globMatch("**/*", "a"), true);
  assert.equal(globMatch("**/*", "a/b/c"), true);
  assert.equal(globMatch("src/**", "src/a.ts"), true);
  assert.equal(globMatch("src/**", "src/x/y.ts"), true);
  assert.equal(globMatch("src/**", "srca/b"), false);
  assert.equal(globMatch("src/**", "other/a.ts"), false);
  // documented subset: `**` matches zero or more segments, so `src/**`
  // also matches a bare `src` file entry
  assert.equal(globMatch("src/**", "src"), true);
});

test("globMatch: `*` stays inside one segment; literals match exactly", () => {
  assert.equal(globMatch("tests/*.test.ts", "tests/foo.test.ts"), true);
  assert.equal(globMatch("tests/*.test.ts", "tests/sub/foo.test.ts"), false);
  assert.equal(globMatch("tests/*.test.ts", "tests/foo.ts"), false);
  assert.equal(globMatch("*.md", "readme.md"), true);
  assert.equal(globMatch("*.md", "docs/x.md"), false); // no slash in pattern → root-level only
  assert.equal(globMatch("config.yaml", "config.yaml"), true);
  assert.equal(globMatch("config.yaml", "sub/config.yaml"), false);
  assert.equal(globMatchAny(["src/**", "docs/**"], "docs/a.md"), true);
  assert.equal(globMatchAny(["src/**", "docs/**"], "misc/a"), false);
});

test("globMatch: no brace expansion, no character classes — those are literals", () => {
  assert.equal(globMatch("{a,b}.ts", "a.ts"), false);
  assert.equal(globMatch("x[0-9].ts", "x5.ts"), false);
  assert.equal(globMatch("{a,b}.ts", "{a,b}.ts"), true); // matches itself literally
});

test("globMatch: multiple `*` inside one segment (two-pointer scan semantics)", () => {
  assert.equal(globMatch("a*b*c.ts", "axxbyyc.ts"), true);
  assert.equal(globMatch("a*b*c.ts", "abbc.ts"), true);
  assert.equal(globMatch("a*b*c.ts", "ac.ts"), false);
  assert.equal(globMatch("a*b*c.ts", "xaxxb"), false);
  assert.equal(globMatch("*a*", "a"), true);
  assert.equal(globMatch("*a*", "b"), false);
});

test("globMatch: pathological patterns stay linear (no catastrophic backtracking)", () => {
  // live-verified before the fix: the recursive matcher took 146 s on
  // the first case and explodes exponentially on `**` chains. The
  // matcher runs synchronously in startRun preflight and verification —
  // it must be bounded. Generous wall-time slack to avoid flakes.
  const deep = Array.from({ length: 60 }, (_, i) => `seg${i}`).join("/");
  const cases: Array<[string, string]> = [
    ["*".repeat(10) + "!", "a".repeat(60)],
    ["**".repeat(30), deep],
    ["*".repeat(30) + "a", "a".repeat(200)],
    ["**/x/**/y/**", deep],
  ];
  for (const [pattern, path] of cases) {
    const start = Date.now();
    const result = globMatch(pattern, path);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 500,
      `globMatch(${JSON.stringify(pattern.slice(0, 40))}…) took ${elapsed} ms`,
    );
    void result;
  }
});

/* ------------------------------ pre-run digest snapshot -------------------------- */

test("writeProtectedDigests snapshots the protected set (SHA-256) into protected-digests.json", () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  const runId = ulid();
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, runId);
    assert.equal(path, join(runDir, SNAPSHOT_FILENAME));
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      task_id: string;
      run_id: string;
      taken_at: string;
      targets: Array<{
        alias: string;
        target_type: string;
        root_path: string;
        protected_globs: string[];
        write_scope_globs: string[];
        full_tree: boolean;
        files: Record<string, string>;
      }>;
    };
    assert.equal(snap.version, 1);
    assert.equal(snap.task_id, s.taskId);
    assert.equal(snap.run_id, runId);
    const t = snap.targets[0]!;
    assert.equal(t.alias, "app");
    assert.equal(t.target_type, "git_repo");
    assert.equal(t.full_tree, false); // git targets snapshot the protected set only
    assert.deepEqual(t.protected_globs, ["tests/**"]);
    assert.deepEqual(t.write_scope_globs, ["src/**"]);
    assert.deepEqual(Object.keys(t.files), ["tests/protected.test.ts"]);
    assert.match(t.files["tests/protected.test.ts"] ?? "", SHA256_RE);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a glob with an empty segment is a hard preflight failure naming the glob", () => {
  // `tests/**/` (trailing slash) splits to an EMPTY segment that can
  // never match — protection silently off. Fail closed, zero tokens.
  const bad: Array<[string, "protected" | "write"]> = [
    ["tests/**/", "protected"],
    ["/tests/**", "protected"],
    ["tests//**", "protected"],
    ["", "protected"],
    ["tests/**/", "write"],
  ];
  for (const [glob, which] of bad) {
    const s = seed();
    const root = gitRepo({ "tests/p.test.ts": "test('p', () => {});\n" });
    const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
    try {
      addTarget(
        s,
        which === "protected"
          ? { alias: "app", root, protected: [glob], write: ["src/**"] }
          : { alias: "app", root, protected: ["tests/**"], write: [glob] },
      );
      assert.throws(
        () => writeProtectedDigests(s.db, s.taskId, runDir, ulid()),
        (err: unknown) => {
          const msg = (err as Error).message;
          return msg.includes(JSON.stringify(glob)) && msg.includes(which === "protected" ? "protected_test_globs" : "write_scope_globs");
        },
        `glob ${JSON.stringify(glob)} (${which}) must be rejected with the glob named`,
      );
    } finally {
      s.db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  }
});

test("`tests/**` (no trailing slash) remains a legal, matching glob", () => {
  const s = seed();
  const root = gitRepo({ "tests/p.test.ts": "test('p', () => {});\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(snap.targets[0]?.files ?? {}), ["tests/p.test.ts"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an invalid glob that somehow reached the snapshot fails closed at verification", async () => {
  const s = seed();
  const root = gitRepo({ "tests/p.test.ts": "test('p', () => {});\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    // tamper the snapshot's protected glob to the under-matching spelling
    const snapPath = join(runDir, SNAPSHOT_FILENAME);
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
      targets: Array<{ protected_globs: string[] }>;
    };
    snap.targets[0]!.protected_globs = ["tests/**/"];
    writeFileSync(snapPath, JSON.stringify(snap, null, 2) + "\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false); // fail closed, not silent
    assert.ok(
      res.notes.some((n) => n.includes("tests/**/")),
      JSON.stringify(res.notes),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("writeProtectedDigests refuses a scoped target whose root is missing (preflight honesty)", () => {
  const s = seed();
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root: "/no/such/repo" });
    assert.throws(() => writeProtectedDigests(s.db, s.taskId, runDir, ulid()), /target root missing/i);
  } finally {
    s.db.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** 21 000 junk files beyond MAX_TREE_FILES — created via brace expansion (fast). */
function manyJunkFiles(root: string, dir: string): void {
  execSync(`bash -c "mkdir -p ${dir} && touch ${dir}/f{1..21000}"`, { cwd: root, stdio: "ignore" });
}

test("the tree walk prunes .git and node_modules — digests never depend on them", () => {
  const s = seed();
  // gitRepo gives the root a real .git (objects, config, …)
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "node_modules/pkg/index.js": "module.exports = {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["**/*"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    // .git internals and node_modules are digest-invariant: pruned from
    // every walk, so an all-matching glob still snapshots only real files
    assert.deepEqual(Object.keys(snap.targets[0]?.files ?? {}), ["tests/protected.test.ts"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("literal-prefixed protected globs walk only their subtrees — junk elsewhere never trips the bound", () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-repo-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "p.test.ts"), "test('p', () => {});\n");
  manyJunkFiles(root, "vendor"); // 21 000 files OUTSIDE the protected subtree
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(snap.targets[0]?.files ?? {}), ["tests/p.test.ts"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an empty protected set snapshots no files and never walks the tree", () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-repo-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "p.test.ts"), "test('p', () => {});\n");
  manyJunkFiles(root, "vendor"); // would blow the walk bound if walked
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: [] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    assert.deepEqual(snap.targets[0]?.files, {});
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a snapshot walk failure is a preflight error naming the target", () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-dir-"));
  mkdirSync(join(root, "locked"), { recursive: true });
  chmodSync(join(root, "locked"), 0o000); // unreadable subtree
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "docs", type: "directory", root, protected: [], write: ["**/*"] });
    assert.throws(
      () => writeProtectedDigests(s.db, s.taskId, runDir, ulid()),
      /target docs/, // the walk error must name the target, not just the path
    );
  } finally {
    chmodSync(join(root, "locked"), 0o700);
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an unreadable subtree during a git target's protected walk is a finding, never a throw", async () => {
  const s = seed();
  const root = gitRepo({ "tests/p.test.ts": "test('p', () => {});\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    // `**/*` has no literal prefix → the verification walk covers the
    // whole tree and must swallow the unreadable subtree as a finding
    addTarget(s, { alias: "app", root, protected: ["**/*"], write: ["**/*"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    mkdirSync(join(root, "locked"), { recursive: true });
    chmodSync(join(root, "locked"), 0o000);
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false); // fail closed: no evidence, no pass
    assert.ok(
      res.notes.some((n) => n.includes("cannot walk target tree app")),
      JSON.stringify(res.notes),
    );
  } finally {
    chmodSync(join(root, "locked"), 0o700);
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("symlinks are digest entries — created and retargeted links count as modified paths", async () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-dir-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "x.txt"), "x\n");
  symlinkSync("x.txt", join(root, "data", "link")); // in-scope symlink at snapshot time
  symlinkSync("a", join(root, "out.link")); // out-of-scope symlink at snapshot time
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "docs", type: "directory", root, protected: [], write: ["data/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    // a symlink's identity is its target string — snapshotted like a file
    assert.match(snap.targets[0]?.files["data/link"] ?? "", SHA256_RE);
    assert.match(snap.targets[0]?.files["out.link"] ?? "", SHA256_RE);

    // an agent-created symlink outside the write scope is scope creep
    symlinkSync("/tmp", join(root, "rogue-link"));
    let res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.deepEqual(res.scopeCreepPaths, ["docs/rogue-link"]);

    // retargeting an out-of-scope symlink is a modified path → creep
    rmSync(join(root, "out.link"));
    symlinkSync("b", join(root, "out.link"));
    res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.ok(
      res.scopeCreepPaths.includes("docs/out.link"),
      JSON.stringify(res.scopeCreepPaths),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

/* ------------------------------- protected verification ------------------------- */

test("unchanged protected set → untouched=true, no scope creep", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, true);
    assert.deepEqual(res.scopeCreepPaths, []);
    assert.deepEqual(res.notes, []);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a tampered protected test file → untouched=false, note names the file", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    // the agent weakens the test after the run
    writeFileSync(join(root, "tests/protected.test.ts"), "test('gamed', () => {});\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false);
    assert.ok(res.notes.some((n) => n.includes("tests/protected.test.ts")), JSON.stringify(res.notes));
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a deleted protected test file → untouched=false", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    rmSync(join(root, "tests/protected.test.ts"));
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false);
    assert.ok(res.notes.some((n) => n.includes("deleted")), JSON.stringify(res.notes));
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a protected-set file CREATED after the snapshot → untouched=false (new gaming route closed)", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    writeFileSync(join(root, "tests", "new.test.ts"), "test('new', () => {});\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false);
    assert.ok(res.notes.some((n) => n.includes("tests/new.test.ts")), JSON.stringify(res.notes));
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a missing snapshot fails closed: untouched=false with a note (FR-TSK-11)", async () => {
  const s = seed();
  const root = gitRepo({ "src/app.ts": "export {};\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"] });
    // no writeProtectedDigests call — the snapshot is missing
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, false);
    assert.ok(
      res.notes.some((n) => n.includes("failing closed")),
      JSON.stringify(res.notes),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a task with no target scopes has nothing to protect → untouched=true, no snapshot required", async () => {
  const s = seed();
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, true);
    assert.deepEqual(res.scopeCreepPaths, []);
    assert.deepEqual(res.notes, []);
  } finally {
    s.db.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

/* ------------------------------- write-scope check ------------------------------- */

test("scope creep: a git_repo modification outside write_scope_globs is flagged; in-scope changes are not", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    // the agent modifies an in-scope file AND writes an out-of-scope file
    writeFileSync(join(root, "src/app.ts"), "export const v = 1;\n");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "extra.txt"), "scope creep\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, true); // protected set untouched
    assert.deepEqual(res.scopeCreepPaths, ["app/notes/extra.txt"]);
    assert.equal(res.notes.length, 0);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("directory target: modified paths are detected digest-based (no git), creep still caught", async () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-dir-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "data", "x.txt"), "x\n");
  writeFileSync(join(root, "other", "y.txt"), "y\n");
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "docs", type: "directory", root, protected: [], write: ["data/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ full_tree: boolean; files: Record<string, string> }>;
    };
    assert.equal(snap.targets[0]?.full_tree, true, "directory targets snapshot the whole tree");
    assert.equal(Object.keys(snap.targets[0]?.files ?? {}).length, 2);

    // in-scope modification → no creep
    writeFileSync(join(root, "data", "x.txt"), "x2\n");
    let res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, true);
    assert.deepEqual(res.scopeCreepPaths, []);

    // out-of-scope modification → creep
    writeFileSync(join(root, "other", "y.txt"), "y2\n");
    res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.deepEqual(res.scopeCreepPaths, ["docs/other/y.txt"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a directory target with an out-of-scope NEW file → creep (digest-based detection)", async () => {
  const s = seed();
  const root = mkdtempSync(join(tmpdir(), "novaflow-dir-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "x.txt"), "x\n");
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "docs", type: "directory", root, protected: [], write: ["data/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    writeFileSync(join(root, "rogue.txt"), "new out-of-scope file\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.deepEqual(res.scopeCreepPaths, ["docs/rogue.txt"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("git status failing in a git_repo target → fails closed: scope inconclusive, digests still enforced", async () => {
  const s = seed();
  // a plain directory typed as git_repo: git status will fail (128)
  const root = mkdtempSync(join(tmpdir(), "novaflow-notrepo-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "p.test.ts"), "test('p', () => {});\n");
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    assert.equal(res.protectedFilesUntouched, true); // digests still enforced, untouched here
    assert.equal(res.scopeCheckInconclusive, true); // fail closed: the verdict must fail
    assert.deepEqual(res.scopeCreepPaths, []);
    assert.ok(res.notes.some((n) => n.includes("git status")), JSON.stringify(res.notes));
    assert.ok(
      res.notes.some((n) => n.includes("scope check inconclusive")),
      JSON.stringify(res.notes),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});


test("the agent deletes .git and writes out of scope → verification fails closed (git baseline gone)", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    // the agent erases the git baseline AND writes an out-of-scope file
    rmSync(join(root, ".git"), { recursive: true, force: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "extra.txt"), "scope creep\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    // protected digests are still enforced (and untouched here) …
    assert.equal(res.protectedFilesUntouched, true);
    // … but a failed git status means the scope check has NO evidence:
    // fail closed, the overall verification verdict must fail
    assert.equal(res.scopeCheckInconclusive, true);
    assert.ok(
      res.notes.some((n) => n.includes("scope check inconclusive")),
      JSON.stringify(res.notes),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("parseGitPorcelain: rename entries contribute BOTH the source and the destination", () => {
  const paths = parseGitPorcelain(
    "R  old/dir/file.ts -> new/dir/file.ts\n?? untracked.txt\nM  src/app.ts\n",
  );
  assert.deepEqual(paths, [
    "old/dir/file.ts", // the renamed-away SOURCE is a modified path too
    "new/dir/file.ts",
    "untracked.txt",
    "src/app.ts",
  ]);
});

test("renaming a protected file away from its out-of-scope location is creep", async () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
    "src/app.ts": "export {};\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    execSync("git mv tests/protected.test.ts src/moved.test.ts", {
      cwd: root,
      stdio: "ignore",
    });
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    // the destination src/moved.test.ts is in scope; the vanished
    // SOURCE tests/protected.test.ts is out of scope → creep
    assert.ok(
      res.scopeCreepPaths.includes("app/tests/protected.test.ts"),
      JSON.stringify(res.scopeCreepPaths),
    );
    assert.ok(
      !res.scopeCreepPaths.includes("app/src/moved.test.ts"),
      JSON.stringify(res.scopeCreepPaths),
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("non-ASCII modified paths arrive raw (core.quotePath=false) — no unescaping needed", async () => {
  const s = seed();
  const root = gitRepo({ "src/app.ts": "export {};\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "über.txt"), "out of scope\n");
    const res = await verifyProtectedAndScope(s.db, s.taskId, runDir);
    // the literal UTF-8 path, NOT git's \\303\\274ber.txt default escaping
    assert.deepEqual(res.scopeCreepPaths, ["app/notes/über.txt"]);
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("pruning wins even when a protected glob names .git explicitly — documented, pinned (re-judge finding 4)", () => {
  const s = seed();
  const root = gitRepo({
    "tests/protected.test.ts": "test('protected', () => {});\n",
  });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: [".git/hooks/**"], write: ["src/**"] });
    const path = writeProtectedDigests(s.db, s.taskId, runDir, ulid());
    const snap = JSON.parse(readFileSync(path, "utf8")) as {
      targets: Array<{ files: Record<string, string> }>;
    };
    // Intentional: PRUNED_DIRS never enter a snapshot, glob or no glob.
    assert.deepEqual(snap.targets[0]?.files, {});
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a protected subtree itself exceeding MAX_TREE_FILES is a preflight error naming the target (count-bound branch, re-judge finding 3)", () => {
  const s = seed();
  const root = gitRepo({ "src/app.ts": "export {};\n" });
  const runDir = mkdtempSync(join(tmpdir(), "novaflow-run-"));
  try {
    addTarget(s, { alias: "app", root, protected: ["tests/**"], write: ["src/**"] });
    manyJunkFiles(root, "tests");
    assert.throws(
      () => writeProtectedDigests(s.db, s.taskId, runDir, ulid()),
      (err: unknown) => {
        const msg = (err as Error).message;
        return /exceeds 20000/i.test(msg) && /app/i.test(msg);
      },
      "the >20k protected walk must fail as a named preflight error, not succeed or throw raw",
    );
  } finally {
    s.db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
