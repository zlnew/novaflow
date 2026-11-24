# Chains — several tasks, one file

A chain is a set of tasks wired together in one graph and imported in one transaction. Members run
as their dependencies complete; a gate stops the chain for a human; a rejection routes the feedback
back to the task that should fix it. Import is all-or-nothing: the chain row, every member in
`draft`, every edge and every scope land together, or nothing does.

Importing a chain does **not** start it. You enqueue the root members yourself
(`nova task run <key>`), and the engine propagates readiness from each completion.

## The file

`nova project import-dag <file> --project <slug>` takes JSON or YAML. Four top-level keys, all
required:

| key | what it is |
| --- | --- |
| `version` | the format version, `1.0.0` |
| `project_slug` | the project the members belong to |
| `tasks` | at least one member |
| `edges` | the wires; an empty list is legal, so a one-task chain imports |

Every member needs `key`, `title`, `objective`, `profile_name` and `target_scopes`. Scopes are
never inherited: a project can bind several targets, so each member states where it may work.

| member key | what it is |
| --- | --- |
| `key` | uppercase letters, digits, `_` and `-`; how you refer to the member |
| `title`, `objective` | what the task is called, and the written brief the agent receives |
| `profile_name` | the profile to run as; resolved in the task's workspace first, then globally ([profiles](profiles.md)) |
| `target_scopes` | at least one `{repo_alias, access_mode}`, plus optional `write_scope_globs`, `protected_test_globs`, `verification_commands` |
| `requires_human_gate` | `true` to stop the run and wait for a person |
| `context_files` | files attached to the objective: `docs/...` resolves through the docs index, any other value is workspace-relative (same rule as `nova task create --context`) |
| `priority` | free ordering hint among ready members |

| edge key | what it is |
| --- | --- |
| `source_key`, `target_key` | the two members |
| `edge_type` | `depends_on` (the target runs after the source completes), `on_changes_requested` (where a rejection goes), `on_failure` (what to run after a confirmed failure) |

`depends_on` edges must form no cycle. `on_changes_requested` and `on_failure` edges are allowed to
loop on purpose — that loop is the review path.

## A worked example

`chain.yaml`, a plan → work → review chain:

```yaml
version: "1.0.0"
project_slug: shop
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
    context_files: ["docs/spec.md"]   # files under <workspace>/docs/
    target_scopes:
      - repo_alias: code
        access_mode: read_write
        write_scope_globs: ["src/**"]
        verification_commands: ["npm test"]
  - key: FIX
    title: Apply review feedback
    objective: Address the reviewer's feedback on the change.
    profile_name: dev
    target_scopes:
      - repo_alias: code
        access_mode: read_write
        write_scope_globs: ["src/**"]
        verification_commands: ["npm test"]
edges:
  - source_key: PLAN
    target_key: WORK
    edge_type: depends_on
  - source_key: WORK
    target_key: FIX
    edge_type: on_changes_requested
```

```bash
nova project import-dag chain.yaml --project shop   # prints the chain-run id
nova task run PLAN                                  # start the root
nova chain status <chain-run-id> --watch            # per-member readiness, one line per change
nova task gate-approve WORK --by me --note "reviewed"      # when the gate stops
# or: nova task gate-reject WORK "tests do not cover the cache path"
nova chain verify <chain-run-id>                    # configured vs executed verification
nova chain clean <chain-run-id>                     # after the chain settles
```

## Gates

`requires_human_gate: true` ends the run in `awaiting_gate` and the extension wakes your session.
The gate is an operator act, and it is never decided from the browser.

| call | what happens next |
| --- | --- |
| `nova task gate-approve <id> [--by <name>] [--note <text>]` | the task moves to validation: its configured verification commands run, and the engine decides completion |
| `nova task gate-reject <id> "<feedback>"` | the task moves to `changes_requested`, counts one retry, and the feedback travels to the member named by an `on_changes_requested` edge — or the task re-enters the gate when the retry budget is spent |

An approval records who approved and the note. A rejection needs non-empty feedback; the command
refuses an empty one.

## Verification

`nova chain verify <chain-run-id>` prints, per member, every configured verification command next
to the one that actually ran, with its exit code. A configured command that never executed makes
the verb exit **3** — an unverified chain is a rejection, not a success with a footnote.

Verification is the engine's verdict, not the agent's claim. The commands run after the agent
settles, protected test files are compared against a snapshot taken before the run, and a test file
the agent edited counts as a violation even when the suite passes.

## Worktrees, and cleaning them up

A target with `target_type` `git_repo` and `access_mode` `read_write` gets a fresh worktree per run:

```text
<workspace_root>/.novaflow/worktrees/<run_id>/<target_alias>/
```

The branch is `novaflow/run-<run_id>`, created from the target's recorded base branch when that
branch resolves, otherwise from `HEAD` — and the run report says which. A read-only git target and a
plain `directory` target run in place and record no worktree.

Worktrees **persist** after a run settles: the engine writes `workspace_diff.patch` and the commit
list, and you decide what to merge. NovaFlow never merges.

| rule | what happens |
| --- | --- |
| concurrency | `concurrency.workspace` defaults to **2** per workspace and `concurrency.global` to **4** on the machine; `nova daemon status` reports `inflight` and each running run's worktree |
| `nova chain clean <chain-run-id>` | removes the chain's worktrees and prunes the repos |
| a chain that is still `active` | refused, naming the state; wait for `completed`/`failed`/`aborted`, or abort the chain first |
| a worktree with uncommitted changes, or one whose state cannot be read | refused, naming the run; `--force` removes it anyway |
| run rows and artifacts | never deleted. The recorded worktree path stays as history |

A task that is not in a chain has no `clean` verb — its worktree persists too. Remove it by hand:

```bash
git -C <repo> worktree list
git -C <repo> worktree remove <path>
git -C <repo> worktree prune
git -C <repo> branch -D novaflow/run-<run_id>   # once its commits are merged
```

## Common problems

| symptom | cause | the command that fixes it |
| --- | --- | --- |
| `schema_invalid` naming a member | that member has no `target_scopes`, or an empty list | add at least one `{repo_alias, access_mode}` to the member, then re-run the import |
| `schema_invalid` naming an edge | a cycle in `depends_on`, a duplicate key, or an unknown edge type | break the cycle, or route the loop through `on_changes_requested` |
| `no profile named "<name>"` at import | the member's `profile_name` matches nothing in the workspace or global scope | `nova profile list`, then fix the name in the file |
| a chain is imported but nothing runs | roots are not auto-enqueued | `nova task run <root-key>` |
| `nova chain clean` refuses, naming the state | the chain is still `active` | `nova chain status <chain-run-id>`, then wait or `nova chain abort <chain-run-id>` |
| `nova chain clean` refuses, naming a run | that worktree holds uncommitted changes | commit or discard them, or re-run with `--force` |
| `nova chain verify` exits 3 | a configured verification command never executed | read which member and command it names, fix the failure, re-run the member |
