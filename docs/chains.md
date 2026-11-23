# Chains — import, gates, verify, clean

A chain is a DAG of tasks under one `chain_runs` row. Import is all-or-nothing: the chain row,
every member in `draft`, every edge and every scope land in one transaction, or nothing does.
Roots are not auto-enqueued — the operator enqueues the root (`nova task run`), and the engine
propagates readiness.

## Import

`nova project import-dag <file> --project <slug>` accepts JSON or a YAML subset. The top level is
the `data` §4.3 schema: `version`, `project_slug`, `tasks`, `edges`.

- **`target_scopes` is required on every member** (DEBT-011). There is no inheritance: a project
  may bind more than one target, so a missing scope fails the import naming the member key. An
  empty scope list is the same unstartable chain and is refused too.
- **An empty `edges:` list is legal** (DEBT-013), so a one-task chain imports.
- A refusal is `schema_invalid`, names the offending key, and ends with the next move: correct
  the graph file and re-run the import.

A valid two-task graph (`chain.yaml`):

```yaml
version: "1.0.0"
project_slug: app
tasks:
  - key: PLAN
    title: Plan the change
    objective: Write the implementation plan end to end.
    profile_name: dev
    target_scopes:
      - repo_alias: code
        access_mode: read_only
  - key: WORK
    title: Do the work
    objective: Implement the planned change end to end.
    profile_name: dev
    requires_human_gate: true
    context_files: ["docs/spec.md"]
    target_scopes:
      - repo_alias: code
        access_mode: read_write
        write_scope_globs: ["src/**"]
        verification_commands: ["npm test"]
edges:
  - source_key: PLAN
    target_key: WORK
    edge_type: depends_on
```

```bash
bin/nova project import-dag chain.yaml --project app   # prints the chain-run id
bin/nova task run PLAN                                 # enqueue the root
bin/nova chain status <chain-run-id>                   # state + per-member readiness
```

`profile_name` resolves workspace-local first, then global — the same rule as
[profiles](profiles.md).

## Gates

`requires_human_gate: true` stops the run in `awaiting_gate`. The gate is an operator act:

```bash
bin/nova task gate-approve WORK --by me --note "reviewed"
bin/nova task gate-reject WORK "tests do not cover the cache path"
```

Approval completes the gated run; rejection feeds the feedback back through the review path. A
gate is never approved from the tier-D browser: Pi Web is read-only for NovaFlow.

## Verify

`nova chain verify <chain-run-id>` prints each run's configured verification commands next to the
ones that actually executed (DEBT-006). When a configured command was never executed, the verb
exits **3** — an unverified chain is an engine-state rejection, not a success with a footnote.

## Clean

Worktrees persist on settle by design: the engine records `workspace_diff.patch` and
`git_commits_json` per run, and the operator performs the merge. `nova chain clean
<chain-run-id>` is the confirmation to remove them.

- It refuses a chain that is not terminal, naming the state; wait for `completed`/`failed`/
  `aborted`, or abort the chain first.
- It refuses a run whose worktree has uncommitted changes (or cannot be assessed), naming the
  run; `--force` removes it anyway.
- It removes the worktrees and prunes; it never deletes a run row or an artifact.
  `task_runs.worktree_root` is history.

## Worktrees and cleanup

Per-run isolation is the default for a `git_repo` target with `access_mode: read_write`:

```text
<workspace_root>/.novaflow/worktrees/<run_id>/<target_alias>/
```

created by `git worktree add -b novaflow/run-<run_id>`. A read-only git target and a plain
`directory` target run in place, and their `worktree_root` is `NULL`. The run's
`worktree_root` is the parent of one subdirectory per target, so one column describes a run with
one target or several. Concurrency is real: `concurrency.workspace` defaults to **2** and
`concurrency.global` to **4**, and `nova_daemon_status` reports the `inflight` count with each
running run's `worktree_root`.

**A task without a chain has no `nova chain clean` verb.** Its worktrees still persist on
settle. Clean them by hand: `git -C <repo> worktree list` to find the path, `git -C <repo>
worktree remove <path>` to remove it, then `git -C <repo> worktree prune`. The
`novaflow/run-<run_id>` branch is not deleted by this or by `chain clean`; remove it with `git
branch -D` when its commits are merged.
