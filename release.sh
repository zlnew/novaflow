#!/usr/bin/env bash
# release.sh — cut and publish a NovaFlow release.
#
# Flow: feature branches -> develop -> release pull request -> main -> tag -> publish
#
# Usage:
#   ./release.sh bump <major|minor|patch>   on develop: version commit, pushed to develop
#   ./release.sh pr                         on develop: open the develop -> main pull request
#   ./release.sh tag                        on main: tag vX.Y.Z, push it, create the GitHub release
#   ./release.sh publish [--dry-run] [--confirm]
#                                           on main: npm publish (a dry run unless --confirm)
#
# Every step refuses a dirty tree, a red `npm test`, or the wrong branch. `tag` takes the
# release body from the `## [X.Y.Z]` section of CHANGELOG.md; `publish` uploads only with
# --confirm, after proving the tag exists in both places and the version is not on the registry.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_root"

die() { echo "release: $1" >&2; exit 1; }
clean() { [ -z "$(git status --porcelain)" ] || die "dirty tree — commit first"; }
on_branch() { [ "$(git rev-parse --abbrev-ref HEAD)" = "$1" ] || die "must run on '$1'"; }
gate() { npm test >/dev/null 2>&1 || die "npm test is red — no release"; }
version() { node -p "require('./package.json').version"; }

usage() {
  cat <<'USAGE'
Flow: feature branches -> develop -> release pull request -> main -> tag -> publish

Usage:
  ./release.sh bump <major|minor|patch>   on develop: version commit, pushed to develop
  ./release.sh pr                         on develop: open the develop -> main pull request
  ./release.sh tag                        on main: tag vX.Y.Z, push it, create the GitHub release
  ./release.sh publish [--dry-run] [--confirm]
                                          on main: npm publish (a dry run unless --confirm)
USAGE
}

# gh acts as the owning account (zlnew), scoped per call — the machine-wide
# active account never switches. Same rule as the workspace push door.
PR_USER="${GH_PR_USER:-zlnew}"
ghz() {
  local tok
  tok="$(gh auth token --user "$PR_USER" 2>/dev/null || true)"
  [ -n "$tok" ] || die "no gh token for '$PR_USER' — gh auth login --user $PR_USER"
  GH_TOKEN="$tok" gh "$@"
}

case "${1:-}" in
  bump)
    part="${2:-}"
    case "$part" in major|minor|patch) ;; *) die "bump needs <major|minor|patch>" ;; esac
    on_branch develop
    clean
    gate
    npm version "$part" --no-git-tag-version >/dev/null
    v="$(version)"
    git add package.json package-lock.json
    git commit -m "chore(release): bump version to ${v}"
    git push origin develop
    echo "release: develop at ${v}"
    ;;

  pr)
    on_branch develop
    clean
    gate
    git fetch -q origin
    v="$(version)"
    [ -n "$(git log --oneline origin/main..develop)" ] || die "develop has no commits beyond main — nothing to release"
    notes="$(git log --oneline origin/main..develop | sed 's/^/- /')"
    ghz pr create --base main --head develop \
      --title "release ${v}" \
      --body "Release ${v} from develop.

Commits since main:
${notes}

Merging this PR IS the release merge. After merge, run: ./release.sh tag" \
      && echo "release: PR opened — merge it, then run ./release.sh tag"
    ;;

  tag)
    on_branch main
    clean
    gate
    git pull -q --ff-only origin main
    v="$(version)"
    tag="v${v}"
    [ -z "$(git tag --list "$tag")" ] || die "tag ${tag} already exists — bump the version instead of re-tagging"
    heading="## [${v}]"
    start="$(awk -v h="$heading" 'index($0, h) == 1 { print NR; exit }' CHANGELOG.md)"
    [ -n "$start" ] || die "CHANGELOG.md has no \"${heading}\" section — add one that opens \"${heading} — <date>\" and says what changed for the user, then re-run"
    notes_dir="$(mktemp -d)"
    trap 'rm -rf "$notes_dir"' EXIT
    end="$(awk -v s="$start" 'NR > s && /^## / { print NR; exit }' CHANGELOG.md)"
    [ -n "$end" ] || end=$(( $(wc -l < CHANGELOG.md) + 1 ))
    sed -n "$((start + 1)),$((end - 1))p" CHANGELOG.md | sed -e '/./,$!d' > "$notes_dir/notes.md"
    [ -s "$notes_dir/notes.md" ] || die "the \"${heading}\" section of CHANGELOG.md is empty — write what changed for the user, then re-run"
    git tag -a "$tag" -m "NovaFlow ${tag}"
    git push origin "$tag"
    ghz release create "$tag" --title "NovaFlow ${tag}" --notes-file "$notes_dir/notes.md"
    echo "release: ${tag} tagged and released"
    ;;

  publish)
    dry_run=0
    confirm=0
    shift
    for arg in "$@"; do
      case "$arg" in
        --dry-run) dry_run=1 ;;
        --confirm) confirm=1 ;;
        -h|--help) usage; exit 0 ;;
        *) die "publish takes [--dry-run] [--confirm], got \"${arg}\"" ;;
      esac
    done
    on_branch main
    clean
    gate
    v="$(version)"
    tag="v${v}"
    git fetch -q origin --tags
    [ -n "$(git tag --list "$tag")" ] || die "no tag ${tag} — cut one first: ./release.sh tag"
    [ -n "$(git ls-remote --tags origin "refs/tags/${tag}")" ] || die "tag ${tag} is not on origin — push it with: git push origin ${tag}"
    if registry_version="$(npm view "novaflow@${v}" version 2>&1)"; then
      die "novaflow@${v} is already on the registry (npm view reports ${registry_version}) — cut a new version; a published release cannot be republished"
    fi
    printf '%s' "$registry_version" | grep -qE '(E404|404)' ||
      die "could not confirm that novaflow@${v} is unpublished — npm view said: ${registry_version}"
    if [ "$dry_run" -eq 0 ] && [ "$confirm" -eq 0 ]; then
      die "publish needs --confirm: it uploads novaflow@${v} to the public registry — inspect the plan first with: ./release.sh publish --dry-run"
    fi
    echo "release: about to publish"
    echo "  package: novaflow"
    echo "  version: ${v}"
    echo "  url:     https://www.npmjs.com/package/novaflow/v/${v}"
    npm publish --dry-run
    if [ "$dry_run" -eq 1 ]; then
      echo "release: dry run only — nothing was uploaded; re-run with --confirm to publish ${v}"
      exit 0
    fi
    npm publish
    echo "release: novaflow@${v} published — verify with: npm view novaflow@${v} version"
    ;;

  -h|--help)
    usage
    exit 0
    ;;

  *)
    usage >&2
    exit 2
    ;;
esac
