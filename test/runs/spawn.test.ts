import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { specFile } from "../helpers/spec.ts";
import {
  buildRunArgv,
  PI_TOOLS,
  defaultExtensionPath,
  runDirPath,
} from "../../src/runs/spawn.ts";

/**
 * Golden: the spawn argv is EXACTLY api.md §1 — flag order and values,
 * parsed live from the spec's invocation block.
 */
function specInvocationFlags(): string[] {
  const api = specFile("api.md");
  const start = api.indexOf("## 1. Invocation Syntax");
  assert.ok(start >= 0, "api.md §1 heading not found");
  const m = api.slice(start).match(/```text\n([\s\S]*?)```/);
  assert.ok(m && m[1], "api.md §1 invocation block not found");
  const lines = m[1]!.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  // one flag per line; the first line is "pi --mode rpc" (binary + first flag)
  const flags: string[] = [];
  for (const l of lines) {
    const toks = l.split(/\s+/);
    if (toks[0] === "pi") flags.push(toks[1]!);
    else if ((toks[0] ?? "").startsWith("-")) flags.push(toks[0]!);
  }
  return flags;
}

test("golden: buildRunArgv flags follow api.md §1 exactly, in order", () => {
  const expected = specInvocationFlags();
  assert.deepEqual(expected, [
    "--mode", "-e", "--tools", "--session-dir", "--session-id",
    "--model", "--thinking", "--append-system-prompt", "--no-approve",
  ]);

  const argv = buildRunArgv({
    extensionPath: "/ext/novaflow.ts",
    runDir: "/ws/.novaflow/runs/01TASK/01RUN",
    runId: "01RUN",
    model: "claude-3-5-sonnet-20241022",
    thinkingLevel: "high",
    systemPromptFile: "/ws/.novaflow/prompts/sys_dev.txt",
  });
  // every even index is a flag, in the spec's exact order
  const flags = argv.filter((_, i) => i % 2 === 0);
  assert.deepEqual(flags, expected);
  assert.deepEqual(argv, [
    "--mode", "rpc",
    "-e", "/ext/novaflow.ts",
    "--tools", PI_TOOLS,
    "--session-dir", "/ws/.novaflow/runs/01TASK/01RUN",
    "--session-id", "01RUN",
    "--model", "claude-3-5-sonnet-20241022",
    "--thinking", "high",
    "--append-system-prompt", "/ws/.novaflow/prompts/sys_dev.txt",
    "--no-approve",
  ]);
});

test("golden: the tools allowlist is the spec's §1 list, verbatim", () => {
  const api = specFile("api.md");
  const m = api.match(/--tools (\S+)/);
  assert.ok(m);
  assert.equal(PI_TOOLS, m[1]);
  assert.equal(PI_TOOLS, "read,bash,edit,write,novaflow_submit_result");
});

test("golden: defaultExtensionPath is the spec's §1 -e value with ~ expanded", () => {
  const api = specFile("api.md");
  const m = api.match(/-e (\S+)/);
  assert.ok(m);
  assert.equal(m[1], "~/.pi/agent/extensions/novaflow.ts");
  assert.equal(
    defaultExtensionPath(),
    join(homedir(), ".pi", "agent", "extensions", "novaflow.ts"),
  );
});

test("runDirPath is <workspace_root>/.novaflow/runs/<task_id>/<run_id> with bare ULIDs (data.md 5.1/5.2)", () => {
  assert.equal(
    runDirPath("/ws", "01TASKULIDAAAAAAAAAAAAAA", "01RUNULIDAAAAAAAAAAAAAAA"),
    join("/ws", ".novaflow", "runs", "01TASKULIDAAAAAAAAAAAAAA", "01RUNULIDAAAAAAAAAAAAAAA"),
  );
});
