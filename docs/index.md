# NovaFlow docs

One page per concept. The [README](../README.md) is the tour; these are the operator's pages.

| page | what it answers |
| --- | --- |
| [operations](operations.md) | how to run work without waiting: enqueue, end the turn, get woken; never sleep-poll |
| [chains](chains.md) | DAG import, gates, `nova chain verify`, `nova chain clean`, and the worktree lifecycle |
| [profiles](profiles.md) | create/update/delete a profile and the scope resolution rule |
| [the live view](live-view.md) | `nova status --watch` (tier C) and the private Pi Web mirror (tier D) |
| [`nova` CLI reference](cli.md) | every verb: purpose, blocking behaviour, `--json`, exit codes, help and fix hints |
| [install](install.md) | acquisition routes, the preflight checks, the config file written once |
| [release notes template](release-notes-template.md) | the shape of an entry before a tag |

The pinned specification is the contract; the golden tests fail if the code drifts from it.
These pages describe what ships, not what is planned.
