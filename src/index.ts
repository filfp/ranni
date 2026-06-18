import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { detectConflict, handleConflict } from './conflict.js';
import {
    cancelTask,
    complete,
    enqueue,
    getPendingResults,
    getSnapshot,
    queuePath,
    readQueue,
    resetInterrupted,
    startNext
} from './queue.js';
import { initRun } from './runs.js';
import type { Config, Task } from './types.js';
import { runWorker } from './worker.js';

const DEFAULT_MANAGER_CONTEXT = `ORCHESTRATOR RULES (read before every action):
1. Always call get_pending_results before dispatching new tasks — read every result first.
2. Each task must be self-contained: include all file paths, context, and background the worker needs.
3. Use depends_on when task B genuinely needs task A's output to be on disk first.
4. When a worker returns needs_help, surface the question to the user before dispatching a follow-up.
5. When a worker returns error, decide: retry, dispatch a corrected version, or inform the user.`

function formatFooter(managerContext: string): string {
  return `\n\n---\n${managerContext}`
}

async function main() {
  const { config, configDir } = loadConfig()
  const qPath = queuePath(configDir)
  const runLogger = initRun(config, configDir)

  resetInterrupted(qPath)

  let activeCount = 0

  async function tickPool() {
    const available = config.max_workers - activeCount
    if (available <= 0) return

    for (let i = 0; i < available; i++) {
      const task = startNext(qPath)
      if (!task) break

      activeCount++
      runWorkerAsync(task, config, qPath, runLogger, configDir).finally(() => {
        activeCount--
      })
    }
  }

  setInterval(tickPool, 200)

  const server = new Server({ name: 'ranni-mcp', version: '0.1.0' }, { capabilities: { tools: {} } })

  const footer = formatFooter(config.manager_context ?? DEFAULT_MANAGER_CONTEXT)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'dispatch_task',
        description:
          'Add one or more tasks to the worker queue. Workers run autonomously up to max_workers in parallel.',
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique ID you choose for tracking' },
                  dir: { type: 'string', description: `One of: ${Object.keys(config.dirs).join(', ')}` },
                  task: { type: 'string', description: 'Full self-contained task description for the worker' },
                  context: { type: 'string', description: 'Optional extra context: file paths, background, etc.' },
                  links: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'URLs the worker should read first (Notion tickets, PRs, docs). Worker is instructed to fetch these before touching any code.'
                  },
                  relevant_files: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'File paths already identified by the manager. Worker starts investigation here instead of searching from scratch.'
                  },
                  depends_on: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Task IDs that must be done before this starts'
                  }
                },
                required: ['id', 'dir', 'task']
              },
              minItems: 1
            }
          },
          required: ['tasks']
        }
      },
      {
        name: 'list_active_workers',
        description: 'Snapshot of the current queue: running workers, pending tasks, and free slots.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'get_pending_results',
        description: 'Read completed worker results since the last call. Call this before dispatching new tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            drain: { type: 'boolean', description: 'Mark results as acknowledged after reading (default: true)' }
          }
        }
      },
      {
        name: 'cancel_task',
        description: 'Cancel a pending (not yet running) task.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Task ID to cancel' }
          },
          required: ['id']
        }
      }
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'dispatch_task': {
        const tasks = (args as any).tasks as Array<{
          id: string
          dir: string
          task: string
          context?: string
          links?: string[]
          relevant_files?: string[]
          depends_on?: string[]
        }>

        const unknownDirs = tasks.filter(t => !config.dirs[t.dir]).map(t => t.dir)
        if (unknownDirs.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: unknown dir(s): ${[...new Set(unknownDirs)].join(', ')}. Valid dirs: ${Object.keys(config.dirs).join(', ')}${footer}`
              }
            ]
          }
        }

        enqueue(qPath, tasks)
        tickPool()

        const snapshot = getSnapshot(qPath)
        return {
          content: [
            {
              type: 'text',
              text: `Queued ${tasks.length} task(s). Active workers: ${activeCount}/${config.max_workers}. Queue depth: ${snapshot.queued.length}.${footer}`
            }
          ]
        }
      }

      case 'list_active_workers': {
        const snapshot = getSnapshot(qPath)
        const runningList = snapshot.running
          .map(t => `  [running] ${t.id} (${t.dir}) — started ${t.started_at}`)
          .join('\n')
        const queuedList = snapshot.queued
          .map(
            t =>
              `  [queued]  ${t.id} (${t.dir})${t.depends_on?.length ? ` — waiting on: ${t.depends_on.join(', ')}` : ''}`
          )
          .join('\n')
        const lines = [
          `Workers: ${activeCount}/${config.max_workers} active`,
          runningList || '  (none running)',
          queuedList || '  (queue empty)'
        ].join('\n')
        return { content: [{ type: 'text', text: lines + footer }] }
      }

      case 'get_pending_results': {
        const drain = (args as any)?.drain !== false
        const results = getPendingResults(qPath, drain)

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No new results.${footer}` }] }
        }

        const formatted = results
          .map(t => {
            const r = t.result
            const status = r ? r.status : t.status
            const summary = r ? r.summary : '(no summary)'
            const files = r?.files_changed?.length ? `\n  Files: ${r.files_changed.join(', ')}` : ''
            const msg = r?.message ? `\n  Message: ${r.message}` : ''
            return `[${status.toUpperCase()}] ${t.id} (${t.dir})\n  ${summary}${files}${msg}`
          })
          .join('\n\n')

        return { content: [{ type: 'text', text: formatted + footer }] }
      }

      case 'cancel_task': {
        const id = (args as any).id as string
        const cancelled = cancelTask(qPath, id)
        const msg = cancelled
          ? `Task "${id}" cancelled.`
          : `Task "${id}" could not be cancelled — it may be running or already finished.`
        return { content: [{ type: 'text', text: msg + footer }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('Orchestrator MCP server running\n')
}

async function runWorkerAsync(
  task: Task,
  config: Config,
  qPath: string,
  runLogger: ReturnType<typeof initRun>,
  configDir: string
) {
  try {
    const result = await runWorker(task, config)

    complete(qPath, task.id, result)

    runLogger?.updateSummary(readQueue(qPath).tasks)

    const queue = readQueue(qPath)
    const conflict = detectConflict(result, queue, task.id)
    if (conflict) {
      const resolvedDir = config.dirs[task.dir]!
      await handleConflict(qPath, task, conflict, resolvedDir)
    }

    if (runLogger) {
      const stdout = result.message ?? result.summary
      runLogger.logTask(task.id, stdout)
      runLogger.updateSummary(readQueue(qPath).tasks)
    }
  } catch (err) {
    complete(qPath, task.id, {
      status: 'error',
      summary: 'Worker threw an unexpected error',
      files_changed: [],
      message: String(err),
      exit_code: 1
    })
  }
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
