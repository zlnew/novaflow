import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../daemon/client.ts";

/**
 * `nova chain …` and `nova project import-dag …` through the ACTUAL
 * CLI binary against a real detached daemon (stub pi via the documented
 * env knobs): both file formats over the wire, the exit-code battery
 * (schema_invalid → 3, not_found → 4, invalid_transition → 3, usage → 2),
 * the p5 successor to the honest-refusal check (`nova mcp` is a server now:
 * it exits 0 when its stdio client hangs up, and a stray argument is still
 * usage → 2), and an end-to-end chain completing through the operator's
 * own commands (import → run root → propagate → completed).
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

type Home = { dir: string; home: string; wsRoot: string; env: Record<string, string> };

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-chain-cli-"));
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
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
    NOVAFLOW_WATCH_MS: "200",
  };
  return { dir, home, wsRoot, env };
}

async function forceStopDaemon(h: Home): Promise<void> {
  const sock = join(h.home, "novaflow.sock");
  if (existsSync(sock)) {
    try {
      const { TestClient } = await import("../daemon/client.ts");
      const client = await TestClient.connect(sock, 1500);
      await client.request({ id: "cleanup", op: "nova_daemon_stop", args: {} });
      client.close();
    } catch {
      // fall through to the pid kill
    }
    try {
      await waitFor(() => !existsSync(sock), 5000);
    } catch {
      // fall through
    }
  }
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
    await new Promise((r) => setTimeout(r, 200));
  }
  rmSync(h.dir, { recursive: true, force: true });
}

function graphJson(keyA: string, keyB: string): string {
  return JSON.stringify(
    {
      version: "1.0.0",
      project_slug: "app",
      tasks: [
        { key: keyA, title: "Task A", objective: "The objective of task A.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
        { key: keyB, title: "Task B", objective: "The objective of task B.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
      ],
      edges: [{ source_key: keyA, target_key: keyB, edge_type: "depends_on" }],
    },
    null,
    2,
  );
}

function graphYaml(keyA: string, keyB: string): string {
  return `version: "1.0.0"
project_slug: app
tasks:
  - key: ${keyA}
    title: Task A
    objective: The objective of task A.
    profile_name: dev
    target_scopes:
      - repo_alias: code
        access_mode: read_write
  - key: ${keyB}
    title: Task B
    objective: The objective of task B.
    profile_name: dev
    target_scopes:
      - repo_alias: code
        access_mode: read_write
edges:
  - source_key: ${keyA}
    target_key: ${keyB}
    edge_type: depends_on
`;
}

test("nova project import-dag + nova chain end to end through the binary", async () => {
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
    mkdirSync(join(h.wsRoot, "prompts"), { recursive: true });
    writeFileSync(join(h.wsRoot, "prompts", "dev_system.md"), "You are a worker agent.\n");
    assert.equal(runNova(["project", "create", "app", "--objective", "Ship it.", "--target", `code=${h.wsRoot}`], h.env).code, 0);

    // ---- import-dag: JSON file, YAML file, --json envelope ----
    const jsonFile = join(h.dir, "chain.json");
    writeFileSync(jsonFile, graphJson("A", "B"));
    const imp = runNova(["project", "import-dag", jsonFile], h.env);
    assert.equal(imp.code, 0, imp.stderr);
    assert.match(imp.stdout, /imported chain/);
    assert.match(imp.stdout, /A \(tsk_/);
    assert.match(imp.stdout, /enqueue roots/);
    const impJson = runNova(["project", "import-dag", jsonFile, "--json"], h.env);
    assert.notEqual(impJson.code, 0, "the same keys twice must refuse (duplicate)");
    assert.match(impJson.stderr, /duplicate/);

    const yamlFile = join(h.dir, "chain.yaml");
    writeFileSync(yamlFile, graphYaml("Y1", "Y2"));
    const impYaml = runNova(["project", "import-dag", yamlFile], h.env);
    assert.equal(impYaml.code, 0, impYaml.stderr);
    assert.match(impYaml.stdout, /Y1/);

    // ---- the exit-code battery ----
    // 3 schema_invalid: --project mismatch (the schema carries project_slug)
    const mismatch = runNova(["project", "import-dag", jsonFile, "--project", "other"], h.env);
    assert.equal(mismatch.code, 3);
    assert.match(mismatch.stderr, /schema_invalid|mismatch/);
    // 3 schema_invalid: a cyclic graph
    const cyclicFile = join(h.dir, "cyclic.json");
    writeFileSync(
      cyclicFile,
      JSON.stringify({
        version: "1.0.0",
        project_slug: "app",
        tasks: [
          { key: "C1", title: "Cycle one", objective: "The objective of task C1.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
          { key: "C2", title: "Cycle two", objective: "The objective of task C2.", profile_name: "dev", target_scopes: [{ repo_alias: "code", access_mode: "read_write" }] },
        ],
        edges: [
          { source_key: "C1", target_key: "C2", edge_type: "depends_on" },
          { source_key: "C2", target_key: "C1", edge_type: "depends_on" },
        ],
      }),
    );
    const cyclic = runNova(["project", "import-dag", cyclicFile], h.env);
    assert.equal(cyclic.code, 3);
    assert.match(cyclic.stderr, /cycle/);
    // 3 schema_invalid: YAML outside the subset names the line
    const badYamlFile = join(h.dir, "bad.yaml");
    writeFileSync(badYamlFile, "version: 1.0.0\ntasks: [A]\n");
    const badYaml = runNova(["project", "import-dag", badYamlFile], h.env);
    assert.equal(badYaml.code, 3);
    assert.match(badYaml.stderr, /line 2/);
    // 4 not_found: a graph naming an unknown project
    const ghostFile = join(h.dir, "ghost.json");
    writeFileSync(ghostFile, graphJson("G1", "G2").replace('"project_slug": "app"', '"project_slug": "ghost"'));
    const ghost = runNova(["project", "import-dag", ghostFile], h.env);
    assert.equal(ghost.code, 4);
    assert.match(ghost.stderr, /not_found/);
    // 4 not_found: the file itself is missing
    const noFile = runNova(["project", "import-dag", join(h.dir, "nope.json")], h.env);
    assert.equal(noFile.code, 4);
    // 2 usage: missing file argument
    const usage = runNova(["project", "import-dag"], h.env);
    assert.equal(usage.code, 2);

    // ---- chain list / status ----
    const list = runNova(["chain", "list"], h.env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /ID\s+PROJECT/);
    assert.match(list.stdout, /app/);
    const listJson = JSON.parse(runNova(["chain", "list", "--json"], h.env).stdout) as {
      chains: Array<{ id: string; state: string; member_count: number }>;
    };
    const chainRun = listJson.chains.find((c) => c.member_count === 2 && c.state === "active")!;
    assert.ok(chainRun);

    const status = runNova(["chain", "status", chainRun.id], h.env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /state:\s+active/);
    // p4b (additive): the FEEDBACK column — the delivered feedback context
    // count per member (derived recording, never new state)
    assert.match(status.stdout, /KEY\s+STATE\s+READY\s+FEEDBACK/);
    // roots render "root" — the engine never auto-enqueues them (review fix)
    assert.match(status.stdout, /A\s+draft\s+root/);
    assert.match(status.stdout, /B\s+draft\s+no/); // dep unmet (A still draft)
    const statusJson = JSON.parse(runNova(["chain", "status", chainRun.id, "--json"], h.env).stdout) as {
      chain: { state: string };
      members: Array<{ key: string; state: string }>;
      paused: boolean;
    };
    assert.equal(statusJson.chain.state, "active");
    assert.equal(statusJson.paused, false);
    assert.equal(statusJson.members.length, 2);
    // unknown chain → 4; bare `nova chain` → 2
    assert.equal(runNova(["chain", "status", "01HJ8Z9X01ABCDEFGHJKMNPQRS"], h.env).code, 4);
    assert.equal(runNova(["chain"], h.env).code, 2);
    // `nova mcp` is a SERVER now (p5): with no client on stdin it serves
    // until EOF and exits 0 — a disconnected session is a normal end of
    // service, not a usage error (mcp.md §2; src/cli/commands/mcp.ts).
    const mcp = runNova(["mcp"], h.env);
    assert.equal(mcp.code, 0, `stderr=${mcp.stderr}`);
    assert.equal(mcp.stdout, "", "stdout is the protocol channel — nothing decorative");
    // an extra argument is still a usage error (it would otherwise be
    // silently dropped, which is the one thing a server must not do)
    const mcpArg = runNova(["mcp", "stray"], h.env);
    assert.equal(mcpArg.code, 2);

    // ---- the operator flow: run the root, the chain completes itself ----
    const runRoot = runNova(["task", "run", "A"], h.env);
    assert.equal(runRoot.code, 0, runRoot.stderr);
    await waitFor(
      () => {
        const probe = runNova(["chain", "status", chainRun.id, "--json"], h.env, 15_000);
        if (probe.code !== 0) return false;
        const parsed = JSON.parse(probe.stdout) as { chain: { state: string } };
        return parsed.chain.state === "completed";
      },
      30_000,
    );
    const final = JSON.parse(runNova(["chain", "status", chainRun.id, "--json"], h.env).stdout) as {
      chain: { state: string };
      members: Array<{ key: string; state: string }>;
    };
    assert.equal(final.chain.state, "completed");
    assert.deepEqual(
      final.members.map((m) => `${m.key}=${m.state}`).sort(),
      ["A=completed", "B=completed"],
    );

    // abort on a terminal chain → 3 (a terminal chain never moves again)
    const abortDone = runNova(["chain", "abort", chainRun.id], h.env);
    assert.equal(abortDone.code, 3);
    assert.match(abortDone.stderr, /invalid_transition/);

    // ---- pause/resume/abort on a fresh active chain ----
    const freshFile = join(h.dir, "fresh.json");
    writeFileSync(freshFile, graphJson("F1", "F2"));
    assert.equal(runNova(["project", "import-dag", freshFile], h.env).code, 0);
    const freshList = JSON.parse(runNova(["chain", "list", "--json"], h.env).stdout) as {
      chains: Array<{ id: string; member_count: number; state: string }>;
    };
    const fresh = freshList.chains.find((c) => c.member_count === 2 && c.state === "active" && c.id !== chainRun.id)!;

    const pause = runNova(["chain", "pause", fresh.id], h.env);
    assert.equal(pause.code, 0, pause.stderr);
    assert.match(pause.stdout, /paused/);
    const pausedStatus = JSON.parse(runNova(["chain", "status", fresh.id, "--json"], h.env).stdout) as {
      paused: boolean;
      chain: { state: string };
    };
    assert.equal(pausedStatus.paused, true);
    assert.equal(pausedStatus.chain.state, "active"); // the ROW stays active (no paused state)
    const resume = runNova(["chain", "resume", fresh.id], h.env);
    assert.equal(resume.code, 0, resume.stderr);
    assert.match(resume.stdout, /resumed/);

    // abort the fresh chain: drafts have no abort row — reported honestly
    const abortFresh = runNova(["chain", "abort", fresh.id], h.env);
    assert.equal(abortFresh.code, 0, abortFresh.stderr);
    assert.match(abortFresh.stdout, /aborted/);
    assert.match(abortFresh.stdout, /no-abort-row/);

    assert.equal(runNova(["daemon", "stop"], h.env).code, 0);
  } finally {
    await forceStopDaemon(h);
  }
});
