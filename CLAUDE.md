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

## Supply chain

`bunfig.toml` pins exact versions and refuses releases younger than 7 days. Add a dependency with
`bun add --exact <pkg>@<x.y.z>`; `.claude/hooks/guard-install.sh` refuses anything else. CI runs
the supply-chain gate, the Bun setup and the release-tag workflow shared from `filfp/relic`,
pinned to a commit: bump that SHA in `.github/workflows/` to take a Relic change.
Release: `bun run release <x.y.z>` opens `release/v<x.y.z>`; merging it tags and publishes through
npm trusted publishing (`publish-npm.yml`, no token).

## Rules

- Relic is consumed through `relic search --kind <kind> --json` only, including each work item's
  metadata (`waiting`). Ranni never opens corpus files.
- State is derived at read time. No stored status, queue, lock, cache, config file or env config.
- Never spawn, schedule or configure agents; never read harness-specific session state.
- No staleness thresholds and no computed blocking.
- `ranni init` never creates `relic.yaml` and never touches it beyond declaring the work kind.
- The npm package is `ranni-cli` (`ranni` was refused by npm as too similar to another name; 0.1.x shipped the old MCP orchestrator as `ranni-mcp`). Version bumps are the developer's call.
