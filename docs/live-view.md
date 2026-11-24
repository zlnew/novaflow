# The live view — tier C and tier D

Two tiers, no plugin. The installed Pi Web (0.18.0, spiked 2026-11-23) exposes no plugin surface,
so NovaFlow does not pretend to own a panel: tier C is the terminal, tier D is Pi Web's own
renderer reading a private mirror. There is no NovaFlow web UI, no REST/SSE server, and no token
stream to a dashboard.

## Tier C — `nova status --watch`

`nova status` prints one screen an operator can paste:

```text
daemon: running (v…, started 2026-11-23T…)
scheduler: inflight 2 queued 3 paused false live WC2,WC3
spend: today $0.4200 (3 runs), month $1.1000 (9 runs), prices_armed true, inert_models -
transitions (last 3):
  12:06:54 UTC WC2 queued→running
```

`nova status --watch` reprints only when the screen changes: the transition cursor advances every
2 s, so a quiet daemon costs one socket op per tick and no terminal writes. Every transition line
prints `HH:MM:SS UTC` with the zone on the line (DEBT-012). `NOVAFLOW_STATUS_WATCH_MS` overrides
the interval for tests and operators (a number ≥ 50, in milliseconds); a bad value is a usage
error with the fix in the message. `nova status --json` is the same data as one document.

The five facts on the screen: daemon state, scheduler in-flight/queued/paused/live tasks, today
and month spend with `prices_armed` and `inert_models`, and the last three transitions. Uptime is
deliberately absent — a field that moves every second would reprint forever.

## Tier D — the private Pi Web mirror

```bash
bin/nova web sync --all          # mirror every SETTLED run's session file
bin/nova web sync --run FEAT-1   # one task (key) — or a bare run ULID
bin/nova web start               # dedicated Pi Web on http://127.0.0.1:30142
bin/nova web status              # pid liveness, port, answering, mirrored-run count, URL
bin/nova web stop
```

`nova web start` needs `pi-web` on `PATH` (`npm install -g @agegr/pi-web`; a missing binary is
refused naming that command). It sets `PI_CODING_AGENT_DIR=~/.novaflow/piweb`, writes
`~/.novaflow/piweb/piweb.log` and `piweb.pid`, and waits for `GET /api/sessions` before printing
the URL. `NOVAFLOW_PIWEB_PORT` changes the port, `NOVAFLOW_PIWEB_BIN` changes the binary. It
refuses a busy port naming what holds it and refuses to start a second instance over a live one —
each refusal ends with the next move.

### Mirror rules

- **Copies, never links.** A hardlink would let Pi Web's rename/delete/resume write through to a
  run's record. `sync` writes an independent byte copy and rewrites it only when the source
  changed; a second `sync` changes nothing, not even an mtime.
- **Settled runs only.** A live run's transcript is still being written, so copying it is a torn
  read: `--run` on a live run refuses (exit 1, pointing at `nova status --watch`) and copies
  nothing. `--all` is a workspace sweep where in-flight work is expected, so it mirrors the
  settled runs and reports the live ones as `refused`.
- **No raw stream, ever.** `events.raw.jsonl` is never copied by any path; the redacted
  `events.jsonl` is not the mirror's unit either — only the run's own Pi session file is. The run
  directory is opened read-only.
- **No implicit prune.** The mirror only grows with `sync`; delete `~/.novaflow/piweb/sessions`
  by hand to empty it. Nothing in NovaFlow ever deletes it.

The destination is Pi Web's own layout, derived from the session's recorded cwd:
`~/.novaflow/piweb/sessions/--home-x-y--/<ts>_<run id>.jsonl` for a run started in `/home/x/y`.

Pi Web stays **read-only** for NovaFlow. Gate approvals, aborts, retries and follow-ups stay on
the CLI, MCP and the chat; the browser is a transcript view over copied files.

## Access from the tailnet

The instance belongs on loopback. To read runs from a phone or another machine, let
Tailscale publish it — never widen the bind:

```bash
nova web start                                   # binds 127.0.0.1:30142
tailscale serve --bg --https=443 http://127.0.0.1:30142
tailscale serve status                           # shows https://<node>.<tailnet>.ts.net
```

That gives you `https://<node>.<tailnet>.ts.net/` with Tailscale's own TLS, reachable only from
devices on your tailnet (nothing is exposed to the LAN or the internet).

**Why not `--hostname 0.0.0.0`:** with Pi Web's authentication off by default, a wildcard bind
serves every mirrored transcript to anything on the same network — a real exposure found on
2026-11-24 (DEBT-016). `nova web start` therefore always passes the bind host explicitly
(loopback unless you set `PI_WEB_HOSTNAME`), probes that host for readiness, and reports it in
`nova web status`. If you have `PI_WEB_HOSTNAME=0.0.0.0` exported in your shell for a
hand-run Pi Web, unset it before `nova web start` — your environment is inherited by the child.

`tailscale serve` needs HTTPS enabled for the tailnet (admin console → DNS → HTTPS
Certificates). `--bg` persists across restarts; `tailscale serve reset` removes it.

