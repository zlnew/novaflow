# Maintaining — cutting a release

Five steps, and every one of them refuses to run from a dirty tree, a red suite, or the wrong
branch. The order is: bump on `develop`, open the release pull request, merge it, tag `main`, then
publish.

You need: push access to `origin`, `gh` authenticated for the account that creates the release, and
npm credentials for the package. Everything runs from a checkout of this repository.

## The five steps

| step | command | run on | what it does |
| --- | --- | --- | --- |
| 1 | `./release.sh bump <major\|minor\|patch>` | `develop` | bumps `package.json` and `package-lock.json`, commits `chore(release): bump version to X.Y.Z`, pushes `develop` |
| 2 | `./release.sh pr` | `develop` | opens the `develop` → `main` pull request, with the commit list since `main` in the body |
| 3 | merge the pull request | — | the merge *is* the release merge; nothing else happens here |
| 4 | `./release.sh tag` | `main` | pulls fast-forward, tags `vX.Y.Z`, pushes the tag, and creates the GitHub release with notes taken from this repository's changelog |
| 5 | `./release.sh publish --dry-run`, then `./release.sh publish --confirm` | `main` | checks the tag and the registry, shows the plan, then uploads to npm |

## What each step refuses

| step | refuses when |
| --- | --- |
| every step | the working tree has uncommitted changes; `npm test` fails; you are not on the branch the step requires |
| `bump` | the part is not exactly `major`, `minor` or `patch` |
| `pr` | `develop` has no commits beyond `main` — there is nothing to release |
| `tag` | the tag `vX.Y.Z` already exists; `CHANGELOG.md` has no `## [X.Y.Z]` section, or that section is empty |
| `publish` | the tag `vX.Y.Z` does not exist locally; the tag is not on `origin`; `npm view novaflow@X.Y.Z version` answers (the version is already published); the registry check cannot be completed; `--confirm` was not passed |

`tag` takes the release body from the `## [X.Y.Z]` section of `CHANGELOG.md`, verbatim, and passes it
to the release as a notes file. The heading itself is not part of the body: the release title already
carries the version. Write that section as the text you want a reader to see on the release page —
it is not a summary of commits.

`publish` always runs `npm publish --dry-run` first and prints the package name, the version and the
URL the release will land on. The real upload runs only when `--confirm` is passed, so a publish is
two deliberate acts, never one keystroke.

## The package

`npm publish` uploads the allowlist in `package.json`'s `files` field, plus the root `README.md`,
`LICENSE` and `CHANGELOG.md`. `prepublishOnly` runs the typecheck and the whole suite inside npm's
own publish path, so a package cannot be uploaded from a checkout whose tests fail even if the
release script were bypassed.

## Verifying a release

Run these after the publish finishes; each answers a different question.

```bash
npm view novaflow@X.Y.Z version          # the registry has this exact version
npm view novaflow dist-tags              # `latest` points at it
gh release view vX.Y.Z                   # the release page exists, with the changelog body
git ls-remote --tags origin vX.Y.Z       # the tag is on the remote
```

Then install the published artifact somewhere disposable and run it:

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" novaflow@X.Y.Z
"$prefix/bin/nova" --version
rm -rf "$prefix"
```

If `--version` prints something other than `X.Y.Z`, stop: the published tarball does not match the
tag. The guarded end-to-end check (`NOVAFLOW_SMOKE=1 npm test`) goes further — it installs the
artifact, boots a daemon against a temporary store and runs one task to completion under a small
cost cap.

## Rolling back

A published version is effectively permanent. npm only allows an unpublish within a short window,
and never when another package depends on the version; treat any release that others may have
installed as immutable. Roll forward instead:

| situation | what to do |
| --- | --- |
| the version is wrong but nothing depends on it yet, and it is within npm's unpublish window | `npm unpublish novaflow@X.Y.Z`, then cut a new patch release |
| the version is live and wrong | `npm deprecate novaflow@X.Y.Z "reason and the version to use instead"`, then cut `X.Y.Z+1` |
| `latest` points at the wrong version | `npm dist-tag add novaflow@X.Y.W latest` (the version that should be installed) |
| the release page is wrong, the package is fine | edit the release body with `gh release edit vX.Y.Z --notes-file <file>` |
| the tag is wrong and nothing was published from it yet | `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, fix `main`, tag again |
| the store schema changed and you need to move a store back to an older release | there is no downgrade path: take `nova daemon backup` before upgrading and restore that copy for the older binary |

Never move a tag that a published version points at: the tarball and the tag are supposed to be the
same commit, and a moved tag makes that claim false.

## The changelog is the release notes

`CHANGELOG.md` is user-facing and is the source of the GitHub release body, so the person who writes
the release notes is the person who writes the changelog section. One bullet per user-visible
change, in the present tense, saying what the reader can now do. Internal shorthand — ticket
numbers, decision ids, branch names — belongs in the commit message, not in the changelog.
