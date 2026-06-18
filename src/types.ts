export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'done_with_conflict'
  | 'needs_help'
  | 'error'
  | 'cancelled'
  | 'awaiting_review'

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
  // PR tracking fields (set when auto_pr creates a branch)
  pr_branch?: string
  pr_merged?: boolean         // true once the PR lands in base_branch; gates depends_on satisfaction
  pr_comment_cursor?: string  // ISO timestamp — comments after this are unread (await_merge only)
  // Set on correction workers dispatched in response to review comments
  parent_task_id?: string
}

export type WorkerResult = {
  status: 'done' | 'needs_help' | 'error'
  summary: string
  files_changed: string[]
  message?: string
  exit_code: number
  pr_url?: string
}

export type QueueFile = {
  tasks: Task[]
  touched_files: Record<string, string>
}

export type GitConfig = {
  auto_pr: boolean
  branch_prefix: string
  base_branch: string
  await_merge: boolean
}

export type Config = {
  worker: { command: string; args: string[] }
  max_workers: number
  persist_runs: boolean
  git?: GitConfig
  dirs: Record<string, string>
  manager_context?: string
}
