# NovaFlow

**NovaFlow is a workflow framework and orchestration toolset — not a harness. Pi is the
harness.**

NovaFlow normalizes and rules agentic lines, flows, and knowables: a deterministic engine
owns every state transition, and bounded Pi sessions do the cognitive work. It is built
mainly for coding, but it is domain-agnostic — the engine core knows
tasks, states, artifacts, and verification commands, nothing specific to code. The
orchestrator (human or conversational agent) lives *outside* NovaFlow with full freedom
over what to do; NovaFlow provides the tools and the rules.

## The three rulings

1. **Profiles are free-form.** A profile is a named bundle: model identity, system prompt,
   tool allowlist, limits. Model identity is validated against the live Pi model catalog —
   Pi is the identity truth. Role labels are optional conventions; there is no role
   taxonomy and no trust tiers.
2. **Chains are the core feature.** The caller owns topology: any DAG shape, per-task
   profiles, gates, priorities, context files. The engine imposes only acyclic validation,
   bounded retry loops, and gate semantics — rules, not shapes.
3. **The engine rules; everyone else proposes.** Humans and orchestrator agents reach the
   engine through the CLI, MCP, or the Pi extension, and every transition passes the same
   FSM validation regardless of who called. No surface gets a shortcut.

## Surfaces

| surface | what it is | entry point |
|---|---|---|
| **CLI** | the operator's control surface — one command = one daemon op | `bin/nova` (`nova <noun> <sub>`) |
| **MCP** | the programmatic twin, for an orchestrator agent over stdio | `nova mcp` |
| **Pi extension** | run mode (in-session scope enforcement + result submission) and operator mode (`/nova`) | `extensions/novaflow.ts` |

All three are thin clients of one daemon over a loopback Unix socket
(`~/.novaflow/novaflow.sock`). The daemon is the single writer of the SQLite store; the CLI
and MCP server never open it. There is no TCP, no HTTP, no web UI.

## What actually ships (v1)

- **Deterministic FSM** over the canonical states (`draft`, `queued`, `running`,
  `validating`, `awaiting_gate`, `changes_requested`, `completed`, `failed`, `cancelled`),
  with every transition audited in `state_transition_logs`.
- **Chains**: DAG import (JSON or a YAML subset), dependency-gated readiness, review
  re-entry on `changes_requested`, `on_failure` fallbacks, chain-level terminal rules,
  aggregated `PROJECT_SUMMARY.md`.
- **Scheduling**: 5-field cron and one-shot timers, missed-run policies (`skip` /
  `run_immediately`), pause/resume.
- **Zero-token pre-flight**: target roots, base-worktree cleanliness, the Pi binary, budget
  ceilings, and disk availability are all checked *before* a token is spent.
- **Independent verification**: the engine runs the configured verification commands and
  checks protected test files and write scopes after the run — a task never completes on
  its own say-so.
- **Two-file logging**: `events.raw.jsonl` (verbatim, mode `0600`, never served) and
  `events.jsonl` (scrubbed — the only read surface).
- **Storage maintenance**: online SQLite backups (`nova daemon backup`) and raw-stream
  retention (`nova daemon prune`).
- **Docs indexing**: `.md`/`.txt`/`.rst` files in a workspace's `docs/` are listable
  (`nova docs list`) and injectable into a task's prompt (`--context docs/spec.md`).
- **The Pi extension**: blocks writes outside the task's scope and protected test files,
  and accepts the validated `result.json` handoff as the run's completion signal.

Deliberately **not** in v1: a web UI, a REST/SSE engine, webhooks, remote control planes,
token streaming to a dashboard, and any second orchestration path.

## Install

Requires **Node.js ≥ 22** and a working **Pi** installation (`pi` on `PATH`).

```bash
git clone <this repo> && cd novaflow
npm install          # also builds better-sqlite3
```

Start the daemon (it persists across CLI invocations):

```bash
bin/nova daemon start
```

Then install the extension so spawned sessions enforce scope and can submit results:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/novaflow.ts ~/.pi/agent/extensions/novaflow.ts
```

In an **operator** session (a plain `pi` session, no `NOVAFLOW_RUN_CONTEXT`) the same
extension adds the `/nova` command family and the **wake watcher**: it polls the
transition stream every ~2 s and injects one `[novaflow] …` follow-up message per
transition that needs a human — `awaiting_gate`, `failed`, and inferred chain
completion. It seeds at head on session start, so pre-existing history never wakes.
Configure it in `~/.novaflow/config.yaml`:

```yaml
wake:
  enabled: true      # default true
  workspace: null    # a workspace slug to narrow, or null for every workspace
```

`NOVAFLOW_WAKE=off` disables the watcher for the session; `NOVAFLOW_WAKE_MS` overrides
the poll interval.

`npm test` runs the suite and `npm run typecheck` the type check; both must be green.

## Quickstart — a chained task workflow in three steps

```bash
# 1. a workspace + a project
bin/nova workspace create my-ws --path ~/work/my-ws
bin/nova workspace switch my-ws
bin/nova project create app --objective "Ship the feature."

# 2. an agent profile (free-form: model, prompt, tools, limits)
cat > dev.json <<'JSON'
{
  "name": "dev",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "thinking_level": "medium",
  "tools_allowlist": ["read", "write", "edit", "bash"],
  "system_prompt_path": "prompts/dev.md",
  "limits": { "max_timeout_sec": 3600, "max_cost_usd": 5 }
}
JSON
bin/nova profile create --file dev.json
# change the profile later: the canonical file and the stored row move together
# (a renamed profile file, an invalid one or an unresolvable model is refused)
bin/nova profile update dev --file dev.json
# delete it -- refused, naming the count, while any task still pins it
bin/nova profile delete dev

# 3. a task, run to completion -- --scope names a project target the run
#    is confined to (DEBT-010: the run refuses a task with no scopes)
bin/nova task create FEAT-1 --title "Add PKCE" --objective "Implement PKCE." \
  --profile dev --project app --context docs/spec.md --scope code
bin/nova task run FEAT-1 --watch
bin/nova task result FEAT-1
```

For a **chain** instead of a single task, describe the graph and import it:

```bash
bin/nova project import-dag chain.yaml --project app
bin/nova chain status <chain-run-id>
```

`bin/nova help` prints every noun and verb. The pinned specification lives in the workspace
repo at `odd/specs/novaflow-v1/` — the spec set is the contract, and the golden tests fail
if this code drifts from it.
