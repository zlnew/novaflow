#!/usr/bin/env bash
# release.sh — NovaFlow release flow. No CI exists for this repo (GitHub Actions
# is deliberately not used); this box is the pipeline and this script is the door.
#
# Flow (git workflow ruling, DEC-novaflow-git-workflow):
#   feature/* -> PR -> develop -> PR -> main -> tag from main
#
# Usage:
#   ./release.sh bump <major|minor|patch>  # on develop: npm version <part>, commit, push develop
#   ./release.sh pr                        # open the develop -> main release PR (notes from the log)
#   ./release.sh tag                      # after the release PR merges: tag main vX.Y.Z, push tag, GitHub release
#
# Every step refuses a dirty tree, a red `npm test`, or the wrong branch.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_root"

die() { echo "release: $1" >&2; exit 1; }
clean() { [ -z "$(git status --porcelain)" ] || die "dirty tree — commit first"; }
on_branch() { [ "$(git rev-parse --abbrev-ref HEAD)" = "$1" ] || die "must run on '$1'"; }
gate() { npm test >/dev/null 2>&1 || die "npm test is red — no release"; }
version() { node -p "require('./package.json').version"; }

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
    [ -z "$(git tag --list "$tag")" ] || die "tag ${tag} already exists"
    git tag -a "$tag" -m "NovaFlow ${tag}"
    git push origin "$tag"
    ghz release create "$tag" --title "NovaFlow ${tag}" \
      --notes "See the release PR for the commit list. Contract: odd/specs/novaflow-v1 in the workspace repo."
    echo "release: ${tag} published"
    ;;

  *)
    sed -n '2,9p' "$0"
    exit 2
    ;;
esac
