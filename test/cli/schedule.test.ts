import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../daemon/client.ts";
import { readConnection } from "../daemon/seed.ts";

/**
 * `nova schedule …` through the actual CLI binary against a real
 * detached daemon (stub pi via the documented env knobs): attach
 * (cron + ISO one-shot), list (--json + human table), pause/resume,
 * and the exit-code battery (schema_invalid → 3, not_found → 4).
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>, timeoutMs = 60_000): Run {
  const res = spawnSync(NOVA, args, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, ...env } });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type Home = { dir: string; home: string; env: Record<string, string> };

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-sched-cli-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  const env: Record<string, string> = {
    NOVAFLOW_HOME: home,
    NOVAFLOW_SOCK: join(home, "novaflow.sock"),
    NOVAFLOW_DB: join(home, "state.db"),
    NOVAFLOW_PI_BIN: "node",
    NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
    NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
    NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
  };
  return { dir, home, env };
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

function taskState(h: Home, key: string): string {
  const ro = readConnection(h.env["NOVAFLOW_DB"]!);
  const row = ro
    .prepare(
      "SELECT t.state FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key = ?",
    )
    .get(key) as { state: string } | undefined;
  ro.close();
  return row?.state ?? "missing";
}

/** Boot the daemon + one workspace/project/profile/task ("TASK-1"). */
async function bootWorkspace(h: Home): Promise<void> {
  mkdirSync(join(h.dir, "wsroot", "prompts"), { recursive: true });
  writeFileSync(join(h.dir, "wsroot", "prompts", "dev_system.md"), "You are a worker agent.\n");
  const start = runNova(["daemon", "start"], h.env);
  assert.equal(start.code, 0, `stdout=${start.stdout} stderr=${start.stderr}`);
  assert.equal(runNova(["workspace", "create", "alpha", "--path", join(h.dir, "wsroot")], h.env).code, 0);
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
    runNova(
      ["project", "create", "app", "--objective", "Ship the thing.", "--target", `work=${join(h.dir, "wsroot")}`],
      h.env,
    ).code,
    0,
  );
  assert.equal(
    runNova(
      ["task", "create", "TASK-1", "--title", "Do the work", "--objective", "Do the work end to end.", "--profile", "dev", "--project", "app", "--scope", "work"],
      h.env,
    ).code,
    0,
  );
}

test("nova schedule: one-shot attach fires the task end to end; bare ULID id printed", async () => {
  const h = makeHome();
  try {
    await bootWorkspace(h);
    // a run_at 2 s ahead: the evaluator tick (1 s) fires it within ~3 s
    const at = new Date(Date.now() + 2000).toISOString();
    const attach = runNova(["schedule", "attach", "TASK-1", "--at", at, "--missed", "run_immediately"], h.env);
    assert.equal(attach.code, 0, `stdout=${attach.stdout} stderr=${attach.stderr}`);
    assert.match(attach.stdout, new RegExp(`attached schedule ${ULID_RE.source}`));
    const scheduleId = attach.stdout.match(ULID_RE)![0];

    // FR-SCH-01 AC2 end to end: draft → queued (schedule) → dispatched → completed
    await waitFor(() => taskState(h, "TASK-1") === "completed", 30_000);

    // the fired one-shot is expired: next_run_at NULL in the list
    const list = runNova(["schedule", "list", "--json"], h.env);
    assert.equal(list.code, 0, list.stderr);
    const data = JSON.parse(list.stdout) as { schedules: Array<Record<string, unknown>> };
    const row = data.schedules.find((s) => s["id"] === scheduleId)!;
    assert.equal(row["next_run_at"], null);
    assert.equal(row["missed_policy"], "run_immediately");
    assert.equal(row["enabled"], 1);
  } finally {
    await forceStopDaemon(h);
  }
});

test("nova schedule list: human table + --task filter", async () => {
  const h = makeHome();
  try {
    await bootWorkspace(h);
    const attach = runNova(["schedule", "attach", "TASK-1", "--cron", "0 0 1 1 *"], h.env);
    assert.equal(attach.code, 0, attach.stderr);

    const table = runNova(["schedule", "list"], h.env);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^ID\s+TASK/);
    assert.match(table.stdout, /0 0 1 1 \*/);

    const scoped = runNova(["schedule", "list", "--task", "TASK-1", "--json"], h.env);
    assert.equal(scoped.code, 0, scoped.stderr);
    const data = JSON.parse(scoped.stdout) as { schedules: Array<Record<string, unknown>> };
    assert.equal(data.schedules.length, 1);
    assert.match(String(data.schedules[0]!["next_run_at"]), /T00:00:00\.000Z$/);
  } finally {
    await forceStopDaemon(h);
  }
});

test("nova schedule pause|resume: pause freezes; resume states the recomputed next run", async () => {
  const h = makeHome();
  try {
    await bootWorkspace(h);
    const attach = runNova(["schedule", "attach", "TASK-1", "--cron", "0 0 1 1 *"], h.env);
    assert.equal(attach.code, 0, attach.stderr);
    const scheduleId = attach.stdout.match(ULID_RE)![0];

    const pause = runNova(["schedule", "pause", scheduleId], h.env);
    assert.equal(pause.code, 0, pause.stderr);
    const paused = JSON.parse(runNova(["schedule", "list", "--json"], h.env).stdout) as {
      schedules: Array<{ id: string; enabled: number }>;
    };
    assert.equal(paused.schedules.find((s) => s.id === scheduleId)!.enabled, 0);

    const resume = runNova(["schedule", "resume", scheduleId], h.env);
    assert.equal(resume.code, 0, resume.stderr);
    assert.match(resume.stdout, /resumed/);
    assert.match(resume.stdout, /next run/); // the recomputed next run is stated
    const resumed = JSON.parse(runNova(["schedule", "list", "--json"], h.env).stdout) as {
      schedules: Array<{ id: string; enabled: number }>;
    };
    assert.equal(resumed.schedules.find((s) => s.id === scheduleId)!.enabled, 1);
  } finally {
    await forceStopDaemon(h);
  }
});

test("nova schedule: the exit-code battery (schema_invalid → 3, not_found → 4)", async () => {
  const h = makeHome();
  try {
    await bootWorkspace(h);
    // 3 schema_invalid: neither cron nor at
    const neither = runNova(["schedule", "attach", "TASK-1"], h.env);
    assert.equal(neither.code, 3);
    assert.match(neither.stderr, /schema_invalid/);
    // 3 schema_invalid: both
    const both = runNova(["schedule", "attach", "TASK-1", "--cron", "* * * * *", "--at", "2027-01-01T00:00:00Z"], h.env);
    assert.equal(both.code, 3);
    // 3 schema_invalid: bad cron / names out of scope / bad ISO
    for (const args of [
      ["--cron", "not cron"],
      ["--cron", "0 0 * * MON"],
      ["--cron", "61 * * * *"],
      ["--at", "2026-01-01"],
      ["--at", "2026-01-01T00:00:00"],
      ["--missed", "wat", "--cron", "* * * * *"],
    ] as string[][]) {
      const res = runNova(["schedule", "attach", "TASK-1", ...args], h.env);
      assert.equal(res.code, 3, `args=${args.join(" ")} stderr=${res.stderr}`);
      assert.match(res.stderr, /schema_invalid/);
    }
    // 4 not_found: unknown task key / unknown schedule id
    const noTask = runNova(["schedule", "attach", "NOPE", "--cron", "* * * * *"], h.env);
    assert.equal(noTask.code, 4);
    const noSchedule = runNova(["schedule", "pause", "01GARBAGEIDGARBAGEIDGARBAGE"], h.env);
    assert.equal(noSchedule.code, 4);
  } finally {
    await forceStopDaemon(h);
  }
});
