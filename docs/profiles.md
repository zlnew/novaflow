# Profiles — the agent a task runs as

A profile is a JSON file: the model, the system prompt, the tools the agent may use, and its limits.
It is stored once, referenced by name from tasks and chains, and validated before it is stored. A
model name that Pi cannot resolve is refused when you enqueue a task, not when you create the
profile — creation checks the document's shape, the model catalog is checked at enqueue.

## A worked example

`dev.json` — an agent that can read, write and run commands, for at most an hour and five dollars:

```json
{
  "name": "dev",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "thinking_level": "medium",
  "tools_allowlist": ["read", "write", "edit", "bash"],
  "system_prompt_path": "prompts/dev_system.md",
  "limits": { "max_timeout_sec": 3600, "max_cost_usd": 5 }
}
```

```bash
nova workspace switch shop                  # scope the next commands to that workspace
nova profile create --file dev.json         # stored, and copied to .novaflow/profiles/dev.json
nova profile validate dev                   # re-check the document as stored
nova profile list                           # everything visible in this scope
nova task create CHECKOUT-1 --title "Add PKCE" --objective "Implement PKCE end to end." \
  --profile dev --project shop --scope code
nova profile update dev --file dev.json     # replace the document and its canonical file together
nova profile delete dev                     # only while no task pins it
```

## Every field

| field | required | what it means |
| --- | --- | --- |
| `name` | yes | lower-case letters, digits and `-`; how tasks refer to the profile |
| `provider` | yes | the model provider, as Pi names it |
| `model` | yes | the model identifier Pi resolves |
| `thinking_level` | yes | how much reasoning budget the model gets |
| `system_prompt_path` | yes | the prompt file the agent starts from, resolved under the workspace root; a missing file fails preflight before any token is spent |
| `tools_allowlist` | yes | unique tool names the agent may call; no duplicates |
| `limits.max_timeout_sec` | yes | wall-clock ceiling for one run, in whole seconds |
| `limits.max_cost_usd` | yes | cost ceiling for one run, in dollars |
| `role` | no | a free-form label for humans; it changes no behaviour |

Names are the only taxonomy. There is no built-in set of roles: two profiles that differ only in
`role` behave identically.

## Where a profile lives

A profile is either workspace-scoped or global. The choice is explicit:

| you ran | where the profile lives |
| --- | --- |
| `nova profile create --file dev.json` with `--workspace <slug>` or an active workspace marker | in that workspace, with a canonical copy at `<workspace_root>/.novaflow/profiles/<name>.json` |
| the same command with neither | in the global scope, with no canonical file |

`nova workspace switch <slug>` sets the marker for the CLI, so the profile verbs scope themselves
without repeating `--workspace`.

Resolution is workspace first, then global, everywhere a name is read — the profile verbs, task
enqueue, and chain import:

- inside a workspace, a workspace-local profile of that name wins over a global one; a stale global
  profile can never shadow the workspace's own;
- with no workspace in context, only a global profile is addressable;
- a name matching more than one global profile is refused as ambiguous rather than resolved by row
  order.

## Changing and removing one

- **update** replaces the stored document and the canonical file in one transaction. A renamed
  profile, an invalid document, or a model Pi cannot resolve leaves both as they were.
- **update** with a file identical to what is stored is refused as `duplicate` (exit 1, "no change") and writes nothing.
- **delete** counts the tasks that pin the profile and refuses while any exist, naming the count.
  There is no reassign verb, so pin new tasks to a different profile if you want the old one gone.
  Deleting a workspace-scoped profile also removes its canonical file, and a failed removal is
  reported rather than swallowed.

## Common problems

| symptom | cause | the command that fixes it |
| --- | --- | --- |
| `profile key "name" must match …` | the name has an uppercase letter, a space or an underscore | rename it to lower-case letters, digits and `-` |
| `tools_allowlist entries must be unique` | the same tool is listed twice | remove the duplicate |
| `limits.max_timeout_sec must be an integer >= 1` | a zero, a decimal or a string in the limits block | use whole seconds (`3600`) |
| `no profile named "<name>"` when enqueuing | the task and the profile are in different scopes | `nova profile list --workspace <slug>`, then create the profile in that workspace |
| `profile "<name>" … is pinned by N task(s)` | tasks still reference it | pin the new tasks to another profile; the old one can go once nothing references it |
| `profile_unresolved` at enqueue | Pi does not know that provider/model pair | fix `provider`/`model` in the file, `nova profile update <name> --file <path>`, then re-run the task |
