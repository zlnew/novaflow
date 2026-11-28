# NovaFlow CLI reference

Read this only when `novaflow <command> --help` is not enough. Every command
accepts the global flags listed first.

## Global flags

| Flag | Short | Meaning |
|---|---|---|
| `--workspace <name\|path>` | `-w` | Target workspace (overrides `NOVAFLOW_WORKSPACE` and cwd walk-up) |
| `--project <slug\|prefix>` | `-p` | Target project (overrides `NOVAFLOW_PROJECT` and workspace default) |
| `--json` | | One machine-readable envelope on `stdout` |
| `--quiet` | `-q` | Minimal identifiers, one per line |
| `--dry-run` | | Validate inputs and state without writing |
| `--help` | `-h` | Scoped help |
| `--version` | `-V` | Print `novaflow <semver>` |

Exit codes: `0` success, `1` runtime/internal, `2` usage/validation, `3` state
conflict, `4` not found.

## Workspace

| Verb | Usage |
|---|---|
| `create` | `novaflow workspace create [--name <slug>] [--path <dir>] [--gitignore] [--default]` |
| `list` | `novaflow workspace list` |
| `show` | `novaflow workspace show [name]` |
| `update` | `novaflow workspace update [--name <new>] [--default-project <slug>] [--clear-default-project] [--set-default]` |
| `register` | `novaflow workspace register --name <slug> --path <dir>` |
| `unregister` | `novaflow workspace unregister <name>` |

## Project

| Verb | Usage |
|---|---|
| `create` | `novaflow project create --title <title> [--workspace <ws>] [--slug <s>] [--prefix <P>] [--objective <text>] [--path <dir>] [--verify <cmd>] [--tag <t>...]` |
| `list` | `novaflow project list [--workspace <ws>] [--status active\|paused\|archived\|all]` |
| `show` | `novaflow project show <project>` |
| `update` | `novaflow project update <project> [--title <t>] [--objective <o>] [--clear-objective] [--path <dir>] [--clear-repo-path] [--verify <cmd>] [--clear-verify] [--tag <t>...] [--clear-tags] [--status active\|paused\|archived]` |
| `archive` | `novaflow project archive <project>` |

## Task

| Verb | Usage |
|---|---|
| `create` | `novaflow task create --title <title> [--project <p>] [--slug <s>] [--objective <t>] [--assignee <a>] [--priority low\|medium\|high\|urgent] [--depends-on <k1,k2>] [--tag <t>...] [--idempotency-key <k>]` |
| `list` | `novaflow task list [--status <s>...] [--ready] [--assignee <a>] [--claimed-by <a>] [--tag <t>] [--limit <n>]` |
| `next` | `novaflow task next [--assignee <a>] [--limit <n>]` |
| `status` | `novaflow task status <ID>` |
| `context` | `novaflow task context <ID>` |
| `update` | `novaflow task update <ID> [--title <t>] [--objective <o>] [--clear-objective] [--priority <p>] [--assignee <a>] [--clear-assignee] [--tag <t>...] [--clear-tags]` |
| `start` | `novaflow task start <ID> [--by <actor>] [--ref <session>] [--lease <sec>] [--note <text>] [--force]` |
| `complete` | `novaflow task complete <ID> [--summary <text>] [--by <actor>] [--artifact <uri>...] [--force]` |
| `block` | `novaflow task block <ID> [--reason <text>] [--waiting-on <ref>] [--on <OTHER_ID>] [--by <actor>]` |
| `unblock` | `novaflow task unblock <ID> [--note <text>] [--start] [--by <actor>] [--ref <uri>] [--lease <sec>] [--force]` |
| `cancel` | `novaflow task cancel <ID> [--reason <text>] [--by <actor>]` |
| `reopen` | `novaflow task reopen <ID> [--reason <text>] [--by <actor>]` |
| `claim` | `novaflow task claim <ID> --by <actor> [--ref <uri>] [--lease <sec>] [--force]` |
| `release` | `novaflow task release <ID> [--by <actor>] [--to-todo]` |
| `depend` | `novaflow task depend <ID> --on <OTHER_ID>` |
| `undepend` | `novaflow task undepend <ID> --on <OTHER_ID>` |
| `note` | `novaflow task note <ID> <message> [--by <actor>]` |
| `attach` | `novaflow task attach <ID> <uri> [--label <text>] [--kind file\|pr\|log\|url]` |

Lifecycle: `todo` -> `in_progress` -> `done`; `blocked` is reachable from
`todo`/`in_progress` and leaves only through `unblock`. `cancelled` is terminal
until `reopen`. `--lease <sec>` is a positive integer; omitting it stores a
non-expiring claim.

## Utility

| Command | Usage |
|---|---|
| `status` | `novaflow status [-w <ws>] [-p <proj>]` |
| `events` | `novaflow events [list] [--task <ID>] [--since <iso\|dur>] [--after-seq <n>] [--limit <n>]` |
| `export` | `novaflow export [--out <file>]` |
| `mcp` | `novaflow mcp [-w <ws>]` |

`--since` accepts an ISO-8601 timestamp or a relative token matching
`^[1-9][0-9]*[smhdw]$` (`30m`, `2h`, `7d`).

## Skill

| Verb | Usage |
|---|---|
| `install` | `novaflow skill install [--agent auto\|<list>] [--local [dir]] [--copy] [--force] [--dry-run]` |
| `status` | `novaflow skill status [--local [dir]]` |
| `uninstall` | `novaflow skill uninstall [--agent auto\|<list>] [--local [dir]] [--force] [--dry-run]` |

Harness ids: `agents` (canonical), `claude`, `codex`, `hermes`, `pi`,
`opencode`, `cursor`. `--agent auto` links only harnesses whose parent config
directory already exists. The canonical store is
`${XDG_AGENTS_HOME:-~/.agents}/skills/novaflow`, or `<dir>/.agents/skills/novaflow`
with `--local`. Every managed directory carries `.novaflow-managed.json`; a
directory without it is user-owned and refuses replacement without `--force`
(exit `3`).

## Envelopes

Success (`stdout`, exit `0`):

```json
{ "ok": true, "command": "task.start", "data": { "key": "NV3-1" }, "next_actions": [ { "command": "novaflow task complete NV3-1 --summary \"...\"", "description": "Mark task done" } ] }
```

Error (`stderr`, exit != 0):

```json
{ "ok": false, "command": "task.start", "error": { "code": "STATE_CONFLICT", "message": "...", "hint": "..." } }
```

Domain codes: `VALIDATION_ERROR`, `NOT_FOUND`, `WORKSPACE_NOT_FOUND`,
`STATE_CONFLICT`, `ALREADY_CLAIMED`, `UNMET_DEPENDENCIES`, `CYCLE_DETECTED`,
`INTERNAL_ERROR`.

## MCP tools

`novaflow mcp` exposes the same operations over stdio as
`novaflow_<noun>_<verb>`: `novaflow_workspace_{create,list,show,update}`,
`novaflow_status`, `novaflow_project_{create,list,show,update,archive}`,
`novaflow_task_{create,list,next,status,context,update,start,complete,block,unblock,cancel,reopen,claim,release,depend,undepend,note,attach}`,
`novaflow_events_list`, `novaflow_export`.

Example loop over MCP: `novaflow_task_next` -> `novaflow_task_context` ->
`novaflow_task_start` -> `novaflow_task_note` -> `novaflow_task_complete`.

Every tool takes an optional `workspace`. Success returns
`{ "ok": true, "data": ..., "next_actions": [ { "tool": ..., "args": ..., "description": ... } ] }`
with `isError: false`; failures return `isError: true` and the same error JSON in
a text block. Nullable fields clear with `null`. Workspace registry and `skill *`
commands are intentionally CLI-only.
