# AGENTS.md — novaflow

Contract for this repo. Short on purpose. Anything that can rot belongs in a command output, not here.

## Commands

```bash
npm run typecheck    # tsc --noEmit, no emit
npm run build        # tsc -> dist/, the only thing bin/novaflow loads
npm test             # node:test via tsx; offline, one temp root per case
./release.sh check   # the release gate: typecheck, build, test, pack allowlist, tarball smoke
```

Run these instead of inventing equivalent commands. If a command here is wrong, fix this file in the
same commit.

## What runs

- One binary: `bin/novaflow`, an ES module loader over `dist/cli/index.js`. `dist/` is build output
  and is never edited or committed.
- The store is `node:sqlite` (built-in, Node 24+) in WAL mode. No native module, no compiled
  binding, no install script.
- Runtime state lives in `<workspace>/.novaflow/`, never in this checkout.

## Invariants

1. Never edit files under `node_modules/`, `dist/`, or a generated migration.
2. Never weaken a test to make it pass. Deleting an assertion, adding `skip`, or loosening a matcher
   is a failure, not a fix.
3. No new dependency without an entry in `_memory/decisions/` in the workspace and explicit approval.
4. Database changes ship as a migration under `src/store/migrations/`, never as a manual `ALTER`.
5. Nothing is pushed. Local commits only. Sign-off belongs to Maul.
6. A test never writes outside its temp root: isolate `HOME`, `NOVAFLOW_HOME`, `XDG_CONFIG_HOME`,
   and `XDG_AGENTS_HOME` per case.

## Branching

`feature/`, `fix/`, `hotfix/` off `develop`. Never commit to `main` or `develop`.
Commits: `type(scope): summary`.

## Release

`develop` → `./release.sh bump <part>` → `./release.sh pr` → merge → `./release.sh tag` →
`./release.sh publish --confirm`. `publish` is a dry run without `--confirm`; every stage refuses the
wrong branch, a dirty tree, or a red `./release.sh check`. The contract is `novaflow-v100/release`.

## Done

`npm run typecheck && npm run build && npm test` passes, and `./release.sh check` passes for anything
that touches packaging, the CLI surface, or the skill bundle. Report the exact command you ran and
its exit code. "Should work" is not done.

## When blocked

Stop and report. Do not work around a gate, do not widen scope, do not touch the workspace scripts to
make something pass.
