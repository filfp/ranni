# ranni

Provider-agnostic multi-agent orchestration MCP server. Lets a manager agent (Claude Code, Codex, Copilot) dispatch autonomous worker subprocesses, track their progress via a file-backed task queue, and receive results when workers finish, need help, or error.

The agent you are already talking to is the UI. Ranni is the plumbing.

---

## How it works

```
You ↔ Manager agent (Claude Code, your existing terminal agent)
              │
              │ MCP tools
              ▼
         ┌─────────────────────┐
         │        ranni        │
         │    (MCP server)     │
         └──────────┬──────────┘
                    │ spawns subprocesses
         ┌──────────┼──────────┐
         ▼          ▼          ▼
     [Worker A]  [Worker B]  [Worker C]   ← up to max_workers
         │          │          │
         └──────────┴──────────┘
                    │ structured JSON result
                    ▼
         Manager reads callbacks, decides what to do next
```

Workers run fully autonomously. They never talk to the user directly — they exit with a structured result, ranni queues it, and the manager reads it and decides whether to escalate.

The task queue is a plain JSON file on disk. It survives reboots, is manually editable, and is the single source of truth for all task state.

---

## Install

```bash
bun add ranni-mcp
bun node_modules/ranni-mcp/src/init.ts
```

`init` writes three things into your project:

| File | Behaviour |
|------|-----------|
| `.claude/skills/ranni/` | Manager skill for Claude Code — always overwrites |
| `.agents.yaml` | Starter config — skipped if already exists |
| `.mcp.json` | Merges the ranni entry, preserving all existing entries |

---

## Configuration

Edit `.agents.yaml` at your repo root:

```yaml
worker:
  command: claude
  args: [--print, --dangerously-skip-permissions]

max_workers: 3
persist_runs: false   # set true to archive full worker stdout

dirs:
  root: .
  backend: ./backend
  web: ./apps/web
  mobile: ./apps/mobile

# Optional — injected into every MCP tool response as a reminder
# manager_context: |
#   Always call get_pending_results() before dispatching new tasks.
```

`worker.command` can be any CLI that accepts a prompt on stdin — `claude`, `codex`, `aider`, anything.

---

## MCP tools

| Tool | Description |
|------|-------------|
| `dispatch_task` | Push one or more tasks onto the queue |
| `list_active_workers` | Snapshot of running + queued tasks |
| `get_pending_results` | Read completed results (drains buffer by default) |
| `cancel_task` | Cancel a pending task by ID |

### `dispatch_task` input

```ts
{
  tasks: Array<{
    id: string             // unique ID you choose for tracking
    dir: string            // key from .agents.yaml dirs
    task: string           // full self-contained task description
    context?: string       // optional background, constraints
    links?: string[]       // URLs the worker should read first (tickets, PRs, docs)
    relevant_files?: string[]  // files already identified — worker starts here
    depends_on?: string[]  // task IDs that must be "done" before this starts
  }>
}
```

---

## Worker output protocol

Every worker must end its output with this block as the very last thing written:

```
<orchestrator_result>
{"status":"done","summary":"one-line summary","files_changed":["relative/path"],"message":"optional"}
</orchestrator_result>
```

Valid statuses: `done`, `needs_help`, `error`.

If the marker is absent (crash, unexpected exit), ranni synthesises an `error` result from the last 2000 chars of stdout.

---

## Task statuses

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet started |
| `running` | Worker subprocess active |
| `done` | Completed successfully |
| `done_with_conflict` | Done, but touched a file another worker already modified — resolution task auto-dispatched |
| `needs_help` | Worker could not proceed — manager must act |
| `error` | Worker failed — manager may retry or cancel |
| `cancelled` | Removed before it ran |

Tasks left in `running` state from a crashed session are automatically reset to `pending` on startup.

---

## Task dependencies

```json
{
  "id": "web-ui",
  "depends_on": ["api-endpoint", "mobile-service"]
}
```

Ranni skips a task until every ID in `depends_on` has status `done`. IDs not found in the queue are treated as satisfied (completed in a prior session).

---

## Runtime files

- `.agent-queue.json` — task queue state, lives alongside `.agents.yaml` (gitignore this)
- `tools/ranni/runs/<timestamp>/` — worker output archives when `persist_runs: true` (gitignore this)

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A Claude Code (or compatible) setup with MCP support
