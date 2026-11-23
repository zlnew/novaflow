# Profiles — the named bundle an agent runs as

A profile is a named bundle: model identity, system prompt, tool allowlist and limits. It is
free-form — role labels are optional conventions with no engine behaviour, and there is no role
taxonomy. The model identity is validated against the live Pi model catalog; Pi is the identity
truth.

## Create, update, delete

A profile is created from a JSON file:

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
bin/nova profile create --file dev.json
bin/nova profile update dev --file dev.json
bin/nova profile delete dev
bin/nova profile list
bin/nova profile validate dev
```

- **create** validates the document, inserts the row and — when the profile is
  workspace-scoped — writes the canonical copy at
  `<workspace_root>/.novaflow/profiles/<name>.json`. A global profile has no canonical file in
  v1.
- **update** replaces the stored document and the canonical file together, in one transaction: a
  renamed profile file, an invalid document, or a model the catalog cannot resolve is refused
  and nothing moves.
- **delete** is FK-safe. It counts the tasks that pin the profile and refuses while any exist,
  naming the count; the refusal now ends with the next move (` — fix: …`). v1 has no task
  reassign or delete, so pin new tasks to a different profile if you want the old one gone.
  A deletion also removes the canonical file, and reports a removal failure rather than
  swallowing it.
- **validate** is the structural check only. The live catalog probe (`profile_unresolved` on a
  model that cannot be resolved) happens at enqueue.

## Scope resolution

A profile lives either in one workspace or in the global scope. Scoping is explicit: `--workspace
<slug|id>` (or the CLI's active-workspace marker) creates a workspace-scoped profile; with
neither, the profile is global.

Resolution is **workspace-scoped first, then global**, at every call site (the CLI lifecycle
verbs, enqueue, and chain import):

- With a workspace context, a workspace-local row of that name wins over a global row. A stale
  global row can never shadow the workspace's own profile.
- With no workspace context, only a global row is addressable.
- A name that matches more than one global row is ambiguous: the engine refuses to pick
  (`profile_unresolved`) rather than resolving by rowid order.

`nova profile list` prints what is visible in the current scope; a global profile and a
workspace profile may share a name, and the workspace one is what a task in that workspace runs.
