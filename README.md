# Ranni

The work frontier agents leave behind. Ranni keeps the living state of in-flight work as
ordinary Relic records, so any agent, harness or human can
pick it up. It never runs agents, keeps no queue and stores no status: `ranni status`
derives the board from Relic, Git and the Git host every time you ask.

Spec: [`.relic/specs/001-work-frontier/index.html`](.relic/specs/001-work-frontier/index.html)

## Requirements

- Relic 2.4.0 or later, with structured search (`relic search --kind <kind> --json`,
  `formatVersion` 1). Ranni consumes Relic's read model and never parses the corpus. In a
  federation, Relic 2.4.0's `projects` list gives each member's root, so Git and `gh` evidence is
  read in each member's own repository (members sharing one repository share one read). Older
  Relic still works, with root-repository evidence only and a note.
- `git`. `gh` is optional: without it (or without auth or network) `status` shows Git evidence
  only and says what is missing.
- Bun.

## Install

```bash
bun add -g ranni-cli
```

The 0.1 MCP orchestrator was published as `ranni-mcp`; Ranni 2 is published as `ranni-cli`, and the command is `ranni`.

## `ranni init`

```bash
relic init && relic install   # once, if the project has no Relic yet
ranni init [--kind <kind>]
```

Idempotent. It requires an existing `relic.yaml` (it never creates one). It declares the work
kind in `topology.records` if it is not declared yet (comments and formatting are kept), names
it in the shared document `<shared>/ranni.md` (`id: SHARED-ranni`, `ranni-kind: <kind>`), and
installs the Ranni skill next to every installed Relic skill (`<dot-dir>/skills/ranni/`).

The kind is `--kind`, else the one `ranni.md` already names, else `work` when `relic.yaml`
already declares it (projects from Ranni 0.2), else `ticket`. The kind sets the identities,
branches and trailer: `ticket` gives `TICKET-042`, `ticket/TICKET-042-push` and
`Ticket: TICKET-042`. `ranni.md` is an ordinary Relic document, so the name lives in the
corpus without a Ranni configuration file or a Ranni key in `relic.yaml`. Changing the kind
later leaves the previous kind's records where they are. Running init again only refreshes the
skill and prints what changed.

## `ranni status`

```bash
ranni status [id...] [--json] [--kind <kind>]
```

Without `--kind`, the kind is the one `ranni.md` names (found with
`relic search --kind shared --meta ranni-kind --json`), else `work`.

A read-only board grouped by the first label that applies, with the age of the last activity
and links to related work items (`-> TICKET-041 in review`):

1. Waiting on you: the `waiting` frontmatter key is set.
2. Ready to close: a pull request mentioning it is merged (or, without `gh`, a branch fully merged).
3. In review: an open pull request, with requested changes, unresolved threads, failing checks or approval.
4. In flight: branches or commits, no pull request yet.
5. Not started: no traces.

An open pull request in a GitHub stack shows its place in it (`stack #24 3 of 6`, and the
branch the stack targets when it is not the default branch): the ones below land first.

There is no staleness threshold and no computed blocking; the reader decides.

Agents usually work in their own Git worktrees, so status also reads every worktree of the
repository whose branch names an identity of the kind. The copy of a work item in the worktree
whose branch names it (`ticket/TICKET-042-push` for `TICKET-042`) replaces the checkout's, and
one that exists only there is added. In `--json`, such an item carries
`source: { root, branch }`: its `path` is relative to that worktree's project folder.

## The executor contract

Any agent or human leaves traces the board can read. With the `ticket` kind:

- the branch name contains the identity, for example `ticket/TICKET-042-push`;
- commits carry a trailer named after the kind, `Ticket: TICKET-042`;
- the pull request title or head branch mentions the identity, or its body carries `Ticket: TICKET-042`;
- the current frontier section of the work item is rewritten at natural stopping points.

## Development

```bash
bun install
bun test
bun run typecheck
bun run ranni -- status
```

## Contributing, security and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md). Ranni is released under the [MIT License](LICENSE).
