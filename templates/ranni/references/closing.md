# Closing

Read this reference only when a work item's work has landed, or when the developer asks
to close one.

## Contents

- Confirm It Landed — evidence before proposing
- Harvest — what outlives the work item
- Remove It — closing without a closed status

## Confirm It Landed

Check the evidence, not the frontier's claims:

- pull requests tied to the identity (title, branch, or a `Work:` line) are merged;
- branches carrying it are merged or gone;
- sub-items are closed, or are explicitly moving on without their parent;
- the intent is met.

If something is missing, update the frontier and stop.

## Harvest

Before closing, list the durable knowledge that the work produced: decisions, business
rules, changed contracts, things a spec now gets wrong. Propose each one as a Relic
update and let the Relic skill handle it, including the developer's approval. Work
details and discarded paths are not knowledge; Git keeps them.

## Remove It

Ask the developer to close, together with the harvest proposal. After approval:

1. delete the work item file; there is no closed status, archive, or tombstone;
2. find relative links that pointed at it and repair them, usually by rewording them as
   plain text or linking to the knowledge it was harvested into;
3. run `relic verify` and fix any broken links you introduced.
