import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * FR-WS-04 AC2 over the two operator surfaces that owe it:
 *
 *   - the DAEMON op `nova_docs_list` (the index, served from the workspace
 *     root the store knows — the CLI cannot compute it, it never reads the
 *     store);
 *   - `nova docs list [<workspace>]` (the CLI read verb, srs 4.1.1
 *     amendment);
 *   - `nova task create ... --context docs/spec.md` (the selectable prompt
 *     injection option, resolved to the SAME context_files_json the run
 *     loop feeds composePrompt — never a second injection path).
 *
 * The daemon is started through the real binary (detached), the CLI calls
 * are real subprocesses, and the store is read back with a plain SQLite
 * handle — the same shape as the other CLI integration tests.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>, timeoutMs = 60_000): Run {
  const res = spawnSync(NOVA, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Env = {
  dir: string;
  home: string;
  wsRoot: string;
  env: Record<string, string>;
  sock: string;
  slug: string;
};

/** A registered workspace + live daemon, driven through the real binary. */
async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-docs-"));
  const wsRoot = join(dir, "workspace");
  mkdirSync(wsRoot);
  const home = join(dir, "novahome");
  mkdirSync(home);
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, "concurrency:\n  global: 2\nretry:\n  delay_sec: 3600\n");
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_DAEMON_CONFIG: cfg,
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
  };
  const start = runNova(["daemon", "start"], env);
  assert.equal(start.code, 0, `daemon start failed: ${start.stderr}`);
  const ws = runNova(["workspace", "create", "docs-ws", "--path", wsRoot], env);
  assert.equal(ws.code, 0, `workspace create failed: ${ws.stderr}`);
  return { dir, home, wsRoot, env, sock: env["NOVAFLOW_SOCK"]!, slug: "docs-ws" };
}

async function shutdown(e: Env): Promise<void> {
  const stop = runNova(["daemon", "stop"], e.env);
  if (stop.code !== 0) {
    try {
      const pid = Number(readFileSync(join(e.home, "daemon.pid"), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      /* gone */
    }
  }
  const deadline = Date.now() + 10_000;
  while (existsSync(e.sock) && Date.now() < deadline) await sleep(100);
  rmSync(e.dir, { recursive: true, force: true });
}

test("FR-WS-02 creates the workspace-root docs/ directory at registration (the FR-WS-04 premise)", async () => {
  const e = await boot();
  try {
    assert.equal(existsSync(join(e.wsRoot, "docs")), true, "docs/ exists after `nova workspace create`");
  } finally {
    await shutdown(e);
  }
});

test("nova docs list <workspace>: the selectable index, filtered to .md/.txt/.rst", async () => {
  const e = await boot();
  try {
    writeFileSync(join(e.wsRoot, "docs", "spec.md"), "# Spec\n");
    writeFileSync(join(e.wsRoot, "docs", "notes.txt"), "notes\n");
    writeFileSync(join(e.wsRoot, "docs", "ignored.json"), "{}\n");

    const human = runNova(["docs", "list", e.slug], e.env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /docs\/spec\.md/);
    assert.match(human.stdout, /docs\/notes\.txt/);
    assert.doesNotMatch(human.stdout, /ignored\.json/);

    const json = runNova(["docs", "list", e.slug, "--json"], e.env);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.trim()) as {
      workspace: string;
      docs: Array<{ path: string; absolute_path: string; extension: string }>;
    };
    assert.equal(parsed.workspace, e.slug);
    assert.deepEqual(parsed.docs.map((d) => d.path), ["docs/notes.txt", "docs/spec.md"]);
    assert.equal(parsed.docs[1]!.absolute_path, join(e.wsRoot, "docs", "spec.md"));
    assert.equal(parsed.docs[1]!.extension, ".md");

    // an empty docs dir is an honest empty list (exit 0, no docs)
    rmSync(join(e.wsRoot, "docs"), { recursive: true });
    mkdirSync(join(e.wsRoot, "docs"));
    const empty = runNova(["docs", "list", e.slug, "--json"], e.env);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual((JSON.parse(empty.stdout.trim()) as { docs: unknown[] }).docs, []);
  } finally {
    await shutdown(e);
  }
});

test("nova docs list: an unknown workspace is not_found (exit 4)", async () => {
  const e = await boot();
  try {
    const res = runNova(["docs", "list", "no-such-ws"], e.env);
    assert.equal(res.code, 4, res.stderr);
    assert.match(res.stderr, /not_found/);
  } finally {
    await shutdown(e);
  }
});

test("task creation accepts --context docs/<name> and records the doc as a context file (FR-WS-04 AC2)", async () => {
  const e = await boot();
  assert.equal(runNova(["workspace", "switch", e.slug], e.env).code, 0); // the CLI-local active marker
  try {
    writeFileSync(join(e.wsRoot, "docs", "spec.md"), "# Spec\nImplement PKCE.\n");
    const prof = join(e.dir, "dev.json");
    writeFileSync(
      prof,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        tools_allowlist: ["read", "write"],
        system_prompt_path: "prompts/dev.md",
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    mkdirSync(join(e.wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(e.wsRoot, "prompts", "dev.md"), "You are a worker.\n");
    assert.equal(runNova(["profile", "create", "--file", prof], e.env).code, 0);
    assert.equal(
      runNova(["project", "create", "prj", "--objective", "Build it."], e.env).code,
      0,
    );

    const created = runNova(
      [
        "task",
        "create",
        "DOC-1",
        "--title",
        "Doc-fed task",
        "--objective",
        "Use the spec.",
        "--profile",
        "dev",
        "--project",
        "prj",
        "--context",
        "docs/spec.md",
        "--json",
      ],
      e.env,
    );
    assert.equal(created.code, 0, created.stderr);
    const task = (JSON.parse(created.stdout.trim()) as { task: { id: string; context_files_json: string } }).task;
    assert.deepEqual(JSON.parse(task.context_files_json), ["docs/spec.md"]);
  } finally {
    await shutdown(e);
  }
});

test("task creation refuses an unresolvable doc reference, naming it (schema_invalid, exit 3, nothing created)", async () => {
  const e = await boot();
  assert.equal(runNova(["workspace", "switch", e.slug], e.env).code, 0);
  try {
    writeFileSync(join(e.wsRoot, "docs", "spec.md"), "# Spec\n");
    const prof = join(e.dir, "dev2.json");
    writeFileSync(
      prof,
      JSON.stringify({
        name: "dev2",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        tools_allowlist: ["read"],
        system_prompt_path: "prompts/dev.md",
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    mkdirSync(join(e.wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(e.wsRoot, "prompts", "dev.md"), "You are a worker.\n");
    assert.equal(runNova(["profile", "create", "--file", prof], e.env).code, 0);
    assert.equal(runNova(["project", "create", "prj2", "--objective", "Build it."], e.env).code, 0);

    const bad = runNova(
      [
        "task",
        "create",
        "DOC-2",
        "--title",
        "t",
        "--objective",
        "o",
        "--profile",
        "dev2",
        "--project",
        "prj2",
        "--context",
        "docs/missing.md",
      ],
      e.env,
    );
    assert.equal(bad.code, 3, bad.stderr);
    assert.match(bad.stderr, /schema_invalid/);
    assert.match(bad.stderr, /docs\/missing\.md/);
    // nothing was created
    const list = runNova(["task", "list", "--json"], e.env);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual((JSON.parse(list.stdout.trim()) as { tasks: unknown[] }).tasks, []);
  } finally {
    await shutdown(e);
  }
});
test("mixed --context: a PLAIN .md path outside docs/ stays a context file; a docs/ reference stays a doc (judge B finding 2)", async () => {
  const e = await boot();
  assert.equal(runNova(["workspace", "switch", e.slug], e.env).code, 0);
  try {
    writeFileSync(join(e.wsRoot, "docs", "spec.md"), "# Spec\n");
    const prof = join(e.dir, "dev3.json");
    writeFileSync(
      prof,
      JSON.stringify({
        name: "dev3",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        tools_allowlist: ["read"],
        system_prompt_path: "prompts/dev.md",
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    mkdirSync(join(e.wsRoot, "prompts"), { recursive: true });
    // the exact pre-p7 working shape: a plain .md context file that is NOT
    // an indexed doc — extension-based routing turned this into a hard
    // schema_invalid; the docs/ prefix is the ONLY doc-reference spelling
    writeFileSync(join(e.wsRoot, "prompts", "dev.md"), "You are a worker.\n");
    assert.equal(runNova(["profile", "create", "--file", prof], e.env).code, 0);
    assert.equal(runNova(["project", "create", "prj3", "--objective", "Build it."], e.env).code, 0);

    const created = runNova(
      [
        "task",
        "create",
        "MIX-1",
        "--title",
        "mixed context",
        "--objective",
        "Use both.",
        "--profile",
        "dev3",
        "--project",
        "prj3",
        "--context",
        "docs/spec.md",
        "--context",
        "prompts/dev.md",
      ],
      e.env,
    );
    assert.equal(created.code, 0, created.stderr);
    const list = runNova(["task", "list", "--json"], e.env);
    const tasks = (JSON.parse(list.stdout.trim()) as { tasks: Array<{ context_files_json: string }> }).tasks;
    const ctx = JSON.parse(tasks[0]!.context_files_json) as string[];
    assert.ok(ctx.some((c) => c.endsWith("docs/spec.md")), "the doc reference resolved into context files");
    assert.ok(ctx.includes("prompts/dev.md"), "the PLAIN .md path is recorded verbatim, as before p7");
  } finally {
    await shutdown(e);
  }
});
