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
and MCP server never open it. NovaFlow's own control plane has no TCP, no HTTP, no web UI.

There is one web surface, and it is Pi Web's, not NovaFlow's: a dedicated Pi Web instance
reads a private directory of **copied** session files (tier D, below). It is read-only for
NovaFlow — no gate can be approved from it, and nothing in it is a control surface.

## What actually ships

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
- **The live view** (`nova status --watch`, `nova web sync|start|stop|status`): the tier-C
  operator screen and the tier-D mirror of SETTLED run transcripts into a private Pi Web
  instance. Copies, never links; never `events.raw.jsonl` (see below).
- **Docs indexing**: `.md`/`.txt`/`.rst` files in a workspace's `docs/` are listable
  (`nova docs list`) and injectable into a task's prompt (`--context docs/spec.md`).
- **The Pi extension**: blocks writes outside the task's scope and protected test files,
  and accepts the validated `result.json` handoff as the run's completion signal. Its bash
  scan is best-effort: a command it cannot classify (reads, script bodies, heredocs, git
  internals) is allowed with one warning per session naming the command.

Deliberately **not** in v1: a web UI, a REST/SSE engine, webhooks, remote control planes,
token streaming to a dashboard, and any second orchestration path.

## The live view

Two tiers, no plugin — the installed Pi Web exposes no plugin surface (spiked against pi-web
0.18.0 / pi 1.6.0, 2026-11-23), so the panel is built from NovaFlow's own files and Pi Web's
own renderer.

```bash
bin/nova status                  # one screen: daemon, in-flight, spend, last 3 transitions
bin/nova status --watch          # reprints only when it changes (2 s cursor poll)
bin/nova status --json

bin/nova web sync --all          # mirror every SETTLED run's session file
bin/nova web sync --run FEAT-1   # one task (key) — or a bare run ULID
bin/nova web start               # dedicated Pi Web on http://127.0.0.1:30142
bin/nova web status              # pid liveness, port, mirrored-run count, URL
bin/nova web stop
```

`nova web start` needs `pi-web` on `PATH` (`npm install -g @agegr/pi-web`), sets
`PI_CODING_AGENT_DIR=~/.novaflow/piweb`, writes `~/.novaflow/piweb/piweb.log` and
`piweb.pid`, and waits for `GET /api/sessions` before printing the URL. It refuses a busy
port naming what holds it, and refuses to start a second instance over a live one.

The mirror's rules, in one place:

- **Copies, never links.** A hardlink would let Pi Web's rename/delete/resume write through to
  a run's record; `sync` writes an independent byte copy and rewrites it only when the source
  actually changed (a second `sync` changes nothing, not even an mtime).
- **Settled runs only.** A live run's transcript is still being written, so copying it is a
  torn read: `--run` on a live run refuses (exit 1, `nova status --watch` is the pointer) and
  copies nothing; `--all` is a workspace sweep where in-flight work is expected, so it
  mirrors the settled runs and reports the live ones as `refused`.
- **No raw stream, ever.** `events.raw.jsonl` is never copied by any path; the redacted
  `events.jsonl` is not the mirror's unit either — only the run's own pi session file is.
  The run directory is opened read-only: nothing is written, renamed or deleted inside it.
- **No implicit prune.** The mirror only grows with `sync`; delete
  `~/.novaflow/piweb/sessions` by hand to empty it. Nothing in NovaFlow ever deletes it.

The destination is Pi Web's own layout, derived from the session's recorded cwd:
`~/.novaflow/piweb/sessions/--home-x-y--/<ts>_<run id>.jsonl` for a run started in
`/home/x/y`.

## Install

Requires **Node.js ≥ 22**, a working **Pi** installation (`pi` on `PATH`) — the engine spawns
it for every run — and **git ≥ 2.40** (per-run worktrees). The installer checks all three and
refuses with the fix in the message.

```bash
git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh
```

That one command runs `npm install` in the checkout, links `nova` onto your `PATH` with
`npm link` (a symlink to this checkout, so `git pull && sh novaflow/install.sh` upgrades it
in place — `npm install -g .` would copy a tree without the `tsx` loader `bin/nova` drives),
copies the extension to `~/.pi/agent/extensions/novaflow.ts` (only when absent, so reload Pi
with `/reload` to pick up a fresh deploy), writes `~/.novaflow/config.yaml` once (only when
absent), and prints the three commands that come next. `--start` also starts the daemon;
`--from-tarball <pkg.tgz>` installs a packed artifact instead of this checkout. A second run
with the same flags changes nothing, and an existing store is never touched.

The same steps by hand:

```bash
cd novaflow
npm install             # also builds better-sqlite3
bin/nova daemon start   # it persists across CLI invocations
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
