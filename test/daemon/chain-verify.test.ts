import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/lifecycle.ts";
import { TestClient, waitFor } from "./client.ts";
import { seedFileStore, readConnection, MODEL } from "./seed.ts";
import { ulid } from "../../src/store/ids.ts";
import { buildEngineContext, writeEngineContext } from "../../src/runs/context.ts";

/**
 * `nova chain verify <chain-run-id>` (srs 4.1.1 + novaflow-v030 amendments
 * row 4 — DEBT-006): the OPERATOR SURFACE for `verification_commands`
 * (FR-TSK-12). Per member, over its NEWEST run, the verb prints the commands
 * CONFIGURED at run time against the commands the engine ACTUALLY EXECUTED
 * with their exit status. A configured command with no executed record
 * prints UNEXECUTED and the verb exits 3 (engine-state: this chain's
 * verification is not the state the operator assumes); an unknown chain is
 * not_found → 4; a member with nothing configured says so plainly and the
 * verb stays 0.
 *
 * THE POINT OF THIS FILE (the card's Risk): every printed line must come
 * from the RUN's recorded facts — never from the task's current config. The
 * engine writes them in three existing run surfaces: `engine-context.json`
 * carries the configured set snapshot taken at spawn, the §4.1 artifact
 * block carries `verification_results`, and the verification frame in
 * `events.jsonl` carries each executed command WITH its cwd. The
 * config-edited-after-the-run test is the one that bites if a future change
 * starts reading `task_target_scopes` again.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");

type Env = {
  dir: string;
  dbPath: string;
  wsRoot: string;
  projectId: string;
  profileId: string;
  /** The seeded `ws-app` directory target every member scope points at. */
  targetId: string;
  targetRoot: string;
  socketPath: string;
  handle: DaemonHandle;
  client: TestClient;
};

async function boot(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-chain-verify-"));
  const seeded = seedFileStore(dir);
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, "concurrency:\n  global: 4\nretry:\n  delay_sec: 3600\n");
  const socketPath = join(dir, "novaflow.sock");
  const handle = await startDaemon({
    dbPath: seeded.dbPath,
    socketPath,
    daemonConfigPath: cfgPath,
    probePiBin: "node",
    probeArgs: [STUB, "ok"],
    probeTimeoutMs: 3000,
    runPiBin: "node",
    runArgs: [STUB, "run-ok", join(dir, "run-ok.pid")],
    extensionPath: "/ext/novaflow.ts",
    pricesPath: join(dir, "no-prices.json"),
    killGraceMs: 300,
    tickMs: 30,
  });
  const client = await TestClient.connect(socketPath);
  return {
    dir,
    dbPath: seeded.dbPath,
    wsRoot: seeded.wsRoot,
    projectId: seeded.projectId,
    profileId: seeded.profileId,
    targetId: seeded.targetId,
    targetRoot: join(seeded.wsRoot, "target"),
    socketPath,
    handle,
    client,
  };
}

async function shutdown(env: Env): Promise<void> {
  env.client.close();
  await env.handle.stop();
  rmSync(env.dir, { recursive: true, force: true });
}

type Run = { code: number; stdout: string; stderr: string };

const execFileAsync = promisify(execFile);

/**
 * The verb through the ACTUAL binary, against this test's daemon socket.
 * ASYNC on purpose: the daemon runs inside this test process, so a
 * synchronous spawn would block the very event loop that has to answer it.
 */
async function runNova(args: string[], env: Env): Promise<Run> {
  try {
    const res = await execFileAsync(NOVA, args, {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NOVAFLOW_SOCK: env.socketPath },
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function seedChain(env: Env, state: "active" | "completed"): string {
  const db = new Database(env.dbPath);
  try {
    const chainId = ulid();
    db.prepare("INSERT INTO chain_runs (id, project_id, state) VALUES (?, ?, ?)").run(
      chainId,
      env.projectId,
      state,
    );
    return chainId;
  } finally {
    db.close();
  }
}

type Member = { taskId: string; key: string };

/** A chain member task scoped to the seeded target, carrying `configured` NOW. */
function seedMember(
  env: Env,
  chainId: string,
  opts: { key: string; state: string; configured?: string[] },
): Member {
  const db = new Database(env.dbPath);
  try {
    const taskId = ulid();
    db.prepare(
      `INSERT INTO tasks (id, project_id, key, title, objective, profile_id, state, chain_run_id)
       VALUES (?, ?, ?, 'T', 'o', ?, ?, ?)`,
    ).run(taskId, env.projectId, opts.key, env.profileId, opts.state, chainId);
    db.prepare(
      `INSERT INTO task_target_scopes (id, task_id, target_id, access_mode, verification_commands_json)
       VALUES (?, ?, ?, 'read_write', ?)`,
    ).run(ulid(), taskId, env.targetId, JSON.stringify(opts.configured ?? []));
    return { taskId, key: opts.key };
  } finally {
    db.close();
  }
}

/** The run's verification frame, byte-for-byte as the engine records it. */
function verificationFrame(
  runId: string,
  configured: string[],
  executed: Array<{ command: string; exit: number }>,
  cwd: string,
  collectionError: string | null = null,
): string {
  return JSON.stringify({
    type: "novaflow_verification",
    run_id: runId,
    configured: configured.map((command) => ({ command, cwd })),
    executed: executed.map((e) => ({ command: e.command, exit: e.exit, cwd })),
    collection_error: collectionError,
  });
}

type RunSpec = {
  attempt?: number;
  status?: "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  /** The recorded verification frame's content; omitted = verification never recorded. */
  frame?: {
    configured: string[];
    executed: Array<{ command: string; exit: number }>;
    cwd: string;
    collectionError?: string | null;
  };
  /** A §4.1 artifact `verification_results` block, written with NO frame. */
  artifact?: Array<{ command: string; exit_code: number; passed: boolean }>;
};

type SeededRun = { runId: string; sessionDir: string; eventsPath: string; artifactPath: string };

/**
 * One run row + its run directory. `engine-context.json` comes from the
 * ENGINE's own builder (`buildEngineContext`) so the fixture cannot invent a
 * snapshot shape the engine never writes.
 */
function seedRun(env: Env, member: Member, spec: RunSpec = {}): SeededRun {
  const runId = ulid();
  const sessionDir = join(env.wsRoot, ".novaflow", "runs", member.taskId, runId);
  mkdirSync(sessionDir, { recursive: true });
  const eventsPath = join(sessionDir, "events.jsonl");
  const artifactPath = join(sessionDir, "result.json");
  const lines = ['{"type":"agent_settled"}'];
  if (spec.frame !== undefined) {
    lines.push(
      verificationFrame(
        runId,
        spec.frame.configured,
        spec.frame.executed,
        spec.frame.cwd,
        spec.frame.collectionError ?? null,
      ),
    );
  }
  writeFileSync(eventsPath, lines.join("\n") + "\n");
  if (spec.artifact !== undefined) {
    writeFileSync(artifactPath, JSON.stringify({ verification_results: spec.artifact }, null, 2) + "\n");
  }
  const db = new Database(env.dbPath);
  try {
    writeEngineContext(
      sessionDir,
      buildEngineContext(
        db,
        { id: member.taskId, output_schema_version: "1.0.0" },
        runId,
        "execution",
        { max_timeout_sec: 3600, max_cost_usd: 5 },
      ),
    );
    db.prepare(
      `INSERT INTO task_runs
         (id, task_id, attempt_number, pi_session_id, pi_session_dir, status, preflight_status,
          model_used, events_log_path, artifact_path)
       VALUES (?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?)`,
    ).run(
      runId,
      member.taskId,
      spec.attempt ?? 1,
      runId,
      sessionDir,
      spec.status ?? "succeeded",
      MODEL,
      eventsPath,
      spec.artifact === undefined ? null : artifactPath,
    );
  } finally {
    db.close();
  }
  return { runId, sessionDir, eventsPath, artifactPath };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------- the record-then-report round trip (real run) ------------------ */

test("a LIVE run: the daemon records the verification frame, and the verb reports configured == executed with the exit status", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "active");
    const res = await env.client.request({
      id: "c-report",
      op: "nova_task_create",
      args: {
        project_id: env.projectId,
        key: "REPORT",
        title: "Report",
        objective: "Verify the reported verification.",
        profile_name: "dev",
        target_scopes: [
          { repo_alias: "ws-app", access_mode: "read_write", verification_commands: ["true"] },
        ],
      },
    });
    assert.equal(res["ok"], true, JSON.stringify(res));
    const taskId = (res["data"] as { task: { id: string } }).task.id;
    const db = new Database(env.dbPath);
    try {
      db.prepare("UPDATE tasks SET chain_run_id = ? WHERE id = ?").run(chainId, taskId);
    } finally {
      db.close();
    }
    const runRes = await env.client.request({ id: "r", op: "nova_task_run", args: { task_id: taskId } });
    assert.equal(runRes["ok"], true, JSON.stringify(runRes));

    const readRun = (): Record<string, unknown> | undefined => {
      const ro = readConnection(env.dbPath);
      try {
        return ro
          .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
          .get(taskId) as Record<string, unknown> | undefined;
      } finally {
        ro.close();
      }
    };
    await waitFor(() => readRun() !== undefined && readRun()!["engine_verification_passed"] === 1, 15_000);
    const run = readRun()!;

    // RECORDED: the engine's own frame in the redacted stream, with cwd
    const frames = readFileSync(String(run["events_log_path"]), "utf8")
      .split("\n")
      .filter((l) => l.includes('"novaflow_verification"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(frames.length, 1, "one verification frame per pass");
    const frame = frames[0]!;
    assert.equal(frame["run_id"], run["id"]);
    assert.deepEqual(frame["configured"], [{ command: "true", cwd: env.targetRoot }]);
    assert.deepEqual(frame["executed"], [{ command: "true", exit: 0, cwd: env.targetRoot }]);
    assert.equal(frame["collection_error"], null);

    // REPORTED: from that record (the §4.1 block carries no cwd, the frame does)
    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, new RegExp(`^chain ${chainId}: completed$`, "m"));
    assert.match(printed.stdout, /member REPORT \(.+\): completed — run .+ \(attempt 1\), 1 configured, 1 executed/);
    assert.match(
      printed.stdout,
      new RegExp(`configured\\s+true\\s+→\\s+executed\\s+exit 0\\s+cwd=${escapeRe(env.targetRoot)}`),
    );
    assert.doesNotMatch(printed.stdout, /UNEXECUTED/);
  } finally {
    await shutdown(env);
  }
});

/* -------------------------- configured but never executed ------------------------- */

test("a CONFIGURED command with no executed record prints UNEXECUTED and the verb exits 3", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const member = seedMember(env, chainId, {
      key: "LINT",
      state: "completed",
      configured: ["npm test", "npm run lint"],
    });
    // The engine recorded what RAN (the §4.1 block: npm test, exit 0) but the
    // configured set collected at verification time never reached it: the
    // daemon died mid-pass, so npm run lint has no executed record at all.
    seedRun(env, member, {
      artifact: [{ command: "npm test", exit_code: 0, passed: true }],
    });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 3, `expected engine-state exit 3, got ${printed.code}: ${printed.stderr}`);
    assert.match(printed.stdout, /configured\s+npm test\s+→\s+executed\s+exit 0/);
    assert.match(printed.stdout, /configured\s+npm run lint\s+→\s+UNEXECUTED/);
    assert.match(printed.stdout, /1 configured command never executed on 1 member/);

    // …and the op itself stays a READ: the report is data, not an error frame
    const op = await env.client.request({
      id: "op",
      op: "nova_chain_verify",
      args: { chain_run_id: chainId },
    });
    assert.equal(op["ok"], true, JSON.stringify(op["error"]));
    const data = op["data"] as {
      members: Array<{ unexecuted: string[]; notes: string[] }>;
      unexecuted: Array<{ key: string; command: string }>;
    };
    assert.deepEqual(data.members[0]!.unexecuted, ["npm run lint"]);
    assert.deepEqual(data.unexecuted, [{ task_id: member.taskId, key: "LINT", command: "npm run lint" }]);
  } finally {
    await shutdown(env);
  }
});

/* ----------------------------- nothing configured -------------------------------- */

test("a member with NOTHING configured says so plainly — and the verb stays 0", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const member = seedMember(env, chainId, { key: "DOCS", state: "completed", configured: [] });
    seedRun(env, member, { frame: { configured: [], executed: [], cwd: env.targetRoot } });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /member DOCS \(.+\): completed — run .+, 0 configured, 0 executed/);
    assert.match(printed.stdout, /no verification commands configured for this run/);
    assert.doesNotMatch(printed.stdout, /UNEXECUTED/);
    assert.doesNotMatch(printed.stdout, /exit 3/);
  } finally {
    await shutdown(env);
  }
});

/* ---------------------------------- unknown chain -------------------------------- */

test("an unknown chain is not_found — exit 4, never a silent success", async () => {
  const env = await boot();
  try {
    const ghost = ulid();
    const printed = await runNova(["chain", "verify", ghost], env);
    assert.equal(printed.code, 4, printed.stderr);
    assert.match(printed.stderr, /not_found/);
    assert.match(printed.stderr, new RegExp(escapeRe(ghost)));
    assert.equal(printed.stdout, "");

    const op = await env.client.request({
      id: "op",
      op: "nova_chain_verify",
      args: { chain_run_id: ghost },
    });
    assert.equal(op["ok"], false);
    assert.equal((op["error"] as { code: string }).code, "not_found");
  } finally {
    await shutdown(env);
  }
});

/* ------------------- the report is the RECORD, not the live config ----------------- */

test("the report comes from the RUN's record: editing the task config after the run changes nothing it prints", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const member = seedMember(env, chainId, { key: "TIGHT", state: "completed", configured: ["npm test"] });
    seedRun(env, member, {
      frame: { configured: ["npm test"], executed: [{ command: "npm test", exit: 0 }], cwd: env.targetRoot },
    });

    const before = await runNova(["chain", "verify", chainId], env);
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /configured\s+npm test\s+→\s+executed\s+exit 0/);

    // the operator "improves" the task's config AFTER the run: the run never
    // saw this command, so it must never appear as configured-and-skipped
    const db = new Database(env.dbPath);
    try {
      db.prepare("UPDATE task_target_scopes SET verification_commands_json = ? WHERE task_id = ?").run(
        JSON.stringify(["npm run lint"]),
        member.taskId,
      );
    } finally {
      db.close();
    }

    const after = await runNova(["chain", "verify", chainId], env);
    assert.equal(after.code, 0, `the report must not re-read the edited config: ${after.stdout}`);
    assert.equal(after.stdout, before.stdout, "the report is a function of the record alone");
    assert.doesNotMatch(after.stdout, /npm run lint/);
    assert.doesNotMatch(after.stdout, /UNEXECUTED/);
  } finally {
    await shutdown(env);
  }
});

/* ------------------------- newest run per member (retry) -------------------------- */

test("the NEWEST run per member is reported — a retry's record supersedes the earlier attempt", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const member = seedMember(env, chainId, { key: "RETRY", state: "completed", configured: ["npm test"] });
    const first = seedRun(env, member, {
      attempt: 1,
      frame: { configured: ["npm test"], executed: [{ command: "npm test", exit: 1 }], cwd: env.targetRoot },
    });
    const second = seedRun(env, member, {
      attempt: 2,
      frame: { configured: ["npm test"], executed: [{ command: "npm test", exit: 0 }], cwd: env.targetRoot },
    });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, new RegExp(`run ${second.runId} \\(attempt 2\\)`));
    assert.doesNotMatch(printed.stdout, new RegExp(first.runId));
    assert.match(printed.stdout, /configured\s+npm test\s+→\s+executed\s+exit 0/);
    assert.doesNotMatch(printed.stdout, /exit 1\b/);
  } finally {
    await shutdown(env);
  }
});

/* ------------------ a run verified before the frame existed (§4.1) ---------------- */

test("a run whose record is the §4.1 artifact block alone still reports its executed command (no false UNEXECUTED)", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const member = seedMember(env, chainId, { key: "LEGACY", state: "completed", configured: ["npm test"] });
    seedRun(env, member, {
      artifact: [{ command: "npm test", exit_code: 0, passed: true }],
    });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 0, `the artifact block IS a record: ${printed.stdout}`);
    assert.match(printed.stdout, /configured\s+npm test\s+→\s+executed\s+exit 0/);
    assert.doesNotMatch(printed.stdout, /UNEXECUTED/);
  } finally {
    await shutdown(env);
  }
});

/* ------------------ the whole report shape, three members at once ----------------- */

test("the three-member shape: verified / UNEXECUTED / nothing configured, one line per configured command", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "completed");
    const ok = seedMember(env, chainId, { key: "OK", state: "completed", configured: ["npm test"] });
    const okRun = seedRun(env, ok, {
      frame: { configured: ["npm test"], executed: [{ command: "npm test", exit: 0 }], cwd: env.targetRoot },
    });
    const skip = seedMember(env, chainId, {
      key: "SKIP",
      state: "completed",
      configured: ["npm run lint"],
    });
    const skipRun = seedRun(env, skip);
    const none = seedMember(env, chainId, { key: "NONE", state: "completed", configured: [] });
    const noneRun = seedRun(env, none, { frame: { configured: [], executed: [], cwd: env.targetRoot } });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 3, printed.stderr);
    assert.equal(
      printed.stdout,
      [
        `chain ${chainId}: completed`,
        `member OK (${ok.taskId}): completed — run ${okRun.runId} (attempt 1), 1 configured, 1 executed`,
        `  configured  npm test  →  executed  exit 0  cwd=${env.targetRoot}`,
        `member SKIP (${skip.taskId}): completed — run ${skipRun.runId} (attempt 1), 1 configured, 0 executed`,
        "  configured  npm run lint  →  UNEXECUTED",
        `member NONE (${none.taskId}): completed — run ${noneRun.runId} (attempt 1), 0 configured, 0 executed`,
        "  no verification commands configured for this run",
        "1 configured command never executed on 1 member — this chain's verification is not in the state you think (exit 3)",
        "",
      ].join("\n"),
    );
  } finally {
    await shutdown(env);
  }
});

/* --------------------------- a member that never ran ------------------------------ */

test("a member that never ran is reported as such — plainly, and it is not an UNEXECUTED alarm", async () => {
  const env = await boot();
  try {
    const chainId = seedChain(env, "active");
    seedMember(env, chainId, { key: "DRAFT", state: "draft", configured: ["npm test"] });

    const printed = await runNova(["chain", "verify", chainId], env);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /member DRAFT \(.+\): draft — no run yet/);
    assert.doesNotMatch(printed.stdout, /UNEXECUTED/);
  } finally {
    await shutdown(env);
  }
});
