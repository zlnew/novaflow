#!/usr/bin/env bash
# release.sh — preflight, cut, and publish a NovaFlow release.
#
# Flow: feature branch -> PR -> develop -> ./release.sh bump -> ./release.sh pr
#       -> merge to main -> ./release.sh tag -> ./release.sh publish --confirm
#
# Usage:
#   ./release.sh check
#   ./release.sh bump <major|minor|patch|X.Y.Z>
#   ./release.sh pr
#   ./release.sh tag
#   ./release.sh publish [--dry-run] [--confirm] [--otp <code>] [--tag <dist-tag>]
#
# Every step refuses a dirty tree, a red `./release.sh check`, or the wrong branch.
# `tag` takes the GitHub release body from the `## [X.Y.Z]` section of CHANGELOG.md.
# `publish` uploads only with --confirm, and only after proving the tag exists on
# origin at HEAD and the version is absent from the npm registry.
#
# `check` mutates nothing: no git write, no registry write, no host path. The
# tarball smoke test installs into a throwaway prefix with an isolated HOME,
# NOVAFLOW_HOME, XDG_CONFIG_HOME and XDG_AGENTS_HOME.
#
# Tests source this file with NOVAFLOW_RELEASE_LIB_ONLY=1 to exercise the helper
# functions without dispatching a subcommand. Nothing else sets it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

die() { printf 'release: %s\n' "$1" >&2; exit 1; }
halt() { printf 'release: %s\n' "$1" >&2; exit 2; }
step() { printf 'release: %s\n' "$1" >&2; }

tmp_dirs=()
new_tmp() {
  local dir
  dir="$(mktemp -d)"
  tmp_dirs+=("$dir")
  printf '%s' "$dir"
}
cleanup() {
  local dir
  if [ "${#tmp_dirs[@]}" -gt 0 ]; then
    for dir in "${tmp_dirs[@]}"; do
      if [ -n "$dir" ]; then
        rm -rf "$dir"
      fi
    done
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: ./release.sh <command> [options]

  check
      Full release preflight, mutating nothing: typecheck, build, test, the
      npm pack allowlist, and a tarball install smoke test.

  bump <major|minor|patch|X.Y.Z>
      On develop with a clean tree: bump package.json and package-lock.json,
      sync skills/novaflow/SKILL.md metadata.version, ensure a
      CHANGELOG.md "## [X.Y.Z]" section, commit, push develop.

  pr
      On develop with a clean tree: open the develop -> main pull request as
      the GH_PR_USER account (default zlnew).

  tag
      On main with a clean tree: pull --ff-only, run check, require the
      CHANGELOG.md section, create annotated tag vX.Y.Z, push it, and create
      the GitHub release from that section.

  publish [--dry-run] [--confirm] [--otp <code>] [--tag <dist-tag>]
      On main with a clean tree: run check, prove vX.Y.Z is on origin at HEAD,
      prove the version is absent from the registry, then publish. Without
      --confirm this is a dry run that prints the exact command to run next.
      --otp <code> answers 2FA; NODE_AUTH_TOKEN or a granular bypass token
      works instead. --tag <dist-tag> defaults to latest.

Examples:
  ./release.sh check
  ./release.sh bump patch
  ./release.sh publish --dry-run
  ./release.sh publish --confirm --tag next --otp 123456
USAGE
}

version() { node -p "require('./package.json').version"; }

git_branch() { git rev-parse --abbrev-ref HEAD; }

require_branch() {
  local want="$1" have
  have="$(git_branch)"
  [ "$have" = "$want" ] || die "must run on '${want}' (you are on '${have}')"
}

require_clean() {
  local dirty
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" >&2
    die "dirty tree — commit or stash first"
  fi
}

run_gate() {
  step "typecheck"
  npm run typecheck
  step "build"
  npm run build
  step "test"
  npm test
}

# The packed file list, one path per line, across npm `pack --json` shapes.
pack_paths() {
  npm pack --dry-run --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(raw);
      const meta = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      for (const file of meta.files) process.stdout.write(file.path + "\n");
    });
  '
}

# Reads a packed file list on stdin; exits 1 with the reason on a bad package.
check_pack_paths() {
  local paths haystack required entry bad
  paths="$(cat)"
  haystack=$'\n'"$paths"$'\n'
  case "$haystack" in
    *$'\n'dist/*) ;;
    *) die "the tarball is missing dist/ — run: npm run build" ;;
  esac
  required=(bin/novaflow skills/novaflow/SKILL.md README.md LICENSE CHANGELOG.md)
  for entry in "${required[@]}"; do
    case "$haystack" in
      *$'\n'"$entry"$'\n'*) ;;
      *) die "the tarball is missing ${entry}" ;;
    esac
  done
  bad="$(grep -E '^(src|test)/|\.db($|-)|^\.novaflow/|\.tsbuildinfo$' <<<"$paths" || true)"
  [ -z "$bad" ] || die "the tarball must not ship: $(printf '%s' "$bad" | tr '\n' ' ')"
}

assert_pack_allowlist() {
  local paths
  paths="$(pack_paths)" || die "npm pack --dry-run failed"
  printf '%s\n' "$paths" | check_pack_paths
}

smoke_tarball() {
  local work tgz prefix log home workspace bin
  work="$(new_tmp)"
  step "packing a real tarball"
  env -u npm_config_dry_run -u npm_config_pack_destination npm pack --dry-run=false --pack-destination "$work" >/dev/null 2>&1 || die "npm pack failed"
  tgz="$(find "$work" -maxdepth 1 -name '*.tgz' -print -quit)"
  [ -n "$tgz" ] || die "npm pack produced no .tgz"

  prefix="$work/prefix"
  log="$work/install.log"
  step "installing the tarball into an isolated prefix"
  if ! env -u npm_config_dry_run npm install -g --dry-run=false --prefix "$prefix" --no-audit --no-fund --prefer-offline "$tgz" >"$log" 2>&1; then
    printf '%s\n' "$(cat "$log")" >&2
    die "npm install -g failed for ${tgz}"
  fi
  if grep -Eqi 'node-gyp|prebuild-install|gyp (info|verb|warn|err)' "$log"; then
    printf '%s\n' "$(cat "$log")" >&2
    die "the tarball ran a native compilation script — NovaFlow must install with zero native builds"
  fi
  if find "$prefix" \( -name '*.node' -o -name 'binding.gyp' \) -print -quit | grep -q .; then
    die "the installed prefix contains native build artifacts"
  fi

  bin="$prefix/bin/novaflow"
  [ -x "$bin" ] || die "the tarball did not install a novaflow binary at ${bin}"
  home="$work/home"
  workspace="$work/ws"
  mkdir -p "$home" "$workspace"

  smoke_run() {
    HOME="$home" \
      XDG_CONFIG_HOME="$home/.config" \
      XDG_AGENTS_HOME="$home/.agents" \
      NOVAFLOW_HOME="$home/.novaflow" \
      "$bin" "$@"
  }

  step "running novaflow --version from the tarball"
  local reported
  reported="$(smoke_run --version)"
  [ "$reported" = "novaflow $(version)" ] ||
    die "the tarball reports \"${reported}\", expected \"novaflow $(version)\""

  step "running novaflow workspace create in an isolated HOME"
  smoke_run workspace create --name release-smoke --path "$workspace" --json >/dev/null ||
    die "novaflow workspace create failed from the tarball"

  step "running novaflow skill install --dry-run in an isolated HOME"
  smoke_run skill install --dry-run --json >/dev/null ||
    die "novaflow skill install --dry-run failed from the tarball"
  [ ! -e "$home/.agents/skills/novaflow" ] ||
    die "a dry run wrote the canonical skill directory — the smoke test is not isolated"
}

cmd_check() {
  run_gate
  step "inspecting the npm pack allowlist"
  assert_pack_allowlist
  smoke_tarball
  step "check green for novaflow $(version)"
}

# Copies X.Y.Z into skills/novaflow/SKILL.md metadata.version, so the bundled
# skill reports the version the CLI does (test/skills/package.test.ts enforces it).
set_skill_version() {
  local v="$1" file="skills/novaflow/SKILL.md"
  [ -f "$file" ] || die "missing ${file} — the bundled skill must ship"
  node -e '
    const fs = require("node:fs");
    const [file, version] = process.argv.slice(1);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let inMetadata = false;
    let patched = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^metadata:[ \t]*$/.test(line)) { inMetadata = true; continue; }
      if (!inMetadata) continue;
      if (/^\S/.test(line)) { inMetadata = false; continue; }
      if (/^[ \t]+version:[ \t]*/.test(line)) {
        lines[index] = line.replace(/^([ \t]+version:[ \t]*).*$/, (_match, head) => head + "\"" + version + "\"");
        patched = true;
        break;
      }
    }
    if (!patched) {
      process.stderr.write("release: " + file + " has no metadata.version line to update\n");
      process.exit(1);
    }
    fs.writeFileSync(file, lines.join("\n"));
  ' "$file" "$v" || die "could not update metadata.version in ${file}"
  step "skills/novaflow/SKILL.md now reports ${v}"
}

changelog_has_section() {
  local v="$1" file="${2:-CHANGELOG.md}"
  local vre="${v//./\\.}"
  grep -qE "^## \\[${vre}\\]" "$file"
}

ensure_changelog_section() {
  local v="$1" file="CHANGELOG.md" tmp inserted=0 line
  [ -f "$file" ] || die "missing ${file}"
  if changelog_has_section "$v" "$file"; then
    step "CHANGELOG.md already has a ${v} section"
    return 0
  fi
  step "scaffolding a ${v} section in CHANGELOG.md"
  tmp="$file.scaffold"
  {
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$inserted" -eq 0 ] && printf '%s\n' "$line" | grep -qE '^## '; then
        printf '## [%s] — unreleased\n\nWrite what changed for the user, then run ./release.sh tag.\n\n' "$v"
        inserted=1
      fi
      printf '%s\n' "$line"
    done <"$file"
    if [ "$inserted" -eq 0 ]; then
      printf '\n## [%s] — unreleased\n\nWrite what changed for the user, then run ./release.sh tag.\n' "$v"
    fi
  } >"$tmp"
  mv "$tmp" "$file"
}

# Prints the `## [v]` section body, or exits 1 naming why the section is unusable.
changelog_notes() {
  local v="$1" file="${2:-CHANGELOG.md}" vre start heading end body
  [ -f "$file" ] || die "missing ${file}"
  vre="${v//./\\.}"
  start="$(grep -m1 -nE "^## \\[${vre}\\]" "$file" | cut -d: -f1 || true)"
  [ -n "$start" ] ||
    die "${file} has no \"## [${v}]\" section — add one that opens \"## [${v}] — <date>\" and says what changed for the user"
  heading="$(sed -n "${start}p" "$file")"
  if printf '%s\n' "$heading" | grep -qiE '([[:space:]]|[—-])unreleased([[:space:]]|$)'; then
    die "the \"## [${v}]\" heading in ${file} still says unreleased — replace it with the release date before tagging"
  fi
  end="$(awk -v s="$start" 'NR > s && /^## / { print NR; exit }' "$file")"
  [ -n "$end" ] || end=$(( $(wc -l <"$file") + 2 ))
  body="$(sed -n "$((start + 1)),$((end - 1))p" "$file" | sed -e '/./,$!d')"
  [ -n "${body//[[:space:]]/}" ] ||
    die "the \"## [${v}]\" section of ${file} is empty — write what changed for the user, then re-run"
  if printf '%s\n' "$body" | grep -qF 'Write what changed for the user, then run ./release.sh tag.'; then
    die "the \"## [${v}]\" section of ${file} still contains the scaffold placeholder — write real release notes first"
  fi
  printf '%s\n' "$body"
}

# gh acts as the owning account (GH_PR_USER, default zlnew), scoped per call.
# The machine-wide active account never switches. Same rule as the workspace door.
PR_USER="${GH_PR_USER:-zlnew}"
ghz() {
  local tok
  tok="$(gh auth token --user "$PR_USER" 2>/dev/null || true)"
  [ -n "$tok" ] || die "no gh token for '${PR_USER}' — run: gh auth login --user ${PR_USER}"
  GH_TOKEN="$tok" gh "$@"
}

cmd_bump() {
  local part="${1:-}" v
  [ "$#" -le 1 ] || halt "bump takes exactly one target"
  case "$part" in
    major|minor|patch) ;;
    *)
      printf '%s' "$part" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
        halt "bump needs <major|minor|patch|X.Y.Z>, got \"${part}\""
      ;;
  esac
  require_branch develop
  require_clean
  cmd_check

  step "bumping to ${part}"
  npm version "$part" --no-git-tag-version >/dev/null
  v="$(version)"
  set_skill_version "$v"
  ensure_changelog_section "$v"

  git add package.json package-lock.json CHANGELOG.md skills/novaflow/SKILL.md
  git commit -q -m "chore(release): bump version to ${v}"
  git push -q origin develop
  printf 'release: develop at %s — next: ./release.sh pr\n' "$v"
}

cmd_pr() {
  local v ahead notes
  require_branch develop
  require_clean
  cmd_check

  git fetch -q origin
  v="$(version)"
  ahead="$(git log --oneline origin/main..develop)"
  [ -n "$ahead" ] || die "develop has no commits beyond origin/main — nothing to release"
  notes="$(printf '%s\n' "$ahead" | sed 's/^/- /')"
  ghz pr create --base main --head develop \
    --title "release ${v}" \
    --body "Release ${v} from develop.

Commits since main:
${notes}

Merging this pull request is the release merge. After the merge, run: ./release.sh tag" ||
    die "gh pr create failed"
  printf 'release: pull request opened for %s — merge it, then run ./release.sh tag\n' "$v"
}

cmd_tag() {
  local v tag notes_dir
  require_branch main
  require_clean
  git pull -q --ff-only origin main
  cmd_check

  v="$(version)"
  tag="v${v}"
  # Fetch tags first, so a tag that only exists on origin is caught here rather
  # than by a rejected push after the local tag is already created.
  git fetch -q origin --tags
  [ -z "$(git tag --list "$tag")" ] || die "tag ${tag} already exists — bump the version instead of re-tagging"

  step "validating the CHANGELOG.md section for ${v}"
  notes_dir="$(new_tmp)"
  changelog_notes "$v" CHANGELOG.md >"$notes_dir/notes.md"
  [ -s "$notes_dir/notes.md" ] || die "the \"## [${v}]\" section of CHANGELOG.md is empty"

  git tag -a "$tag" -m "NovaFlow ${tag}"
  git push -q origin "$tag"
  ghz release create "$tag" --title "NovaFlow ${tag}" --notes-file "$notes_dir/notes.md" ||
    die "git tag ${tag} is pushed, but gh release create failed — re-run: gh release create ${tag} --notes-file <notes>"
  printf 'release: %s tagged, pushed, and released — next: ./release.sh publish --confirm\n' "$tag"
}

require_tag_at_head() {
  local tag="$1" head local_commit remote_lines remote_sha
  head="$(git rev-parse HEAD)"
  [ -n "$(git tag --list "$tag")" ] || die "no local tag ${tag} — cut one first: ./release.sh tag"
  local_commit="$(git rev-parse "${tag}^{commit}")"
  [ "$local_commit" = "$head" ] ||
    die "tag ${tag} points at ${local_commit:0:12}, not HEAD ${head:0:12} — check out the tagged commit"
  remote_lines="$(git ls-remote --tags origin 2>/dev/null | awk -v t="refs/tags/${tag}" '$2 == t || $2 == t "^{}"')" ||
    die "could not list origin tags — check the remote"
  [ -n "$remote_lines" ] || die "tag ${tag} is not on origin — push it: git push origin ${tag}"
  remote_sha="$(printf '%s\n' "$remote_lines" | awk -v t="refs/tags/${tag}^{}" '$2 == t { print $1 }')"
  if [ -z "$remote_sha" ]; then
    remote_sha="$(printf '%s\n' "$remote_lines" | awk -v t="refs/tags/${tag}" '$2 == t { print $1 }')"
  fi
  [ "$remote_sha" = "$head" ] ||
    die "origin tag ${tag} points at ${remote_sha:0:12}, not HEAD ${head:0:12} — a published tag cannot move"
}

require_unpublished() {
  local v="$1" out
  if out="$(npm view "novaflow@${v}" version 2>&1)"; then
    if [ -z "${out//[[:space:]]/}" ]; then
      return 0
    fi
    die "novaflow@${v} is already on the registry (npm view: ${out}) — bump the version instead of republishing"
  fi
  printf '%s\n' "$out" | grep -qE '(^|[[:space:]:])E?404([[:space:]]|$)' ||
    die "could not confirm novaflow@${v} is unpublished — npm view said: ${out}"
}

has_automation_npm_token() {
  # Normal `npm login` also writes //registry.npmjs.org/:_authToken to ~/.npmrc,
  # so only treat NODE_AUTH_TOKEN (or an explicit bypass opt-in) as 2FA-bypass.
  [ -n "${NODE_AUTH_TOKEN:-}" ] || [ "${NOVAFLOW_NPM_BYPASS_2FA:-0}" = "1" ]
}

require_publish_otp_ready() {
  local confirm="$1" otp="$2"
  if [ "$confirm" -eq 1 ] && [ -z "$otp" ] && ! has_automation_npm_token && [ ! -t 0 ]; then
    halt "publish --confirm needs an OTP here: stdin is not a TTY. Pass --otp <code> or set NODE_AUTH_TOKEN (a granular 2FA-bypass token), then re-run"
  fi
}

require_npm_auth() {
  local who
  if ! who="$(npm whoami 2>&1)"; then
    die "not signed in to npm — run 'npm login' or set NODE_AUTH_TOKEN; npm whoami said: ${who}"
  fi
  step "npm user: ${who}"
}

# The exact command to run after a dry run.
next_publish_command() {
  local dist_tag="$1" otp="$2" command
  command="./release.sh publish --confirm --tag ${dist_tag}"
  if [ -n "$otp" ]; then
    command="${command} --otp <code>"
  fi
  printf '%s\n' "$command"
}

cmd_publish() {
  local dry_run=0 confirm=0 otp="" dist_tag="latest" v tag
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --confirm) confirm=1; shift ;;
      --otp)
        [ "$#" -ge 2 ] || halt "--otp needs <code>"
        otp="$2"
        shift 2
        ;;
      --otp=*)
        otp="${1#*=}"
        shift
        ;;
      --tag)
        [ "$#" -ge 2 ] || halt "--tag needs <dist-tag>"
        dist_tag="$2"
        shift 2
        ;;
      --tag=*)
        dist_tag="${1#*=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *) halt "publish does not take \"$1\" — see: ./release.sh publish --help" ;;
    esac
  done
  [ -n "$dist_tag" ] || halt "--tag needs a non-empty <dist-tag>"
  if [ "$dry_run" -eq 1 ] && [ "$confirm" -eq 1 ]; then
    halt "cannot combine --dry-run and --confirm — pass --dry-run to preview or --confirm to upload"
  fi

  # 2FA: an explicit OTP and an automation token both answer the prompt. Without
  # either, a TTY hands control to npm; a pipe fails fast instead of hanging.
  require_publish_otp_ready "$confirm" "$otp"

  require_branch main
  require_clean
  require_npm_auth
  cmd_check

  v="$(version)"
  tag="v${v}"
  git fetch -q origin --tags
  require_tag_at_head "$tag"
  require_unpublished "$v"

  local publish_args=(--tag "$dist_tag")
  if [ -n "$otp" ]; then
    publish_args+=(--otp "$otp")
  fi

  if [ "$confirm" -eq 0 ]; then
    step "dry run only — nothing is uploaded"
    npm publish --dry-run "${publish_args[@]}"
    printf 'release: dry run complete for novaflow@%s — nothing was uploaded\n' "$v"
    printf 'release: to publish it, run: %s\n' "$(next_publish_command "$dist_tag" "$otp")"
    printf 'release: registry page: https://www.npmjs.com/package/novaflow/v/%s\n' "$v"
    exit 0
  fi

  npm publish "${publish_args[@]}"
  printf 'release: novaflow@%s published — verify with: npm view novaflow@%s version\n' "$v" "$v"
}

# Test-only hook: define the helpers above, dispatch nothing. See the header.
if [ "${NOVAFLOW_RELEASE_LIB_ONLY:-0}" = "1" ]; then
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return 0
  fi
  exit 0
fi

case "${1:-}" in
  check)
    shift
    [ "$#" -eq 0 ] || halt "check takes no arguments"
    cmd_check
    ;;
  bump)
    shift
    cmd_bump "$@"
    ;;
  pr)
    shift
    [ "$#" -eq 0 ] || halt "pr takes no arguments"
    cmd_pr
    ;;
  tag)
    shift
    [ "$#" -eq 0 ] || halt "tag takes no arguments"
    cmd_tag
    ;;
  publish)
    shift
    cmd_publish "$@"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  "")
    usage >&2
    exit 2
    ;;
  *)
    printf 'release: unknown command "%s"\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac
