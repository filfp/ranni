# Agent Orchestrator — Design Document

A provider-agnostic multi-agent orchestration system. The manager agent (Claude Code, Codex, Copilot — whatever you are already talking to) is the UI. The orchestrator is the plumbing: an MCP server that manages a persistent task queue and a pool of autonomous worker subprocesses.

No custom TUI. The agent you are chatting with is the TUI.

The task queue is a file on disk. This means:
- **Create now, run later** — fill the queue in one session, start the orchestrator in another
- **Token window optimization** — queue tasks during expensive hours, run when rates are lower
- **Survives reboots** — orchestrator picks up where it left off on next start
- **Manually editable** — inspect, reorder, or remove tasks with any text editor before running

---

## Mental Model: Kanban Board as MCP Server

```
You ↔ Manager agent (your existing terminal agent — already your UI)
              │
              │ calls MCP tools
              ▼
     ┌─────────────────────────┐
     │   Orchestrator          │
     │   (MCP server)          │
     │                         │
     │  dispatch_task()        │  ← manager pushes cards
     │  list_active_workers()  │  ← manager checks the board
     │  get_pending_results()  │  ← manager reads callbacks
     │  cancel_task()          │  ← manager removes a card
     └────────────┬────────────┘
                  │ spawns subprocesses
       ┌──────────┼──────────┐
       ▼          ▼          ▼
   [Worker A]  [Worker B]  [Worker C]   ← up to max_workers
       │          │          │
       └──────────┴──────────┘
                  │ exits with JSON payload
                  ▼
     Orchestrator parses result → queues callback
                  │
                  ▼ next get_pending_results() call
     Manager receives callbacks, decides what to do next
```

Key rules:
- Manager **pushes tasks at any time** — even while workers are running
- Workers **pull from the queue** as slots free — always up to `max_workers` running
- Workers **never talk to the user directly** — they exit with a structured JSON payload, orchestrator queues it, manager reads it and decides whether to escalate to the user
- The orchestrator has **no UI** — it is a background MCP server

---

## Queue File

`.agent-queue.json` at the repo root. Written by the manager via `dispatch_task`, read and updated by the orchestrator at runtime. Should be gitignored — it is runtime state, not source.

```json
{
  "tasks": [
    {
      "id": "notif-mobile-01",
      "status": "pending",
      "dir": "mobile",
      "task": "Add push notification support to the mobile app...",
      "context": "See apps/mobile/src/notifications/",
      "created_at": "2026-06-17T14:00:00Z",
      "started_at": null,
      "finished_at": null,
      "result": null
    },
    {
      "id": "notif-api-01",
      "status": "done",
      "dir": "backend",
      "task": "Add /api/notifications endpoint...",
      "context": null,
      "created_at": "2026-06-17T14:00:00Z",
      "started_at": "2026-06-17T14:01:00Z",
      "finished_at": "2026-06-17T14:03:42Z",
      "result": {
        "status": "done",
        "summary": "Added POST /api/notifications, migration applied",
        "files_changed": ["backend/api/notifications.py", "backend/api/urls.py"],
        "message": null
      }
    }
  ]
}
```

**Task statuses:**

| Status | Meaning |
|--------|---------|
| `pending` | In the queue, not yet started |
| `running` | A worker subprocess is active |
| `done` | Worker exited successfully |
| `needs_help` | Worker could not proceed — manager must read and act |
| `error` | Worker failed — manager may retry or cancel |
| `cancelled` | Removed before it ran |

The orchestrator on startup reads the file and re-queues all `pending` tasks. Tasks marked `running` at startup (from a previous interrupted session) are reset to `pending` and re-queued — the worker was killed mid-run and the task is not safe to mark done.

The queue file is the single source of truth. The orchestrator never holds task state only in memory.

---

## Configuration

`.agents.yaml` at the repo root:

```yaml
worker:
  command: claude
  args: [--print, --dangerously-skip-permissions]

max_workers: 3

dirs:
  backend: ./backend
  mobile: ./apps/mobile
  web: ./apps/web
  root: .
```

`worker.command` can be any CLI binary that accepts a prompt and writes output — `claude`, `codex`, `aider`, anything. The manager agent is not configured here: it is whatever agent you are already talking to, connected via MCP.

---

## MCP Tools

The orchestrator exposes four tools to the manager agent:

### `dispatch_task`

Push one or more tasks onto the queue.

```ts
input: {
  tasks: Array<{
    id: string           // unique id chosen by manager, for tracking
    task: string         // full self-contained description for the worker
    dir: keyof dirs      // which sub-project to run in
    context?: string     // optional extra context (file paths, background)
  }>
}

output: {
  queued: string[]       // ids of tasks now in the queue
  active_workers: number // current running count
  queue_depth: number    // tasks waiting for a free slot
}
```

### `list_active_workers`

Snapshot of the current board state.

```ts
input: {}

output: {
  running: Array<{ id: string; dir: string; started_at: string; task_preview: string }>
  queued:  Array<{ id: string; dir: string; task_preview: string }>
  slots_free: number
}
```

### `get_pending_results`

Read and drain completed worker callbacks. Call this to find out what workers have finished since the last call.

```ts
input: {
  clear?: boolean  // default true — drain the buffer after reading
}

output: {
  results: Array<WorkerResult>
}
```

### `cancel_task`

Remove a queued (not yet running) task from the queue.

```ts
input: { id: string }
output: { cancelled: boolean; reason?: string }
```

---

## Worker Result Schema

Every worker must exit with this JSON as the last block of its stdout, wrapped in markers:

```
<orchestrator_result>
{
  "status": "done" | "needs_help" | "error",
  "summary": "One-line description of what was done or what went wrong",
  "files_changed": ["relative/path/to/file.ts"],
  "message": "Optional longer message — required for needs_help and error"
}
</orchestrator_result>
```

The worker's system prompt instructs it to always emit this trailer. If the marker is absent (crash, unexpected exit), the orchestrator synthesises an error result from the raw stdout.

`WorkerResult` as seen by the manager:

```ts
type WorkerResult = {
  id: string
  dir: string
  status: "done" | "needs_help" | "error"
  summary: string
  files_changed: string[]
  message?: string
  exit_code: number
  started_at: string
  finished_at: string
}
```

---

## Worker Lifecycle

```
task enters queue
      ↓
slot frees (semaphore.acquire)
      ↓
Bun.spawn(worker.command, worker.args, { cwd: resolved_dir, stdin: taskPrompt })
      ↓
worker runs fully autonomously
      ↓
process exits
      ↓
orchestrator reads stdout, extracts <orchestrator_result> block
      ↓
result pushed into pending_results buffer
      ↓
semaphore.release → next queued task starts
```

---

## Worker System Prompt

The orchestrator prepends this to every worker task:

```
You are an autonomous coding agent. Complete the task below fully and independently.
Do not ask for confirmation. Do not stop mid-task.

When you are done — whether successful, blocked, or errored — output the following
as the very last thing you write, with no trailing text:

<orchestrator_result>
{"status":"done"|"needs_help"|"error","summary":"...","files_changed":["..."],"message":"..."}
</orchestrator_result>

Use "needs_help" only if you genuinely cannot proceed without information you do not have.
Use "error" if you attempted the task and it failed.
Use "done" if the task is complete.

---
TASK:
<task description from manager>

CONTEXT:
<context field from dispatch, if provided>
```

---

## Task Dependencies

Tasks support an optional `depends_on` array of task IDs. The orchestrator will not start a task until every ID listed in `depends_on` has status `done`.

In `.agent-queue.json`:

```json
{
  "id": "web-ui-01",
  "status": "pending",
  "dir": "web",
  "task": "Add notification bell to the nav bar",
  "depends_on": ["notif-api-01", "notif-mobile-01"]
}
```

The orchestrator checks dependencies on every tick of the worker pool runner:

```
task pulled from queue
      ↓
check depends_on IDs in queue file
      ↓ any not yet "done"?
   yes → put task back, skip for now
   no  → acquire semaphore, spawn worker
```

`depends_on` IDs that do not exist in the queue file are treated as satisfied — they were completed in a previous session and are no longer tracked.

---

## Manager Prompt Guidance

The manager agent (whatever you are chatting with) should be told in its system context:

```
You have access to an orchestrator MCP server with tools: dispatch_task,
list_active_workers, get_pending_results, cancel_task.

Dispatch rules:
1. ALWAYS call get_pending_results() before dispatching any new tasks.
   Read every result. Understand what changed before adding more work.
2. Break work into atomic, self-contained tasks. Each task must include all
   context the worker needs — workers share no history with each other or with you.
3. Use depends_on to express ordering when task B genuinely needs task A's output.
   Do not use it as a substitute for reading results — always read results first.
4. When a worker returns needs_help, surface the question to the user.
   Dispatch a follow-up task only after you have the answer.
5. When a worker returns error, decide: retry the same task, dispatch a corrected
   version, or cancel and inform the user. Do not silently skip errors.
```

This is set in `.agents.yaml` under `manager_context` and injected by the orchestrator into every MCP tool response as a reminder header.

---

## File Conflict Resolution

When two workers modify the same file, the second worker to finish will find a git conflict. The orchestrator handles this automatically before marking the task done:

```
worker exits with status "done"
      ↓
orchestrator runs: git status --short
      ↓ conflict markers found?
   no  → write result, mark done, notify manager
   yes → enter conflict resolution flow
```

**Resolution flow — first diff wins:**

```
1. Identify conflicting files from git status output
2. For each conflict:
   a. Accept the already-applied (first) version: git checkout --ours <file>
   b. Capture the rejected (second) diff: git show MERGE_HEAD -- <file>
3. Dispatch a new resolution task to the manager's queue:
   {
     "id": "<original-id>-conflict-01",
     "task": "Resolve conflict in <file>. The first worker's version was kept.
              Review the rejected diff below and apply any changes that are safe
              to merge without breaking the first worker's work.\n\n<rejected diff>",
     "dir": "<same dir>",
     "status": "pending"
   }
4. Mark the original task as "done_with_conflict" — visible to the manager
5. If the resolution worker also returns needs_help or error, escalate to the user
```

`done_with_conflict` is a terminal status for the original task but signals to the manager that a follow-up is in flight. The manager never needs to act on it directly unless the resolution worker escalates.

---

## Run Persistence

Controlled by a flag in `.agents.yaml`:

```yaml
persist_runs: false   # default — queue file only, no archived outputs
```

When `persist_runs: true`, the orchestrator writes a run log to:

```
tools/orchestrator/runs/<ISO-timestamp>/
  summary.json        — all tasks with statuses and results
  <task-id>.txt       — full stdout of each worker
```

The run directory is created when the orchestrator starts. It is appended to as workers complete — not written all at once at the end. Run directories are gitignored.

This flag is off by default so there is no disk accumulation unless explicitly opted in.

---

## File Structure

```
tools/orchestrator/
  src/
    index.ts        — MCP server entry point, tool handlers
    queue.ts        — file-backed task queue + semaphore pool
    worker.ts       — Bun.spawn wrapper, output parser
    config.ts       — load and validate .agents.yaml (zod schema)
    types.ts        — WorkerResult, Task, TaskStatus discriminated unions
  package.json
  tsconfig.json

.agents.yaml        — root config (committed)
.agent-queue.json   — task queue state (gitignored, runtime only)
```

---

## Configuration Reference

Full `.agents.yaml`:

```yaml
worker:
  command: claude
  args: [--print, --dangerously-skip-permissions]

max_workers: 3

persist_runs: false   # set true to archive worker outputs under tools/orchestrator/runs/

dirs:
  backend: ./backend
  mobile: ./apps/mobile
  web: ./apps/web
  root: .

# Injected into every MCP tool response as a reminder header for the manager
manager_context: |
  Always call get_pending_results() before dispatching new tasks.
  Read every result before adding more work.
```

---

## MVP Build Order

1. `types.ts` — Task, TaskStatus (`pending` | `running` | `done` | `done_with_conflict` | `needs_help` | `error` | `cancelled`), WorkerResult
2. `config.ts` — zod schema for `.agents.yaml`, resolve and validate dirs
3. `queue.ts` — file-backed queue: read/write `.agent-queue.json`, dependency checker, semaphore pool, crash recovery (reset `running` → `pending` on startup)
4. `worker.ts` — `Bun.spawn` wrapper, extract `<orchestrator_result>`, run conflict detection, dispatch resolution task if needed
5. `index.ts` — MCP server wiring the four tools to the queue, inject `manager_context` into responses
6. `.agents.yaml` — default config for this repo
7. Add `.agent-queue.json` and `tools/orchestrator/runs/` to `.gitignore`
8. `just orchestrate` — Justfile entry to start the MCP server
