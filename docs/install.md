# Quick start — install and first run

One command installs everything, after it has checked that your machine can actually run work:

```bash
git clone https://github.com/zlnew/novaflow
sh novaflow/install.sh
```

The installer refuses to finish a job it cannot complete. It runs the five checks below before it writes a file, copies the Pi extension into place, writes a config file once, and prints
the three commands that come next.

## Requirements

| check | rule | if it is missing |
| --- | --- | --- |
| Node.js | 22 or newer | refuses, naming the install command |
| `npm` | on `PATH` | refuses; it ships with Node, so the Node upgrade fixes it |
| `pi` | on `PATH` | refuses — NovaFlow spawns Pi for every run |
| git | 2.40 or newer | refuses — per-run worktrees need `git worktree` |
| `sqlite3` | any version | warns only — the bundled SQLite driver carries its own |

## What the installer does

```bash
sh install.sh                                  # the checkout route (the default)
sh install.sh --from-source [--start] [--force-ext]
sh install.sh --from-tarball pkg.tgz [--start] [--force-ext]
```

| flag | effect |
| --- | --- |
| `--from-source` | `npm install` in the checkout, rebuild the native binding, then `npm link` — so `git pull && sh install.sh` upgrades in place. This is the default. |
| `--from-tarball <pkg.tgz>` | install a packed artifact globally instead of a checkout |
| `--start` | also run `nova daemon start --migrate` |
| `--force-ext` | replace a `~/.pi/agent/extensions/novaflow.ts` that differs from this checkout |

Then, in order:

1. **The Pi extension** is copied from `extensions/novaflow.ts` to
   `~/.pi/agent/extensions/novaflow.ts` if it is not there. An existing file that differs is left
   alone and reported; `--force-ext` replaces it. Reload Pi with `/reload` (or a new session) to
   pick it up.
2. **The config file** `~/.novaflow/config.yaml` is written only when it does not exist — never
   overwritten, and an existing store is never touched. These are the values it starts you with:

   ```yaml
   # ~/.novaflow/config.yaml — edit freely; install.sh never overwrites it
   budgets:
     daily_usd: 5.0
     monthly_usd: 40.0
   concurrency:
     global: 4
   retry:
     delay_sec: 300
   wake:
     enabled: true
     workspace: null
   ```
3. **Three commands are printed**, and running the installer twice changes nothing:

   ```bash
   nova daemon start --migrate
   nova workspace create <name> --path <dir>
   nova project create <name> --objective "<text>"
   ```

The package is published as `novaflow`. Once the version you want is on the registry,
`npm install -g novaflow` is the shortest route; it installs the same package the tarball route
does, so it has the same native-binding caveat below.

## The native SQLite binding

NovaFlow loads one native module, `better-sqlite3`. Recent npm versions do not run a package's
install scripts unless the script is approved, so the prebuilt binding can be missing after a global
install. The installer handles this for both routes. If you installed by hand and `nova daemon
start` reports a `better_sqlite3.node` error:

```bash
npm rebuild -g better-sqlite3
```

## By hand

```bash
cd novaflow
npm install                                  # also builds better-sqlite3
bin/nova daemon start --migrate
mkdir -p ~/.pi/agent/extensions
cp extensions/novaflow.ts ~/.pi/agent/extensions/novaflow.ts
```

`bin/nova` runs the TypeScript sources through the `tsx` loader, so a checkout works without a build
step.

## What the package contains

The published package is an allowlist, not the checkout:

| ships | does not ship |
| --- | --- |
| `bin/`, `src/`, `extensions/`, `docs/` | `test/` and fixtures |
| `README.md`, `CHANGELOG.md`, `LICENSE` | `release.sh`, `tsconfig.json`, `package-lock.json` |
| the store migrations | run logs, `events.raw.jsonl`, secrets, `.env` files |

`prepublishOnly` runs the typecheck and the whole suite before npm will upload anything.

There is also a guarded end-to-end check, off by default because it needs network access, a live
`pi` with credentials, and a model that costs money:

```bash
NOVAFLOW_SMOKE=1 npm test
```

It packs the artifact, installs it into a temporary prefix, runs `nova --version`, boots a daemon
against a temporary store, and runs one task with a small cost cap — asserting that it completed and
that its cost was priced. Without the flag it skips with one line naming what it needs.

## Common problems

| symptom | cause | the command that fixes it |
| --- | --- | --- |
| `node v20… is older than 22` | the shell is on an old Node | `nvm install 22 && nvm use 22`, then re-run `install.sh` |
| `pi is not on PATH` | the coding agent is not installed | `npm install -g @earendil-works/pi-coding-agent`, confirm with `pi --version` |
| `better_sqlite3.node` error on `nova daemon start` | the native binding did not build or was blocked | `npm rebuild -g better-sqlite3` |
| `nova: command not found` after installing | npm's global bin directory is not on `PATH` | run `npm prefix -g` and add its `bin` to `PATH` |
| the extension did not update after `git pull` | the destination file differs, so it was not overwritten | re-run `sh install.sh --force-ext`, then `/reload` in Pi |
| your edits to `~/.novaflow/config.yaml` vanished | they cannot — the file is written once | check you edited the global file, not a workspace's `.novaflow/config.yaml` |
