import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { QueueFile, Task, TaskStatus, WorkerResult } from './types.js';

export function queuePath(configDir: string): string {
  return join(configDir, '.agent-queue.json')
}

export function readQueue(path: string): QueueFile {
  if (!existsSync(path)) return { tasks: [], touched_files: {} }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as QueueFile
  } catch {
    return { tasks: [], touched_files: {} }
  }
}

export function writeQueue(path: string, queue: QueueFile): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function enqueue(
  path: string,
  tasks: Omit<Task, 'status' | 'created_at' | 'started_at' | 'finished_at' | 'result' | 'acknowledged'>[]
): void {
  const queue = readQueue(path)
  const now = new Date().toISOString()
  for (const t of tasks) {
    queue.tasks.push({
      ...t,
      status: 'pending',
      created_at: now,
      started_at: null,
      finished_at: null,
      result: null,
      acknowledged: false
    })
  }
  writeQueue(path, queue)
}

export function startNext(path: string): Task | null {
  const queue = readQueue(path)
  // A done task with a PR only satisfies depends_on after the PR lands in base_branch
  const doneIds = new Set(
    queue.tasks
      .filter(t => t.status === 'done' && (!t.pr_branch || t.pr_merged === true))
      .map(t => t.id)
  )

  const isEligible = (t: Task) => {
    if (t.status !== 'pending') return false
    if (!t.depends_on || t.depends_on.length === 0) return true
    return t.depends_on.every(dep => doneIds.has(dep))
  }

  // Highest priority first; ties broken by queue order (earliest enqueued).
  let pick = -1
  for (let i = 0; i < queue.tasks.length; i++) {
    if (!isEligible(queue.tasks[i]!)) continue
    if (pick === -1 || (queue.tasks[i]!.priority ?? 0) > (queue.tasks[pick]!.priority ?? 0)) {
      pick = i
    }
  }

  if (pick === -1) return null

  queue.tasks[pick]!.status = 'running'
  queue.tasks[pick]!.started_at = new Date().toISOString()
  writeQueue(path, queue)
  return queue.tasks[pick]!
}

export function complete(path: string, id: string, result: WorkerResult): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task) return

  const terminalStatus: TaskStatus = result.status === 'done' ? 'done' : result.status
  task.status = terminalStatus
  task.finished_at = new Date().toISOString()
  task.result = result

  for (const file of result.files_changed) {
    queue.touched_files[file] = id
  }

  writeQueue(path, queue)
}

export function markConflict(path: string, id: string): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (task) {
    task.status = 'done_with_conflict'
    writeQueue(path, queue)
  }
}

export function markAwaitingReview(path: string, id: string, prUrl: string, branch: string): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task) return
  task.status = 'awaiting_review'
  task.pr_branch = branch
  task.pr_merged = false
  if (task.result) task.result.pr_url = prUrl
  writeQueue(path, queue)
}

// Called when the PR lands. Moves awaiting_review → done; for already-done tasks just sets the flag.
export function markPRMerged(path: string, id: string): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task) return
  task.pr_merged = true
  if (task.status === 'awaiting_review') task.status = 'done'
  writeQueue(path, queue)
}

export function updatePrCommentCursor(path: string, id: string, cursor: string): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task) return
  task.pr_comment_cursor = cursor
  writeQueue(path, queue)
}

export function autoAcknowledge(path: string, id: string): void {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task) return
  task.acknowledged = true
  writeQueue(path, queue)
}

export function resetInterrupted(path: string): void {
  const queue = readQueue(path)
  let changed = false
  for (const task of queue.tasks) {
    if (task.status === 'running') {
      task.status = 'pending'
      task.started_at = null
      changed = true
    }
  }
  if (changed) writeQueue(path, queue)
}

export function cancelTask(path: string, id: string): boolean {
  const queue = readQueue(path)
  const task = queue.tasks.find(t => t.id === id)
  if (!task || task.status !== 'pending') return false
  task.status = 'cancelled'
  writeQueue(path, queue)
  return true
}

export function getPendingResults(path: string, drain: boolean): Task[] {
  const queue = readQueue(path)
  const terminal: TaskStatus[] = ['done', 'done_with_conflict', 'needs_help', 'error']
  const results = queue.tasks.filter(t => terminal.includes(t.status) && !t.acknowledged)

  if (drain && results.length > 0) {
    const ids = new Set(results.map(t => t.id))
    for (const task of queue.tasks) {
      if (ids.has(task.id)) task.acknowledged = true
    }
    writeQueue(path, queue)
  }

  return results
}

export function getSnapshot(path: string): {
  running: Task[]
  queued: Task[]
  awaiting: Task[]
} {
  const queue = readQueue(path)
  return {
    running: queue.tasks.filter(t => t.status === 'running'),
    // Shown in scheduling order: highest priority first, then enqueue order.
    queued: queue.tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    awaiting: queue.tasks.filter(t => t.status === 'awaiting_review')
  }
}
