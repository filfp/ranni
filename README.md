# Ranni

The work frontier agents leave behind. Ranni keeps the living state of in-flight work as
ordinary Relic records, so any agent, harness or human can
pick it up. It never runs agents, keeps no queue and stores no status: `ranni status`
derives the board from Relic, Git and the Git host every time you ask.

Spec: [`.relic/specs/001-work-frontier/index.html`](.relic/specs/001-work-frontier/index.html)

## Requirements

- Relic 2.3.0 or later, with structured search (`relic search --kind <kind> --json`,
  `formatVersion` 1). Ranni consumes Relic's read model and never parses the corpus.
- `git`. `gh` is optional: without it (or without auth or network) `status` shows Git evidence
  only and says what is missing.
- Bun.

## Install

```bash
bun add -g ranni
```

The 0.1 MCP orchestrator was published as `ranni-mcp`; Ranni 2 is published as `ranni`.

## `ranni init`

```bash
relic init && relic install   # once, if the project has no Relic yet
ranni init
```

Idempotent. It requires an existing `relic.yaml` (it never creates one), adds a `work` record
kind to `topology.records` only if none is declared (comments and formatting are kept), and
installs the Ranni skill next to every installed Relic skill (`<dot-dir>/skills/ranni/`).
Running it again only refreshes the skill and prints what changed.

## `ranni status`

```bash
ranni status [id...] [--json] [--kind <kind>]
```

A read-only board grouped by the first label that applies, with the age of the last activity
and links to related work items (`-> WORK-041 in review`):

1. Waiting on you: the `waiting` frontmatter key is set.
2. Ready to close: a pull request mentioning it is merged (or, without `gh`, a branch fully merged).
3. In review: an open pull request, with requested changes, unresolved threads, failing checks or approval.
4. In flight: branches or commits, no pull request yet.
5. Not started: no traces.

There is no staleness threshold and no computed blocking; the reader decides.

## The executor contract

Any agent or human leaves traces the board can read:

- the branch name contains the identity, for example `work/WORK-042-push`;
- commits carry a trailer, `Work: WORK-042`;
- the pull request title or head branch mentions the identity, or its body carries `Work: WORK-042`;
- the current frontier section of the work item is rewritten at natural stopping points.

## Development

```bash
bun install
bun test
bun run typecheck
bun run ranni -- status
```
