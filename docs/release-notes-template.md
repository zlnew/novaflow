# Release notes template

Copy this shape into the release PR body (or the GitHub release) and fill it from the
`CHANGELOG.md` section for the tag. Every number needs its denominator and its source; if a line
cannot be checked against a file, a test or a command, delete it.

```markdown
# NovaFlow <version>

<one sentence: what this release changes for the operator>

## What you can do now

- <a user-visible capability, with the verb that reaches it>
- <another one>

## Numbers

- <measured fact — value, denominator, and where it was measured>

## Upgrading

- <the migration or `--migrate` step, or "no store change">
- <the config change, or "none">

## Known limits

- <what this release deliberately does not do>
```
