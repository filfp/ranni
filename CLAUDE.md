# packages/orchestrator

Provider-agnostic multi-agent orchestration MCP server. Exposes four MCP tools that let a manager agent (Claude Code, Codex, Copilot) dispatch autonomous worker subprocesses, track their progress via a file-backed task queue, and receive results when workers finish, need help, or error.

## Stack

- **Runtime**: Bun
- **Language**: TypeScript (`moduleResolution: bundler`, strict)
- **MCP**: `@modelcontextprotocol/sdk` stdio transport
- **Config validation**: `zod`
- **Config parsing**: `yaml`

## Commands

```bash
just orchestrate dev           # start the MCP server (development)
just orchestrate build         # compile to a single binary at dist/orchestrator
just orchestrate typecheck     # TypeScript type check only
```

## Configuration

Create `.agents.yaml` at the repo root:

```yaml
worker:
  command: claude
  args: [--print, --dangerously-skip-permissions]

max_workers: 3
persist_runs: false   # set true to archive worker outputs

dirs:
  backend: ./backend
  mobile: ./apps/mobile
  web: ./apps/web
  root: .

# Optional — injected into every MCP tool response as a reminder
manager_context: |
  Always call get_pending_results() before dispatching new tasks.
```

## Runtime files

- `.agent-queue.json` — task queue state at repo root (gitignored)
- `tools/orchestrator/runs/<timestamp>/` — worker output archives when `persist_runs: true` (gitignored)

## MCP tools

| Tool | Description |
|------|-------------|
| `dispatch_task` | Push tasks onto the queue |
| `list_active_workers` | Snapshot of running + queued tasks |
| `get_pending_results` | Read completed worker results (call before dispatching) |
| `cancel_task` | Cancel a pending task by ID |

## Worker output protocol

Every worker must end its output with:

```
<orchestrator_result>
{"status":"done","summary":"what was done","files_changed":["path/to/file.ts"],"message":"optional"}
</orchestrator_result>
```

Valid statuses: `done`, `needs_help`, `error`.

## Wiring to Claude Code

Add to `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "bun",
      "args": ["run", "<absolute-path-to>/packages/orchestrator/src/index.ts"]
    }
  }
}
```
