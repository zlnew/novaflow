import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The thin-client rule (grep-level): src/cli NEVER opens the SQLite
 * store — no better-sqlite3, no openDb, no store/db import. The one
 * sanctioned exception is `nova daemon start --foreground`, which runs
 * the DAEMON itself in-process via a DYNAMIC import of the lifecycle
 * (the store is opened by the daemon, never by a client command); a
 * static lifecycle import would drag the store into every invocation
 * and is refused here too.
 */

const CLI_DIR = join(import.meta.dirname, "..", "..", "src", "cli");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("thin client discipline: src/cli never opens the SQLite store", () => {
  const files = tsFiles(CLI_DIR);
  assert.ok(files.length > 0, "the CLI sources must exist for this rule to bite");
  for (const path of files) {
    const src = readFileSync(path, "utf8");
    assert.doesNotMatch(src, /better-sqlite3/, `${path} must not import better-sqlite3`);
    assert.doesNotMatch(src, /\bopenDb\b/, `${path} must not call openDb`);
    assert.doesNotMatch(src, /store\/db/, `${path} must not touch the store module`);
    // the daemon entry is importable ONLY dynamically (foreground mode)
    assert.doesNotMatch(
      src,
      /import\s*{[^}]*startDaemon/s,
      `${path} must reach startDaemon only via a dynamic import`,
    );
  }
});
