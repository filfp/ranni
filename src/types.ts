export type TaskStatus = 'pending' | 'running' | 'done' | 'done_with_conflict' | 'needs_help' | 'error' | 'cancelled'

export type Task = {
  id: string
  status: TaskStatus
  dir: string
  task: string
  context?: string
  links?: string[]
  relevant_files?: string[]
  depends_on?: string[]
  created_at: string
  started_at: string | null
  finished_at: string | null
  result: WorkerResult | null
  acknowledged: boolean
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
  touched_files: Record<string, string>
}

export type Config = {
  worker: { command: string; args: string[] }
  max_workers: number
  persist_runs: boolean
  dirs: Record<string, string>
  manager_context?: string
}
