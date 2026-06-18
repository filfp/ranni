import { enqueue, readQueue, writeQueue } from './queue.js';
import type { QueueFile, Task, WorkerResult } from './types.js';

export type ConflictInfo = {
  taskId: string
  conflictingFiles: Array<{ file: string; previousTaskId: string }>
}

export function detectConflict(result: WorkerResult, queue: QueueFile, taskId: string): ConflictInfo | null {
  const conflicts: ConflictInfo['conflictingFiles'] = []

  for (const file of result.files_changed) {
    const prev = queue.touched_files[file]
    if (prev && prev !== taskId) {
      conflicts.push({ file, previousTaskId: prev })
    }
  }

  return conflicts.length > 0 ? { taskId, conflictingFiles: conflicts } : null
}

async function getDiff(file: string, cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'diff', 'HEAD', '--', file], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output || '(no diff available)'
  } catch {
    return '(could not generate diff)'
  }
}

export async function handleConflict(
  queueFilePath: string,
  originalTask: Task,
  conflict: ConflictInfo,
  resolvedDir: string
): Promise<void> {
  const queue = readQueue(queueFilePath)
  const original = queue.tasks.find(t => t.id === originalTask.id)
  if (original) original.status = 'done_with_conflict'

  const existingResolutions = queue.tasks.filter(t => t.id.startsWith(`${originalTask.id}-conflict-`)).length

  const resolutionId = `${originalTask.id}-conflict-${existingResolutions + 1}`

  const diffSections: string[] = []
  for (const { file, previousTaskId } of conflict.conflictingFiles) {
    const diff = await getDiff(file, resolvedDir)
    diffSections.push(`File: ${file}\nFirst modified by task: ${previousTaskId}\n\nRejected diff:\n${diff}`)
  }

  const resolutionTask = `Resolve file conflict from task "${originalTask.id}".

The following files were already modified by an earlier worker. The first worker's version is on disk. Review the rejected diff below and apply any changes that are safe to merge without breaking the existing work.

${diffSections.join('\n\n---\n\n')}

If the changes cannot be safely merged, set status to "needs_help" and explain what a human needs to decide.`

  writeQueue(queueFilePath, queue)

  enqueue(queueFilePath, [
    {
      id: resolutionId,
      dir: originalTask.dir,
      task: resolutionTask
    }
  ])
}
