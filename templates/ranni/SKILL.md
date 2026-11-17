---
name: ranni
description: Use Ranni's work frontier to pick up, continue, hand off, and close in-flight work that outlives one session or one agent. Use when the repository has a shared ranni.md or its relic.yaml declares a work record kind, the developer names a work item such as TICKET-042 or WORK-042, the current branch name contains a work identity, or the developer asks to track, split, hand off, or check ongoing work.
---

# Ranni

Ranni keeps the living state of in-flight work as ordinary Relic records, so any agent,
harness, or human can continue it. It never runs agents and has no runtime. You execute
with whatever this harness offers, and you leave traces the next executor can follow.

Ranni requires Relic. Use the Relic skill for knowledge work: roasts, specifications,
records, and persistence. This skill covers work items only.

## Find the Work

1. Find the work kind. The shared document `ranni.md` (in the `shared` root of the
   `relic.yaml` that Relic selects) names it in its `ranni-kind` key, for example
   `ticket`. Without that document the kind is `work`. The developer may name another
   declared kind. If the kind is not declared in `relic.yaml`, say so and continue
   without Ranni.
2. Locate the item. Use the one the developer names, then the identity in the current
   branch name, then a search by subject, using native tools or
   `relic search --kind <kind>`.
3. Read its intent, its current frontier, and the links that matter before acting.

A small task needs no work item. Using Ranni creates no obligation.

## Leave Traces

Every executor follows the same contract, including you. The names follow the kind;
with `ticket`:

- the branch name contains the identity, for example `ticket/TICKET-042-push`;
- every commit carries the trailer `Ticket: TICKET-042` (the kind, capitalized);
- the pull request title mentions the identity, or its body carries `Ticket: TICKET-042`.
  Mentioning another item in the body ("depends on TICKET-041") does not tie the PR to it.

To parallelize, use what this harness offers: subagents, sessions, worktrees. Hand each
executor the identity and these rules, and ask it to rewrite the frontier when it stops.
Never spawn, schedule, or poll on Ranni's behalf.

## Work in Worktrees

`ranni status` reads every worktree whose branch names an identity of the kind, and the
copy of the work item there wins over the main checkout's. So when you work in a
worktree:

- keep the work item there: rewrite its frontier and set `waiting` in the worktree's
  copy, not in the main checkout;
- give the branch the identity before you edit the work item, or status will not see
  your copy;
- use one worktree per work item; when two branches name the same item, status shows
  only the first;
- a work item you create there is visible before it merges only if the branch names it.
  Escalate on the item the branch names, and mention the new item in its frontier.

The developer may answer `waiting` straight in the worktree's file, as an uncommitted
change. Read the work item again before you continue, and never discard or overwrite
uncommitted changes to it.

## Keep the Frontier Current

Rewrite the current frontier, never append to it. Rewrite it when:

- the plan changes;
- you learn something the next agent needs;
- you are blocked;
- you are about to end a turn that changed something.

Say where the work stopped, what was learned, what changed, and the next step. Write it
for an agent reading it cold. Git keeps the history.

You may, without asking:

- rewrite the frontier;
- create sub-items that refine the parent's intent;
- set or clear `waiting`.

Ask the developer before you change or cut intent, drop scope, or close a work item.

## Escalate Without Blocking

When a decision belongs to the developer:

1. set the frontmatter key `waiting` to a one-line question;
2. explain the options in the frontier and recommend one;
3. keep working on unblocked parts, and stop mutating the blocked boundary.

If the developer is present, also ask in the conversation. Remove `waiting` once the
decision is made.

## Route References Deliberately

Read a reference only when its trigger fires.

**Creating a work item or a sub-item** → [work-items.md](references/work-items.md)
**The work landed, or the developer asks to close it** → [closing.md](references/closing.md)

## Boundaries

- Do not write a status field, queue, lock, or counter. State comes from Git and the Git
  host at read time.
- Do not treat harness-specific session state as evidence.
- Do not dispatch follow-up work automatically or require a polling loop.
- Do not add a Ranni configuration file or reserve topology inside Relic. The shared
  `ranni.md` is an ordinary Relic document; `ranni init` writes it.
