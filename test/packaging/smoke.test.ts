import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The tarball smoke test (novaflow-v030 W3 / R3.2): pack, install into a temp
 * prefix, `nova --version`, `nova daemon start --migrate` against a temp store,
 * then ONE task end to end — pinned to `opencode-go/deepseek-v4.1-flash`, a
 * 3-line objective, `max_cost_usd: 0.05` in the task's overrides, asserting
 * `completed` and `cost_basis: priced`.
 *
 * GUARDED: this test spends money and needs a live Pi with working credentials,
 * network access for better-sqlite3's install script, and a git 2.40+. Run it
 * with NOVAFLOW_SMOKE=1 when proving a release; without the flag it skips with
 * one line naming what it needs. Every step is asserted with the STAGE in the
 * message, so a red run says whether the package or the live model failed
 * (the card's risk: "a smoke test that needs live credentials can fail for
 * reasons unrelated to the package").
 */

const REPO = join(import.meta.dirname, "..", "..");
const SKIP_REASON =
  "tarball smoke needs NOVAFLOW_SMOKE=1 plus a live pi with credentials for " +
  "opencode-go/deepseek-v4.1-flash, network for better-sqlite3, and git >= 2.40";

/** FR-AGT-03 / data 4.3: the task-level overrides key. */
const MODEL = "opencode-go/deepseek-v4.1-flash";
const COST_CAP_USD = 0.05;

type Run = { code: number; stdout: string; stderr: string };

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Run {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, env });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("tarball smoke: pack → global install → --version → daemon --migrate → one task priced under the cap", (t) => {
  if (process.env["NOVAFLOW_SMOKE"] !== "1") {
    t.skip(`skipped — ${SKIP_REASON}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "novaflow-smoke-"));
  const pkgDir = join(dir, "pkg");
  const prefix = join(dir, "prefix");
  const home = join(dir, "novahome");
  const wsRoot = join(dir, "wsroot");
  const target = join(dir, "target");
  for (const d of [pkgDir, home, wsRoot, target]) mkdirSync(d, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(prefix, "bin")}:${process.env["PATH"] ?? ""}`,
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_WATCH_MS: "250",
  };
  const nova = join(prefix, "bin", "nova");
  const run = (args: string[], timeoutMs = 120_000): Run => sh(nova, args, wsRoot, env, timeoutMs);

  try {
    // ---- 1. pack this checkout -------------------------------------------
    const pack = sh("npm", ["pack", "--pack-destination", pkgDir], REPO, env, 300_000);
    assert.equal(pack.code, 0, `[pack] npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
    const tgzName = readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
    assert.ok(tgzName !== undefined, "[pack] npm packed nothing");
    const tgz = join(pkgDir, tgzName);

    // ---- 2. install the artifact into a temp GLOBAL prefix ----------------
    // `-g --prefix` is what puts the bin link at <prefix>/bin/nova; a bare
    // `--prefix` install would only create <prefix>/node_modules/.bin/nova.
    const install = sh("npm", ["install", "-g", "--prefix", prefix, tgz], dir, env, 600_000);
    assert.equal(install.code, 0, `[install] npm install -g failed:\n${install.stdout}\n${install.stderr}`);
    assert.ok(existsSync(nova), "[install] the installed package has no <prefix>/bin/nova");

    // ---- 3. the packaged CLI runs offline --------------------------------
    const version = sh(nova, ["--version"], dir, env, 60_000);
    assert.equal(version.code, 0, `[version] nova --version exited ${version.code}: ${version.stderr}`);
    assert.match(version.stdout, /^nova \d+\.\d+\.\d+ \(novaflow\)$/m, "[version] unexpected version line");

    // ---- 4. daemon boots and migrates a temp store -----------------------
    const start = run(["daemon", "start", "--migrate"]);
    assert.equal(start.code, 0, `[daemon] nova daemon start --migrate failed:\n${start.stdout}\n${start.stderr}`);
    assert.ok(existsSync(join(home, "state.db")), "[daemon] the temp store was not created");

    // ---- 5. one workspace / project / profile ----------------------------
    const ws = run(["workspace", "create", "smoke", "--path", wsRoot]);
    assert.equal(ws.code, 0, `[workspace] create failed: ${ws.stderr}`);
    const sw = run(["workspace", "switch", "smoke"]);
    assert.equal(sw.code, 0, `[workspace] switch failed: ${sw.stderr}`);
    const proj = run(["project", "create", "smoke", "--objective", "Prove the packed CLI runs a task end to end.", "--target", `work=${target}`]);
    assert.equal(proj.code, 0, `[project] create failed: ${proj.stderr}`);

    mkdirSync(join(wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(wsRoot, "prompts", "smoke_system.md"), "You are a smoke-test worker. Do exactly what the objective says.\n");
    const profilePath = join(dir, "smoke.json");
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: "smoke",
        provider: "opencode-go",
        // pi is addressed by its full identity; `provider` above is the same
        // provider recorded on the row (data 4.2 keeps the two fields).
        model: MODEL,
        system_prompt_path: "prompts/smoke_system.md",
        tools_allowlist: ["read", "write", "bash"],
        limits: { max_timeout_sec: 600, max_cost_usd: COST_CAP_USD },
      }),
    );
    const prof = run(["profile", "create", "--file", profilePath]);
    assert.equal(prof.code, 0, `[profile] create failed: ${prof.stderr}`);

    // ---- 6. ONE task, through a chain import: overrides live there -------
    // `nova task create` has no override flag; data 4.3's chain member
    // `overrides` is the documented surface for `max_cost_usd`, so the smoke
    // task is imported as a one-task chain (DEBT-013: empty edges are legal).
    const chainPath = join(dir, "chain.json");
    writeFileSync(
      chainPath,
      JSON.stringify({
        version: "1.0.0",
        project_slug: "smoke",
        tasks: [
          {
            key: "SMOKE-1",
            title: "Smoke",
            objective: "Create the file smoke.txt in the target root.\nIt must contain exactly one line: smoke.\nChange nothing else.",
            profile_name: "smoke",
            overrides: { max_cost_usd: COST_CAP_USD },
            target_scopes: [{ repo_alias: "work", access_mode: "read_write" }],
          },
        ],
        edges: [],
      }),
    );
    const imported = run(["project", "import-dag", chainPath, "--project", "smoke"]);
    assert.equal(imported.code, 0, `[import] project import-dag failed:\n${imported.stdout}\n${imported.stderr}`);

    // ---- 7. run it to a terminal state -----------------------------------
    const ran = run(["task", "run", "SMOKE-1", "--watch"], 900_000);
    assert.equal(ran.code, 0, `[run] the task did not complete:\n${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /SUCCESS task completed/, "[run] the task's final status was not completed");

    const status = run(["task", "status", "SMOKE-1", "--json"]);
    assert.equal(status.code, 0, `[status] task status failed: ${status.stderr}`);
    const data = JSON.parse(status.stdout) as {
      task: { state: string };
      current_run: { status: string; cost_usd: number; cost_basis: string } | null;
    };
    assert.equal(data.task.state, "completed", "[status] the task is not in `completed`");
    assert.ok(data.current_run !== null, "[status] the task has no run row");
    assert.equal(data.current_run?.status, "completed", "[status] the run is not `completed`");
    assert.equal(data.current_run?.cost_basis, "priced", "[status] the cost was not priced from recorded usage");
    assert.ok(
      (data.current_run?.cost_usd ?? Infinity) <= COST_CAP_USD,
      `[status] cost ${String(data.current_run?.cost_usd)} exceeded the ${COST_CAP_USD} USD cap`,
    );
  } finally {
    if (existsSync(nova)) {
      sh(nova, ["daemon", "stop"], dir, env, 60_000);
      const pidFile = join(home, "daemon.pid");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
