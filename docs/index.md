# NovaFlow documentation

Seven pages, one question each. [The README](../README.md) is the tour; these are the pages you
keep open while you work.

## Read this first

| order | page | the question it answers |
| --- | --- | --- |
| 1 | [Quick start](install.md) | How do I install it, and what does the installer check before it writes anything? |
| 2 | [Operations](operations.md) | How do I hand work to the daemon and get on with my day? |
| 3 | [Chains](chains.md) | How do I wire several tasks together, and what happens when one needs review? |
| 4 | [Profiles](profiles.md) | How do I describe the agent that runs a task — model, prompt, tools, limits? |
| 5 | [Live view](live-view.md) | How do I watch work from a terminal or a browser without exposing my machine? |
| 6 | [CLI reference](cli.md) | What does this verb do, does it wait, and what does its exit code mean? |
| 7 | [Maintaining](maintaining.md) | How is a release cut, verified and rolled back? |

Pages 1–4 are the whole daily loop. Page 6 is a lookup table: you will not read it top to bottom.

## What each page is for

| page | what it covers |
| --- | --- |
| [Quick start](install.md) | the requirements, the two install routes, the config file written once, the native SQLite binding, and what the published package contains |
| [Operations](operations.md) | enqueue, step away, act when woken; what is allowed to block; budgets, spend, retention and backups; the refusals you will meet first |
| [Chains](chains.md) | the chain file format, gates, review edges, configured-versus-executed verification, and the worktree lifecycle |
| [Profiles](profiles.md) | every profile field, creating and updating one, deleting an unused one, and how a name resolves |
| [Live view](live-view.md) | the terminal screen, the browser mirror over copied transcripts, and tailnet access without a widened bind |
| [CLI reference](cli.md) | all 54 verbs in one table, the exit-code table, and the next move each refusal names |
| [Maintaining](maintaining.md) | cutting a release, what each step refuses, verifying a publication, and rolling forward |

## How to read a page

Each page leads with the answer, then the detail. Tables carry the parallel facts. One worked
example per page is meant to be pasted and run — it uses real flags, and every command in it
exists in `nova <noun> <verb> --help`. A "Common problems" section lists the refusals a reader
actually hits, with the command that fixes each one.

If a page and the program disagree, the program is right: run `nova <noun> <verb> --help`, and
`nova status --json` for the state of the machine.
