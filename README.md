# NovaFlow

**Run coding agents in the background, in their own git worktrees, and see exactly what they spent.**

NovaFlow is a local orchestrator for [Pi](https://github.com/earendil-works/pi) coding-agent
sessions. You describe work as tasks or as a chain of tasks, hand it to a small daemon, and get on
with something else. Each run gets its own worktree, its own budget, and an engine that verifies the
result instead of trusting it. When a run needs a human — a gate, a failure, a finished chain —
your editor session is told, and you decide.

If you have ever watched an agent drift for twenty minutes and then wondered what it cost, that is
the problem this solves.

## Quick start

Requires **Node.js 22+**, the **`pi` coding agent on your `PATH`**, and **git 2.40+**.

```bash
git clone https://github.com/zlnew/novaflow
sh novaflow/install.sh
```

The installer checks Node, npm, `pi`, git and `sqlite3`, copies the Pi extension into place,
writes a config file once, and prints the next three commands.

### Try it on a throwaway project

```bash
# 0. start the daemon (it owns the store and the state machine)
nova daemon start --migrate

# 1. a workspace is an ordinary directory: NovaFlow keeps its state and your docs there
mkdir -p ~/work
nova workspace create my-work --path ~/work
nova workspace switch my-work

# 2. a project points at targets; :git_repo is what gets per-run worktrees,
#    and its base must be a clean git repo (no uncommitted files)
git init -q ~/work/app-src && cd ~/work/app-src \
  && printf '# app\n' > README.md && git add . \
  && git -c user.email=you@example.com -c user.name=you commit -qm init && cd - >/dev/null
nova project create app --objective "Ship the feature." --target code=~/work/app-src:git_repo

# 3. a profile is a named bundle: model, prompt, tools, limits.
#    system_prompt_path resolves under the WORKSPACE root, so create it first.
mkdir -p ~/work/prompts
printf 'You are a careful developer. Make the smallest change that works.\n' \
  > ~/work/prompts/dev_system.md
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
nova profile create --file dev.json

# 4. a task, bound to the target it may touch
nova task create FEAT-1 --title "Add PKCE" --objective "Implement PKCE end to end." \
  --profile dev --project app --scope code
nova task run FEAT-1
```

`nova task run` returns immediately. The work continues in the background; `nova status --watch`
shows it, and the Pi extension wakes your session (see [operations](docs/operations.md)) when
something needs you. The run's changes land in its own worktree — NovaFlow never commits to your
branch.

## What it does for you

| | |
|---|---|
| **Work runs without you holding it open** | Runs live in a daemon. You enqueue, end your turn, and get woken on the events that matter. |
| **Two agents cannot collide** | Each run on a writable git target works in its own `git worktree`, from a commit of that target's base branch. Read-only git targets and plain directories run in place, and the runner says so. |
| **A task cannot pass itself** | The engine runs the verification commands you configure, then checks protected test files and write scopes after the agent settles. Completion is the engine's verdict, not the agent's claim. |
| **Cost is recorded, not estimated** | Every run stores fresh input, cache read, cache write and output tokens, priced from a local table. `nova status` shows today and this month, and names any model that has no price, so a silent zero cannot happen. |
| **You can read any run afterwards** | Each run's transcript is kept: a redacted event log for reading, and a verbatim one kept `0600` and never served. |

## How it works

```
   your Pi session  ──┐
   an agent via MCP  ─┼──►  nova daemon  ──►  run 1 ─► worktree A ─► verify ─► result
   your shell (CLI)  ─┘        │             run 2 ─► worktree B ─► verify ─► result
                               └── one SQLite store, one writer, one state machine
```

The daemon owns the store and the state machine. The CLI, the MCP server, and the Pi extension are
thin clients of one Unix socket at `~/.novaflow/novaflow.sock` — no TCP port, no HTTP, no telemetry.
Every state change passes the same validation whoever asked for it.

## Core concepts

| concept | what it is |
|---|---|
| **workspace** | The directory you work from, plus its budgets and concurrency. One machine can hold several. |
| **project** | A goal inside a workspace, with one or more named **targets** (a git repo or a plain directory, each with an access mode). |
| **profile** | A reusable agent bundle: model, system prompt, tool allowlist, time and cost limits. |
| **task** | One bounded objective for one profile: a title, a written objective, optional context files, an optional gate. |
| **chain** | Tasks wired into an acyclic graph — `depends_on`, `on_changes_requested`, `on_failure` — imported as one YAML file. |
| **run** | One attempt at a task: a Pi session, a worktree, tokens, cost, and a result artifact. A retry is a new run. |
| **gate** | A task that waits for a human before it continues. Approve, or reject with feedback and the chain routes on it. |

A task's states are `draft → queued → running → validating → completed`, with `awaiting_gate`,
`changes_requested`, `failed` and `cancelled` as the branches you will actually see.

## Everyday commands

| I want to… | command |
|---|---|
| see what is happening | `nova status`, `nova status --watch` |
| run a task and walk away | `nova task run <id or key>` |
| run a task and watch it | `nova task run <id or key> --watch` |
| read a result | `nova task result <id or key>` |
| follow a run's log | `nova task logs <id or key> --follow` |
| import a chain | `nova project import-dag chain.yaml --project app` |
| watch a chain | `nova chain status <chain-id> --watch` |
| decide a gate | `nova task gate-approve <id> [--note …]`, `nova task gate-reject <id> "<feedback>"` |
| check what verification ran | `nova chain verify <chain-id>` |
| tidy the worktrees | `nova chain clean <chain-id> [--force]` |
| browse finished runs in a browser | `nova web sync --all && nova web start` |

`nova <noun> <verb> --help` prints that verb's usage, flags, one example and its exit codes.
Exit codes are stable: `0` ok, `1` failed, `2` usage, `3` engine-state rejection, `4` not found,
`5` daemon unreachable. Every refusal ends with the next move to try.

## Watching work

```bash
nova status                  # daemon, in-flight runs, today/month spend, last transitions
nova status --watch          # same screen, reprinted only when it changes
nova web sync --all          # copy settled run transcripts into a private Pi Web directory
nova web start               # browse them at http://127.0.0.1:30142
```

The browser view is Pi Web's own renderer pointed at a private directory of **copied** transcripts,
so it can never change a run. Copies are made only for settled runs, never for a run still writing,
and the verbatim event log is never copied.

In a Pi session, the extension wakes you on the transitions that need a human — a gate, a failure,
a finished chain — so you do not poll:

```yaml
# ~/.novaflow/config.yaml
wake:
  enabled: true
  workspace: null   # or a workspace slug
```

## The safety model, plainly

- **Nothing runs unconfined.** A run without target scopes is refused before a token is spent.
- **Preflight is free.** Target roots, a clean base worktree, the Pi binary, budget ceilings and
  disk space are checked before the agent starts.
- **Write scopes are enforced during the run** by the Pi extension, which reads its allowed roots
  from the run's own directory and fails closed.
- **Verification runs after the agent stops**, with protected test files watched, so a task cannot
  quietly disable the tests that judge it.
- **Two logs per run**: `events.jsonl` (redacted, the read surface) and `events.raw.jsonl`
  (verbatim, `0600`, never served).
- **Merging is yours.** NovaFlow never merges. It leaves each run's worktree and patch on disk and
  tells you what changed.

## Is it for you?

Good fit: you already run coding agents, you want unattended work with an audit trail, you care
what it costs, and you are happy merging the results yourself.

Not a fit: you want a hosted service, a web dashboard that edits code, multi-user auth, or an agent
that merges to `main` on its own. Those are deliberate non-goals, not roadmap items.

## Documentation

| page | covers |
|---|---|
| [Quick start](docs/install.md) | the two install routes, what the installer checks, the config file |
| [Operations](docs/operations.md) | the daily loop: enqueue, step away, act when woken |
| [Chains](docs/chains.md) | the chain format, gates, retries, verification, worktree cleanup |
| [Profiles](docs/profiles.md) | creating, updating and deleting profiles, and how names resolve |
| [Live view](docs/live-view.md) | the terminal screen, the browser mirror, tailnet access |
| [CLI reference](docs/cli.md) | every verb: purpose, blocking behaviour, `--json`, exit codes |
| [Maintaining](docs/maintaining.md) | how a release is cut and published |

Every page is listed in the [docs index](docs/index.md), with the reading order.

## Status

Pre-1.0, single-operator by design, MIT licensed. The store is SQLite; the control plane is local.
Back up with `nova daemon backup` and read `nova daemon status` for the version and budget in force.

```bash
npm test          # the suite
npm run typecheck # the type check
```
