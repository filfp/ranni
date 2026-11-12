# Contributing to Ranni

Ranni's contract is the work frontier spec,
[`.relic/specs/001-work-frontier/index.html`](.relic/specs/001-work-frontier/index.html).
Read it before changing behavior, especially "State is derived, never stored" and
"Regression alarms". [CLAUDE.md](CLAUDE.md) lists the layout and the rules that keep
Ranni small: no stored status, no orchestration, Relic consumed only through
`relic search`.

`templates/ranni/` is the skill `ranni init` installs. It is product text; change it
deliberately and keep it short.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun test ./.claude/hooks/guard-install.test.ts
relic verify
```

Pull requests run the same checks in CI, plus the supply-chain gate.

## Supply chain

`bunfig.toml` pins exact versions and refuses releases younger than 7 days. Add a
dependency with `bun add --exact <pkg>@<x.y.z>`. The Claude Code hook
`.claude/hooks/guard-install.sh` refuses npm, pnpm and yarn installs, unpinned
`bun add`, `--trust`, and release-age overrides.

CI uses the `setup-bun`, `supply-chain` and `github-packages` actions and the
`release-tag.yml` workflow shared from [Relic](https://github.com/filfp/relic), pinned
to a commit. To take a change from Relic, bump that SHA in `.github/workflows/`.

## Releasing

```bash
bun run release <x.y.z>
```

This pushes `release/v<x.y.z>` with the version bump; open a pull request from it. Merging
it tags `v<x.y.z>`, creates the GitHub release, and publishes `ranni-cli` to npm (trusted
publishing, with provenance) and `@filfp/ranni-cli` to GitHub Packages.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
