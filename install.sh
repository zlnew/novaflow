#!/bin/sh
# install.sh — the NovaFlow installer (novaflow-v030 W3 / R3.1).
#
# Acquisition (the route this release supports, named on screen):
#   git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh
#
# DEFAULT route is --from-source: `npm install` in THIS checkout, then
# `npm link` — deliberately not `npm install -g .`:
#   * bin/nova drives the tsx loader at runtime, and tsx is a dependency
#     (the shim documents the failure: "a devDependency — an --omit=dev
#     install hits this path. Exit 2").
#   * `npm install -g .` copies only the package's runtime dependencies into
#     the global prefix; the checkout's prepared tree (and its bin link) are
#     re-created there, not linked, so an upgrade means re-installing.
#   * `npm link` symlinks this checkout into the global prefix, so the CLI
#     runs against the exact tree `npm install` just prepared and
#     `git pull && sh install.sh` upgrades it in place.
# This script installs from the checkout you cloned; `npm install -g novaflow`
# installs the published package instead (same code, no checkout).
#
# Usage:
#   sh install.sh                                  # --from-source (default)
#   sh install.sh --from-source [--start] [--force-ext]
#   sh install.sh --from-tarball pkg.tgz [--start] [--force-ext]
#
# Every preflight check refuses with the FIX in the message: a clean install
# whose first task dies at preflight is a worse failure than a refused install.
# Running it twice with the same flags changes nothing, and it never touches an
# existing store or an existing config.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# The daemon's global config and the extension's install location (data 4.4,
# and the path the engine actually spawns — pinned by test/docs/readme.test.ts).
config_dir="$HOME/.novaflow"
config_file="$config_dir/config.yaml"
ext_src="$repo_root/extensions/novaflow.ts"
ext_dir="$HOME/.pi/agent/extensions"
ext_dest="$ext_dir/novaflow.ts"

route=source
tarball=""
do_start=0
force_ext=0

note() { printf '%s\n' "install.sh: $*"; }
warn() { printf '%s\n' "install.sh: warning: $*" >&2; }
die() {
  printf '%s\n' "install.sh: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
usage: sh install.sh [--from-source | --from-tarball <pkg.tgz>] [--start] [--force-ext]

NovaFlow installer (novaflow-v030 R3.1).

  --from-source          install this checkout's dependencies and link it
                         globally, from this checkout (DEFAULT); the published
                         package is `npm install -g novaflow`
  --from-tarball <pkg>   install a packed artifact (`npm pack`) globally
  --start                also start the daemon: nova daemon start --migrate
  --force-ext            overwrite a different ~/.pi/agent/extensions/novaflow.ts
  -h, --help             print this usage

acquisition: git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh
USAGE
}

have() { command -v "$1" >/dev/null 2>&1; }

# version_ge <have> <want> — dotted numeric compare; missing parts count as 0.
version_ge() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    nh = split(have, H, "."); nw = split(want, W, ".")
    n = (nh > nw ? nh : nw)
    for (i = 1; i <= n; i++) {
      h = (i <= nh ? H[i] + 0 : 0)
      w = (i <= nw ? W[i] + 0 : 0)
      if (h > w) exit 0
      if (h < w) exit 1
    }
    exit 0
  }'
}

# srs 2.2: Pi is a hard requirement — the engine spawns it for every run.
check_node() {
  have node || die "node is not on PATH — NovaFlow needs Node.js >= 22. Fix: install Node 22+ (nvm install 22 && nvm use 22, or https://nodejs.org), then re-run this script."
  _raw=$(node -v 2>/dev/null || true)
  _v=${_raw#v}
  [ -n "$_v" ] || die "node -v printed nothing — the node on PATH is broken. Fix: reinstall Node 22+ (https://nodejs.org) and re-run."
  version_ge "$_v" "22.0.0" ||
    die "node $_v is older than 22 — NovaFlow needs Node.js >= 22. Fix: nvm install 22 && nvm use 22 (or upgrade from https://nodejs.org), then re-run."
  note "node $_raw"
}

check_npm() {
  have npm || die "npm is not on PATH — NovaFlow installs with npm. Fix: install Node 22+, which ships npm (nvm install 22), then re-run."
  _v=$(npm --version 2>/dev/null || true)
  note "npm ${_v:-present}"
}

check_pi() {
  have pi || die "pi is not on PATH — NovaFlow drives Pi sessions and will not install without it. Fix: npm install -g @earendil-works/pi-coding-agent, then confirm with: pi --version."
  _v=$(pi --version 2>/dev/null || true)
  note "pi ${_v:-present}"
}

# srs 2.2 / FR-TSK: per-run worktrees need `git worktree add` (2.40+).
check_git() {
  have git || die "git is not on PATH — NovaFlow's per-run worktrees need git >= 2.40. Fix: install git (Linux: sudo apt install git; macOS: brew install git), then re-run."
  _raw=$(git --version 2>/dev/null || true)
  _v=${_raw##* }
  version_ge "$_v" "2.40.0" ||
    die "git $_v is older than 2.40 — NovaFlow's per-run worktrees need git >= 2.40. Fix: upgrade git (Linux: sudo apt install --only-upgrade git; macOS: brew upgrade git), then re-run."
  note "git $_v"
}

# Warn-only: better-sqlite3 carries its own SQLite, so the CLI needs no
# sqlite3 on PATH at all — an old one is worth one line, never a refusal.
check_sqlite3() {
  if ! have sqlite3; then
    warn "sqlite3 is not on PATH — not required: the bundled better-sqlite3 driver carries its own SQLite. No action needed."
    return 0
  fi
  _raw=$(sqlite3 --version 2>/dev/null || true)
  _v=${_raw%% *}
  if [ -n "$_v" ] && version_ge "$_v" "3.42.0"; then
    note "sqlite3 $_v"
  else
    warn "sqlite3 ${_v:-unknown} is older than 3.42 — not required: the bundled better-sqlite3 driver carries its own SQLite. No action needed."
  fi
}

install_from_source() {
  [ -f "$repo_root/package.json" ] ||
    die "no package.json in $repo_root — run install.sh from the novaflow checkout, or use --from-tarball <pkg.tgz>."
  # npm (>= 12) blocks dependency install scripts by default. In a PROJECT-scoped
  # install the env form is REJECTED (EALLOWSCRIPTS), so the checkout's own
  # package.json carries `allowScripts` for the one native dep — npm's documented
  # project mechanism.
  note "installing dependencies in $repo_root"
  ( cd "$repo_root" && npm install ) || die "npm install failed — fix the error above and re-run this script."
  # belt and braces: the binding is load-bearing, rebuild if it did not land.
  if ! ( cd "$repo_root" && npm rebuild better-sqlite3 ); then
    printf '%s\n' "install.sh: warning: npm rebuild better-sqlite3 failed — if 'nova daemon start' reports a better_sqlite3.node error, see docs/install.md (The native binding)." >&2
  fi
  note "linking nova onto PATH from this checkout"
  ( cd "$repo_root" && npm link ) || die "npm link failed — check that npm's global prefix is writable (npm prefix -g) and re-run."
}

install_from_tarball() {
  _tgz=$1
  [ -f "$_tgz" ] || die "tarball not found: $_tgz — build one from the checkout with: npm pack"
  _abs="$(CDPATH= cd -- "$(dirname -- "$_tgz")" && pwd)/$(basename -- "$_tgz")"
  note "installing $_abs globally"
  # npm (>= 12) blocks dependency install scripts by default; allowing the one
  # native dep makes its prebuilt binding land with the install itself.
  if ! npm_config_allow_scripts=better-sqlite3 npm install -g "$_abs"; then
    # older/blocked npm: plain install, then the documented rebuild fallback
    npm install -g "$_abs" || die "npm install -g failed — fix the error above and re-run this script."
    npm rebuild -g better-sqlite3 || printf '%s\n' "install.sh: warning: npm rebuild -g better-sqlite3 failed — if 'nova daemon start' reports a better_sqlite3.node error, see docs/install.md (The native binding)." >&2
  fi
}

reload_note() {
  printf '%s\n' "            reload Pi with /reload (or start a new pi session) to pick it up."
}

deploy_extension() {
  [ -f "$ext_src" ] || die "extensions/novaflow.ts is missing from $repo_root — is this the novaflow checkout?"
  mkdir -p "$ext_dir"
  if [ ! -e "$ext_dest" ]; then
    cp "$ext_src" "$ext_dest"
    note "Pi extension deployed to $ext_dest"
    reload_note
    return 0
  fi
  if cmp -s "$ext_src" "$ext_dest"; then
    note "Pi extension at $ext_dest is already current — left alone"
    return 0
  fi
  if [ "$force_ext" -eq 1 ]; then
    cp "$ext_src" "$ext_dest"
    note "Pi extension overwritten (--force-ext) at $ext_dest"
    reload_note
    return 0
  fi
  warn "$ext_dest differs from this checkout's extensions/novaflow.ts — NOT overwritten. Re-run with --force-ext to replace it."
  reload_note
}

write_config() {
  mkdir -p "$config_dir"
  if [ -e "$config_file" ]; then
    note "keeping the existing $config_file (written only when absent)"
    return 0
  fi
  # The pinned global-scope shape (R3.1), in BLOCK form: the daemon's own
  # loader (src/daemonconfig.ts) parses sections of scalars and REFUSES the
  # flow form this requirement writes inline — `budgets: { daily_usd: 5.0 }`
  # fails with "lists/maps are not supported by the documented subset", which
  # would leave a config the daemon will not boot with. Same four sections,
  # same values, the one form that parses.
  cat >"$config_file" <<'YAML'
# ~/.novaflow/config.yaml — global scope (data 4.4).
# Written once by install.sh, only when absent. Edit freely: install.sh never
# overwrites an existing file.
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
YAML
  note "wrote $config_file (budgets 5/40 USD, concurrency.global 4, retry 300 s, wake enabled)"
}

start_daemon() {
  have nova ||
    die "nova is not on PATH after install — add npm's global bin directory to PATH (see: npm prefix -g), then run: nova daemon start --migrate"
  note "starting the daemon"
  nova daemon start --migrate ||
    die "the daemon did not start — run 'nova daemon start --migrate' by hand to see the full error."
}

print_next() {
  cat <<'NEXT'

Installed. Three commands from here:

  nova daemon start --migrate
  nova workspace create <name> --path <dir>
  nova project create <name> --objective "<text>"
NEXT
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --from-source) route=source ;;
      --from-tarball)
        if [ $# -lt 2 ] || [ -z "$2" ]; then
          printf '%s\n' "install.sh: --from-tarball needs a <pkg.tgz> path" >&2
          usage >&2
          exit 2
        fi
        route=tarball
        tarball=$2
        shift
        ;;
      --from-tarball=*)
        route=tarball
        tarball=${1#--from-tarball=}
        if [ -z "$tarball" ]; then
          printf '%s\n' "install.sh: --from-tarball needs a <pkg.tgz> path" >&2
          usage >&2
          exit 2
        fi
        ;;
      --start) do_start=1 ;;
      --force-ext) force_ext=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf '%s\n' "install.sh: unknown option \"$1\"" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  note "NovaFlow installer (novaflow ${route} route)"
  note "acquisition: git clone https://github.com/zlnew/novaflow && sh novaflow/install.sh"
  check_node
  check_npm
  check_pi
  check_git
  check_sqlite3
  case "$route" in
    source) install_from_source ;;
    tarball) install_from_tarball "$tarball" ;;
  esac
  deploy_extension
  write_config
  if [ "$do_start" -eq 1 ]; then start_daemon; fi
  print_next
}

main "$@"
