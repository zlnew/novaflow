# NovaFlow

**A daemonless ledger for agent work: workspaces, projects, and tasks in SQLite, driven by a CLI or MCP.**

Coding agents know how to spawn work. What they lack is durable shared state: what exists, who
holds it, what is blocked, what runs next, and what the previous agent learned. NovaFlow keeps that
state in one SQLite database inside your workspace and hands it back as plain JSON.

NovaFlow is the control plane only. It does not spawn agents, hold model keys, price tokens, or
listen on a port.

## Install

Node.js **24 or newer** (the store uses the built-in `node:sqlite` module) and npm.

```bash
npm install -g novaflow
novaflow --version
```

No daemon, no service to start, no native compilation step.

## Quick start

```bash
# 1. A workspace is an ordinary directory. novaflow writes .novaflow/ inside it.
mkdir -p ~/work/app
novaflow workspace create --name app --path ~/work/app --default

# 2. A project holds the task keys. The prefix (APP) is derived from the title,
#    and can be pinned with --prefix.
novaflow project create --title "App" --prefix APP -w app

# 3. Tasks are the unit of work: a title, an objective, a priority, dependencies.
novaflow task create --title "Add PKCE to the login flow" --priority high -w app -p app
novaflow task create --title "Document the PKCE flow" --depends-on APP-1 -w app -p app

# 4. Ask what is ready, in order.
novaflow task next -w app --json
```

Every task gets a short readable key (`APP-1`), and every command accepts `--json` for one machine
readable envelope on `stdout`.

## Where state lives

| path | what it is |
|---|---|
| `<workspace>/.novaflow/config.yaml` | Workspace identity and defaults, plain YAML you can edit |
| `<workspace>/.novaflow/state.db` | The ledger: SQLite in WAL mode with `foreign_keys=ON` and `busy_timeout=5000` |
| `<workspace>/.novaflow/.gitignore` | Keeps the database, WAL, shared-memory and lock files out of git |
| `~/.config/novaflow/workspaces.json` | XDG index, so `-w <name>` resolves from any directory |

Workspaces are found the way git finds a repository: NovaFlow walks up from the current directory
looking for `.novaflow/config.yaml`. `--workspace <name|path>` and `NOVAFLOW_WORKSPACE` win over the
walk-up; the registry's `default_workspace` is the last resort.

## Core concepts

| concept | what it is |
|---|---|
| **workspace** | A directory that holds `.novaflow/`, its projects, and its defaults |
| **project** | A slug, a key prefix, and an objective inside one workspace |
| **task** | `todo`, `in_progress`, `blocked`, `done`, or `cancelled`, with a readable `PREFIX-N` key |
| **dependency** | A DAG edge. `task next` only returns tasks whose upstream tasks are `done` |
| **claim** | Who is working: `--by <actor>`, an optional `--ref` session, and an optional lease |
| **context** | The handoff bundle: upstream summaries, notes, artifacts, and the downstream list |
| **event** | An append-only audit row for every transition |

Lifecycle: `todo` → `in_progress` → `done`, with `blocked` and `cancelled` as the branches you will
actually see. `task start` is strict: the task must be `todo`, unclaimed (or its lease expired), and
its dependencies `done` — `--force` overrides deliberately, and says so in the audit log.

## Commands

| noun | verbs |
|---|---|
| `workspace` | `create`, `list`, `show`, `update`, `register`, `unregister` |
| `project` | `create`, `list`, `show`, `update`, `archive` |
| `task` | `create`, `list`, `next`, `status`, `context`, `update`, `start`, `complete`, `block`, `unblock`, `cancel`, `reopen`, `claim`, `release`, `depend`, `undepend`, `note`, `attach` |
| `status` | Compact board summary: counts, in progress, ready, blocked, recent events |
| `events` | `list` — the audit trail, filterable by `--task`, `--since`, `--after-seq` |
| `export` | Portable JSON snapshot of projects, tasks, dependencies, notes, artifacts, events |
| `mcp` | Serve the same operations over stdio |
| `skill` | `install`, `status`, `uninstall` |

Global flags work on every command, in any position:

```
-w, --workspace <name|path>   -p, --project <slug|prefix>
--json                        -q, --quiet
--dry-run                     -h, --help        -V, --version
```

`novaflow <noun> <verb> --help` prints that verb's flags, one example, and its exit codes. Nothing
reads `stdin`: a command either does the thing or refuses with the next move to try.

### Exit codes

| code | meaning |
|---|---|
| `0` | success |
| `1` | runtime error |
| `2` | usage or validation error |
| `3` | state or domain conflict (claimed task, unmet dependency, cycle) |
| `4` | not found (workspace, project, task) |

### JSON envelope

```json
{ "ok": true, "command": "task.start", "data": { "task": { "key": "APP-1" } }, "next_actions": [ ... ] }
```

Failures print `{ "ok": false, "command": "...", "error": { "code": "...", "message": "...", "hint": "..." } }`
on `stderr` and exit non-zero. `next_actions` are runnable command lines.

## MCP

`novaflow mcp` serves the same core service over stdio — one `novaflow_<noun>_<verb>` tool per CLI
verb. It is stateless: point it at a workspace and it resolves state on each call.

```json
{
  "mcpServers": {
    "novaflow": {
      "command": "novaflow",
      "args": ["mcp", "-w", "/home/you/work/app"]
    }
  }
}
```

Machine-local setup (`novaflow skill ...`) stays CLI-only; it is never an MCP tool.

## Agent skill

The bundled skill follows the `agentskills.io` `SKILL.md` standard. One canonical copy lives under
`${XDG_AGENTS_HOME:-~/.agents}/skills/novaflow`, and it is linked into the harnesses that are
actually installed.

```bash
novaflow skill install              # canonical copy + links into detected harnesses
novaflow skill install --local      # <project>/.agents/skills/novaflow instead
novaflow skill install --copy       # copy instead of symlink
novaflow skill install --dry-run    # show what would change, write nothing
novaflow skill status --json        # canonical version and per-harness link health
novaflow skill uninstall            # removes only novaflow-managed paths
```

Re-running `install` is a no-op when the installed version already matches. A directory NovaFlow
does not manage is refused unless you pass `--force`.

## Release

One script, five stages. Each stage refuses the wrong branch, a dirty tree, or a red check.

```bash
./release.sh check                                   # typecheck, build, test, pack allowlist, tarball smoke
./release.sh bump patch                              # on develop: bump, sync skill version, changelog, push
./release.sh pr                                      # on develop: open develop -> main
./release.sh tag                                     # on main: annotated tag + GitHub release from CHANGELOG
./release.sh publish --dry-run                       # on main: prints the exact command to run next
./release.sh publish --confirm --otp 123456           # upload to npm
```

`check` mutates nothing. It installs the packed tarball into a throwaway prefix with an isolated
`HOME`, `NOVAFLOW_HOME`, `XDG_CONFIG_HOME`, and `XDG_AGENTS_HOME`, then runs `novaflow --version`,
`novaflow workspace create`, and `novaflow skill install --dry-run` there.

`publish` is a dry run unless `--confirm` is passed. With `--confirm` it proves the `vX.Y.Z` tag is
on `origin` at `HEAD`, proves the version is absent from the npm registry, checks `npm whoami`, and
answers 2FA with `--otp <code>` or an automation token in `NODE_AUTH_TOKEN`. Without either, a
terminal hands the prompt to npm and a pipe exits `2` instead of hanging. `--tag <dist-tag>`
defaults to `latest`.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/, which bin/novaflow loads
npm test             # node:test via tsx, offline, no host mutation
```

Tests use a fresh temporary root plus isolated `HOME`, `NOVAFLOW_HOME`, and `XDG_*` for every case.
Nothing in the suite touches a real `~/.novaflow`, `~/.config/novaflow`, or `~/.agents`.

MIT licensed.
