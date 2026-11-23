import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePrompt } from "../../src/runs/prompt.ts";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "novaflow-prompt-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "spec.md"), "# Spec\nImplement PKCE.\n");
  return root;
}

test("composePrompt carries the objective and ONLY the mapped context files (FR-TSK-04)", () => {
  const root = workspace();
  try {
    const { message, files } = composePrompt({
      objective: "Implement PKCE code challenge verification.",
      contextFiles: ["docs/spec.md"],
      workspaceRoot: root,
    });
    assert.deepEqual(files.map((f) => f.path), ["docs/spec.md"]);
    assert.equal(
      message,
      [
        "Objective:",
        "Implement PKCE code challenge verification.",
        "",
        "Context files:",
        "--- docs/spec.md ---",
        "# Spec",
        "Implement PKCE.",
        "--- end docs/spec.md ---",
      ].join("\n"),
    );
    // the file content really came from disk under the workspace root
    assert.equal(files[0]?.content, "# Spec\nImplement PKCE.\n");
    assert.equal(files[0]?.resolvedPath, join(root, "docs", "spec.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt with no context files says (none) — nothing else is injected", () => {
  const root = workspace();
  try {
    const { message } = composePrompt({
      objective: "Do the thing.",
      contextFiles: [],
      workspaceRoot: root,
    });
    assert.equal(
      message,
      ["Objective:", "Do the thing.", "", "Context files:", "(none)"].join("\n"),
    );
    // a file that exists in the workspace but is NOT mapped must not appear
    assert.equal(message.includes("spec.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt: an unreadable mapped context file is a hard error naming the path", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "docs", "secret.md"), "x");
    chmodSync(join(root, "docs", "secret.md"), 0o000);
    assert.throws(
      () =>
        composePrompt({
          objective: "o",
          contextFiles: ["docs/secret.md"],
          workspaceRoot: root,
        }),
      (err: unknown) => {
        assert.match((err as Error).message, /unreadable context file "docs\/secret\.md"/);
        return true;
      },
    );
  } finally {
    chmodSync(join(root, "docs", "secret.md"), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt: a mapped context file that does not exist is a hard error too", () => {
  const root = workspace();
  try {
    assert.throws(
      () =>
        composePrompt({
          objective: "o",
          contextFiles: ["docs/missing.md"],
          workspaceRoot: root,
        }),
      /unreadable context file "docs\/missing\.md"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt: a mapped context file escaping the workspace root is a hard error naming the path", () => {
  const root = workspace();
  try {
    for (const bad of ["../outside.md", "../../etc/passwd", "/etc/passwd"]) {
      assert.throws(
        () =>
          composePrompt({
            objective: "o",
            contextFiles: [bad],
            workspaceRoot: root,
          }),
        (err: unknown) => {
          assert.ok(
            (err as Error).message.includes(`context file "${bad}" escapes the workspace root`),
            `${bad}: ${(err as Error).message}`,
          );
          return true;
        },
        bad,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt: a repair from a worktree attempt names the tree, its patch, and that the tree is read-only (DEBT-014)", () => {
  const root = workspace();
  try {
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const taskId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const worktreeRoot = join(root, ".novaflow", "worktrees", runId);
    const patchPath = join(root, ".novaflow", "runs", taskId, runId, "workspace_diff.patch");
    const { message } = composePrompt({
      objective: "Implement PKCE.",
      contextFiles: [],
      workspaceRoot: root,
      repairFeedback: "result.json was missing after agent_settled.",
      repairWorktree: { worktreeRoot, patchPath },
    });
    assert.equal(
      message,
      [
        "Objective:",
        "Implement PKCE.",
        "",
        "Context files:",
        "(none)",
        "",
        "Repair feedback from the previous attempt:",
        "result.json was missing after agent_settled.",
        "",
        `The previous attempt's worktree is ${worktreeRoot}, its workspace_diff.patch is ${patchPath}; that tree is read-only evidence — inspect it; do not write to it.`,
      ].join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composePrompt: the repair attempt additionally carries the failure feedback (FR-TSK-06)", () => {
  const root = workspace();
  try {
    const { message } = composePrompt({
      objective: "Implement PKCE.",
      contextFiles: [],
      workspaceRoot: root,
      repairFeedback: "result.json was missing after agent_settled.",
    });
    assert.equal(
      message,
      [
        "Objective:",
        "Implement PKCE.",
        "",
        "Context files:",
        "(none)",
        "",
        "Repair feedback from the previous attempt:",
        "result.json was missing after agent_settled.",
      ].join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
