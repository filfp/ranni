# Plan: packages/orchestrator — Provider-Agnostic Multi-Agent MCP Server

## Context

This adds a new first-party package (`packages/orchestrator/`) to the monorepo that exposes an MCP server. A manager agent (Claude Code, Codex, Copilot) connects to it via stdio transport and uses four tools to dispatch autonomous worker subprocesses, track progress via a file-backed task queue, and receive results when workers finish, need help, or hit errors.

**Note:** The plan references `docs/ORCHESTRATOR.md` as a full design doc, but that file doesn't exist in the repo yet. This plan is the implementation spec. `docs/ORCHESTRATOR.md` can be added as a follow-up reference document if desired.

`packages/orchestrator/` is **not** a git submodule — it lives in the monorepo proper.

---

## Data / module flow

```
Manager agent
     │ MCP stdio
     ▼
  index.ts  ──── loadConfig() ────► config.ts  (.agents.yaml)
     │
     ├── dispatch_task ──────────► queue.ts  (.agent-queue.json)
     │                                  │
     │          pool ticker ◄───────────┘
     │               │
     │               ▼
     │           worker.ts  (Bun.spawn)
     │               │
     │               ▼
     │           conflict.ts  (detectConflict → inject resolution task)
     │               │
     │               ▼
     │           runs.ts  (optional: tools/orchestrator/runs/<ts>/)
     │
     ├── list_active_workers ────► queue.ts (read-only snapshot)
     ├── get_pending_results ────► queue.ts (drain completed)
     └── cancel_task ────────────► queue.ts (pending → cancelled)
```

---

## File structure

```
packages/orchestrator/
  src/
    index.ts       MCP server entry, tool handlers, pool ticker, startup
    types.ts       TaskStatus, Task, WorkerResult, QueueFile discriminated unions
    config.ts      Zod schema for .agents.yaml, loadConfig(), git-root walk
    queue.ts       File-backed queue: read/write/atomic-swap, enqueue/startNext/complete/cancel/resetInterrupted
    worker.ts      Bun.spawn wrapper, prompt builder, <orchestrator_result> parser, WORKER_SYSTEM_PROMPT
    conflict.ts    touched-file registry, detectConflict(), resolution-task injection
    runs.ts        RunLogger (null when persist_runs: false), summary.json + per-task .txt
  package.json
  tsconfig.json
  .gitignore
  CLAUDE.md
```

---

## Types (`src/types.ts`)

```ts
export type TaskStatus = 'pending' | 'running' | 'done' | 'done_with_conflict' | 'needs_help' | 'error' | 'cancelled'

export type Task = {
  id: string
  status: TaskStatus
  dir: string // key from config.dirs
  task: string
  context?: string
  depends_on?: string[] // must all be "done" before this starts
  created_at: string
  started_at: string | null
  finished_at: string | null
  result: WorkerResult | null
}

export type WorkerResult = {
  status: 'done' | 'needs_help' | 'error'
  summary: string
  files_changed: string[]
  message?: string
  exit_code: number
}

export type QueueFile = {
  tasks: Task[]
  touched_files: Record<string, string> // filepath → last task id that touched it
}

export type Config = {
  worker: { command: string; args: string[] }
  max_workers: number
  persist_runs: boolean
  dirs: Record<string, string>
  manager_context?: string
}
```

---

## Config (`src/config.ts`)

Zod schema with defaults. `loadConfig()` walks from `process.cwd()` upward until it finds a `.agents.yaml` or hits the git root (`/.git` present). Throws a descriptive error if not found or schema invalid.

```ts
const ConfigSchema = z.object({
  worker: z.object({
    command: z.string(),
    args: z.array(z.string()).default([])
  }),
  max_workers: z.number().int().min(1).default(3),
  persist_runs: z.boolean().default(false),
  dirs: z.record(z.string()),
  manager_context: z.string().optional()
})
```

---

## Queue (`src/queue.ts`)

Atomic writes via write-to-temp + `rename()`. All state lives in `.agent-queue.json` at the path returned by `queuePath()` (same directory as `.agents.yaml`).

Key functions:

- `readQueue(path): QueueFile` — JSON.parse, falls back to `{ tasks: [], touched_files: {} }`
- `writeQueue(path, q): void` — writes to `<path>.tmp`, then `fs.renameSync`
- `enqueue(path, tasks[]): void`
- `startNext(path): Task | null` — finds first `pending` task whose `depends_on` are all `done`; flips to `running` synchronously before returning (prevents double-pickup)
- `complete(path, id, result): void` — sets status, stores result, updates `touched_files`
- `resetInterrupted(path): void` — flips any `running` → `pending` on startup
- `cancelTask(path, id): void` — flips `pending` → `cancelled`; no-op if already running/done

---

## Worker (`src/worker.ts`)

```ts
export async function runWorker(task: Task, config: Config): Promise<WorkerResult>
```

1. Build prompt from `WORKER_SYSTEM_PROMPT` (module constant) + task fields
2. `Bun.spawn([config.worker.command, ...config.worker.args], { cwd: config.dirs[task.dir], stdin: "pipe", stdout: "pipe", stderr: "pipe" })`
3. Write prompt to stdin, close stdin
4. Await `proc.exited`
5. Extract JSON from `<orchestrator_result>…</orchestrator_result>` with regex
6. If marker absent → synthesise `WorkerResult { status: "error", summary: "no result marker", exit_code }`

`WORKER_SYSTEM_PROMPT` instructs workers to wrap their final output in `<orchestrator_result>` JSON matching `WorkerResult`. This constant is defined in `worker.ts` and should contain the full system preamble that was designed in the original `ORCHESTRATOR.md` spec.

---

## Conflict detection (`src/conflict.ts`)

Called immediately after `queue.complete()`:

```ts
export function detectConflict(result: WorkerResult, queue: QueueFile, taskId: string): ConflictInfo | null
```

If any file in `result.files_changed` is already in `queue.touched_files` under a **different** task id:

1. Flip original task to `done_with_conflict`
2. Generate diff via `git diff HEAD -- <file>` in the task's resolved dir
3. Inject a resolution task: `id = <original-id>-conflict-<n>`, task text includes the conflicting file and the rejected diff
4. Update `touched_files` to the new resolution task id

---

## Run persistence (`src/runs.ts`)

```ts
export type RunLogger = { logTask(id: string, stdout: string): void; updateSummary(tasks: Task[]): void }
export function initRun(config: Config): RunLogger | null
```

Returns `null` when `persist_runs: false` — callers guard with `runLogger?.logTask(...)`. When active, creates `tools/orchestrator/runs/<ISO-timestamp>/` at process startup.

---

## MCP Server (`src/index.ts`)

Uses `@modelcontextprotocol/sdk` with `StdioServerTransport`. All MCP output goes to stdout; all logging goes to stderr.

Four tools registered:

| Tool                  | Input                                                  | Action                                                   |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `dispatch_task`       | `{ tasks: Array<{dir, task, context?, depends_on?}> }` | enqueue, tick pool                                       |
| `list_active_workers` | —                                                      | read queue snapshot, return running+pending              |
| `get_pending_results` | `{ drain?: boolean }`                                  | return completed results; if drain, mark as acknowledged |
| `cancel_task`         | `{ id: string }`                                       | cancelTask(id)                                           |

Every tool response appends `config.manager_context` (or a default) as a footer.

Pool runner: a `setInterval`-style async loop that calls `queue.startNext()` up to `max_workers - activeCount` times per tick, launching `runWorker()` for each. Tracks in-flight count with a module-level counter (the queue file is the real concurrency lock).

Startup sequence:

1. `loadConfig()` — find and parse `.agents.yaml`
2. `queue.resetInterrupted()` — crash recovery
3. `initRun(config)` — start run logger if enabled
4. `server.connect(new StdioServerTransport())`
5. Log `"Orchestrator MCP server running"` to stderr

---

## package.json

```json
{
  "name": "@codeleap/orchestrator",
  "version": "0.1.0",
  "description": "Provider-agnostic multi-agent orchestration MCP server",
  "type": "module",
  "bin": { "orchestrator": "./dist/orchestrator" },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build --compile src/index.ts --outfile dist/orchestrator",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.22.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  }
}
```

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ESNext"]
  },
  "include": ["src/**/*"]
}
```

`moduleResolution: "bundler"` is required for Bun's module resolution. `noEmit: true` because Bun handles transpilation; `tsc` is only used for type checking.

---

## Justfile additions (root `justfile`)

Add after the `back_dir` variable block and before the existing sections:

```justfile
orch_dir := root / "packages/orchestrator"

# ── Orchestrator ─────────────────────────────────────────────────────────────

# Run any bun script in packages/orchestrator  (e.g. just orchestrate dev)
[no-cd]
orchestrate *cmd:
    cd "{{orch_dir}}" && bun {{cmd}}
```

Follows the exact pattern of the existing `web` and `mobile` recipes.

---

## Gitignore additions

Create `packages/orchestrator/.gitignore`:

```
node_modules/
dist/
```

Add to the **root** `.gitignore` (create it if absent):

```
.agent-queue.json
tools/orchestrator/runs/
```

---

## CLAUDE.md for the package

Create `packages/orchestrator/CLAUDE.md` documenting: stack (Bun + TypeScript + MCP SDK), commands (`just orchestrate dev`, `just orchestrate build`, `just orchestrate typecheck`), the `.agents.yaml` config format, runtime files created, and the `<orchestrator_result>` protocol that workers must follow.

---

## Build order

1. `packages/orchestrator/tsconfig.json` + `packages/orchestrator/package.json`
2. `src/types.ts`
3. `src/config.ts`
4. `src/queue.ts`
5. `src/worker.ts`
6. `src/conflict.ts`
7. `src/runs.ts`
8. `src/index.ts`
9. Root `justfile` — add `orch_dir` variable + `orchestrate` recipe
10. `packages/orchestrator/.gitignore`
11. Root `.gitignore` — add `.agent-queue.json` and `tools/orchestrator/runs/`
12. `packages/orchestrator/CLAUDE.md`
13. `bun install` inside `packages/orchestrator/` to lock deps

---

## Verification

1. `just orchestrate typecheck` — zero TypeScript errors
2. `just orchestrate dev` — server starts; stderr shows "Orchestrator MCP server running"; stdout is silent (reserved for MCP protocol)
3. Add the server to Claude Code via `mcpServers` in `.claude/settings.json` with `{"command": "bun", "args": ["run", "<repo-root>/packages/orchestrator/src/index.ts"]}`
4. From Claude Code, call `list_active_workers` — returns empty queue, no errors
5. Create a minimal `.agents.yaml` at repo root pointing to a real dir, dispatch one task — verify `.agent-queue.json` appears with `status: "pending"`, transitions to `"running"`, then `"done"`
6. Add a task with `depends_on` pointing to a pending task — verify it stays `pending` until the dependency completes
7. Set `persist_runs: true`, run one task — verify `tools/orchestrator/runs/<ts>/summary.json` and `<task-id>.txt` are created
