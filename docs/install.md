# Install

## Requirements

| check | rule | refusal |
| --- | --- | --- |
| Node.js | ≥ 22 | refuses, naming the fix |
| `npm` | on `PATH` | refuses, naming the fix |
| `pi` | on `PATH` | refuses — the engine spawns Pi for every run |
| git | ≥ 2.40 | refuses — per-run worktrees need `git worktree` |
| `sqlite3` | any version | **warn-only** — the bundled `better-sqlite3` driver carries its own SQLite |

A clean install whose first task dies at preflight is a worse failure than a refused install, so
the installer checks before it writes anything.

## The native binding

NovaFlow loads one native module, `better-sqlite3`. npm (>= 11) does not run a package's
install scripts on a tarball/global install unless you approve them, so the prebuilt
binding can be missing after `npm install -g`. `install.sh` runs
`npm rebuild -g better-sqlite3` for you; if you installed by hand and `nova daemon start`
reports a `better_sqlite3.node` error, run:

    npm rebuild -g better-sqlite3

## The route this release supports

```bash
git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh
```

`--from-source` is the **default** because the registry has no release yet. It runs `npm install`
in this checkout and then `npm link` — a symlink to the checkout, so `git pull && sh
novaflow/install.sh` upgrades in place. It is deliberately not `npm install -g .`: that copies a
tree without the `tsx` loader `bin/nova` drives at runtime (and a dev-dependency install hits the
same wall).

```bash
sh install.sh                                  # --from-source (default)
sh install.sh --from-source [--start] [--force-ext]
sh install.sh --from-tarball pkg.tgz [--start] [--force-ext]
```

- `--from-tarball <pkg.tgz>` installs a packed artifact instead of this checkout.
- `--start` also runs `nova daemon start --migrate`.
- `--force-ext` replaces a different `~/.pi/agent/extensions/novaflow.ts`.

The installer copies the extension from `extensions/novaflow.ts` to
`~/.pi/agent/extensions/novaflow.ts` when it is absent, and prints the reload step (`/reload` or
a new Pi session). It writes `~/.novaflow/config.yaml` only when absent, in the daemon loader's
block form:

```yaml
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

A second run with the same flags changes nothing (asserted by a test), and an existing store is
never touched. It then prints exactly these three commands:

```bash
nova daemon start --migrate
nova workspace create <name> --path <dir>
nova project create <name> --objective "<text>"
```

## By hand

```bash
cd novaflow
npm install             # also builds better-sqlite3
bin/nova daemon start --migrate
mkdir -p ~/.pi/agent/extensions
cp extensions/novaflow.ts ~/.pi/agent/extensions/novaflow.ts
```

## Publishable, not published

The package is ready for npm but not on it. `npm pack --dry-run`'s file list is asserted by a
test: the packed file list (asserted by a test) ships `bin/`, `src/`, `extensions/`, `docs/`, `README.md`,
`CHANGELOG.md` and the MIT `LICENSE` (npm always includes the root `README.md` and `LICENSE` regardless of the `files` allowlist); `test/`, fixtures, dev config, `events.raw.jsonl` and
secrets stay out. `prepublishOnly` runs the typecheck and the suite.

The guarded tarball smoke (`NOVAFLOW_SMOKE=1`) packs the artifact, installs it into a temp prefix,
runs `nova --version`, boots `nova daemon start --migrate` against a temp store, then runs one
task end to end pinned to `opencode-go/deepseek-v4.1-flash` with a `max_cost_usd` cap of 0.05,
asserting `completed` and `cost_basis: priced`. Without the flag it skips with one line naming
what it needs. Publishing itself is a separate, operator-approved act.
