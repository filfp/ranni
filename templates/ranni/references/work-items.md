# Work Items

Read this reference only when you are creating a work item or a sub-item.

## Contents

- Decide Whether It Deserves One — when a work item pays for itself
- Write It — destination, identity, and shape
- Refine Into Sub-items — splitting without asking

## Decide Whether It Deserves One

Create a work item when the work will likely outlive one session, pass between agents,
or land in separate parts. Otherwise, do the work and leave no record.

## Write It

Write it in the work kind's root, taken from `relic.yaml`. Allocate the identity the way
the Relic skill does, from the greatest current identity in that root, with no counter or
reservation. Name the file after the identity and a readable slug, for example
`WORK-042-push-notifications.md`.

```markdown
---
id: WORK-042
---

# Push notifications

## Intent

The outcome the developer wants, and why. Write it in their words; a rough intent is fine.

## Current frontier

Not started.

## Relationships

- [Notifications spec](../../specs/007-notifications/index.html)
- Depends on [WORK-041](./WORK-041-notification-api.md)
```

- Only `id` is required. `waiting` is Ranni's one convention; any other key is the
  project's.
- Express relationships as ordinary relative links in the body, never as frontmatter
  values, so they become edges in Relic's graph.
- Ask only the questions that block a first step. Do not specify the work completely
  upfront; the frontier refines it as it moves.

## Refine Into Sub-items

When the work splits into parts that can land, or be worked, separately, create one
sub-item per part, without asking:

- each sub-item's intent narrows its parent's intent and never changes it;
- link the sub-item to its parent, and list it under the parent's relationships;
- the parent's frontier says how the parts fit together.

A split that drops or changes scope is a change of intent. Set `waiting` instead.
