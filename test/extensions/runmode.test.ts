import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  SessionStartEvent,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import novaflowFactory, {
  ARTIFACT_REQUIRED_KEYS,
  SUBMIT_TOOL_NAME,
  SUBMIT_TOOL_PARAMS,
  bashWriteTargets,
  checkBashWriteScope,
  checkWritePath,
  daemonRequest,
  globMatch,
  loadRunContext,
  MAX_RESULT_PAYLOAD_BYTES,
  resolveToolPath,
  runNovaCommand,
  validateAndWriteResult,
  validateArtifactStructure,
} from "../../extensions/novaflow.ts";
import { globMatch as engineGlobMatch } from "../../src/verify/protected.ts";
import { validateArtifact as engineValidateArtifact } from "../../src/runs/artifact.ts";

/**
 * Run-mode unit coverage (the card's step-2 list): scope allow/block
 * matrices, protected globs, read_only refusal, path escapes, submit
 * validation (valid → file + block/terminate; invalid → no file, no
 * terminate, structured error), oversized payloads, plus PARITY against
 * the engine's own matcher and structural validator — the extension
 * PORTS both (self-contained file; no src/ imports at runtime), and the
 * parity corpus pins the port against drift.
 *
 * The factory drives against a fake pi double typed as the real
 * ExtensionAPI — the seam contract is the package's, not a reimagining.
 */

/* --------------------------------- doubles ---------------------------------- */

type ToolDef = ToolDefinition & { name: string };

type PiDouble = {
  api: ExtensionAPI;
  tools: ToolDef[];
  commands: Array<{ name: string; options: Omit<RegisteredCommand, "name" | "sourceInfo"> }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
};

function fakePi(): PiDouble {
  const tools: ToolDef[] = [];
  const commands: Array<{ name: string; options: Omit<RegisteredCommand, "name" | "sourceInfo"> }> = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    registerTool: (def: ToolDefinition) => {
      tools.push(def as ToolDef);
    },
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.push({ name, options });
    },
  } as unknown as ExtensionAPI;
  return { api, tools, commands, handlers };
}

type Note = { message: string; severity: string };

function fakeCtx(cwd: string): { ctx: ExtensionContext; notes: Note[] } {
  const notes: Note[] = [];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, severity: "info" | "warning" | "error") => {
        notes.push({ message, severity });
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, notes };
}

async function fireToolCall(
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ result: unknown; notes: Note[] }> {
  const { ctx, notes } = fakeCtx(cwd);
  const event = { type: "tool_call", toolCallId: "call_x", toolName, input } as unknown as ToolCallEvent;
  const result = (await handlers.get("tool_call")!(event, ctx)) as unknown;
  return { result, notes };
}

/* --------------------------------- fixtures --------------------------------- */

const TASK_ID = "01HJ8Z9X01ABCDEFGHJKMNPQRS";
const RUN_ID = "01HJ8Z9XABCDEFGHJKMNPQRSTV";

assert.match(TASK_ID, /^[0-9A-HJKMNP-TV-Z]{26}$/);
assert.match(RUN_ID, /^[0-9A-HJKMNP-TV-Z]{26}$/);

/** Foreign but PATTERN-VALID ids — the identity-binding probes (B4): they pass the §4.1 ULID check yet belong to another run. */
const FOREIGN_TASK_ID = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
const FOREIGN_RUN_ID = "01ZZZZZZZZZZZZZZZZZZZZZZZ0";
assert.match(FOREIGN_TASK_ID, /^[0-9A-HJKMNP-TV-Z]{26}$/);
assert.match(FOREIGN_RUN_ID, /^[0-9A-HJKMNP-TV-Z]{26}$/);
assert.notEqual(FOREIGN_TASK_ID, TASK_ID);
assert.notEqual(FOREIGN_RUN_ID, RUN_ID);

type TargetFixture = {
  alias: string;
  access_mode: "read_only" | "read_write";
  write_scope_globs: string[];
  protected_test_globs: string[];
  subdir: string;
};

const TARGETS: TargetFixture[] = [
  {
    alias: "alpha",
    access_mode: "read_write",
    write_scope_globs: ["src/**"],
    protected_test_globs: ["golden/**"],
    subdir: "alpha",
  },
  {
    alias: "beta",
    access_mode: "read_only",
    write_scope_globs: [],
    protected_test_globs: [],
    subdir: "beta",
  },
];

/** A seeded run dir: engine-context.json + protected-digests.json, §6 shape. */
function seedRunDir(base: string, targets: TargetFixture[] = TARGETS): { runDir: string; contextPath: string } {
  const runDir = join(base, ".novaflow", "runs", TASK_ID, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const snapshotTargets = [];
  const scopes = [];
  for (const [i, t] of targets.entries()) {
    const rootPath = join(base, t.subdir);
    mkdirSync(join(rootPath, "src"), { recursive: true });
    mkdirSync(join(rootPath, "golden"), { recursive: true });
    if (t.access_mode === "read_only") {
      mkdirSync(join(rootPath, "data"), { recursive: true });
      writeFileSync(join(rootPath, "data", "notes.txt"), "read only\n");
    }
    const targetId = `01TGT0000000000000000000${String(i).padStart(2, "0")}`;
    scopes.push({
      target_id: targetId,
      alias: t.alias,
      access_mode: t.access_mode,
      write_scope_globs: t.write_scope_globs,
      protected_test_globs: t.protected_test_globs,
    });
    snapshotTargets.push({
      target_id: targetId,
      alias: t.alias,
      target_type: "directory",
      root_path: rootPath,
      protected_globs: t.protected_test_globs,
      write_scope_globs: t.write_scope_globs,
      full_tree: true,
      files: {},
    });
  }
  const contextPath = join(runDir, "engine-context.json");
  writeFileSync(
    contextPath,
    JSON.stringify({
      task_id: TASK_ID,
      run_id: RUN_ID,
      attempt_kind: "execution",
      scopes,
      output_schema: { id: "1.0.0", inline: null },
      budget: { max_timeout_sec: 600, max_cost_usd: 1 },
      verification_commands: ["npm test"],
    }) + "\n",
  );
  writeFileSync(
    join(runDir, "protected-digests.json"),
    JSON.stringify({ version: 1, task_id: TASK_ID, run_id: RUN_ID, taken_at: "2026-11-22T00:00:00Z", targets: snapshotTargets }) + "\n",
  );
  return { runDir, contextPath };
}

function validArtifact(): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    task_id: TASK_ID,
    run_id: RUN_ID,
    status: "completed",
    summary: "Implemented the feature and all tests pass.",
    assumptions_made: ["the spec's example is normative"],
    open_questions: [],
    artifacts_modified: [{ target_alias: "alpha", path: "src/feature.ts", action: "modified", diff_summary: "the change" }],
    feedback_items: [{ severity: "info", category: "test", message: "suite green" }],
    next_recommended_action: "proceed_to_next",
  };
}

/* ---------------------------------- tests ----------------------------------- */

test("loadRunContext: joins engine-context scopes with the snapshot's target roots", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { runDir, contextPath } = seedRunDir(base);
    const ctx = loadRunContext(contextPath);
    assert.equal(ctx.loadError, null);
    assert.equal(ctx.taskId, TASK_ID);
    assert.equal(ctx.runDir, runDir);
    assert.equal(ctx.scopes.length, 2);
    assert.equal(ctx.scopes[0]!.alias, "alpha");
    assert.equal(ctx.scopes[0]!.root_path, join(base, "alpha"));
    assert.equal(ctx.scopes[0]!.target_type, "directory");
    assert.equal(ctx.scopes[1]!.access_mode, "read_only");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadRunContext: a missing engine context is a loadError, never a throw", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const ctx = loadRunContext(join(base, "engine-context.json"));
    assert.notEqual(ctx.loadError, null);
    assert.match(ctx.loadError!, /engine-context/);
    assert.deepEqual(ctx.scopes, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadRunContext: scopes without the protected-digests snapshot fail closed", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    rmSync(join(dirname(contextPath), "protected-digests.json"));
    const ctx = loadRunContext(contextPath);
    assert.notEqual(ctx.loadError, null);
    assert.match(ctx.loadError!, /protected-digests/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadRunContext: a context scope with no snapshot target fails closed naming the alias", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    const parsed = JSON.parse(readFileSync(contextPath, "utf8")) as { scopes: Array<{ target_id: string }> };
    parsed.scopes[0]!.target_id = "01TGT000000000000000000099";
    writeFileSync(contextPath, JSON.stringify(parsed));
    const ctx = loadRunContext(contextPath);
    assert.notEqual(ctx.loadError, null);
    assert.match(ctx.loadError!, /alpha/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadRunContext: zero mapped scopes mirror the engine — no enforcement, no snapshot needed", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { runDir, contextPath } = seedRunDir(base, []);
    rmSync(join(runDir, "protected-digests.json"));
    const ctx = loadRunContext(contextPath);
    assert.equal(ctx.loadError, null);
    assert.deepEqual(ctx.scopes, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadRunContext: a snapshot target with an empty or non-absolute root_path is a loadError — never a silent process.cwd() scope", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    const snapPath = join(dirname(contextPath), "protected-digests.json");
    for (const bad of ["", "alpha"]) {
      const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { targets: Array<{ root_path: string }> };
      snap.targets[0]!.root_path = bad;
      writeFileSync(snapPath, JSON.stringify(snap));
      const ctx = loadRunContext(contextPath);
      assert.notEqual(ctx.loadError, null, `root_path ${JSON.stringify(bad)} must fail closed`);
      assert.match(ctx.loadError!, /root_path/);
      assert.match(ctx.loadError!, /failing closed/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("glob parity: the ported matcher answers identically to the engine's (src/verify/protected.ts)", () => {
  const corpus: Array<[string, string]> = [
    ["src/**", "src/x.ts"],
    ["src/**", "src"],
    ["src/**", "src/a/b/c.ts"],
    ["src/*", "src/a/b.ts"],
    ["src/*", "src/a.ts"],
    ["*", "a.ts"],
    ["*", "a/b.ts"],
    ["a/**/b", "a/x/y/b"],
    ["a/**/b", "a/b"],
    ["**/*.test.ts", "deep/nested/x.test.ts"],
    ["docs/*.md", "docs/readme.md"],
    ["docs/*.md", "docs/sub/readme.md"],
    ["src/**", "other/x.ts"],
    ["golden/**", "golden/deep/x.test"],
  ];
  for (const [pattern, path] of corpus) {
    assert.equal(
      globMatch(pattern, path),
      engineGlobMatch(pattern, path),
      `globMatch(${JSON.stringify(pattern)}, ${JSON.stringify(path)}) diverged from the engine matcher`,
    );
  }
});

test("the ported matcher stays linear on the p2c ReDoS-shaped pathological pattern", () => {
  const pattern = "*".repeat(10) + "!";
  const segment = "a".repeat(60);
  const start = Date.now();
  assert.equal(globMatch(pattern, segment), false);
  assert.ok(Date.now() - start < 1000, "the pathological glob must not backtrack catastrophically");
});

test("scope matrix: writes allowed in scope, refused outside it / protected / read_only / untargeted", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    const { scopes } = loadRunContext(contextPath);
    const alpha = (rel: string): string => resolveToolPath(base, join("alpha", rel));
    assert.deepEqual(checkWritePath(scopes, alpha("src/feature.ts")), { ok: true }, "write scope src/** allows src writes");
    assert.equal(checkWritePath(scopes, alpha("other/x.ts")).ok, false, "outside write_scope_globs");
    assert.match((checkWritePath(scopes, alpha("other/x.ts")) as { reason: string }).reason, /write scope/);
    assert.equal(checkWritePath(scopes, alpha("golden/x.test")).ok, false, "protected_test_globs refuse");
    assert.match((checkWritePath(scopes, alpha("golden/x.test")) as { reason: string }).reason, /protected/);
    const betaNote = join(base, "beta", "data", "notes.txt");
    assert.equal(checkWritePath(scopes, betaNote).ok, false, "read_only target refuses writes");
    assert.match((checkWritePath(scopes, betaNote) as { reason: string }).reason, /read_only/);
    const nowhere = join(base, "unmapped.txt");
    assert.equal(checkWritePath(scopes, nowhere).ok, false, "writes outside every target are refused");
    assert.match((checkWritePath(scopes, nowhere) as { reason: string }).reason, /no target scope/);
    assert.deepEqual(checkWritePath([], nowhere), { ok: true }, "zero scopes mirror the engine: no enforcement");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("path escapes: .., symlinks, cwd-relative and ~ tricks all resolve before the scope check", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  const prevHome = process.env["HOME"];
  try {
    const { contextPath } = seedRunDir(base);
    const { scopes } = loadRunContext(contextPath);

    // `..` landing inside the write scope resolves to the real path: allowed
    const insideViaDots = resolveToolPath(join(base, "alpha", "src", "sub"), "../../src/x.ts");
    assert.deepEqual(checkWritePath(scopes, insideViaDots), { ok: true });
    // `..` escaping the target: refused by the governing read_only target
    const escapeViaDots = resolveToolPath(join(base, "alpha", "src"), "../golden/x.test");
    assert.equal(checkWritePath(scopes, escapeViaDots).ok, false);

    // a symlink INSIDE the write scope pointing at the read_only target's data
    symlinkSync(join(base, "beta", "data", "notes.txt"), join(base, "alpha", "src", "escape-link.txt"));
    assert.equal(
      checkWritePath(scopes, resolveToolPath(base, join("alpha", "src", "escape-link.txt"))).ok,
      false,
      "a write through a symlink into the read_only target must refuse",
    );

    // a symlink inside the write scope pointing OUTSIDE every target
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(base, "outside", "evil.txt"), "x\n");
    symlinkSync(join(base, "outside", "evil.txt"), join(base, "alpha", "src", "outside-link.txt"));
    assert.equal(
      checkWritePath(scopes, resolveToolPath(base, join("alpha", "src", "outside-link.txt"))).ok,
      false,
      "a write through a symlink escaping every target root must refuse",
    );

    // relative paths resolve against cwd; a leading @ is stripped (built-in convention)
    assert.deepEqual(
      checkWritePath(scopes, resolveToolPath(join(base, "alpha"), "@src/x.ts")),
      { ok: true },
    );

    // nonexistent paths under the write scope: the existing ancestors realpath, the tail rides along
    assert.deepEqual(
      checkWritePath(scopes, resolveToolPath(base, join("alpha", "src", "new", "deep", "file.ts"))).ok,
      true,
      "a not-yet-existing file inside the write scope is allowed",
    );

    // ~ expansion follows the actual home, not a literal ~ directory
    process.env["HOME"] = base;
    const homeEscaped = resolveToolPath(base, "~/unmapped.txt");
    assert.equal(homeEscaped, join(base, "unmapped.txt"));
    assert.equal(checkWritePath(scopes, homeEscaped).ok, false);
  } finally {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("nested target roots: the deepest containing root governs", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const targets: TargetFixture[] = [
      ...TARGETS,
      {
        alias: "nested",
        access_mode: "read_write",
        write_scope_globs: ["nested/**"],
        protected_test_globs: [],
        subdir: "alpha/src", // nested INSIDE alpha's root
      },
    ];
    const { contextPath } = seedRunDir(base, targets);
    const { scopes } = loadRunContext(contextPath);
    // alpha's src/** would allow this — but the deeper "nested" target governs it
    const clash = resolveToolPath(base, join("alpha", "src", "x.ts"));
    const res = checkWritePath(scopes, clash) as { ok: false; reason: string };
    assert.equal(res.ok, false);
    assert.match(res.reason, /nested/);
    // and the nested target's own scope allows its subtree
    assert.deepEqual(checkWritePath(scopes, resolveToolPath(base, join("alpha", "src", "nested", "y.ts"))), { ok: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("bashWriteTargets: redirections, mutators, pipes and quoted tokens are extracted; reads are not", () => {
  assert.deepEqual(bashWriteTargets("echo hi"), []);
  assert.deepEqual(bashWriteTargets("echo hi > out.txt"), ["out.txt"]);
  assert.deepEqual(bashWriteTargets("echo hi >>out.txt"), ["out.txt"]);
  assert.deepEqual(bashWriteTargets("cmd 2> err.txt"), ["err.txt"]);
  assert.deepEqual(bashWriteTargets("cmd &> all.log"), ["all.log"]);
  assert.deepEqual(bashWriteTargets("cmd 2>&1"), [], "fd duplication is not a file write");
  assert.deepEqual(bashWriteTargets("rm alpha/golden/x.test"), ["alpha/golden/x.test"]);
  assert.deepEqual(bashWriteTargets("rm -rf alpha/src/junk"), ["alpha/src/junk"]);
  assert.deepEqual(bashWriteTargets("rm 'alpha/golden/x test'"), ["alpha/golden/x test"], "quoted tokens unquote");
  assert.deepEqual(bashWriteTargets("cp alpha/src/a.txt alpha/other/b.txt"), ["alpha/other/b.txt"], "cp's write is the destination");
  assert.deepEqual(bashWriteTargets("mv a b"), ["b"]);
  assert.deepEqual(bashWriteTargets("sed 's/x/y/' alpha/src/a.ts"), [], "sed without -i does not write");
  assert.deepEqual(bashWriteTargets("sed -i 's/x/y/' alpha/src/a.ts"), ["alpha/src/a.ts"]);
  assert.deepEqual(bashWriteTargets("cat golden/a.test | tee alpha/other/o.txt"), ["alpha/other/o.txt"]);
  assert.deepEqual(bashWriteTargets("mkdir alpha/src/new"), ["alpha/src/new"]);
  assert.deepEqual(bashWriteTargets("touch alpha/src/f"), ["alpha/src/f"]);
  assert.deepEqual(bashWriteTargets("cat alpha/golden/x.test"), [], "reads are not write targets");
  assert.deepEqual(bashWriteTargets("git commit -am wip"), [], "git internals are engine-verified, not hook-analyzed");
  assert.deepEqual(
    bashWriteTargets("cat a && rm alpha/golden/x.test"),
    ["alpha/golden/x.test"],
    "compound commands are scanned per segment",
  );
});

test("checkBashWriteScope: protected/read_only/out-of-scope bash writes refuse; devices and reads pass", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    const { scopes } = loadRunContext(contextPath);

    const blocked = (cmd: string, word: RegExp, note?: string): string => {
      const res = checkBashWriteScope(scopes, base, cmd);
      assert.equal(res.ok, false, `expected a block for: ${cmd}${note !== undefined ? ` (${note})` : ""}`);
      assert.match((res as { reason: string }).reason, word);
      return (res as { reason: string }).reason;
    };
    blocked("echo x > alpha/golden/x.test", /protected/);
    blocked("rm -rf alpha/golden", /protected/);
    blocked("echo x >> alpha/other/o.txt", /write scope/);
    blocked("cp alpha/src/a.txt beta/data/b.txt", /read_only/);
    blocked("touch unmapped.txt", /no target scope/);
    blocked("tee 'alpha/other/o.txt'", /write scope/, "quoted targets still resolve");

    const allowed = (cmd: string, note?: string): void => {
      assert.deepEqual(checkBashWriteScope(scopes, base, cmd), { ok: true }, `expected a pass for: ${cmd}${note !== undefined ? ` (${note})` : ""}`);
    };
    allowed("npm test");
    allowed("cat alpha/golden/x.test");
    allowed("git commit -am wip");
    allowed("python -c 'open(\"x\",\"w\")()'", "documented best-effort limit: script bodies are engine-verified");
    allowed("echo done > /dev/null");
    allowed("echo done | tee /dev/null");
    allowed("echo x > alpha/src/log.txt");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("bashWriteTargets: the full redirect operator family, dd's of=, and the -t destination forms are extracted", () => {
  assert.deepEqual(bashWriteTargets("cmd 2>> f"), ["f"], "append-on-stderr is a file write");
  assert.deepEqual(bashWriteTargets("cmd 2>>f"), ["f"]);
  assert.deepEqual(bashWriteTargets("cmd >| f"), ["f"], "the noclobber form is a file write");
  assert.deepEqual(bashWriteTargets("cmd 2>| f"), ["f"]);
  assert.deepEqual(bashWriteTargets("cmd &>> f"), ["f"]);
  assert.deepEqual(bashWriteTargets("cmd 2>&1"), [], "fd duplication stays a non-write across the family");
  assert.deepEqual(bashWriteTargets("dd if=/dev/zero of=f"), ["f"], "dd's write rides its of= operand");
  assert.deepEqual(bashWriteTargets("dd if=/dev/zero of=alpha/src/disk.bin bs=1M count=1"), ["alpha/src/disk.bin"], "dd's other operands are not paths");
  assert.deepEqual(bashWriteTargets("mv -t dir src"), ["dir", "dir/src"], "the -t directory is the destination, not the last operand");
  assert.deepEqual(bashWriteTargets("cp -t dir a b"), ["dir", "dir/a", "dir/b"]);
  assert.deepEqual(bashWriteTargets("install -t dir src"), ["dir", "dir/src"]);
  assert.deepEqual(bashWriteTargets("mv --target-directory=dir a b"), ["dir", "dir/a", "dir/b"]);
  assert.deepEqual(bashWriteTargets("mv a b"), ["b"], "the plain form keeps last-operand destination semantics");
});

test("checkBashWriteScope: operator family, dd of=, -t destinations and ln sources refuse; cd is tracked per segment", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { contextPath } = seedRunDir(base);
    const { scopes } = loadRunContext(contextPath);
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(base, "outside", "evil.txt"), "x\n");

    const blocked = (cmd: string, word: RegExp, cwd: string = base, note?: string): void => {
      const res = checkBashWriteScope(scopes, cwd, cmd);
      assert.equal(res.ok, false, `expected a block for: ${cmd}${note !== undefined ? ` (${note})` : ""}`);
      assert.match((res as { reason: string }).reason, word);
    };
    const allowed = (cmd: string, cwd: string = base, note?: string): void => {
      assert.deepEqual(
        checkBashWriteScope(scopes, cwd, cmd),
        { ok: true },
        `expected a pass for: ${cmd}${note !== undefined ? ` (${note})` : ""}`,
      );
    };

    // the operator family lands its targets
    blocked("cmd 2>> alpha/other/o.txt", /write scope/);
    blocked("cmd >| alpha/other/o.txt", /write scope/, base, "the noclobber form");
    blocked("cmd 2>| alpha/other/o.txt", /write scope/);
    blocked("dd if=/dev/zero of=alpha/other/d.bin", /write scope/);
    blocked("mv -t alpha/other alpha/src/a.ts", /write scope/, base, "the -t directory is the destination");
    blocked("cp --target-directory=alpha/other alpha/src/a.ts", /write scope/);

    // ln TOCTOU: the source is held to the write-scope verdict — a link
    // created inside a governed root from an out-of-scope source is the
    // create-then-write window, refused at the ln itself
    blocked(`ln -s ${join(base, "outside", "evil.txt")} ${join(base, "alpha", "src", "evil")}`, /create-then-write|no target scope/);
    blocked(`ln ${join(base, "outside", "evil.txt")} ${join(base, "alpha", "src", "evil")}`, /create-then-write|no target scope/, base, "the hard-link form");
    blocked(
      `ln -s ${join(base, "beta", "data", "notes.txt")} ${join(base, "alpha", "src", "l")}`,
      /read_only/,
      base,
      "a read_only target's file as the link source",
    );
    blocked(
      `ln -s ${join(base, "outside", "evil.txt")} ${join(base, "alpha", "src", "evil")} && echo x > ${join(base, "alpha", "src", "evil")}`,
      /create-then-write/,
      base,
      "the full same-command chain blocks at the ln",
    );
    blocked(
      `ln -s ${join(base, "beta", "data", "notes.txt")} ${join(base, "alpha", "src", "l")} && echo pwned >> ${join(base, "alpha", "src", "l")}`,
      /read_only/,
    );

    // cd moves the resolution base for every later segment
    blocked("cd ../../outside && echo x > feature.ts", /no target scope/, join(base, "alpha", "src"), "the bypass probe");
    // re-judge r2: the cd-tracking fixes' own bypass classes
    blocked("\\cd ../../beta && echo x > pwn.ts", /read_only|no target scope/, join(base, "alpha", "src"), "backslash-cd is plain cd to bash");
    blocked("command cd ../../beta && echo x > pwn.ts", /read_only|no target scope/, join(base, "alpha", "src"), "command cd moves the shell");
    blocked("env cd ../../beta && echo x > pwn.ts", /read_only|no target scope/, join(base, "alpha", "src"), "an unrecognized head with a cd word fails closed");
    blocked(
      `(cd ${join(base, "alpha", "src")} && true); echo x > feature.ts`,
      /no target scope/, join(base, "alpha", "src"),
      "a subshell cd must not re-anchor later segments (both directions fail closed)",
    );
    blocked(
      `ln -s -t ${join(base, "alpha", "src")} ${join(base, "outside", "evil.txt")}`,
      /links .* into a governed target|no target scope/, join(base, "alpha", "src"),
      "ln with -t still exposes its SOURCES to the link scan (r2 finding 1)",
    );
    blocked("cd - && echo x > f", /no target scope/, join(base, "alpha", "src"), "cd - fails closed");
    blocked("cd no-such-dir && echo x > f", /no target scope/, join(base, "alpha", "src"), "a nonexistent cd fails closed");
    blocked("cd && echo x > f", /no target scope/, join(base, "alpha", "src"), "cd with no argument fails closed");

    // the in-scope directions stay allowed
    allowed("cd alpha/src && echo done > build.log", base, "the in-scope landing after cd (no false positive)");
    allowed("cd alpha && cd src && echo done > build.log", base, "chained cds track");
    allowed("ln -s alpha/src/a.txt alpha/src/b.txt", base, "an in-scope link from an in-scope source is fine");
    allowed("echo x > alpha/src/log.txt");
    allowed("cd - && echo x > /dev/null", base, "device sinks are exempt even after an untracked cd");
    allowed(
      `cd - && echo x > ${join(base, "alpha", "src", "abs.txt")}`,
      base,
      "absolute targets never depended on the working directory",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("artifact parity: the ported structural validator answers identically to the engine's (src/runs/artifact.ts)", () => {
  const corpus: Array<[string, Record<string, unknown>]> = [
    ["full valid artifact", { ...validArtifact(), role: "worker", engine_verified: false, protected_files_untouched: true, verification_results: [{ command: "npm test", exit_code: 0, passed: true, output_tail: "ok" }] }],
    ["minimal valid artifact", validArtifact()],
    ["unknown top-level key (a smuggled path argument)", { ...validArtifact(), path: "/evil/result.json" }],
    ["bad status enum", { ...validArtifact(), status: "done" }],
    ["short summary", { ...validArtifact(), summary: "too short" }],
    ["bad task_id pattern", { ...validArtifact(), task_id: "not-a-ulid" }],
    ["non-semver schema_version", { ...validArtifact(), schema_version: "1.0" }],
    ["assumptions not strings", { ...validArtifact(), assumptions_made: [1, 2] }],
    ["artifacts_modified bad action", { ...validArtifact(), artifacts_modified: [{ target_alias: "a", path: "p", action: "moved" }] }],
    ["artifacts_modified unknown key", { ...validArtifact(), artifacts_modified: [{ target_alias: "a", path: "p", action: "created", extra: 1 }] }],
    ["feedback missing severity", { ...validArtifact(), feedback_items: [{ category: "c", message: "m" }] }],
    ["feedback file_location line 0", { ...validArtifact(), feedback_items: [{ severity: "info", category: "c", message: "m", file_location: { path: "p", line: 0 } }] }],
    ["verification_results non-integer exit", { ...validArtifact(), verification_results: [{ command: "c", exit_code: 0.5, passed: true }] }],
    ["engine_verified not boolean", { ...validArtifact(), engine_verified: "yes" }],
    ["empty-string role", { ...validArtifact(), role: "" }],
    ["missing required key", (() => { const a = validArtifact(); delete a["open_questions"]; return a; })()],
  ];
  for (const [name, value] of corpus) {
    const ported = validateArtifactStructure(value);
    const engine = engineValidateArtifact(value);
    assert.equal(ported.ok, engine.ok, `${name}: ok flags diverged`);
    if (ported.ok === false && engine.ok === false) {
      assert.deepEqual(ported.errors, engine.errors, `${name}: error lists diverged`);
    }
  }
  // the not-an-object cases too
  for (const value of [null, 42, "x", []]) {
    assert.equal(validateArtifactStructure(value).ok, engineValidateArtifact(value).ok);
    assert.deepEqual(
      (validateArtifactStructure(value) as { errors: string[] }).errors,
      (engineValidateArtifact(value) as { errors: string[] }).errors,
    );
  }
  // the smuggled-path case refuses loudly (the no-path-argument pin)
  const pathCase = validateArtifactStructure({ ...validArtifact(), path: "/evil" }) as { ok: false; errors: string[] };
  assert.ok(pathCase.errors.some((e) => e.includes('unknown top-level key "path"')));
});

test("validateAndWriteResult: a valid artifact writes <run_dir>/result.json exactly", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const artifact = validArtifact();
    const res = validateAndWriteResult(base, artifact);
    assert.equal(res.ok, true);
    const path = (res as { path: string }).path;
    assert.equal(path, join(base, "result.json"));
    assert.ok(existsSync(path));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), artifact);
    assert.ok(readFileSync(path, "utf8").endsWith("\n"), "the file ends with a newline like every engine artifact");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateAndWriteResult: invalid input writes NOTHING and reports structured errors", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const res = validateAndWriteResult(base, { ...validArtifact(), status: "nope" }) as { ok: false; errors: string[] };
    assert.equal(res.ok, false);
    assert.ok(res.errors.length > 0);
    assert.ok(res.errors.some((e) => e.includes('"status"')));
    assert.ok(!existsSync(join(base, "result.json")), "an invalid submission must not leave a file");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateAndWriteResult: a smuggled path argument is refused — the run dir is derived, never supplied", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const res = validateAndWriteResult(base, { ...validArtifact(), path: join(base, "elsewhere.json") }) as { ok: false; errors: string[] };
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('"path"')));
    assert.ok(!existsSync(join(base, "result.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(`validateAndWriteResult: payloads over the ${MAX_RESULT_PAYLOAD_BYTES}-byte cap are refused`, () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const oversized = { ...validArtifact(), summary: "x".repeat(MAX_RESULT_PAYLOAD_BYTES) };
    const res = validateAndWriteResult(base, oversized) as { ok: false; errors: string[] };
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("cap")), JSON.stringify(res.errors));
    assert.ok(!existsSync(join(base, "result.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateAndWriteResult: the cap is measured on the SERIALIZED bytes that land on disk, not a compact projection", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    // 140k multibyte chars: the compact JSON's UTF-16 length sits under
    // the cap, but the pretty-printed result.json on disk is over it
    const sneaky = { ...validArtifact(), summary: "\u00e9".repeat(140_000) };
    assert.ok(JSON.stringify(sneaky).length < MAX_RESULT_PAYLOAD_BYTES, "the compact projection is under the cap");
    assert.ok(
      Buffer.byteLength(JSON.stringify(sneaky, null, 2) + "\n", "utf8") > MAX_RESULT_PAYLOAD_BYTES,
      "the on-disk form is over the cap",
    );
    const res = validateAndWriteResult(base, sneaky) as { ok: false; errors: string[] };
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("serialized")), JSON.stringify(res.errors));
    assert.ok(res.errors.some((e) => e.includes("cap")));
    assert.ok(!existsSync(join(base, "result.json")), "an over-cap-on-disk payload must not leave a file");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateAndWriteResult: identity binding — foreign task_id/run_id (pattern-valid) refused; the true pair accepted", () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const foreign = { ...validArtifact(), task_id: FOREIGN_TASK_ID, run_id: FOREIGN_RUN_ID };
    assert.equal(validateArtifactStructure(foreign).ok, true, "the foreign pair passes the structural validator — only the binding catches it");
    const res = validateAndWriteResult(base, foreign, { taskId: TASK_ID, runId: RUN_ID }) as { ok: false; errors: string[] };
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("do not match")), JSON.stringify(res.errors));
    assert.ok(res.errors.some((e) => e.includes(TASK_ID)));
    assert.ok(res.errors.some((e) => e.includes(FOREIGN_TASK_ID)));
    assert.ok(!existsSync(join(base, "result.json")), "a foreign-identity artifact must not leave a file");

    const okRes = validateAndWriteResult(base, validArtifact(), { taskId: TASK_ID, runId: RUN_ID });
    assert.equal(okRes.ok, true, "the loaded context's own pair is accepted");
    assert.ok(existsSync(join(base, "result.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SUBMIT_TOOL_PARAMS: strict JSON Schema pinned — additionalProperties:false at every object level, file_location requires path+line", () => {
  const p = SUBMIT_TOOL_PARAMS as unknown as {
    additionalProperties: unknown;
    required: unknown;
    properties: Record<string, { items?: { additionalProperties: unknown; required: unknown; properties: Record<string, unknown> } }>;
  };
  assert.equal(p.additionalProperties, false, "the top level is a closed object");
  assert.deepEqual(p.required, ARTIFACT_REQUIRED_KEYS);
  for (const key of ["artifacts_modified", "feedback_items", "verification_results"]) {
    const items = p.properties[key]!.items!;
    assert.equal(items.additionalProperties, false, `${key}[] entries are closed objects`);
    assert.ok(Array.isArray(items.required) && items.required.length > 0, `${key}[] entries carry required keys`);
  }
  const fl = p.properties["feedback_items"]!.items!.properties["file_location"] as {
    additionalProperties: unknown;
    required: unknown;
  };
  assert.equal(fl.additionalProperties, false);
  assert.deepEqual(fl.required, ["path", "line"], "the pi layer matches the in-process validator's file_location rule");
});

/* ----------------------------- factory (run mode) ----------------------------- */

function buildRunMode(base: string): { pi: PiDouble; runDir: string } {
  const { runDir, contextPath } = seedRunDir(base);
  process.env["NOVAFLOW_RUN_CONTEXT"] = contextPath;
  const pi = fakePi();
  novaflowFactory(pi.api);
  return { pi, runDir };
}

test("run mode: registers novaflow_submit_result and NO slash commands; operator mode the mirror image", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi } = buildRunMode(base);
    assert.deepEqual(pi.tools.map((t) => t.name), [SUBMIT_TOOL_NAME]);
    assert.equal(pi.tools[0]!.name, "novaflow_submit_result");
    assert.deepEqual(pi.commands, [], "run mode registers no operator commands");
    assert.ok(pi.handlers.has("session_start"));
    assert.ok(pi.handlers.has("tool_call"));

    // start the session (the §6 context load point)
    const started = fakeCtx(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, started.ctx);

    // operator mode: no run context env
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    const opPi = fakePi();
    novaflowFactory(opPi.api);
    assert.deepEqual(opPi.tools, [], "operator mode never registers the run-mode tool");
    assert.deepEqual(opPi.commands.map((c) => c.name), ["nova"], "operator mode registers the /nova family");
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: the tool_call hook enforces scopes without terminate on refusal", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    // in scope: no block at all
    const okWrite = await fireToolCall(pi.handlers, "write", { path: join(base, "alpha", "src", "feature.ts") }, base);
    assert.equal(okWrite.result, undefined, "an in-scope write passes through unblocked");

    // reads are never blocked
    const read = await fireToolCall(pi.handlers, "read", { path: join(base, "beta", "data", "notes.txt") }, base);
    assert.equal(read.result, undefined);

    // out of scope: blocked, reason present, NO terminate (the agent retries with feedback)
    const bad = await fireToolCall(pi.handlers, "write", { path: join(base, "alpha", "golden", "x.test") }, base);
    assert.deepEqual(bad.result, { block: true, reason: (bad.result as { reason: string }).reason });
    assert.equal((bad.result as { terminate?: boolean }).terminate, undefined);
    assert.match((bad.result as { reason: string }).reason, /protected/);

    // bash with an out-of-scope redirection: same shape
    const bashBad = await fireToolCall(pi.handlers, "bash", { command: "echo x > alpha/other/o.txt" }, base);
    assert.equal((bashBad.result as { block?: boolean }).block, true);
    assert.equal((bashBad.result as { terminate?: boolean }).terminate, undefined);

    // an in-scope bash call passes
    const bashOk = await fireToolCall(pi.handlers, "bash", { command: "npm test" }, base);
    assert.equal(bashOk.result, undefined);

    // the edit tool is scope-checked like write
    const editBad = await fireToolCall(pi.handlers, "edit", { path: join(base, "beta", "data", "notes.txt") }, base);
    assert.equal((editBad.result as { block?: boolean }).block, true);
    assert.match((editBad.result as { reason: string }).reason, /read_only/);

    // run-mode submission path through the hook (below) uses this same runDir
    assert.ok(existsSync(join(runDir, "engine-context.json")));
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: an unanalyzable bash command warns exactly ONCE, naming the command verbatim, and still runs", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    // a script body: the syntactic scan finds no write target it can judge
    const command = "python -c 'open(\"x\",\"w\")()'";
    const first = await fireToolCall(pi.handlers, "bash", { command }, base);
    assert.equal(first.result, undefined, "the fallback stays permissible: an unanalyzable command is allowed best-effort");
    const warnings = first.notes.filter((n) => n.severity === "warning");
    assert.equal(warnings.length, 1, `exactly one warning, got ${JSON.stringify(first.notes)}`);
    assert.ok(warnings[0]!.message.includes(command), "the warning names the command verbatim");
    assert.match(
      warnings[0]!.message,
      /not provably within scope — allowed as best-effort/,
      "the warning names the scope mechanism in one clause",
    );
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a SECOND unanalyzable bash command in the same session is silent", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const first = await fireToolCall(pi.handlers, "bash", { command: "cat alpha/src/a.ts" }, base);
    assert.equal(first.notes.filter((n) => n.severity === "warning").length, 1, "the first one warns");

    // the pin: not per-command noise — the second occurrence says nothing
    const second = await fireToolCall(pi.handlers, "bash", { command: "git diff --stat" }, base);
    assert.equal(second.result, undefined);
    assert.deepEqual(second.notes, [], "one warning per session — never per-command noise");
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a destructive bash command BLOCKS and never also warns (block wins over warn)", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const blocked = await fireToolCall(pi.handlers, "bash", { command: "rm -rf alpha/golden" }, base);
    assert.equal((blocked.result as { block?: boolean }).block, true, "the destructive path keeps its BLOCK");
    assert.equal((blocked.result as { terminate?: boolean }).terminate, undefined);
    assert.match((blocked.result as { reason: string }).reason, /protected/);
    assert.deepEqual(
      blocked.notes.filter((n) => n.severity === "warning"),
      [],
      "a blocked command never also warns — the block IS the operator-visible signal",
    );

    // the block did not consume the session's one warning
    const unanalyzable = await fireToolCall(pi.handlers, "bash", { command: "cat alpha/src/a.ts" }, base);
    assert.equal(unanalyzable.result, undefined);
    assert.equal(unanalyzable.notes.filter((n) => n.severity === "warning").length, 1);
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a classifiable in-scope bash command neither warns nor blocks — and leaves the one warning unused", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const inScope = await fireToolCall(pi.handlers, "bash", { command: "echo x > alpha/src/log.txt" }, base);
    assert.equal(inScope.result, undefined, "an analyzed in-scope write passes");
    assert.deepEqual(inScope.notes, [], "a classifiable command is not a fallback: no warn, no block");

    // a device sink is adjudicated too (exempt, not unanalyzable)
    const device = await fireToolCall(pi.handlers, "bash", { command: "echo done > /dev/null" }, base);
    assert.equal(device.result, undefined);
    assert.deepEqual(device.notes, [], "the documented device exemption is a verdict, not a fallback");

    // and the session's single warning is still available afterwards
    const unanalyzable = await fireToolCall(pi.handlers, "bash", { command: "git diff --stat" }, base);
    assert.equal(unanalyzable.notes.filter((n) => n.severity === "warning").length, 1);
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: submit_result valid → file written + {block, terminate, reason: 'artifact accepted'}", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const res = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.deepEqual(res.result, { block: true, terminate: true, reason: "artifact accepted" });
    const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(written["task_id"], TASK_ID);
    assert.equal(written["run_id"], RUN_ID);
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: submit_result invalid → structured block error, NO terminate, NO file", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const res = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, { ...validArtifact(), status: "nope" }, base);
    assert.equal((res.result as { block?: boolean }).block, true);
    assert.equal((res.result as { terminate?: boolean }).terminate, undefined);
    assert.match((res.result as { reason: string }).reason, /result\.json rejected/);
    assert.match((res.result as { reason: string }).reason, /"status"/);
    assert.ok(!existsSync(join(runDir, "result.json")), "an invalid submission leaves no file");
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a structurally valid artifact with FOREIGN ids is rejected by the submit identity binding", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const foreign = { ...validArtifact(), task_id: FOREIGN_TASK_ID, run_id: FOREIGN_RUN_ID };
    assert.equal(validateArtifactStructure(foreign).ok, true, "the foreign pair is pattern-valid — only the binding catches it");
    const res = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, foreign, base);
    assert.equal((res.result as { block?: boolean }).block, true);
    assert.equal((res.result as { terminate?: boolean }).terminate, undefined);
    assert.match((res.result as { reason: string }).reason, /do not match/);
    assert.match((res.result as { reason: string }).reason, new RegExp(FOREIGN_TASK_ID));
    assert.ok(!existsSync(join(runDir, "result.json")), "a foreign-identity submission must not leave a file");

    // the true pair is still accepted on the same session
    const okRes = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.deepEqual(okRes.result, { block: true, terminate: true, reason: "artifact accepted" });
    assert.ok(existsSync(join(runDir, "result.json")));
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: an unwritable result.json (pre-created as a directory) returns a structured block reason, never a throw", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);
    mkdirSync(join(runDir, "result.json")); // the EISDIR probe

    // the hook must NOT throw EISDIR through pi's hook runner
    const res = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.equal((res.result as { block?: boolean }).block, true);
    assert.equal((res.result as { terminate?: boolean }).terminate, undefined);
    assert.match((res.result as { reason: string }).reason, /cannot write result\.json/);
    assert.match((res.result as { reason: string }).reason, /EISDIR/);
    assert.ok(statSync(join(runDir, "result.json")).isDirectory(), "the failed write left the directory untouched");
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a mixed batch — the ordinary write passes per-call while the submit terminates per-call", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    // one batch, two per-call results, recorded independently per pi's
    // every-finalized-result rule (the batch all-terminate rule is pi's)
    const writeRes = await fireToolCall(pi.handlers, "write", { path: join(base, "alpha", "src", "batch.ts") }, base);
    assert.equal(writeRes.result, undefined, "the in-scope write's per-call result is a pass-through (not terminating)");
    const submitRes = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.deepEqual(submitRes.result, { block: true, terminate: true, reason: "artifact accepted" });
    assert.ok(existsSync(join(runDir, "result.json")));
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: the acceptance latch — resubmit and post-acceptance mutations are blocked; reads still pass", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);

    const first = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.equal((first.result as { terminate?: boolean }).terminate, true);

    // resubmit: blocked, no terminate
    const resubmit = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.equal((resubmit.result as { block?: boolean }).block, true);
    assert.equal((resubmit.result as { terminate?: boolean }).terminate, undefined);
    assert.match((resubmit.result as { reason: string }).reason, /already accepted/);

    // post-acceptance write — in scope, but the latch owns it now
    const write = await fireToolCall(pi.handlers, "write", { path: join(base, "alpha", "src", "late.ts") }, base);
    assert.equal((write.result as { block?: boolean }).block, true);
    assert.match((write.result as { reason: string }).reason, /already accepted/);

    // post-acceptance bash: MUTATING bash blocks under the latch
    const bash = await fireToolCall(pi.handlers, "bash", { command: "echo x > alpha/src/late.txt" }, base);
    assert.equal((bash.result as { block?: boolean }).block, true);
    assert.match((bash.result as { reason: string }).reason, /already accepted/);

    // post-acceptance ZERO-WRITE bash stays open (re-judge r2 finding 4:
    // the latch is scoped, not wholesale — grep-before-done is honest work)
    const benignBash = await fireToolCall(pi.handlers, "bash", { command: "grep -rn todo alpha/src" }, base);
    assert.equal(benignBash.result, undefined, "a zero-write bash call after acceptance passes the scope check");

    // reads stay open
    const read = await fireToolCall(pi.handlers, "read", { path: join(base, "beta", "data", "notes.txt") }, base);
    assert.equal(read.result, undefined, "a read after acceptance passes unblocked");
    const grep = await fireToolCall(pi.handlers, "grep", { pattern: "notes" }, base);
    assert.equal(grep.result, undefined);

    // and result.json was written exactly once, with the true identity
    const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(written["task_id"], TASK_ID);
    assert.equal(written["run_id"], RUN_ID);
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: a context that failed to load fails CLOSED on every mutating call", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    // env points at a context that does not exist
    process.env["NOVAFLOW_RUN_CONTEXT"] = join(base, ".novaflow", "runs", TASK_ID, RUN_ID, "engine-context.json");
    const pi = fakePi();
    novaflowFactory(pi.api);
    const started = fakeCtx(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, started.ctx);
    assert.ok(
      started.notes.some((n) => n.severity === "error" && /failed to load/.test(n.message)),
      "session_start reports the load failure",
    );

    const write = await fireToolCall(pi.handlers, "write", { path: join(base, "anywhere.txt") }, base);
    assert.equal((write.result as { block?: boolean }).block, true);
    assert.match((write.result as { reason: string }).reason, /failing closed/);

    const bash = await fireToolCall(pi.handlers, "bash", { command: "echo x > f.txt" }, base);
    assert.equal((bash.result as { block?: boolean }).block, true);
    assert.match((bash.result as { reason: string }).reason, /failing closed/);

    const submit = await fireToolCall(pi.handlers, SUBMIT_TOOL_NAME, validArtifact(), base);
    assert.equal((submit.result as { block?: boolean }).block, true);
    assert.equal((submit.result as { terminate?: boolean }).terminate, undefined);
    assert.ok(!existsSync(join(base, ".novaflow", "runs", TASK_ID, RUN_ID, "result.json")));
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("run mode: the registered tool carries the completion-signal contract (description, snippet, terminate-capable execute)", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  try {
    const { pi, runDir } = buildRunMode(base);
    await pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);
    const tool = pi.tools[0]!;
    assert.equal(tool.name, SUBMIT_TOOL_NAME);
    assert.ok(tool.description.length > 20, "the model sees a real description");
    assert.ok(tool.promptSnippet !== undefined, "the tool appears in the prompt's tools section");
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);

    // the execute() fallback (defense in depth for paths that skip the
    // hook) writes the artifact and returns terminate — the doc's
    // structured-output shape
    const exec = await tool.execute("call_z", validArtifact(), undefined, undefined, fakeCtx(base).ctx as never);
    assert.equal(exec.terminate, true);
    assert.ok(existsSync(join(runDir, "result.json")));
    // the acceptance latch: a second execute on the same session is refused
    await assert.rejects(
      tool.execute("call_z2", validArtifact(), undefined, undefined, fakeCtx(base).ctx as never),
      /already accepted/,
    );
    // and a FRESH session still reports the structured rejection for invalid input
    const { pi: pi2 } = buildRunMode(base);
    await pi2.handlers.get("session_start")!({ type: "session_start", reason: "startup" } as SessionStartEvent, fakeCtx(base).ctx);
    await assert.rejects(
      pi2.tools[0]!.execute("call_z3", { ...validArtifact(), status: "nope" }, undefined, undefined, fakeCtx(base).ctx as never),
      /rejected/,
    );
  } finally {
    delete process.env["NOVAFLOW_RUN_CONTEXT"];
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------ operator (no daemon needed) ------------------------------ */

test("operator mode: /nova renders a dead socket as the exit-5-style structured error", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  delete process.env["NOVAFLOW_RUN_CONTEXT"];
  process.env["NOVAFLOW_SOCK"] = join(base, "missing.sock");
  try {
    const { ctx, notes } = fakeCtx(base);
    await runNovaCommand("status", ctx as never);
    assert.ok(notes.length > 0, "the failure is rendered to the chat, not thrown at the user");
    const err = notes.find((n) => n.severity === "error");
    assert.ok(err !== undefined, "a dead socket renders as an error notification");
    assert.match(err!.message, /daemon unreachable/);
    assert.match(err!.message, /exit 5/);
    assert.match(err!.message, /nova daemon start/);
  } finally {
    delete process.env["NOVAFLOW_SOCK"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("operator mode: unknown or malformed /nova subcommands render usage, never a throw", async () => {
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  delete process.env["NOVAFLOW_RUN_CONTEXT"];
  process.env["NOVAFLOW_SOCK"] = join(base, "missing.sock");
  try {
    for (const args of ["", "bogus", "gate", "gate approve", "gate deny T1", "gate reject T1"]) {
      const { ctx, notes } = fakeCtx(base);
      await runNovaCommand(args, ctx as never);
      assert.ok(notes.length > 0, `usage is rendered for "${args}"`);
    }
    // the unknown subcommand names itself
    const unknown = fakeCtx(base);
    await runNovaCommand("bogus", unknown.ctx as never);
    assert.ok(unknown.notes.some((n) => /bogus/.test(n.message)));
  } finally {
    delete process.env["NOVAFLOW_SOCK"];
    rmSync(base, { recursive: true, force: true });
  }
});

test("daemonRequest (ported client) honors NOVAFLOW_SOCK and frames surface 'human'", async () => {
  // a one-line echo server pinning the wire frame the ported client sends
  const base = mkdtempSync(join(tmpdir(), "novaflow-ext-"));
  const sockPath = join(base, "novaflow.sock");
  const server = createEchoServer(sockPath);
  await server.ready;
  try {
    process.env["NOVAFLOW_SOCK"] = sockPath;
    const data = (await daemonRequest("nova_daemon_status", { x: 1 })) as { echoed?: boolean };
    assert.equal(data["echoed"], true, "the ported client unwraps the daemon's data envelope");
    const frame = server.lastFrame as Record<string, unknown>;
    assert.equal(frame["op"], "nova_daemon_status");
    assert.equal(frame["surface"], "human", "the audit attribution is pinned (client.ts: surface 'human')");
    assert.equal((frame["args"] as Record<string, unknown>)["x"], 1);
    assert.ok(typeof frame["id"] === "string" && (frame["id"] as string).length > 0);
  } finally {
    delete process.env["NOVAFLOW_SOCK"];
    server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

/* --------------------------------- helpers ---------------------------------- */

function createEchoServer(sockPath: string): { ready: Promise<void>; lastFrame: unknown; close: () => void } {
  const state = { lastFrame: undefined as unknown };
  const server: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          state.lastFrame = JSON.parse(line);
        } catch {
          state.lastFrame = line;
        }
        sock.write(JSON.stringify({ ok: true, data: { echoed: true } }) + "\n");
      }
    });
  });
  const ready = new Promise<void>((resolveJwt, reject) => {
    server.once("listening", () => resolveJwt());
    server.once("error", reject);
  });
  server.listen(sockPath);
  return {
    ready,
    get lastFrame(): unknown {
      return state.lastFrame;
    },
    close: () => server.close(),
  };
}
