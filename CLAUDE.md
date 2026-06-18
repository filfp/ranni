# ranni

Provider-agnostic multi-agent orchestration MCP server. Exposes four MCP tools that let a manager agent (Claude Code, Codex, Copilot) dispatch autonomous worker subprocesses, track their progress via a file-backed task queue, and receive results when workers finish, need help, or error.

## Stack

- **Runtime**: Bun
- **Language**: TypeScript (`moduleResolution: bundler`, strict)
- **MCP**: `@modelcontextprotocol/sdk` stdio transport
- **Config validation**: `zod`
- **Config parsing**: `yaml`

## Commands

```bash
bun run start      # start the MCP server (development)
bun run init       # scaffold templates into the current directory (dev/testing)
bun run build      # compile to a single binary at dist/ranni
bun run typecheck  # TypeScript type check only
```

## Installing in a project

```bash
bun add ranni
bun node_modules/ranni/src/init.ts
```

`init` writes three things into the consuming project:
- `.claude/skills/ranni/` — the manager skill (always overwrites)
- `.agents.yaml` — starter config (skipped if already exists)
- `.mcp.json` — merges in the ranni entry, preserving all existing entries

## Configuration

Create `.agents.yaml` at the repo root (config is discovered by walking up from `cwd` to the git root):

```yaml
worker:
  command: claude
  args: [--print, --dangerously-skip-permissions]

max_workers: 3
persist_runs: false   # set true to archive full worker stdout under tools/ranni/runs/

dirs:
  backend: ./backend
  mobile: ./apps/mobile
  web: ./apps/web
  root: .

# Optional — injected as a footer into every MCP tool response as a reminder
manager_context: |
  Always call get_pending_results() before dispatching new tasks.
```

All `dirs` values are resolved to absolute paths at startup; an error is thrown if any path doesn't exist.

## Runtime files

- `.agent-queue.json` — task queue state, written at repo root alongside `.agents.yaml` (gitignored)
- `tools/ranni/runs/<timestamp>/` — worker output archives when `persist_runs: true` (gitignored)
  - `summary.json` — all tasks with statuses and results
  - `<task-id>.txt` — full stdout of each worker

## Task statuses

| Status | Meaning |
|--------|---------|
| `pending` | In the queue, not yet started |
| `running` | A worker subprocess is active |
| `done` | Worker exited successfully |
| `done_with_conflict` | Worker finished but touched a file another worker already modified; a resolution task was auto-dispatched |
| `needs_help` | Worker could not proceed — manager must read and act |
| `error` | Worker failed — manager may retry or cancel |
| `cancelled` | Removed before it ran |

Tasks marked `running` at startup (from a crashed session) are reset to `pending` automatically.

## MCP tools

### `dispatch_task`

```ts
input: {
  tasks: Array<{
    id: string            // unique ID chosen by manager for tracking
    dir: string           // key from config.dirs
    task: string          // full self-contained task description
    context?: string      // optional background, file paths, etc.
    links?: string[]      // URLs to read first (tickets, PRs, docs)
    relevant_files?: string[]  // file paths the manager already identified
    depends_on?: string[] // task IDs that must be "done" before this starts
  }>
}
```

Returns queued count, active worker count, and queue depth.

### `list_active_workers`

No input. Returns a formatted snapshot of running workers and pending tasks, including `depends_on` chains.

### `get_pending_results`

```ts
input: {
  drain?: boolean  // default true — mark results as acknowledged after reading
}
```

Returns all terminal tasks (`done`, `done_with_conflict`, `needs_help`, `error`) not yet acknowledged. Call this before dispatching new tasks.

### `cancel_task`

```ts
input: { id: string }
```

Cancels a `pending` task. No-op if the task is already running, done, or doesn't exist.

## Worker output protocol

Every worker must end its output with this block as the very last thing written:

```
<orchestrator_result>
{"status":"done|needs_help|error","summary":"one-line summary","files_changed":["relative/path"],"message":"optional longer message"}
</orchestrator_result>
```

- `files_changed`: paths relative to the worker's `cwd` (the resolved `dir`)
- `message`: required for `needs_help` and `error`; optional for `done`

If the marker is absent, ranni synthesises an `error` result from the last 2000 chars of stdout.

## Task dependencies

```yaml
# in .agent-queue.json (or via dispatch_task)
{
  "id": "web-ui-01",
  "depends_on": ["api-01", "mobile-01"]
}
```

The orchestrator skips a `pending` task until every ID in `depends_on` has status `done`. IDs not found in the queue are treated as satisfied (completed in a prior session).

## Conflict detection

When a worker finishes and its `files_changed` overlap with files already touched by a different task, ranni:

1. Flips the original task to `done_with_conflict`
2. Generates a `git diff HEAD -- <file>` for each conflicting file
3. Auto-dispatches a resolution task (`<original-id>-conflict-<n>`) with the diff attached
4. Updates `touched_files` in the queue file

The resolution task is a normal worker task — it will run in the pool like any other.

## File structure

```
src/
  index.ts     MCP server entry, tool handlers, pool ticker
  types.ts     TaskStatus, Task, WorkerResult, QueueFile, Config
  config.ts    Zod schema + loadConfig() (walks to git root)
  queue.ts     File-backed queue: read/write/atomic-swap, enqueue/startNext/complete/cancel/resetInterrupted/getPendingResults
  worker.ts    Bun.spawn wrapper, prompt builder, WORKER_SYSTEM_PROMPT, result parser
  conflict.ts  detectConflict(), handleConflict(), resolution-task injection
  runs.ts      RunLogger (null when persist_runs: false)
```

## Wiring to Claude Code

Add to `.claude/settings.local.json`:

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
