import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERBS, verbKey } from "../../src/cli/verbs.ts";

/**
 * `--json` on EVERY read verb — audited against the verb table, then proven
 * through the real binary against a real daemon (W4, the card's step 5).
 *
 * The audit found no gaps in v0.3.0 (every read verb already prints one JSON
 * document), so this file is what keeps that true: it walks `VERBS`, drives
 * every `kind: "read"` verb with `--json`, and requires the driven set to
 * EQUAL the table's read set. A new read verb that ignores `--json` fails
 * here (and in test/cli/help.test.ts's table audit) rather than shipping a
 * human-only surface.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>): Run {
  const res = spawnSync(NOVA, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type Home = { dir: string; home: string; wsRoot: string; env: Record<string, string> };

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-json-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot);
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "5000",
    NOVAFLOW_WATCH_MS: "200",
  };
  return { dir, home, wsRoot, env };
}

async function forceStopDaemon(h: Home): Promise<void> {
  const stop = runNova(["daemon", "stop"], h.env);
  if (stop.code !== 0) {
    const pidFile = join(h.home, "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        try {
          process.kill(-pid, sig);
          process.kill(pid, sig);
        } catch {
          // already gone
        }
      }
    }
  }
  rmSync(h.dir, { recursive: true, force: true });
}

function oneMemberGraph(projectSlug: string): string {
  return JSON.stringify({
    version: "1.0.0",
    project_slug: projectSlug,
    tasks: [
      {
        key: "D1",
        title: "Chain member",
        objective: "The objective of the chain member.",
        profile_name: "dev",
        target_scopes: [{ repo_alias: "code", access_mode: "read_write" }],
      },
    ],
    edges: [],
  });
}

test("every read verb prints one JSON document under --json (driven from the verb table)", async () => {
  const h = makeHome();
  const driven: string[] = [];
  try {
    assert.equal(runNova(["daemon", "start"], h.env).code, 0, "daemon start");
    assert.equal(runNova(["workspace", "create", "alpha", "--path", h.wsRoot], h.env).code, 0);
    assert.equal(runNova(["workspace", "switch", "alpha"], h.env).code, 0);
    const profileSrc = join(h.dir, "dev.json");
    writeFileSync(
      profileSrc,
      JSON.stringify({
        name: "dev",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking_level: "medium",
        system_prompt_path: "prompts/dev_system.md",
        tools_allowlist: ["bash", "read"],
        limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
      }),
    );
    assert.equal(runNova(["profile", "create", "--file", profileSrc], h.env).code, 0);
    mkdirSync(join(h.wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(h.wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
    assert.equal(
      runNova(["project", "create", "app", "--objective", "Ship it.", "--target", `code=${h.wsRoot}`], h.env).code,
      0,
    );
    assert.equal(
      runNova(
        ["task", "create", "K1", "--title", "Do it", "--objective", "Do it end to end.", "--profile", "dev", "--project", "app", "--scope", "code"],
        h.env,
      ).code,
      0,
    );
    const ran = runNova(["task", "run", "K1", "--watch"], h.env);
    assert.equal(ran.code, 0, `task run --watch: ${ran.stderr}`);

    const graphFile = join(h.dir, "chain.json");
    writeFileSync(graphFile, oneMemberGraph("app"));
    const imported = runNova(["project", "import-dag", graphFile, "--json"], h.env);
    assert.equal(imported.code, 0, imported.stderr);
    const chainId = (JSON.parse(imported.stdout) as { chain_run_id: string }).chain_run_id;
    const chainRan = runNova(["task", "run", "D1", "--watch"], h.env);
    assert.equal(chainRan.code, 0, `chain member run: ${chainRan.stderr}`);

    const readJson = (verb: string, argv: string[]): Record<string, unknown> => {
      const res = runNova([...argv, "--json"], h.env);
      assert.equal(res.code, 0, `${argv.join(" ")} --json exited ${res.code}: ${res.stderr}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        assert.fail(`${argv.join(" ")} --json is not one JSON document:\n${res.stdout}`);
      }
      assert.equal(typeof parsed, "object");
      assert.notEqual(parsed, null);
      assert.equal(res.stderr, "", `${argv.join(" ")} --json wrote to stderr`);
      driven.push(verb);
      return parsed as Record<string, unknown>;
    };

    // every read verb, with the arguments the seeded home can answer
    const workspaces = readJson("nova workspace list", ["workspace", "list"]);
    assert.equal((workspaces["workspaces"] as unknown[]).length, 1);
    const projects = readJson("nova project list", ["project", "list"]);
    assert.equal((projects["projects"] as unknown[]).length, 1);
    const project = readJson("nova project status", ["project", "status", "app"]);
    assert.equal((project["project"] as Record<string, unknown>)["slug"], "app");
    const profiles = readJson("nova profile list", ["profile", "list"]);
    assert.equal((profiles["profiles"] as unknown[]).length, 1);
    readJson("nova profile validate", ["profile", "validate", "dev"]);
    const tasks = readJson("nova task list", ["task", "list"]);
    assert.ok((tasks["tasks"] as Array<{ key: string }>).some((t) => t.key === "K1"));
    const task = readJson("nova task status", ["task", "status", "K1"]);
    assert.equal((task["task"] as Record<string, unknown>)["state"], "completed");
    const result = readJson("nova task result", ["task", "result", "K1"]);
    assert.match(String(result["run_id"]), /[0-9A-Z]{26}/);
    const logs = readJson("nova task logs", ["task", "logs", "K1"]);
    assert.ok(Array.isArray(logs["lines"]));
    readJson("nova schedule list", ["schedule", "list"]);
    const daemon = readJson("nova daemon status", ["daemon", "status"]);
    assert.equal(typeof daemon["version"], "string");
    readJson("nova daemon logs", ["daemon", "logs"]);
    const status = readJson("nova status", ["status"]);
    assert.equal(typeof (status["daemon"] as Record<string, unknown>)["scheduler"], "object");
    readJson("nova web status", ["web", "status"]);
    const version = readJson("nova version", ["version"]);
    assert.equal(typeof version["version"], "string");
    const chains = readJson("nova chain list", ["chain", "list"]);
    assert.equal((chains["chains"] as unknown[]).length, 1);
    const chain = readJson("nova chain status", ["chain", "status", chainId]);
    assert.equal((chain["chain"] as Record<string, unknown>)["id"], chainId);
    readJson("nova chain verify", ["chain", "verify", chainId]);
    const docs = readJson("nova docs list", ["docs", "list"]);
    assert.ok(Array.isArray(docs["docs"]));

    // the audit's teeth: every read verb in the table was actually driven
    const readVerbs = VERBS.filter((verb) => verb.kind === "read").map(verbKey);
    assert.deepEqual([...driven].sort(), [...readVerbs].sort(), "a read verb is missing from the --json proof");
  } finally {
    await forceStopDaemon(h);
  }
});
