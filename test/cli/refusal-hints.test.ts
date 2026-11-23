import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R4.3 through the operator's own interface: the two refusals an operator
 * actually hits through `bin/nova` — a bad chain graph on import, and an
 * unscoped `nova task run` — end with the next move (` — fix: …`) and leave
 * the store untouched. The third fixed refusal (the inert-prices note) is a
 * run-record line, asserted in test/cli/fixhint.test.ts.
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
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-fix-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  const wsRoot = join(dir, "wsroot");
  mkdirSync(join(wsRoot, "prompts"), { recursive: true });
  writeFileSync(join(wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
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

test("the P13 refusals name the next move too (daemon, workspace, project, task, profile, flags)", async () => {
  const h = makeHome();
  try {
    assert.equal(runNova(["daemon", "start"], h.env).code, 0);

    // ---- daemon start: a live daemon already answers ----
    const secondDaemon = runNova(["daemon", "start"], h.env);
    assert.equal(secondDaemon.code, 1, secondDaemon.stderr);
    assert.match(secondDaemon.stderr, /live daemon/);
    assert.match(secondDaemon.stderr, / — fix: /, "the daemon refusal names no fix");
    assert.match(secondDaemon.stderr, /nova daemon status/, "the fix names the next command");

    // ---- workspace create: the name rule and the path rule ----
    const badName = runNova(["workspace", "create", "Bad_Name", "--path", h.wsRoot], h.env);
    assert.equal(badName.code, 3, badName.stderr);
    assert.match(badName.stderr, /kebab-case/);
    assert.match(badName.stderr, / — fix: /, "the name refusal names no fix");
    const badPath = runNova(["workspace", "create", "alpha", "--path", join(h.dir, "absent")], h.env);
    assert.equal(badPath.code, 3, badPath.stderr);
    assert.match(badPath.stderr, /root_path/);
    assert.match(badPath.stderr, / — fix: /, "the path refusal names no fix");

    // a real workspace + profile + project, so the not-found refusals are real
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
    assert.equal(
      runNova(["project", "create", "app", "--objective", "Ship it.", "--target", `code=${h.wsRoot}`], h.env).code,
      0,
    );

    // ---- no project, no such task, pinned profile ----
    const noProject = runNova(
      ["task", "create", "K2", "--title", "Do it", "--objective", "Do it.", "--profile", "dev", "--project", "nope"],
      h.env,
    );
    assert.equal(noProject.code, 4, noProject.stderr);
    assert.match(noProject.stderr, /no project "nope"/);
    assert.match(noProject.stderr, / — fix: /, "the project refusal names no fix");

    const noTask = runNova(["task", "status", "NOPE"], h.env);
    assert.equal(noTask.code, 4, noTask.stderr);
    assert.match(noTask.stderr, /no (such task|task with key)/);
    assert.match(noTask.stderr, / — fix: /, "the task refusal names no fix");

    const created = runNova(
      ["task", "create", "K1", "--title", "Do it", "--objective", "Do it.", "--profile", "dev", "--project", "app"],
      h.env,
    );
    assert.equal(created.code, 0, created.stderr);
    const pinned = runNova(["profile", "delete", "dev"], h.env);
    assert.equal(pinned.code, 3, pinned.stderr);
    assert.match(pinned.stderr, /pinned by 1 task/);
    assert.match(pinned.stderr, / — fix: /, "the pinned-profile refusal names no fix");

    // ---- usage flags: each names the rule AND the move ----
    const retention = runNova(["daemon", "prune", "--retention-days", "-1"], h.env);
    assert.equal(retention.code, 2, retention.stderr);
    assert.match(retention.stderr, /--retention-days/);
    assert.match(retention.stderr, / — fix: /, "the retention flag names no fix");
    const lines = runNova(["daemon", "logs", "--lines", "0"], h.env);
    assert.equal(lines.code, 2, lines.stderr);
    assert.match(lines.stderr, /--lines/);
    assert.match(lines.stderr, / — fix: /, "the --lines flag names no fix");
    const watchMs = runNova(["status", "--watch"], { ...h.env, NOVAFLOW_STATUS_WATCH_MS: "10" });
    assert.equal(watchMs.code, 2, watchMs.stderr);
    assert.match(watchMs.stderr, /NOVAFLOW_STATUS_WATCH_MS/);
    assert.match(watchMs.stderr, / — fix: /, "the watch-interval flag names no fix");

    // ---- disabled workspace: archived execution is refused before any write ----
    assert.equal(runNova(["workspace", "archive", "alpha"], h.env).code, 0);
    const disabled = runNova(["task", "run", "K1"], h.env);
    assert.equal(disabled.code, 1, disabled.stderr);
    assert.match(disabled.stderr, /execution is disabled/);
    assert.match(disabled.stderr, / — fix: /, "the archived-workspace refusal names no fix");
    const status = JSON.parse(runNova(["task", "status", "K1", "--json"], h.env).stdout) as {
      task: { state: string };
    };
    assert.equal(status.task.state, "draft", "the refused run wrote nothing");
  } finally {
    await forceStopDaemon(h);
  }
});

test("the two worst CLI refusals name the next move (import schema_invalid, unscoped run)", async () => {
  const h = makeHome();
  try {
    assert.equal(runNova(["daemon", "start"], h.env).code, 0);
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
    assert.equal(
      runNova(["project", "create", "app", "--objective", "Ship it.", "--target", `code=${h.wsRoot}`], h.env).code,
      0,
    );

    // ---- 1. a bad graph: schema_invalid (exit 3) + the fix ----
    const badGraph = join(h.dir, "bad.json");
    writeFileSync(
      badGraph,
      JSON.stringify({ version: "1.0.0", tasks: [{ key: "A", title: "A", objective: "o", profile_name: "dev" }], edges: [] }),
    );
    const imported = runNova(["project", "import-dag", badGraph], h.env);
    assert.equal(imported.code, 3, imported.stderr);
    assert.match(imported.stderr, /schema_invalid/);
    assert.match(imported.stderr, /project_slug/, "the refusal names the missing key");
    assert.match(imported.stderr, / — fix: /, "the refusal names no fix");
    assert.match(imported.stderr, /nova project import-dag <file>/, "the fix names the command to re-run");
    // nothing was written: the project has no chains
    const chains = JSON.parse(runNova(["chain", "list", "--json"], h.env).stdout) as { chains: unknown[] };
    assert.deepEqual(chains.chains, []);

    // ---- 2. an unscoped run: schema_invalid (exit 3) + the fix ----
    const created = runNova(
      ["task", "create", "K1", "--title", "Do it", "--objective", "Do it.", "--profile", "dev", "--project", "app"],
      h.env,
    );
    assert.equal(created.code, 0, created.stderr);
    const ran = runNova(["task", "run", "K1"], h.env);
    assert.equal(ran.code, 3, ran.stderr);
    assert.match(ran.stderr, /no target_scopes/);
    assert.match(ran.stderr, / — fix: /, "the refusal names no fix");
    assert.match(ran.stderr, /--scope <repo_alias>/);
    assert.match(ran.stderr, /nova task run <id\|key>/);
    // the task stayed draft (the guard refuses before any state write)
    const status = JSON.parse(runNova(["task", "status", "K1", "--json"], h.env).stdout) as {
      task: { state: string };
    };
    assert.equal(status.task.state, "draft");
  } finally {
    await forceStopDaemon(h);
  }
});
