# Changelog

What changed for the operator, release by release. The numbers are the ones the code and the
run records enforce; the repository history is the PR list.

## [0.3.2] — 2026-11-24

**Fix:** `nova web start` now passes the bind host explicitly and probes it. Found live: the
command spawned `pi-web --port N --no-open` with no hostname, so an exported
`PI_WEB_HOSTNAME=0.0.0.0` in the operator's shell (inherited by the child) served every mirrored
transcript to the LAN with authentication off. It also hardcoded the readiness probe to
`127.0.0.1`, so an instance bound elsewhere started and was then killed as "not answering".

Now: host = `PI_WEB_HOSTNAME` or loopback, passed to pi-web, used by the probe and reported by
`nova web status` (a wildcard bind is probed on loopback, and the printed URL says loopback).
`docs/live-view.md` gains **Access from the tailnet**: keep the bind on loopback and publish it
with `tailscale serve --bg --https=443 http://127.0.0.1:30142` — TLS, tailnet-only, no LAN
exposure.

## [0.3.1] — 2026-11-24

**Fix:** `install.sh`'s default route (`git clone … && sh novaflow/install.sh`) did not work on
npm >= 12. npm now blocks dependency install scripts by default and rejects the
`--allow-scripts` environment override in *project-scoped* installs, so the native SQLite
binding never landed and the daemon could not start. The package now declares npm 12's
documented project field (`allowScripts` for `better-sqlite3` and `esbuild`), the from-source
route stops passing the invalid override, and the global/tarball route keeps it. Found by the
v0.3.0 stranger test on npm 12.2.3 and verified end to end there: install, extension deploy,
config written once, three next commands, binary runs, binding loads, re-run byte-identical.

## [0.3.0] — 2026-11-24

The release that makes NovaFlow handable to someone else: work runs in the background, in its own
tree, and a settled run can be read in a browser.

- **Work runs in the background.** `nova task run` returns at enqueue, and the extension wakes
  the session with one `[novaflow] …` follow-up when a transition needs a human. The operator
  contract — enqueue, end the turn, act when woken; never sleep-poll — is written in
  `docs/operations.md`.
- **Each run gets its own tree.** A `git_repo` target with `read_write` access runs in
  `.novaflow/worktrees/<run_id>/<alias>/`, with write scopes and verification commands re-rooted
  there. A run whose worktree cannot be created is refused; there is no fallback to the shared
  tree. Read-only git targets and plain directories run in place. Migration 0004 adds
  `task_runs.worktree_root`.
- **Real concurrency.** Independent ready members run in parallel: `concurrency.workspace`
  defaults to 2 and `concurrency.global` to 4. `nova_daemon_status` reports the `inflight` count
  and each running run's `worktree_root`.
- **`nova chain clean <chain-run-id>`** removes a settled chain's worktrees, refuses a
  non-terminal chain, and refuses a dirty (or unassessable) worktree without `--force`. Run rows
  and artifacts are history and are kept.
- **The live view.** Tier C: `nova status` and `nova status --watch`, with `HH:MM:SS UTC` on every
  transition line. Tier D: `nova web sync|start|stop|status` mirrors **settled** runs' session
  files into a private agent dir and serves them from a dedicated Pi Web on port 30142. Copies,
  never links; `events.raw.jsonl` is never copied; no implicit prune. No plugin ships: the
  installed Pi Web exposes no plugin surface.
- **CLI UX.** `--help` on every verb prints that verb's usage, flags and one example; an unknown
  flag is a usage error (exit 2), not a whole-program dump. One exit-code table (0–5), and
  refusals end with a ` — fix: ` next move, listed in `docs/cli.md`.
- **Chain import.** `target_scopes` is required on every member (DEBT-011), an empty `edges:`
  list imports a one-task chain (DEBT-013), and `nova chain verify` prints configured versus
  executed verification commands (DEBT-006).
- **Debt sweep.** The extension's bash analyzer warns once per session, naming a command it could
  not classify (DEBT-005); `--watch` lines carry the UTC zone (DEBT-012).
- **Install and package.** `install.sh` checks Node ≥ 22, `pi`, git ≥ 2.40 and (warn-only)
  `sqlite3`, deploys the extension and writes `~/.novaflow/config.yaml` once. The MIT `LICENSE`
  ships. `npm pack --dry-run`'s file list is asserted; the guarded tarball smoke runs one priced
  task end to end. Publishing is a separate, operator-approved act.
- **Docs.** The README is written for a stranger, `docs/` is one page per concept, and this
  changelog is the release view.

## [0.2.0] — 2026-11-23

The cockpit on real work: the v0.2.0 dogfood trial ran 3 tasks for `$0.0643`, and cache reads were
88.8% of the trial's prompt tokens (1,230,016 of 1,384,732).

- **Cache-aware accounting and the spend block.** Runs record cache-read and cache-write tokens
  and a cost basis (`priced` / `legacy`); `nova status` and `nova_daemon_status` show today and
  month spend with `prices_armed` and `inert_models`.
- **The transitions stream.** `nova_events_since` polls the audited transition log by cursor —
  the only pull surface, and daemon-required.
- **Live follow.** `nova task logs --follow` and the `--watch` views.
- **The wake watcher.** Operator sessions get one `[novaflow] …` follow-up per transition that
  needs a human, armed on session start and seeded at head.
- **Profile update/delete.** Change a stored profile and its canonical file together; delete an
  unpinned profile (a pinned one is refused, naming the count).
- **The `--migrate` upgrade door.** `nova daemon start --migrate` applies pending store
  migrations instead of refusing an older store.

## 0.1.x

- **0.1.4** — the scope guard: a task with no target scopes is refused at enqueue (DEBT-010).
- **0.1.3** — profile resolution: the workspace-scoped profile wins over a global one of the same
  name.
- **0.1.2** — the `bin` field: `nova` is the installed entry point.
- **0.1.1** — first public release.
