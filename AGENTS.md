# AGENTS.md — novaflow

Contract for this repo. Short on purpose. Anything that can rot belongs in a command output, not here.

## Commands

```bash
# run everything (spec-pinned golden suite)
npm test
# typecheck (tsc --noEmit; no emit step in v1 — runtime is tsx)
npm run typecheck
```

Run these instead of inventing equivalent commands. If a command here is wrong, fix this file in the same commit.

## Invariants

1. Never edit files under `vendor/`, `node_modules/`, `dist/`, `build/`, or generated migrations.
2. Never weaken a test to make it pass. Deleting an assertion, adding `skip`, or loosening a matcher is a failure, not a fix.
3. No new dependency without an entry in `_memory/decisions/` in the workspace and explicit approval.
4. Database changes ship as a migration, never as a manual `ALTER`. If you cannot write the down migration, stop and ask.
5. Nothing is pushed. Local commits only. Sign-off belongs to Maul.

## Branching

`feature/`, `fix/`, `hotfix/` off `develop`. Never commit to `main` or `develop`.
Commits: `type(scope): summary`.

## Done

Fast test target passes, and `./dev verify` passes from the workspace root. Report the exact
command you ran and its exit code. "Should work" is not done.

## When blocked

Stop and report. Do not work around a gate, do not widen scope, do not touch the workspace
scripts to make something pass.
