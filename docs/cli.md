# `nova` CLI reference — the verb audit (srs 4.1.1, v0.3.0 W4)

`nova` is a thin client of the daemon's JSONL socket: one command is one op
call, and the CLI never opens the SQLite store. This page is the operator's
complete map of the surface — every verb, what it is for, whether it returns
or blocks, whether `--json` is supported, and which exit codes it can emit.

The table is not prose that drifts: `src/cli/verbs.ts` is the single verb
table, `src/cli/help.ts` renders help from it, the dispatcher refuses a verb
that is not in it, and `test/cli/cli-docs.test.ts` reads this file and fails
the build when a row is missing or disagrees with the table.

## Help

| request | answer | exit |
| --- | --- | --- |
| `nova <noun> <verb> --help` (or `-h`) | that verb's usage, flags and one example | 0 |
| `nova <noun> --help` | the noun's verbs, one line each | 0 |
(a one-verb noun — `status`, `version`, `mcp` — prints that verb's usage)
| `nova help <noun>` | the same noun list | 0 |
| `nova help` (or bare `nova`) | the program overview (`nova help` prints it on stdout, bare `nova` on stderr) | 0 (`nova help`), 2 (bare `nova`) |
| an unknown FLAG on a known verb | that verb's usage | 2 |
| an unknown noun or subcommand | the program overview | 2 |

`--help` is intercepted by the dispatcher before any noun module parses
flags: `nova chain verify --help` answers with `chain verify`'s own usage,
flags and one example — never the whole manual. (This replaced the observed
defect: an unknown `--help` flag, then the entire program dump.)

## Exit codes

Every code in this table is emitted somewhere in the CLI, and nothing else
is. The map lives in `src/cli/exitcode.ts` (`EXIT_CODES`); the test
`test/cli/exitcode.test.ts` writes this table into `docs/cli.md`'s shape and
walks every verb's `exits` list so a new code without a row fails the build.

| exit | short | meaning |
| --- | --- | --- |
| 0 | ok | success |
| 1 | failed | operation failure (task failed, verification failed, refused operation) |
| 2 | usage | usage error (unknown verb, flag or positional shape) |
| 3 | state | engine-state rejection (invalid transition, schema invalid, unverified chain) |
| 4 | not-found | not found (unknown id, key, slug or schedule) |
| 5 | offline | daemon unreachable (no socket, or no answer) |

## Verbs

`blocking` is the operator's question: does the verb return as soon as the
work is queued, or does it wait? `returns at enqueue` is `task run` (it
queues and exits; `--watch` opts into waiting); `blocks to completion` is the
MCP stdio server. Every other verb returns after its one op call.

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

Every read verb supports `--json` (one JSON document on stdout): the audit
found no gaps, and `test/cli/help.test.ts` walks the same verb table so a new
read verb that forgets `--json` fails instead of shipping a table-only
surface. `nova mcp` is the one verb without it: its stdout is the MCP
protocol channel.

## Every error names the fix

A refusal ends with the operator's next move, marked the same way everywhere
(`src/fixhint.ts`, separator ` — fix: `):

```
nova: schema_invalid: the chain graph must declare a non-empty string "project_slug" (§4.3 required key) — fix: correct the graph file (…) and re-run `nova project import-dag <file>`
```

The three worst refusals carry a hint as of v0.3.0 P12:

| refusal | where | next move it names |
| --- | --- | --- |
| graph import `schema_invalid` (every validator message, plus the import op's own shape errors) | `src/chain/graph.ts`, `src/daemon/server.ts` | correct the graph file, re-run `nova project import-dag <file>` |
| the DEBT-010 unscoped-run refusal (`task … carries no target_scopes`) | `src/tasks.ts` | add a scope (`nova task create … --scope <repo_alias>`), re-run `nova task run <id|key>` |
| the inert-prices note (`prices.json missing/unparseable — cost budget enforcement inert`) | `src/runs/prices.ts` | write `<prices path>` with the model's per-1M-token rates, re-run the task |

Usage errors are their own fix: exit 2 prints the verb's usage block, which
IS the next move. The message on the line above it also names the fix
(` — fix: `), so a script that captures stderr sees the same next move a
human sees on the screen.

P13 applied the carried list: every refusal on that list now ends with the
separator, one clause naming the move. On the P13 list, remaining refusals still lack the marker: none. The list and its next moves:

- `a live daemon already answers at <socket> — refusing to start a second one` (`daemon start`) — fix: check it with `nova daemon status`, or stop it with `nova daemon stop`.
- `a live pi-web already answers at <url> (pid N) — refusing to start a second one` (`web start`) — fix: browse the URL, or stop it with `nova web stop`.
- `port <port> is already in use — held by …; refusing to start pi-web on a busy port` (`web start`) — fix: stop the process holding the port, or set `NOVAFLOW_PIWEB_PORT` to a free port.
- `the daemon did not answer <socket> within 15 s` / `pi-web did not answer <url> within 15 s` / `pi-web exited … before answering` (the start commands) — fix: read the log tail below, fix the cause it names, then re-run the start command.
- `workspace "<slug>" is <status> — task execution is disabled (FR-WS-03); …` (`nova_task_run`) — fix: create a new workspace with `nova workspace create <name> --path <dir>` and re-create the task there.
- `no project "<ident>" in the active workspace` / `no project "<slug>" in workspace "<slug>"` / `no project "<slug>" in any workspace` (task create, project status/phase, the project lookup) — fix: list projects with `nova project list` and pass the exact slug.
- `no profile named "<name>" in …` (`profile validate`, enqueue, chain import's project lookup, profile update/delete) — fix: list the profiles in scope with `nova profile list`.
- `no such task: <id>` / `no task with key "<key>" in workspace "<slug>"` (task/schedule/run reads via the wire `not_found`) — fix: list tasks with `nova task list`.
- `profile "<name>" (…) is pinned by N task(s) — a pinned profile is never deleted …` (the FK-safe `profile delete` refusal) — fix: pin new tasks to a different profile (`nova task create … --profile <other>`), since v1 has no task reassign or delete.
- `workspace name must be lower-case kebab-case (…), got "<name>"` / `project name must be lower-case kebab-case (…), got "<name>"` (`workspace create`, `project create`) — fix: use lower-case letters, digits and hyphens, e.g. `my-workspace`.
- `root_path is not an existing writable directory: <path>` (`workspace create`) — fix: create the directory (`mkdir -p <path>`), make it writable, then re-run the verb.
- `--lines must be an integer 1..1000` / `--retention-days must be a non-negative integer (days)` (usage errors naming the rule) — fix: pass a value in range, e.g. `--lines 100` / `--retention-days 30`.
- `NOVAFLOW_STATUS_WATCH_MS must be a number >= 50 (milliseconds)` (`status --watch`) — fix: set a whole number of milliseconds >= 50, or unset it for the 2000 ms default.
- the `web sync --run` live-run refusal — fix: follow it live with `nova status --watch`, then re-run `nova web sync --run <id|key>` once it settles.

The three refusals fixed in P12 keep their hints and their table above: graph
import `schema_invalid`, the DEBT-010 unscoped-run refusal, and the
inert-prices note.
