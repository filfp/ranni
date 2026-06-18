# Plan: Phase 2 — Installable Package

## Goal

Transform ranni from a local tool into an installable package. A consuming project runs two commands:

```bash
bun add ranni
bun node_modules/ranni/src/init.ts
```

That's it. The skill, the MCP server config, and the starter `.agents.yaml` are all in place.

---

## Install approach: local dependency

The package is added as a project dependency, not installed globally. The tradeoff:

| | Local dependency | Global |
|---|---|---|
| `.mcp.json` command | `bun run node_modules/ranni/src/index.ts` | `ranni` |
| Version | locked per project | shared across all projects |
| PATH reliability | always works | fragile in macOS app launches |
| Dev iteration | `bun link` | same |

Global is cleaner in `.mcp.json` but fragile when Claude Code spawns the MCP server (app launch environments don't always inherit the full shell PATH). Start with local dependency; switching to global later is a one-line change to the generated template.

---

## Entry points

No CLI router file. Two separate entry points, each with a single responsibility:

- `src/index.ts` — already exists; the MCP server
- `src/init.ts` — new; the scaffold script, run once by the consuming project

`package.json`:
```json
{
  "scripts": {
    "start": "bun run src/index.ts",
    "init": "bun run src/init.ts"
  },
  "bin": {
    "ranni": "./src/index.ts"
  }
}
```

The `scripts` block serves as documentation and allows running locally during development (`bun run init`, `bun run start`). The `bin` points directly to the MCP server — no argument parsing needed.

---

## Template structure

Templates live at the repo root, mirroring their destination paths:

```
templates/
  ranni/          → .claude/skills/ranni/   (full folder copy)
    SKILL.md
  .agents.yaml           → .agents.yaml
```

Adding new scaffold files in future is just a commit to `templates/`. No CLI changes needed.

The skill is installed as a **folder** (`.claude/skills/ranni/`), not a single file — consistent with how Claude Code skills are structured.

---

## What `init` does

### 1. Copy skill folder
Recursively copy `templates/ranni/` → `.claude/skills/ranni/`.
Always overwrites — the folder is managed by the package.

### 2. Copy `.agents.yaml`
Copy `templates/.agents.yaml` → `.agents.yaml`.
**Skip if file already exists** — never overwrite a configured file. Warn the user.

### 3. Merge `.mcp.json`
`.mcp.json` lives at the project root and likely has existing entries. Never overwrite it.

Logic:
- If file doesn't exist → create with just the ranni entry
- If file exists → parse, add `mcpServers.ranni`, write back preserving all other entries
- If `mcpServers.ranni` already exists → skip and warn

Generated entry:
```json
{
  "mcpServers": {
    "ranni": {
      "command": "bun",
      "args": ["run", "node_modules/ranni/src/index.ts"]
    }
  }
}
```

---

## File additions

```
src/
  init.ts              ← new: scaffold logic
templates/
  ranni/
    SKILL.md           ← new: the manager skill content
  .agents.yaml         ← new: starter config template
```

No changes to any existing `src/` files (queue, worker, config, conflict, runs, index).

---

## Build order

1. `templates/ranni/SKILL.md` — skill content (from working setup)
2. `templates/.agents.yaml` — starter config with placeholder dirs
3. `src/init.ts` — scaffold logic (copy templates, merge `.mcp.json`)
4. `package.json` — add `scripts.start`, `scripts.init`, `bin.ranni`
5. Update `CLAUDE.md` — document the new install + init workflow
