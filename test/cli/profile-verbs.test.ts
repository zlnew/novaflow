import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient, waitFor } from "../daemon/client.ts";

/**
 * DEBT-008 (v0.2.0 P5) through the ACTUAL CLI binary: `nova profile
 * update <name> --file <path>` and `nova profile delete <name>` against a
 * live detached daemon.
 *
 * The CLI is a THIN CLIENT (test/cli/discipline.test.ts stays green: no
 * store access): both verbs are one op call, and every failure row of the
 * srs 4.1.1 exit map is pinned through the binary:
 *   0 success · 1 operation failure (`duplicate`, the no-change refusal) ·
 *   2 usage · 3 engine-state rejection (`schema_invalid`: a renamed file, an
 *   invalid profile, a PINNED profile) · 4 not found · 5 unreachable.
 * The pinned-delete refusal is the DEBT-008 must: never delete a profile a
 * task pins, and name the count.
 */

const REPO = join(import.meta.dirname, "..", "..");
const NOVA = join(REPO, "bin", "nova");
const STUB = join(REPO, "test", "fixtures", "pi-stub.ts");
const OLD_MODEL = "claude-3-5-sonnet-20241022";
const NEW_MODEL = "claude-3-7-sonnet-20250219";
const NEWER_MODEL = "claude-3-9-sonnet-20251001";

type Run = { code: number; stdout: string; stderr: string };

function runNova(args: string[], env: Record<string, string>, timeoutMs = 60_000): Run {
  const res = spawnSync(NOVA, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type Home = { dir: string; home: string; env: Record<string, string> };

function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "novaflow-cli-profile-"));
  const home = join(dir, "novahome");
  mkdirSync(home);
  return {
    dir,
    home,
    env: {
      NOVAFLOW_HOME: home,
      NOVAFLOW_SOCK: join(home, "novaflow.sock"),
      NOVAFLOW_DB: join(home, "state.db"),
      NOVAFLOW_PI_BIN: "node",
      NOVAFLOW_PROBE_ARGS: JSON.stringify([STUB, "ok"]),
      NOVAFLOW_RUN_ARGS: JSON.stringify([STUB, "run-ok"]),
      NOVAFLOW_PROBE_TIMEOUT_MS: "3000",
      NOVAFLOW_WATCH_MS: "200",
    },
  };
}

/** Backstop cleanup: socket stop-op, then group kill by pidfile. */
async function forceStopDaemon(h: Home): Promise<void> {
  const sock = join(h.home, "novaflow.sock");
  if (existsSync(sock)) {
    try {
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

const DEV = {
  name: "dev",
  provider: "anthropic",
  model: OLD_MODEL,
  thinking_level: "medium",
  system_prompt_path: "prompts/dev_system.md",
  tools_allowlist: ["bash", "read"],
  limits: { max_timeout_sec: 3600, max_cost_usd: 5 },
};

function writeProfile(h: Home, file: string, doc: Record<string, unknown>): string {
  const path = join(h.dir, file);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

test("nova profile update/delete end to end: canonical file + row, pinned refusal, the exit-code rows", async () => {
  const h = makeHome();
  try {
    const start = runNova(["daemon", "start"], h.env);
    assert.equal(start.code, 0, `stdout=${start.stdout} stderr=${start.stderr}`);
    const wsRoot = join(h.dir, "wsroot");
    mkdirSync(wsRoot);
    assert.equal(runNova(["workspace", "create", "alpha", "--path", wsRoot], h.env).code, 0);
    assert.equal(runNova(["workspace", "switch", "alpha"], h.env).code, 0);
    const canonical = join(wsRoot, ".novaflow", "profiles", "dev.json");

    // ---- PRESERVE: create / validate / list behave exactly as before ----
    const create = runNova(["profile", "create", "--file", writeProfile(h, "dev.json", DEV)], h.env);
    assert.equal(create.code, 0, create.stderr);
    assert.match(create.stdout, /created profile dev \(workspace-scoped\)/);
    assert.match(create.stdout, /canonical:/);
    assert.ok(existsSync(canonical));
    const validate = runNova(["profile", "validate", "dev"], h.env);
    assert.equal(validate.code, 0, validate.stderr);
    assert.match(validate.stdout, /structurally valid/);
    const listBefore = runNova(["profile", "list", "--json"], h.env);
    assert.equal(listBefore.code, 0);
    assert.match(listBefore.stdout, /"dev"/);

    // ---- update: the canonical file AND the stored row move together ----
    const next1 = writeProfile(h, "dev-next.json", {
      ...DEV,
      model: NEW_MODEL,
      thinking_level: "high",
      role: "reviewer",
      limits: { max_timeout_sec: 900, max_cost_usd: 1.5 },
    });
    const upd = runNova(["profile", "update", "dev", "--file", next1], h.env);
    assert.equal(upd.code, 0, upd.stderr);
    assert.match(upd.stdout, /updated profile dev \(workspace-scoped\)/);
    assert.match(upd.stdout, new RegExp(`model: ${NEW_MODEL}`));
    assert.match(upd.stdout, /canonical:/);
    const written = readFileSync(canonical, "utf8");
    assert.match(written, new RegExp(NEW_MODEL));
    assert.doesNotMatch(written, new RegExp(OLD_MODEL), "the old model leaves the canonical file");
    // the daemon's row is what /list and /validate serve
    const listed = runNova(["profile", "list", "--json"], h.env);
    const listData = JSON.parse(listed.stdout) as { profiles: Array<Record<string, unknown>> };
    assert.equal(listData.profiles.length, 1);
    assert.equal(listData.profiles[0]!["model"], NEW_MODEL);
    assert.equal(listData.profiles[0]!["thinking_level"], "high");
    assert.equal(listData.profiles[0]!["role"], "reviewer");
    assert.equal(runNova(["profile", "validate", "dev"], h.env).code, 0);

    // --json envelope reports the SCOPE acted on
    const next2 = writeProfile(h, "dev-next2.json", { ...DEV, model: NEWER_MODEL });
    const updJson = runNova(["profile", "update", "dev", "--file", next2, "--json"], h.env);
    assert.equal(updJson.code, 0, updJson.stderr);
    const updData = JSON.parse(updJson.stdout) as Record<string, unknown>;
    assert.equal(updData["scope"], "workspace");
    assert.equal(updData["changed"], true);
    assert.equal((updData["profile"] as Record<string, unknown>)["model"], NEWER_MODEL);
    assert.equal(updData["canonical_path"], canonical);

    // ---- the no-change refusal: duplicate (the v1 map's exit 1) ----
    const noChange = runNova(["profile", "update", "dev", "--file", next2], h.env);
    assert.equal(noChange.code, 1, `stdout=${noChange.stdout}`);
    assert.match(noChange.stderr, /duplicate/);
    assert.match(noChange.stderr, /no change/);
    assert.match(readFileSync(canonical, "utf8"), new RegExp(NEWER_MODEL));

    // ---- a renamed file is schema_invalid (exit 3), nothing written ----
    const renamed = writeProfile(h, "renamed.json", { ...DEV, name: "other", model: OLD_MODEL });
    const bad = runNova(["profile", "update", "dev", "--file", renamed], h.env);
    assert.equal(bad.code, 3, `stdout=${bad.stdout}`);
    assert.match(bad.stderr, /schema_invalid/);
    assert.match(bad.stderr, /renaming is not an update/);
    assert.doesNotMatch(readFileSync(canonical, "utf8"), new RegExp(OLD_MODEL));

    // ---- an invalid §4.2 profile is schema_invalid (exit 3) ----
    const invalid = writeProfile(h, "invalid.json", { ...DEV, tools_allowlist: ["read", "read"] });
    const badProfile = runNova(["profile", "update", "dev", "--file", invalid], h.env);
    assert.equal(badProfile.code, 3, `stdout=${badProfile.stdout}`);
    assert.match(badProfile.stderr, /schema_invalid/);
    assert.match(badProfile.stderr, /unique/);

    // ---- an unreadable file is schema_invalid too (the create row) ----
    const unreadable = runNova(["profile", "update", "dev", "--file", join(h.dir, "nope.json")], h.env);
    assert.equal(unreadable.code, 3);
    assert.match(unreadable.stderr, /schema_invalid/);
    assert.match(unreadable.stderr, /unreadable or not JSON/);

    // ---- not found (exit 4) ----
    const ghostFile = writeProfile(h, "ghost.json", { ...DEV, name: "ghost" });
    const ghost = runNova(["profile", "update", "ghost", "--file", ghostFile], h.env);
    assert.equal(ghost.code, 4, `stdout=${ghost.stdout}`);
    assert.match(ghost.stderr, /not_found/);
    assert.ok(!existsSync(join(wsRoot, ".novaflow", "profiles", "ghost.json")));
    const ghostDelete = runNova(["profile", "delete", "ghost"], h.env);
    assert.equal(ghostDelete.code, 4);
    assert.match(ghostDelete.stderr, /not_found/);

    // ---- usage rows (exit 2) ----
    const noFile = runNova(["profile", "update", "dev"], h.env);
    assert.equal(noFile.code, 2);
    assert.match(noFile.stderr, /nova profile update <name> --file <path>/);
    const noName = runNova(["profile", "delete"], h.env);
    assert.equal(noName.code, 2);
    assert.match(noName.stderr, /nova profile delete <name>/);

    // ---- delete refuses a PINNED profile, naming the count (exit 3) ----
    mkdirSync(join(h.dir, "target"));
    assert.equal(
      runNova(
        ["project", "create", "app", "--objective", "Ship it.", "--target", `work=${join(h.dir, "target")}`],
        h.env,
      ).code,
      0,
    );
    assert.equal(
      runNova(
        ["task", "create", "TASK-1", "--title", "t", "--objective", "Do the work.", "--profile", "dev", "--project", "app", "--scope", "work"],
        h.env,
      ).code,
      0,
    );
    const pinned = runNova(["profile", "delete", "dev"], h.env);
    assert.equal(pinned.code, 3, `stdout=${pinned.stdout}`);
    assert.match(pinned.stderr, /schema_invalid/);
    assert.match(pinned.stderr, /pinned by 1 task/, "the refusal names the count");
    assert.match(pinned.stderr, /"dev"/, "the refusal names the profile");
    assert.ok(existsSync(canonical), "a pinned profile's canonical file survives");
    assert.match(readFileSync(canonical, "utf8"), new RegExp(NEWER_MODEL));

    // ---- an unpinned profile: row + canonical file removed (exit 0) ----
    const spare = writeProfile(h, "spare.json", { ...DEV, name: "spare" });
    assert.equal(runNova(["profile", "create", "--file", spare], h.env).code, 0);
    const spareCanonical = join(wsRoot, ".novaflow", "profiles", "spare.json");
    assert.ok(existsSync(spareCanonical));
    const del = runNova(["profile", "delete", "spare"], h.env);
    assert.equal(del.code, 0, del.stderr);
    assert.match(del.stdout, /deleted profile spare \(workspace-scoped\)/);
    assert.match(del.stdout, /\(removed\)/);
    assert.ok(!existsSync(spareCanonical), "the canonical file is removed");
    const delAgain = runNova(["profile", "delete", "spare"], h.env);
    assert.equal(delAgain.code, 4, "a second delete is not_found, never a silent success");

    // ---- /list survived every lifecycle move (preserve) ----
    const listAfter = JSON.parse(runNova(["profile", "list", "--json"], h.env).stdout) as {
      profiles: Array<Record<string, unknown>>;
    };
    assert.deepEqual(listAfter.profiles.map((p) => p["name"]), ["dev"]);

    assert.equal(runNova(["daemon", "stop"], h.env).code, 0);
  } finally {
    await forceStopDaemon(h);
  }
});
