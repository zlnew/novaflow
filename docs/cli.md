# The `nova` CLI — every verb

`nova` is a thin client: one command is one call to the daemon, and the CLI never opens the store
itself. This page is the full surface in one table — every verb, what it does, whether it waits,
whether it speaks JSON, and which exit codes it can produce.

You will not read this top to bottom. Use it to answer three questions: *is this command going to
sit there?*, *what does exit 3 mean?*, and *what is this verb actually for?*

## How to read the table

| column | the question it answers |
| --- | --- |
| **verb** | the exact words to type, in the order the program lists them |
| **purpose** | what one call does, in one line |
| **blocking** | whether the command returns, returns at enqueue, or waits — see below |
| **`--json`** | whether the verb can print one JSON document instead of a table; every read verb can |
| **exit codes** | every code this verb can exit with, out of the table further down |

## What "blocking" means for an operator

| value | what you get |
| --- | --- |
| `returns` | the daemon answers, the command prints, the shell is yours again. Almost everything. |
| `returns at enqueue` | `nova task run` queues the task and exits; the work continues in the daemon |
| `blocks to completion` | `nova mcp` serves until its client disconnects, because it is a server |

`--watch` and `--follow` are opt-in and are for a human at a terminal. They appear in the help text
of the verbs that accept them, never in a script: a script that passes `--watch` is a script that
hangs. When you want to wait for an outcome in a script, poll `nova task status --json` yourself, or
use the MCP tools, which never block.

## Help

| request | answer | exit |
| --- | --- | --- |
| `nova <noun> <verb> --help` (or `-h`) | that verb's usage, flags, one example and its exit codes | 0 |
| `nova <noun> --help` | the noun's verbs, one line each | 0 |
| `nova help <noun>` | the same noun list | 0 |
| `nova help` (or bare `nova`) | the program overview (`nova help` prints it on stdout, bare `nova` on stderr) | 0 for `nova help`, 2 for bare `nova` |
| an unknown flag on a known verb | that verb's usage | 2 |
| an unknown noun or subcommand | the program overview | 2 |

`--help` is intercepted before any flag parsing, so `nova chain verify --help` answers with that
verb's own usage, flags and one example — **never the whole manual**. A one-verb noun (`status`,
`version`, `mcp`) prints its usage the same way.

## Exit codes

Six codes, and nothing else. Scripts can rely on them.

| exit | short | meaning |
| --- | --- | --- |
| 0 | ok | success |
| 1 | failed | operation failure (task failed, verification failed, refused operation) |
| 2 | usage | usage error (unknown verb, flag or positional shape) |
| 3 | state | engine-state rejection (invalid transition, schema invalid, unverified chain) |
| 4 | not-found | not found (unknown id, key, slug or schedule) |
| 5 | offline | daemon unreachable (no socket, or no answer) |

Exit `2` also prints the verb's usage block, which is itself the fix. Exit `3` means the request was
well formed and the engine said no — a chain that is still running, a task in the wrong state, a
verification command that never ran. Exit `5` means start the daemon.

## Verbs

| verb | purpose | blocking | --json | exit codes |
| --- | --- | --- | --- | --- |
| `nova workspace create` | register a workspace root directory | returns | yes | 0 1 2 3 4 5 |
| `nova workspace list` | list registered workspaces | returns | yes | 0 2 5 |
| `nova workspace switch` | set the CLI-local active workspace marker | returns | yes | 0 2 4 5 |
| `nova workspace archive` | archive a workspace: execution disabled, logs stay read-only | returns | yes | 0 2 3 4 5 |
| `nova workspace unregister` | remove a workspace from the registry (files on disk untouched) | returns | yes | 0 2 3 4 5 |
| `nova project create` | create a project with optional targets | returns | yes | 0 1 2 3 4 5 |
| `nova project list` | list projects (active workspace when one is set) | returns | yes | 0 2 5 |
| `nova project status` | one project: phase, task counts, targets | returns | yes | 0 2 4 5 |
| `nova project phase` | set the project's free-text phase label (audited) | returns | yes | 0 2 3 4 5 |
| `nova project import-dag` | import a chain graph (JSON or YAML) as draft members | returns | yes | 0 1 2 3 4 5 |
| `nova profile create` | validate and store an agent profile from a file | returns | yes | 0 1 2 3 5 |
| `nova profile update` | replace a profile's document and canonical file | returns | yes | 0 1 2 3 4 5 |
| `nova profile delete` | delete an unpinned profile (a pinned one is refused) | returns | yes | 0 1 2 3 4 5 |
| `nova profile list` | list profiles visible in the current scope | returns | yes | 0 2 5 |
| `nova profile validate` | structural check of a stored profile (catalog probe happens at enqueue) | returns | yes | 0 2 3 4 5 |
| `nova task create` | create a task in draft | returns | yes | 0 1 2 3 4 5 |
| `nova task list` | list tasks, optionally scoped to a project or state | returns | yes | 0 2 4 5 |
| `nova task run` | enqueue a draft task (draft → queued); --watch waits for the outcome | returns at enqueue | yes | 0 1 2 3 4 5 |
| `nova task status` | one task: state, current run, elapsed time; --watch prints transitions | returns | yes | 0 2 4 5 |
| `nova task result` | print the task's latest result.json artifact | returns | yes | 0 2 4 5 |
| `nova task logs` | tail the run's redacted events log; --follow streams it live | returns | yes | 0 2 4 5 |
| `nova task abort` | abort a live run (the run is marked cancelled, its group killed) | returns | yes | 0 2 3 4 5 |
| `nova task retry` | operator retry of a failed task | returns | yes | 0 2 3 4 5 |
| `nova task steer` | record an operator steering message for the task | returns | yes | 0 2 4 5 |
| `nova task gate-approve` | approve the human gate on a gated run | returns | yes | 0 2 3 4 5 |
| `nova task gate-reject` | reject the human gate, feeding the feedback back to the run | returns | yes | 0 2 3 4 5 |
| `nova schedule attach` | attach a cron or one-shot schedule to a task | returns | yes | 0 2 3 4 5 |
| `nova schedule list` | list schedules, optionally for one task or workspace | returns | yes | 0 2 4 5 |
| `nova schedule pause` | pause one schedule: no runs fire, resume recomputes the next one | returns | yes | 0 2 3 4 5 |
| `nova schedule resume` | resume a paused schedule | returns | yes | 0 2 3 4 5 |
| `nova daemon start` | start the daemon (detached) or run it in the foreground | returns | yes | 0 1 2 |
| `nova daemon stop` | stop the daemon and wait for its socket to go | returns | yes | 0 1 2 5 |
| `nova daemon status` | daemon uptime, scheduler counters, spend totals | returns | yes | 0 2 5 |
| `nova daemon pause` | pause dispatch (running runs finish, nothing new starts) | returns | yes | 0 2 5 |
| `nova daemon resume` | resume dispatch | returns | yes | 0 2 5 |
| `nova daemon kill-all` | pause dispatch and abort every live run | returns | yes | 0 2 5 |
| `nova daemon backup` | online SQLite backup of the store (never overwrites) | returns | yes | 0 1 2 3 5 |
| `nova daemon prune` | purge run-dir events.raw.jsonl past retention (events.jsonl is never touched) | returns | yes | 0 2 3 5 |
| `nova daemon logs` | tail the daemon log file | returns | yes | 0 2 4 |
| `nova status` | one operator screen: daemon, scheduler, spend, last three transitions | returns | yes | 0 2 5 |
| `nova web sync` | mirror settled runs' transcripts into the private Pi Web agent dir | returns | yes | 0 1 2 3 4 5 |
| `nova web start` | start the dedicated Pi Web instance on port 30142 | returns | yes | 0 1 2 |
| `nova web stop` | stop the dedicated Pi Web instance | returns | yes | 0 1 2 |
| `nova web status` | Pi Web instance: pid, port, answering, mirrored runs | returns | yes | 0 2 |
| `nova version` | print the CLI version (offline; no daemon round-trip) | returns | yes | 0 2 |
| `nova chain list` | list chain runs with member counts | returns | yes | 0 2 5 |
| `nova chain status` | one chain: state and per-member readiness; --watch prints member transitions | returns | yes | 0 2 4 5 |
| `nova chain abort` | abort a chain run and its members | returns | yes | 0 2 3 4 5 |
| `nova chain pause` | pause readiness propagation and dispatch for the chain's members | returns | yes | 0 2 3 4 5 |
| `nova chain resume` | resume a paused chain (readiness is evaluated immediately) | returns | yes | 0 2 3 4 5 |
| `nova chain clean` | remove a settled chain's run worktrees (run rows and artifacts are kept) | returns | yes | 0 1 2 3 4 5 |
| `nova chain verify` | configured versus executed verification commands; exit 3 when one was never executed | returns | yes | 0 2 3 4 5 |
| `nova mcp` | serve the MCP control surface on stdio (a server, not a one-shot command) | blocks to completion | no | 0 1 2 |
| `nova docs list` | list the workspace docs index (the selectable --context options) | returns | yes | 0 2 4 5 |

Every read verb supports `--json`: one JSON document on stdout, no table, no colour. `nova mcp` is
the single exception — its stdout is the protocol channel, so a JSON document there would corrupt
the stream.

## Every error names the fix

A refusal ends with your next move, marked the same way everywhere: ` — fix: `. The message before
the marker says what was wrong; the clause after it names the command to run. A script that
captures stderr sees the same next move a human sees on the screen.

```text
nova: schema_invalid: the chain graph must declare a non-empty string "project_slug" — fix: correct the graph file and re-run `nova project import-dag <file>`
```

The refusals you are most likely to meet, and what each one tells you to do:

| refusal | next move it names |
| --- | --- |
| graph import `schema_invalid` | correct the graph file, then re-run `nova project import-dag <file>` |
| no target scope on a task (`task … carries no target_scopes`) | add one with `nova task create … --scope <repo_alias>`, then re-run `nova task run <id|key>` |
| the price table is missing or unparsable (`cost budget enforcement inert`) | write `~/.novaflow/prices.json` with the model's per-million-token rates, then `nova task retry <id|key>` |
| a live daemon already answers at the socket | check it with `nova daemon status`, or stop it with `nova daemon stop` |
| a live Pi Web already answers at the URL | browse that URL, or stop it with `nova web stop` |
| `port <n> is already in use` | stop the process holding it, or set `NOVAFLOW_PIWEB_PORT` to a free port |
| `the daemon did not answer <socket> within 15 s` | read the log tail printed below the message, fix the cause, re-run the start command |
| `workspace "<slug>" is archived — task execution is disabled` | create a new workspace with `nova workspace create <name> --path <dir>` and re-create the task there |
| `no project "<ident>"` | `nova project list`, then pass the exact slug |
| `no profile named "<name>"` | `nova profile list`, then fix the name or create the profile in that scope |
| `no such task: <id>` / `no task with key "<key>"` | `nova task list` |
| `profile "<name>" is pinned by N task(s)` | pin new tasks to a different profile; a pinned profile is never deleted |
| a name that is not lower-case kebab-case | use lower-case letters, digits and hyphens, e.g. `my-workspace` |
| `root_path is not an existing writable directory` | `mkdir -p <path>`, make it writable, re-run the verb |
| `--lines must be an integer 1..1000` | pass a value in range, e.g. `--lines 100` |
| `NOVAFLOW_STATUS_WATCH_MS must be a number >= 50` | set a whole number of milliseconds >= 50, or unset it for the two-second default |
| `nova web sync --run` on a live run | follow it with `nova task status <id> --watch`, then sync again once it settles |

The `--target alias=path[:type]` suffix defaults to `directory`, which runs in place. Use
`:git_repo` for a target that gets per-run worktrees (its base must be a clean git repo).

Usage errors are their own fix: exit 2 prints the verb's usage block, and the line above it carries
the same ` — fix: ` marker.
