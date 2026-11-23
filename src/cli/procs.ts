import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Process helpers shared by the CLI's two detached-instance commands
 * (`nova daemon start|stop`, `nova web start|stop`).
 *
 * They lived inside src/cli/commands/daemon.ts until P8 needed the same
 * discipline for the private Pi Web instance; they are MOVED here (same
 * code, same behaviour) so there is one process-group reaper, one sleep and
 * one log tail in the CLI — never two spellings that drift.
 *
 * Process discipline (architecture 8.4): both instances are spawned
 * `detached: true`, so the child leads its OWN process group; killing the
 * group (`kill(-pid)`) reaches its grandchildren (pi's bash tools, pi-web's
 * workers), which killing the pid alone would orphan.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The last `n` non-empty lines of a log file (bounded, synchronous). */
export function tailFile(path: string, n: number): string {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  return lines.slice(-n).join("\n");
}

/** Is `pid` a live process? (EPERM means alive but not signalable by us.) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGTERM → bounded grace → SIGKILL on the child's process group (and the
 * pid itself, for a child that somehow left its group). Never throws.
 */
export async function reapGroup(pid: number | undefined, graceMs = 3000): Promise<void> {
  if (pid === undefined) return;
  const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, sig);
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return; // reaped
    await sleep(100);
  }
  signal("SIGKILL");
  await sleep(200);
}

/**
 * Resolve an executable on PATH without a shell (`which` is not portable and
 * spawning one would be a second failure mode). Returns null when absent.
 */
export function findOnPath(bin: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, bin);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here (or not executable)
    }
  }
  return null;
}

/**
 * Best-effort "what is listening on this TCP port", for a refusal message.
 * `ss` then `fuser`; no shell, both bounded; an honest "unidentified
 * process" when neither tool can say.
 */
export function portHolder(port: number): string {
  const ss = spawnSync("ss", ["-ltnp", `sport = :${port}`], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (ss.status === 0 && typeof ss.stdout === "string") {
    const named = /"([^"]+)",pid=(\d+)/.exec(ss.stdout);
    if (named !== null) return `pid ${named[2]} (${named[1]})`;
    const bare = /pid=(\d+)/.exec(ss.stdout);
    if (bare !== null) return `pid ${bare[1]}`;
  }
  const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (fuser.status === 0 && typeof fuser.stdout === "string") {
    const pids = fuser.stdout.trim().split(/\s+/).filter((p) => /^\d+$/.test(p));
    if (pids.length > 0) return `pid ${pids.join(", ")}`;
  }
  return "an unidentified process";
}

/** Read every regular file's name in a directory (empty when unreadable). */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Read every subdirectory's name in a directory (empty when absent). */
export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
