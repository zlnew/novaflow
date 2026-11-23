# NovaFlow

NovaFlow is a workflow framework and orchestration toolset, not a harness. Pi is the harness:
NovaFlow gives an operator a deterministic engine for chains of bounded coding-agent tasks,
isolated git worktrees per run, and verification a task cannot skip.

## Why it exists

The v0.3.0 work started from two observed failures.

**A session that sleeps is not a session that can talk to you.** The orchestrator (a Pi session)
sat in a `sleep` loop watching a chain. Execution belongs in the daemon: the session's job is to
enqueue, end its turn, and be woken when a transition needs a human. That is the operator
contract, and v0.3.0 makes it the shape of the tool rather than a habit.

**Spend you cannot see is spend you cannot budget.** Two recorded runs, two different
denominators — stated exactly so neither can be misquoted:

- The **v0.2.0 dogfood trial** (2026-11-23, 3 runs, `$0.0643` total): cache reads were **88.8% of
  the trial's prompt tokens** — 1,230,016 of 1,384,732.
- A separate **DEBT-009-era GLM run**: **88% of the COST** was cache reads — 13,652,160
  cache-read tokens, 98.8% of that run's prompt tokens.

NovaFlow records the cache-aware usage and the cost basis per run, so the number you budget
against is the number the run recorded.

## The three rulings

1. **Profiles are free-form.** A profile is a named bundle: model identity, system prompt, tool
   allowlist, limits. Model identity is validated against the live Pi model catalog — Pi is the
   identity truth. Role labels are optional conventions; there is no role taxonomy and no trust
   tiers.
2. **Chains are the core feature.** The caller owns topology: any DAG shape, per-task profiles,
   gates, priorities, context files. The engine imposes only acyclic validation, bounded retry
   loops, and gate semantics — rules, not shapes.
3. **The engine rules; everyone else proposes.** Humans and orchestrator agents reach the engine
   through the CLI, MCP, or the Pi extension, and every transition passes the same FSM validation
   regardless of who called. No surface gets a shortcut.

## 60-second start

Requirements: **Node.js ≥ 22**, **`pi` on `PATH`**, and **git ≥ 2.40** (per-run worktrees). The
installer checks all three, warns about `sqlite3` (the bundled driver carries its own SQLite),
and refuses with the fix in the message.

```bash
git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh
```

The default route is `--from-source`: `npm install` in the checkout, then `npm link` (a symlink,
so `git pull && sh novaflow/install.sh` upgrades in place; `npm install -g .` would copy a tree
without the `tsx` loader `bin/nova` drives). `--from-tarball <pkg.tgz>` installs a packed
artifact, `--start` also starts the daemon, and `--force-ext` replaces a different Pi extension.
The installer copies the extension to `~/.pi/agent/extensions/novaflow.ts` only when absent
(reload Pi with `/reload` to pick it up) and writes `~/.novaflow/config.yaml` once, only when
absent. A second run with the same flags changes nothing, and an existing store is never touched.

It then prints the three commands that come next:

```bash
nova daemon start --migrate
nova workspace create <name> --path <dir>
nova project create <name> --objective "<text>"
```

From this checkout the same CLI is `bin/nova`; the examples below use that path, so they run
without a global link. (`bin/nova --help` prints every noun and verb.)

A single task, end to end:

```bash
bin/nova daemon start --migrate
bin/nova workspace create my-ws --path ~/work/my-ws
bin/nova workspace switch my-ws
bin/nova project create app --objective "Ship the feature." --target code=~/work/my-ws

cat > dev.json <<'JSON'
{
  "name": "dev",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "thinking_level": "medium",
  "tools_allowlist": ["read", "write", "edit", "bash"],
  "system_prompt_path": "prompts/dev_system.md",
  "limits": { "max_timeout_sec": 3600, "max_cost_usd": 5 }
}
JSON
bin/nova profile create --file dev.json

bin/nova task create FEAT-1 --title "Add PKCE" --objective "Implement PKCE." \
  --profile dev --project app --context docs/spec.md --scope code
bin/nova task run FEAT-1 --watch
bin/nova task result FEAT-1
```

`--scope code` names the project target the run is confined to. A run with no scopes is refused
before any token is spent. `task run` returns at enqueue; `--watch` is the opt-in human view.

## One worked chain

A two-task chain: a read-only plan, then a write task behind a human gate. The graph is the
`data` §4.3 shape, and every member must name its `target_scopes` (a member without scopes is
refused at import, naming the member). An empty `edges:` list is legal, so a one-task chain also
imports.

```yaml
version: "1.0.0"
project_slug: app
tasks:
  - key: PLAN
    title: Plan the change
    objective: Write the implementation plan end to end.
    profile_name: dev
    target_scopes:
      - repo_alias: code
        access_mode: read_only
  - key: WORK
    title: Do the work
    objective: Implement the planned change end to end.
    profile_name: dev
    requires_human_gate: true
    context_files: ["docs/spec.md"]
    target_scopes:
      - repo_alias: code
        access_mode: read_write
        write_scope_globs: ["src/**"]
        verification_commands: ["npm test"]
edges:
  - source_key: PLAN
    target_key: WORK
    edge_type: depends_on
```

```bash
bin/nova project import-dag chain.yaml --project app   # prints the chain-run id
bin/nova task run PLAN                                 # enqueue the root; WORK becomes ready after it
bin/nova chain status <chain-run-id> --watch           # member transitions, one line each
bin/nova task gate-approve WORK                         # the gate is a CLI/MCP act, never a web click
bin/nova task result WORK
bin/nova chain verify <chain-run-id>                    # configured vs executed verification
bin/nova chain clean <chain-run-id>                     # settled only; refuses a dirty worktree without --force
```

A `git_repo` target with `access_mode: read_write` runs in
`.novaflow/worktrees/<run_id>/<alias>/`, created by `git worktree add -b novaflow/run-<run_id>`.
A read-only git target or a plain directory runs in place. A worktree that cannot be created
refuses the run — there is no fallback to the shared tree. `nova chain clean` is the post-terminal
confirmation: it removes the worktrees and keeps the run rows and artifacts.

A task **without a chain** has no `chain clean` verb. Its trees persist on settle by design; clean
them by hand with `git -C <repo> worktree list` and `git -C <repo> worktree remove <path>`, then
`git -C <repo> worktree prune`. The `novaflow/run-<run_id>` branch stays until you delete it.

## What you can watch

The live view is two tiers. There is no NovaFlow web UI and no plugin: the installed Pi Web
(0.18.0, spiked 2026-11-23) exposes no plugin surface, so tier C is the terminal and tier D is
Pi Web's own renderer reading a private mirror.

```bash
bin/nova status                  # one screen: daemon, scheduler in-flight, spend, last 3 transitions
bin/nova status --watch          # reprints only when the screen changes; every transition line is HH:MM:SS UTC
bin/nova status --json

bin/nova web sync --all          # mirror every SETTLED run's session file into the private Pi Web dir
bin/nova web sync --run FEAT-1   # one task (key) — or a bare run ULID
bin/nova web start               # dedicated Pi Web on http://127.0.0.1:30142
bin/nova web status              # pid liveness, port, mirrored-run count, URL
bin/nova web stop
```

The mirror's rules: **copies, never links** (Pi Web could rename/delete/resume through a link);
**settled runs only** (a live transcript is a torn read, and `--run` on a live run copies
nothing); **`events.raw.jsonl` is never copied** by any path; and **no implicit prune** — the
mirror only grows with `sync`. Pi Web is read-only for NovaFlow: gates, aborts and follow-ups
stay on the CLI, MCP and the chat.

In an operator Pi session the extension arms the **wake watcher** and injects one
`[novaflow] …` follow-up per transition that needs a human — `awaiting_gate`, `failed`, and
inferred chain completion. It seeds at head on session start, so pre-existing history never
wakes. Configure it in `~/.novaflow/config.yaml`:

```yaml
wake:
  enabled: true      # default true
  workspace: null    # a workspace slug to narrow, or null for every workspace
```

`NOVAFLOW_WAKE=off` disables it for the session; `NOVAFLOW_WAKE_MS` overrides the ~2 s poll
interval.

## What ships in v0.3.0

- **Per-run worktree isolation.** `git_repo` + `read_write` targets get a tree per run under
  `.novaflow/worktrees/<run_id>/<alias>/`; write scopes and verification commands run against
  that tree. Fail-closed: no worktree, no run. Migration 0004 adds `task_runs.worktree_root`.
- **Real concurrency.** `concurrency.workspace` defaults to **2** and `concurrency.global` to
  **4**. `nova_daemon_status` reports the `inflight` count and each running run's
  `worktree_root`.
- **Background-first operation.** `nova task run` returns at enqueue; the wake watcher is the
  notification path; the operator contract (enqueue, end the turn, act when woken) is written in
  [`docs/operations.md`](docs/operations.md).
- **The live view.** Tier C (`nova status --watch`) and tier D (`nova web sync|start|stop|status`)
  as described above.
- **CLI UX.** Verb-scoped `--help` on every verb, one exit-code table (0–5), and a ` — fix: `
  next move on refusals, listed in [`docs/cli.md`](docs/cli.md).
- **Chain import.** `target_scopes` is required per member (DEBT-011); an empty `edges:` list is
  legal (DEBT-013); `nova chain verify` prints configured vs executed verification commands
  (DEBT-006).
- **Debt sweep.** `--watch` lines print `HH:MM:SS UTC` (DEBT-012); the extension's bash analyzer
  warns once per session, naming the command it could not classify (DEBT-005).
- **Install and packaging.** `install.sh`, the MIT `LICENSE`, and npm publishability: the
  `npm pack --dry-run` file list is asserted by a test, and the guarded tarball smoke runs one
  priced task end to end when `NOVAFLOW_SMOKE=1`. Publishing is a separate, operator-approved act.
- **Deterministic FSM** over the canonical states (`draft`, `queued`, `running`, `validating`,
  `awaiting_gate`, `changes_requested`, `completed`, `failed`, `cancelled`), every transition
  audited in `state_transition_logs`.
- **Scheduling**: 5-field cron and one-shot timers, missed-run policies (`skip` /
  `run_immediately`), pause/resume.
- **Zero-token pre-flight**: target roots, base-worktree cleanliness, the Pi binary, budget
  ceilings and disk availability, checked before a token is spent.
- **Independent verification**: the engine runs the configured commands and checks protected test
  files and write scopes after the run — a task never completes on its own say-so.
- **Two-file logging**: `events.raw.jsonl` (verbatim, mode `0600`, never served) and
  `events.jsonl` (scrubbed — the only read surface).
- **Storage maintenance**: online SQLite backups (`nova daemon backup`) and raw-stream retention
  (`nova daemon prune`).
- **Docs indexing**: `.md`/`.txt`/`.rst` files in a workspace's `docs/` are listable
  (`nova docs list`) and injectable into a task's prompt (`--context docs/spec.md`).

## Surfaces

| surface | what it is | entry point |
|---|---|---|
| **CLI** | the operator's control surface — one command = at most one daemon op; the offline verbs say so in the table | `bin/nova` (`nova <noun> <sub>`) |
| **MCP** | the programmatic twin, for an orchestrator agent over stdio | `nova mcp` |
| **Pi extension** | run mode (in-session scope enforcement + result submission) and operator mode (`/nova`) | `extensions/novaflow.ts` |

All three are thin clients of one daemon over a loopback Unix socket
(`~/.novaflow/novaflow.sock`). The daemon is the single writer of the SQLite store; the CLI and
MCP server never open it. NovaFlow's control plane has no TCP, no HTTP and no telemetry.

## Deliberately **not** in v1

A NovaFlow web UI or REST/SSE engine, webhooks, remote control planes, token streaming to a
dashboard, multi-user auth, a plugin marketplace, and any second orchestration path. No GitHub CI:
this box is the pipeline. The tier-D browser is Pi Web's own renderer over copied files, not a
NovaFlow server.

## Where the rest lives

The [`docs/` index](docs/index.md) is one page per concept:

- [`docs/operations.md`](docs/operations.md) — the operator contract: enqueue, end the turn, get
  woken; never sleep-poll.
- [`docs/chains.md`](docs/chains.md) — DAG import, gates, `chain verify`, `chain clean`, and the
  worktree lifecycle (including the single-task manual cleanup).
- [`docs/profiles.md`](docs/profiles.md) — create/update/delete and the scope resolution rule.
- [`docs/live-view.md`](docs/live-view.md) — tiers C and D, and the mirror rules.
- [`docs/cli.md`](docs/cli.md) — the verb audit table: purpose, blocking, `--json`, exit codes,
  help and fix hints.
- [`docs/install.md`](docs/install.md) — the acquisition routes, the checks, the config file once.

`npm test` runs the suite and `npm run typecheck` the type check; both must be green. The pinned
specification lives in the workspace repo at `odd/specs/novaflow-v1/`; the golden tests fail if
this code drifts from it.
