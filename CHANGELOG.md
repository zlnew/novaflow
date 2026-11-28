# Changelog

What changed for you, release by release. Newest first.

## [1.0.1] — 2026-11-28

- **Release dry-run fix:** `./release.sh publish --dry-run` now isolates `npm pack` and `npm install` in the tarball smoke test from inherited `npm_config_dry_run=true` during `prepublishOnly`.

## [1.0.0] — 2026-11-28

Clean-slate redesign of NovaFlow as a local-first, daemonless CLI and MCP orchestration ledger.

- **Daemonless `.novaflow/` + built-in SQLite WAL:** State lives in `<workspace>/.novaflow/` (`config.yaml`, `.gitignore`, `state.db`) using Node.js 24's built-in `node:sqlite` (zero native C++ addons) with automatic `cwd` walk-up discovery and an XDG global workspace index.
- **Single `novaflow` CLI (`novaflow <noun> <verb>`):** Manages workspaces, projects with deterministic `PREFIX-N` task keys, a 5-state task FSM (`todo`, `in_progress`, `blocked`, `done`, `cancelled`), atomic leases, DAG dependencies, handoff `task context`, `status`, `events`, and `export`, with `--json` `next_actions`, `--dry-run`, `--quiet`, and exit codes `0`–`4`.
- **Stateless stdio MCP server (`novaflow mcp`):** Exposes 30 `novaflow_*` tools 1:1 over the core domain layer with structured `isError` payloads and MCP-native `next_actions`.
- **Bundled Agent Skill (`novaflow skill install|status|uninstall`):** Ships `skills/novaflow/SKILL.md` offline inside the npm package and links it into detected agent harnesses (`claude`, `codex`, `hermes`, `pi`, `opencode`, `cursor`).
- **Unified `./release.sh` pipeline:** Adds `./release.sh check` (typecheck, build, test, pack allowlist, and isolated tarball install smoke) alongside `bump`, `pr`, `tag`, and 2FA-aware `publish`.

## [0.4.0] — 2026-11-24

The first release written for someone who has just heard the name. Nothing about the engine
changed; everything about how it is explained did.

- **The README now starts with what the tool does** and who it is for, then a quick start that runs
  from a fresh machine to a queued task.
- **Every page in `docs/` leads with its answer**, carries one worked example you can paste, and has
  a "Common problems" table: symptom, cause, and the command that fixes it.
- **`docs/maintaining.md` replaces the release-notes template.** It documents the release flow, what
  each step refuses, how to verify a publication, and how to roll forward from a bad one.
- **`./release.sh publish` publishes to npm.** It prints the package, the version and the URL, runs
  `npm publish --dry-run`, and uploads only when you pass `--confirm`. It refuses a dirty tree, a red
  suite, a missing local or remote tag, a version already on the registry, or a missing `--confirm`.
- **The GitHub release body is now your changelog section.** `./release.sh tag` extracts the
  `## [X.Y.Z]` section of this file into a notes file and refuses if the section is missing.
- **No internal shorthand in the public docs.** A test fails the build if a ticket number, a
  decision id, an internal date or a spec path appears in the README, the changelog or `docs/`.

## [0.3.2] — 2026-11-24

- **`nova web start` always passes the bind host explicitly.** The default is loopback; set
  `PI_WEB_HOSTNAME` to change it. A wildcard bind is reported as a warning, and the printed URL stays
  reachable.
- **The readiness probe uses the same host the instance was given**, so an instance bound somewhere
  other than loopback is no longer started and then killed as "not answering".
- **`nova web status` reports the host it is serving.** `docs/live-view.md` shows how to publish the
  loopback instance over a tailnet instead of widening it.

## [0.3.1] — 2026-11-24

- **Installing works with npm 12.** npm now blocks a dependency's install scripts by default and
  rejects the old environment-variable override for project installs, so the native SQLite binding
  never built. The package now declares `allowScripts` for that one native dependency, and the
  from-source route stops passing the invalid override. The tarball route keeps it.

## [0.3.0] — 2026-11-24

- **Work runs in the background.** `nova task run` returns at enqueue, and the Pi extension wakes your
  session with one `[novaflow] …` follow-up when a run needs a human. Upgrade once with
  `nova daemon start --migrate`.
- **Each run gets its own worktree.** A writable git target runs in
  `.novaflow/worktrees/<run_id>/<alias>/` with write scopes and verification commands rooted there. If
  the worktree cannot be created the run is refused — there is no fallback to your shared checkout.
- **Real concurrency.** Independent ready tasks run in parallel: 2 per workspace and 4 per machine by
  default, both configurable.
- **`nova chain clean <chain-run-id>`** removes a settled chain's worktrees, refuses a chain that is
  still running, and refuses a worktree with uncommitted changes unless you pass `--force`. Run rows
  and result artifacts are kept.
- **A live view.** `nova status` and `nova status --watch` give you one screen; `nova web sync`,
  `nova web start`, `nova web status` and `nova web stop` mirror settled runs' transcripts into a
  private Pi Web directory on port 30142. Copies, never links; only settled runs; the verbatim event
  log is never copied; nothing is pruned without you.
- **`nova <noun> <verb> --help`** prints that verb's usage, flags, one example and its exit codes —
  never the whole manual. An unknown flag is a usage error, not a program dump. Refusals end with
  ` — fix: ` and your next move.
- **Chains.** Import refuses a member with no target scope, an empty edge list imports a one-task
  chain, and `nova chain verify` shows configured against executed verification commands (exit 3 when
  one never ran).
- **Install and package.** The installer checks Node 22+, `pi`, git 2.40+ and (as a warning only)
  `sqlite3`, deploys the extension and writes the global config once. The MIT license ships. A tarball
  smoke test runs one priced task end to end.

## [0.2.0] — 2026-11-23

- **Cost is recorded, not guessed.** Runs store fresh input, cache-read, cache-write and output
  tokens, and `nova status` shows today and this month in dollars and runs.
- **The status line tells you when pricing is inert.** `prices_armed` and `inert_models` name any
  model with no price entry, instead of silently recording zero.
- **Live follow.** `nova task logs --follow` streams a run's redacted event log, and the `--watch`
  verbs print one line per transition.
- **The wake watcher.** A Pi session gets one follow-up per transition that needs a human, armed on
  session start and seeded so old history never wakes it.
- **Profile update and delete.** Change a stored profile and its canonical file together; delete a
  profile that no task pins (a pinned one is refused with the count).
- **`nova daemon start --migrate`** applies pending store migrations instead of refusing an older
  store.

In a measured three-task run on this project, cache reads were 88.8% of prompt tokens (1,230,016 of
1,384,732) and the three runs cost $0.0643.

## 0.1.x

- **0.1.4** — a task with no target scope is refused at enqueue, before any work is spent.
- **0.1.3** — a workspace-scoped profile wins over a global profile of the same name.
- **0.1.2** — `nova` is installed as the command, from the package's `bin` entry.
- **0.1.1** — first public release.
