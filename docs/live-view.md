# Live view — the terminal screen and the browser

There are two ways to watch work, and neither is a dashboard that can change anything:

| | what it is | what it costs |
| --- | --- | --- |
| **the screen** | `nova status`, one block of text about the daemon, the queue, money and the last three state changes | one daemon call |
| **the browser** | your run transcripts, rendered by Pi Web from a private directory of **copied** files | one Pi Web process on loopback |

A gate is still approved from the CLI or over MCP. The browser reads files; it never decides
anything, and there is no NovaFlow web UI, HTTP API or telemetry.

## The screen

```text
daemon: running (v<version>, started <iso-timestamp>)
scheduler: inflight 2 queued 3 paused false live CHECKOUT-1,CHECKOUT-2
spend: today $0.4200 (3 runs), month $1.1000 (9 runs), prices_armed true, inert_models -
transitions (last 3):
  12:06:54 UTC CHECKOUT-1 queued→running
  12:09:02 UTC CHECKOUT-2 running→validating
  12:09:44 UTC CHECKOUT-2 validating→completed
```

Five facts, and nothing that moves on a clock: daemon state, in-flight and queued runs, whether
dispatch is paused, today's and this month's spend with the two pricing flags, and the last three
transitions. Uptime is deliberately absent — a field that changes every second would force a redraw
every second.

`nova status --watch` reprints only when the screen changes. It advances a cursor every two seconds,
so a quiet daemon costs one daemon call per tick and no terminal output. `NOVAFLOW_STATUS_WATCH_MS`
overrides the interval (a whole number of milliseconds, 50 or more); anything else is a usage error
that names the fix. `nova status --json` is the same data as one document, for a script.

Every transition line carries its zone (`HH:MM:SS UTC`), so a log pasted into a chat is not
ambiguous.

## The browser

```bash
nova web start                  # start the dedicated Pi Web on http://127.0.0.1:30142
nova web sync --all             # copy every settled run's transcript into it
nova web status                 # pid, port, whether it answers, how many runs are mirrored
nova web stop                   # stop the instance this verb started
```

`nova web start` needs `pi-web` on your `PATH` (`npm install -g @agegr/pi-web`). It runs Pi Web in a
private agent directory, `~/.novaflow/piweb`, writes `piweb.log` and `piweb.pid` there, and waits
for the instance's session list to answer before printing the URL. `NOVAFLOW_PIWEB_PORT` changes the
port and `NOVAFLOW_PIWEB_BIN` names a different binary.

### What gets copied

| rule | why |
| --- | --- |
| copies, never links | Pi Web renames and deletes what it lists; a hardlink would write through to a run's own record |
| settled runs only | a live run's transcript is still being written, so copying it is a torn read |
| `--run` on a live run refuses, and copies nothing | half a transcript is worse than none; `--all` reports the live runs as `refused` and copies the settled ones |
| one file per run: the run's own Pi session file | the event logs are not the mirror's unit |
| `events.raw.jsonl` is never copied, by any path | it is the verbatim log; the mirror holds only what Pi already wrote |
| no implicit prune | the mirror grows only when you sync; delete `~/.novaflow/piweb/sessions` by hand to empty it |

A second `nova web sync` of unchanged runs copies nothing, not even a timestamp. The destination is
Pi Web's own layout, derived from the directory the run recorded inside its transcript:
`~/.novaflow/piweb/sessions/--home-x-y--/<session-file>.jsonl` for a run started in `/home/x/y`.

## Watching from another device

The instance belongs on loopback. To read runs from a phone or another machine, publish it with
Tailscale rather than widening the bind:

```bash
nova web start                                          # binds 127.0.0.1:30142
tailscale serve --bg --https=443 http://127.0.0.1:30142
tailscale serve status                                  # prints https://<node>.<tailnet>.ts.net
```

That gives you TLS from Tailscale and access from your tailnet devices only — nothing is exposed to
the LAN or the internet. `tailscale serve` needs HTTPS enabled for the tailnet; `--bg` keeps the
mapping across restarts, and `tailscale serve reset` removes it.

Do **not** bind `0.0.0.0`. Pi Web has authentication off by default, so a wildcard bind serves every
mirrored transcript to anything on the same network. `nova web start` always passes the bind host
explicitly — loopback unless you set `PI_WEB_HOSTNAME` — probes that host, and reports it in
`nova web status`. If `PI_WEB_HOSTNAME=0.0.0.0` is exported in your shell for a hand-run Pi Web, it
will be inherited by the child: unset it before `nova web start`.

## Common problems

| symptom | cause | the command that fixes it |
| --- | --- | --- |
| `nova web start`: `pi-web is not on PATH` | the renderer is a separate package | `npm install -g @agegr/pi-web`, then `nova web start` |
| `a live pi-web already answers at <url> (pid N)` | an instance is already running | open that URL, or `nova web stop` |
| `port 30142 is already in use` | something else holds the port | the message names the holder; stop it, or `NOVAFLOW_PIWEB_PORT=30143 nova web start` |
| `run <id> is running, not settled` | you asked to mirror a run that is still writing | `nova task status <id> --watch`, then `nova web sync --run <id>` once it settles |
| the browser lists no runs | nothing has been mirrored yet | `nova web sync --all`, then reload the page |
| `nova status --watch` never changes | nothing is happening — the screen only repaints on change | `nova task list --state queued` to confirm the queue is empty |
