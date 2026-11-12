# Security Policy

Ranni reads a Relic corpus through `relic search`, reads Git and the Git host through `git`
and `gh`, and writes only during `ranni init`: the work kind in `relic.yaml`, the work root
directory, and the Ranni skill next to each installed Relic skill. `ranni status` writes
nothing. Treat work items, branch names, commit messages and pull request text as untrusted
input.

Security issues include:

- a subprocess argument or GraphQL query built from untrusted text that changes what runs;
- `ranni init` writing, replacing or deleting files outside the project root, including
  through symbolic links;
- the installed skill differing from the published template;
- a compromised distribution artifact or dependency.

## Supported Versions

Only the latest published version of `ranni-cli` receives security fixes. `ranni-mcp`
(0.1.x) is deprecated and unsupported.

| Version | Supported |
|---|---|
| latest `ranni-cli` | ✅ |
| older, and `ranni-mcp` | ❌ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's built-in mechanism:
**[Report a vulnerability](https://github.com/filfp/ranni/security/advisories/new)**

Include:

- the affected Ranni version, and the Relic, Git and `gh` versions;
- a description of the vulnerability and its potential impact;
- minimal steps or a repository fixture that reproduces it;
- any suggested fix or containment if you have one.

You will receive a response within 7 days. If the issue is confirmed, a fix will be
released as soon as possible and you will be credited in the release notes unless you
prefer to remain anonymous.

Do not include secrets, private repository content, or production credentials in a
report. Use a synthetic repository whenever possible.

## Supply chain

Dependencies are pinned exactly, nothing published in the last 7 days installs, and CI
blocks unpinned or script-trusting dependencies and any unallowlisted `bun audit`
advisory. Releases are published from CI through npm trusted publishing with provenance;
no long-lived npm token exists. See [CONTRIBUTING.md](CONTRIBUTING.md).
