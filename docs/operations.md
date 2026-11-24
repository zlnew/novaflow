# Operations — enqueue, step away, act when woken

Work runs in a daemon, not in your editor session. Your job is three moves:

1. **Enqueue** — `nova task run <id or key>` queues the task and exits.
2. **End the turn** — your session is free; it is not a monitor.
3. **Act when woken** — the Pi extension injects one `[novaflow] …` follow-up when a run reaches a
   state that needs a human: a gate, a failure, or a finished chain.

Everything else in this page is detail. If you remember one rule, make it this one: do not build a
sleep loop around `nova task status`. The extension already wakes you, and a polling loop burns the
session's turn while still missing every event that happened between polls.

## The loop, end to end

```bash
nova daemon start --migrate                      # once per machine (or on login)
nova workspace create shop --path ~/code/shop    # once per project root
nova project create shop --objective "Ship the checkout flow." \
  --target code=~/code/shop:git_repo

# a small profile file — see docs/profiles.md for every field
nova profile create --file dev.json

nova task create CHECKOUT-1 --title "Add PKCE" \
  --objective "Implement PKCE end to end." \
  --profile dev --project shop --scope code --context docs/spec.md
# --context is optional; it names a file under <workspace>/docs/

nova task run CHECKOUT-1     # returns immediately: the task is queued
nova status                  # daemon, in-flight runs, today/month spend, last 3 transitions
```

Later, without holding a session open:

```bash
nova task status CHECKOUT-1          # state, current run, elapsed time
nova task result CHECKOUT-1          # the result artifact the run wrote
nova task logs CHECKOUT-1 --lines 50 # the redacted event log of the current run
```

`--watch` and `--follow` exist for a human sitting at a terminal; they are opt-in and they wait:

```bash
nova task run CHECKOUT-1 --watch
nova task status CHECKOUT-1 --watch
nova task logs CHECKOUT-1 --follow
nova chain status <chain-run-id> --watch
nova status --watch
```

## What is allowed to block

| call | when it returns |
| --- | --- |
| `nova task run <id>` | at enqueue — the run continues in the daemon |
| every other CLI verb | after its one daemon call — or its one local read (`nova version`, `nova daemon logs`, `nova web status` never touch the daemon) |
| `nova mcp` | when its client disconnects (it is a server) |
| anything with `--watch` or `--follow` | when the thing you are watching settles, or you press Ctrl-C |

One daemon owns the store and the state machine. The CLI, the MCP server and the Pi extension are
clients of one Unix socket at `~/.novaflow/novaflow.sock`; there is no TCP port and no HTTP. Every
state change passes the same validation whoever asked for it, so a script and a chat session cannot
produce two different outcomes for the same task.

## Being woken instead of polling

The extension arms a watcher on every session start, seeds it at the current head of the transition
log (so old history never wakes a fresh session), and then injects one follow-up per event that
needs you. When it cannot arm, it says so once per session — silence is not an option.

```yaml
# ~/.novaflow/config.yaml
wake:
  enabled: true      # the default
  workspace: null    # a workspace slug to narrow, or null for every workspace
```

| variable | effect |
| --- | --- |
| `NOVAFLOW_WAKE=off` | disable the watcher for this session |
| `NOVAFLOW_WAKE_MS=<n>` | poll interval, in milliseconds (about two seconds by default) |

If `wake.workspace` names a slug that does not resolve, the extension says so once and watches every
workspace for that session.

## Cost, retention and backups

`nova status` prints one spend line: today and this month, in dollars and runs, plus two flags.
`prices_armed` is `true` when a usable price table was loaded; `inert_models` lists any model whose
price is unknown. A model with no price records zero cost, and the budget breaker for that run is
decorative rather than enforced — the screen says so instead of pretending.

Prices live in `~/.novaflow/prices.json`, keyed by model, with per-million-token rates:

```json
{ "anthropic/claude-3-5-sonnet-20241022": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } }
```

| what | default | how to change it |
| --- | --- | --- |
| daily budget | `budgets.daily_usd: 5.0` in `~/.novaflow/config.yaml` | edit the file; a workspace's own limits win for its runs |
| monthly budget | `budgets.monthly_usd: 40.0` | same |
| concurrent runs per workspace | 2 | `concurrency.workspace` in the workspace's `.novaflow/config.yaml` |
| concurrent runs on the machine | 4 | `concurrency.global` in `~/.novaflow/config.yaml` |
| retry delay after a failure | 300 s | `retry.delay_sec` |
| raw-log retention | 30 days | `nova daemon prune --retention-days <n>` |

`nova daemon prune` deletes only `events.raw.jsonl` for runs past retention. The redacted
`events.jsonl` — the file you read — is never touched. `nova daemon backup` takes an online SQLite
copy and never overwrites an existing file.

## Documents as task context

`nova docs list` lists the files under `<workspace>/docs/` with the extensions `.md`, `.txt` and
`.rst`. Passing `--context docs/spec.md` on `nova task create` attaches one of those documents to the
task; the agent reads it as part of the objective.

## Common problems

| symptom | cause | the command that fixes it |
| --- | --- | --- |
| `nova task run` printed nothing but the task never starts | dispatch is paused, or the concurrency limit is full | `nova status` shows `paused` and `inflight`; `nova daemon resume` |
| `nova task status --watch` prints the first block and then nothing | the task is not terminal yet, or the daemon went away | `nova status`, then `nova daemon logs --lines 100` |
| the session never wakes | `wake.enabled: false`, `NOVAFLOW_WAKE=off`, or a `wake.workspace` slug that does not resolve | check the config file, then `nova workspace list`; the extension prints a warning once when it cannot arm |
| a run is refused before the agent starts | preflight found a missing target root, a dirty base checkout, a spent budget, a missing `pi`, or less than 1 GiB free | `nova task status <id>` — the last line (`detail: preflight failure: …`) names the check that failed |
| `spend: … prices_armed false, inert_models <model>` | `~/.novaflow/prices.json` is missing or unparsable | write the file as shown above, then `nova task retry <id>` |
| today's spend reads `$0.0000` after a real run | that model has no price entry | add it to `prices.json`; already-recorded runs keep their stored cost |
| `nova: daemon unreachable` (exit 5) | the daemon is not running, or the socket was removed | `nova daemon start` |
