# Operations — enqueue, end the turn, get woken

This is the operator contract (novaflow-v030 W1 R1.5), and it is the reason the other pages
exist. Execution lives in the daemon. The orchestrator's job is three moves:

1. **Enqueue.** `nova task run <id|key>` returns at enqueue. It queues the task and exits; it
   does not wait for the run.
2. **End the turn.** The Pi session is free. It is not a monitor and it is not a scheduler.
3. **Act when woken.** The extension's wake watcher injects a `[novaflow] …` follow-up when a
   transition needs a human — `awaiting_gate`, `failed`, and inferred chain completion.

**Never sleep-poll.** A `sleep` loop is the wrong shape: it burns the session's turn, delays
every other instruction, and sees the world through a missing stream. If a session must pull,
`nova_events_since` is the only pull: pass the last cursor and re-poll with `next_cursor` while
`has_more` reports more. A dead daemon answers `daemon_unreachable`; the transition feed is
never served from a store snapshot, because a frozen world reported as current is worse than an
error.

## What is allowed to block

| call | returns |
| --- | --- |
| `nova task run` | at enqueue |
| every other CLI verb | after its one daemon op |
| `nova mcp` | until its client disconnects (it is a server) |

`--watch` and `--follow` are opt-in and are for a human at a terminal: `nova task run --watch`,
`nova task status --watch`, `nova task logs --follow`, `nova chain status --watch`,
`nova status --watch`. The orchestrator never passes them.

## Wake

`wake.enabled` defaults to `true`, and the extension arms the watcher on `session_start`. When it
cannot arm, it says so once per session — silence is not allowed. The watcher seeds at head on
session start, so pre-existing history never wakes the session.

```yaml
# ~/.novaflow/config.yaml
wake:
  enabled: true      # default true
  workspace: null    # a workspace slug to narrow, or null for every workspace
```

`NOVAFLOW_WAKE=off` disables the watcher for the session. `NOVAFLOW_WAKE_MS` overrides the ~2 s
poll interval. A `wake.workspace` that does not resolve says so once and polls every workspace
for that session.

## The one-screen answer

`nova status` prints daemon state, scheduler in-flight/queued, today and month spend with
`prices_armed` and `inert_models`, and the last three transitions. `nova status --watch` reprints
only when the screen changes; `nova status --json` is the same data for a script. The live view's
tiers and mirror rules are in [the live view](live-view.md).

## Where execution happens

The daemon is the single writer of the SQLite store and the only process that spawns a run. A
`git_repo` target with `access_mode: read_write` gets a per-run worktree; write scopes and
verification commands are re-rooted into that tree. Read-only git targets and plain directories
run in place. A run that cannot get its tree is refused — there is no fallback to the shared
tree. Chain-level cleanup is in [chains](chains.md).
