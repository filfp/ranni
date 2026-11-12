# ranni

Ranni 2: a small CLI (`ranni init`, `ranni status`) for the work frontier of agent-driven work. The
contract is [`.relic/specs/001-work-frontier/index.html`](.relic/specs/001-work-frontier/index.html).
Read it before changing behavior, especially "State is derived, never stored" and "Regression alarms".

## Stack

Bun, TypeScript (strict, `moduleResolution: bundler`), `yaml`. Tests with `bun test`.

## Commands

```bash
bun test            # unit and integration tests
bun run typecheck   # tsc --noEmit
bun run ranni -- status   # run from source
bun run release <x.y.z>   # scripts/publish.ts
relic verify        # this repo is a Relic project
```

## Layout

- `src/cli.ts`, `src/index.ts`: argument parsing and entry point
- `src/init.ts`: `ranni init` (relic.yaml edit through the `yaml` Document API, skill sync)
- `src/status.ts`: orchestration of one `status` read; `src/render.ts`: human board
- `src/derive.ts`: pure label derivation; keep it free of I/O
- `src/relic.ts`, `src/git.ts`, `src/host.ts`: the three evidence sources
- `src/runner.ts`: the only place subprocesses start; tests inject a fake (`test/fakes.ts`)
- `templates/ranni/`: the skill this CLI installs. It is the product's text; do not edit it casually.

## Rules

- Relic is consumed through `relic search --kind <kind> --json` only. The one file Ranni opens is a
  work item's frontmatter, to read the `waiting` key when the search result carries no metadata.
- State is derived at read time. No stored status, queue, lock, cache, config file or env config.
- Never spawn, schedule or configure agents; never read harness-specific session state.
- No staleness thresholds and no computed blocking.
- `ranni init` never creates `relic.yaml` and never touches it beyond declaring the work kind.
- The package is still named `ranni-mcp`; renaming and version bumps are the developer's call.
