---
name: novaflow
description: Drive NovaFlow workspaces, projects, and tasks. Query next ready work, load handoff context, then start, note, complete, or block a task with the non-interactive novaflow CLI or its MCP tools.
license: MIT
compatibility: "Requires novaflow >= 1.0.0 CLI on PATH"
metadata:
  version: "1.0.0"
  author: "zlnew"
---

# NovaFlow

NovaFlow is a daemonless task ledger: SQLite state inside `<workspace>/.novaflow/`,
project prefixes (`NV3-1`), a strict lifecycle, and dependency-aware dispatch.
The binary is `novaflow`. It never prompts on stdin.

## When this skill applies

- The request mentions NovaFlow, a workspace, a project prefix, or a task key.
- You are asked to pick up, hand off, complete, or unblock agent work.
- You need the state of the board before deciding what runs next.

## The orchestrator loop

Run these five steps in order. Never skip `context` before `start`.

| Step | Command | Why |
|---|---|---|
| 1. Pick | `novaflow task next --json [--project <p>]` | Ready tasks, ordered by priority then age |
| 2. Load | `novaflow task context <ID> --json` | Objective, upstream summaries/notes/artifacts |
| 3. Claim | `novaflow task start <ID> --by <actor> --ref <session>` | `todo` -> `in_progress`, holds the lease |
| 4. Record | `novaflow task note <ID> "<text>"`, `novaflow task attach <ID> <uri>` | Durable progress trail for the next agent |
| 5. Close | `novaflow task complete <ID> --summary "<text>"`, or `novaflow task block <ID> --reason "<text>"` | `done`, or `blocked` with a reason |

`block` requires `--reason` or `--on <OTHER_ID>`. Clear a blocker with
`novaflow task unblock <ID> --start`, never by editing status by hand.

## Read state before you report it

- `novaflow task status <ID>` — state, claim, unmet dependencies, recent events.
- `novaflow status` — board counts plus `ready`, `in_progress`, `blocked` lists.
- `novaflow task list --ready` — the same set as `next`, without ranking.
- `novaflow events --task <ID>` — the immutable audit trail.

The ledger is the truth. If a command did not return `ok: true`, the transition
did not happen.

## Non-interactive conventions

- Always pass `--json` in scripts and agents: one envelope on `stdout`, one error
  envelope on `stderr`, nothing else.
- Success: `{ "ok": true, "command": "...", "data": {...}, "next_actions": [...] }`.
  `next_actions` are runnable command lines — follow them instead of guessing.
- Failure: exit `2` usage, `3` state conflict, `4` not found, `1` runtime. The
  error carries `code`, `message`, and usually a `hint`.
- `--dry-run` validates without writing. `--quiet` prints identifiers only.
- Never invent task keys, states, or summaries. Read them back.
- Do not edit `.novaflow/state.db` or protected tests to force an outcome.

## Installing this skill

```bash
novaflow skill install              # ~/.agents/skills/novaflow + detected harnesses
novaflow skill install --local      # <project>/.agents/skills/novaflow
novaflow skill status --json        # canonical version + per-harness link health
novaflow skill uninstall            # removes only novaflow-managed paths
```

Re-running `install` is a no-op when the installed version already matches.

## MCP alternative

`novaflow mcp` serves the same operations over stdio as `novaflow_<noun>_<verb>`
tools (`novaflow_task_next`, `novaflow_task_context`, ...). Installation
commands stay CLI-only. Machine-local setup is never an MCP tool.

## References

- `references/cli-reference.md` — every command, flag, exit code, and MCP tool.
  Read it only when a flag is not obvious from `novaflow <command> --help`.
