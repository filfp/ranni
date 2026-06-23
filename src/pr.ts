import { execSync } from 'child_process'
import { relative } from 'path'
import { markPRMerged, readQueue, updatePrCommentCursor, writeQueue } from './queue.js'
import type { Config, Task, WorkerResult } from './types.js'

// Promise-chain mutex: only one git operation runs at a time to avoid index corruption
let gate: Promise<void> = Promise.resolve()

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim()
}

function findGitRoot(dir: string): string {
  return run('git rev-parse --show-toplevel', dir)
}

function withGateLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const next = new Promise<void>(r => { release = r })
  const prev = gate
  gate = next
  return prev.then(fn).finally(release)
}

function gitPaths(resolvedDir: string, gitRoot: string, filesChanged: string[]): string[] {
  const rel = relative(gitRoot, resolvedDir)
  return filesChanged.map(f => (rel ? `${rel}/${f}` : f))
}

function stashAndCheckout(gitRoot: string, label: string, branch: string): { origBranch: string; stashed: boolean } {
  const origBranch = run('git rev-parse --abbrev-ref HEAD', gitRoot)
  const stashOut = run(`git stash push --include-untracked -m "ranni-${label}"`, gitRoot)
  const stashed = !stashOut.includes('No local changes to save')
  run(`git checkout ${branch}`, gitRoot)
  return { origBranch, stashed }
}

function restoreAndReturn(gitRoot: string, origBranch: string, stashed: boolean): void {
  run(`git checkout ${origBranch}`, gitRoot)
  if (stashed) run('git stash pop', gitRoot)
}

function cherryPickFromStash(gitRoot: string, paths: string[]): void {
  for (const p of paths) {
    try {
      run(`git checkout stash@{0} -- "${p}"`, gitRoot)
    } catch {
      // path may differ between resolvedDir and gitRoot — skip
    }
  }
}

// ──────────────────────────────────────────────
// Create branch + PR for a finished task
// ──────────────────────────────────────────────

export async function commitAndOpenPR(
  task: Task,
  result: WorkerResult,
  config: Config,
  resolvedDir: string
): Promise<{ prUrl: string; branch: string } | undefined> {
  const gitCfg = config.git
  if (!gitCfg?.auto_pr || result.status !== 'done' || result.files_changed.length === 0) {
    return undefined
  }
  return withGateLock(() => doCommitAndPR(task, result, gitCfg, resolvedDir))
}

async function doCommitAndPR(
  task: Task,
  result: WorkerResult,
  gitCfg: NonNullable<Config['git']>,
  resolvedDir: string
): Promise<{ prUrl: string; branch: string } | undefined> {
  const branch = `${gitCfg.branch_prefix}/${task.id}`

  let gitRoot: string
  try {
    gitRoot = findGitRoot(resolvedDir)
  } catch {
    process.stderr.write(`[ranni] PR skipped for ${task.id}: not in a git repository\n`)
    return undefined
  }

  const paths = gitPaths(resolvedDir, gitRoot, result.files_changed)
  let origBranch = gitCfg.base_branch
  let stashed = false

  try {
    origBranch = run('git rev-parse --abbrev-ref HEAD', gitRoot)

    const stashOut = run(`git stash push --include-untracked -m "ranni-temp-${task.id}"`, gitRoot)
    stashed = !stashOut.includes('No local changes to save')

    run(`git fetch origin ${gitCfg.base_branch} --quiet`, gitRoot)
    run(`git checkout -b ${branch} origin/${gitCfg.base_branch}`, gitRoot)

    if (stashed) cherryPickFromStash(gitRoot, paths)

    run(`git add -- ${paths.map(p => `"${p}"`).join(' ')}`, gitRoot)
    run(`git commit -m ${JSON.stringify(`${result.summary}\n\nTask: ${task.id}`)}`, gitRoot)
    run(`git push -u origin ${branch}`, gitRoot)

    restoreAndReturn(gitRoot, origBranch, stashed)

    const prBody = buildPrBody(task, result)
    const prUrl = run(
      `gh pr create --title ${JSON.stringify(result.summary)} --body ${JSON.stringify(prBody)} --base ${gitCfg.base_branch} --head ${branch}`,
      gitRoot
    )

    process.stderr.write(`[ranni] PR opened for ${task.id}: ${prUrl}\n`)
    return { prUrl, branch }
  } catch (err) {
    process.stderr.write(`[ranni] PR creation failed for ${task.id}: ${err}\n`)
    try { restoreAndReturn(gitRoot!, origBranch, stashed) } catch {}
    return undefined
  }
}

// ──────────────────────────────────────────────
// Push a correction worker's changes to an existing PR branch
// ──────────────────────────────────────────────

export async function pushToPRBranch(
  task: Task,
  result: WorkerResult,
  resolvedDir: string,
  prBranch: string
): Promise<void> {
  return withGateLock(() => doPushToPRBranch(task, result, resolvedDir, prBranch))
}

async function doPushToPRBranch(
  task: Task,
  result: WorkerResult,
  resolvedDir: string,
  prBranch: string
): Promise<void> {
  let gitRoot: string
  try {
    gitRoot = findGitRoot(resolvedDir)
  } catch {
    process.stderr.write(`[ranni] Push skipped for ${task.id}: not in a git repository\n`)
    return
  }

  const paths = gitPaths(resolvedDir, gitRoot, result.files_changed)
  let origBranch = prBranch
  let stashed = false

  try {
    ;({ origBranch, stashed } = stashAndCheckout(gitRoot, `correction-${task.id}`, prBranch))

    if (stashed) cherryPickFromStash(gitRoot, paths)

    run(`git add -- ${paths.map(p => `"${p}"`).join(' ')}`, gitRoot)
    run(`git commit -m "Address review feedback (task ${task.id})"`, gitRoot)
    run(`git push origin ${prBranch}`, gitRoot)

    restoreAndReturn(gitRoot, origBranch, stashed)
    process.stderr.write(`[ranni] Pushed correction for ${task.id} → ${prBranch}\n`)
  } catch (err) {
    process.stderr.write(`[ranni] Push correction failed for ${task.id}: ${err}\n`)
    try { restoreAndReturn(gitRoot!, origBranch, stashed) } catch {}
  }
}

// ──────────────────────────────────────────────
// Poll open PRs: merge detection (always) + comment relay (await_merge only)
// ──────────────────────────────────────────────

type CorrectionTask = Omit<Task, 'status' | 'created_at' | 'started_at' | 'finished_at' | 'result' | 'acknowledged'>

// Review feedback is time-sensitive: a correction worker jumps ahead of the
// normal backlog so the open PR moves forward instead of waiting its turn.
const CORRECTION_PRIORITY = 100

export async function pollPRStatus(
  qPath: string,
  config: Config,
  dispatch: (tasks: CorrectionTask[]) => void
): Promise<void> {
  const queue = readQueue(qPath)
  const awaitMerge = config.git?.await_merge ?? false

  // Track all tasks that have an open PR not yet confirmed merged
  const tracked = queue.tasks.filter(
    t => t.pr_branch && t.pr_merged !== true && (t.status === 'done' || t.status === 'awaiting_review')
  )
  if (tracked.length === 0) return

  for (const task of tracked) {
    const prUrl = task.result?.pr_url
    if (!prUrl) continue

    try {
      const resolvedDir = config.dirs[task.dir]
      if (!resolvedDir) continue

      let gitRoot: string
      try {
        gitRoot = findGitRoot(resolvedDir)
      } catch {
        continue
      }

      // Fetch comments only when babysitting an awaiting_review task
      const needComments = awaitMerge && task.status === 'awaiting_review'
      const fields = needComments ? 'state,comments' : 'state'
      const raw = run(`gh pr view "${prUrl}" --json ${fields}`, gitRoot)
      const data = JSON.parse(raw) as {
        state: string
        comments?: Array<{ body: string; createdAt: string; author: { login: string } }>
      }

      if (data.state === 'MERGED') {
        // Works for both done and awaiting_review — markPRMerged handles both
        markPRMerged(qPath, task.id)
        process.stderr.write(`[ranni] PR merged — ${task.id}\n`)
        continue
      }

      if (data.state === 'CLOSED' && task.status === 'awaiting_review') {
        const q = readQueue(qPath)
        const t = q.tasks.find(x => x.id === task.id)
        if (t) {
          t.status = 'error'
          if (t.result) t.result.message = 'PR closed without merging'
          writeQueue(qPath, q)
        }
        process.stderr.write(`[ranni] PR closed without merge — ${task.id}\n`)
        continue
      }

      // Comment relay only when babysitting
      if (!needComments) continue

      const cursor = task.pr_comment_cursor ?? '1970-01-01T00:00:00Z'
      const newComments = (data.comments ?? []).filter(c => c.createdAt > cursor)
      if (newComments.length === 0) continue

      const latestTime = newComments.reduce((m, c) => (c.createdAt > m ? c.createdAt : m), cursor)
      updatePrCommentCursor(qPath, task.id, latestTime)

      const existingCorrections = queue.tasks.filter(t => t.parent_task_id === task.id).length
      const correctionId = `${task.id}-correction-${existingCorrections + 1}`
      const commentsText = newComments.map(c => `**${c.author.login}**: ${c.body}`).join('\n\n')

      dispatch([{
        id: correctionId,
        dir: task.dir,
        task: buildCorrectionPrompt(task, commentsText),
        context: task.context,
        parent_task_id: task.id,
        priority: CORRECTION_PRIORITY
      }])

      process.stderr.write(`[ranni] ${newComments.length} new comment(s) on ${task.id} — dispatching ${correctionId} (priority)\n`)
    } catch (err) {
      process.stderr.write(`[ranni] Poll error for ${task.id}: ${err}\n`)
    }
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function buildCorrectionPrompt(task: Task, commentsText: string): string {
  const prUrl = task.result?.pr_url ?? '(see context)'
  return `You are addressing reviewer feedback on an open pull request.

PR: ${prUrl}

## Reviewer Comments
${commentsText}

## Original Task
${task.task}

Apply only the changes needed to satisfy the reviewer's comments. Do not commit, push, or open a new PR — the orchestrator handles that.`
}

function buildPrBody(task: Task, result: WorkerResult): string {
  const sections: string[] = []
  sections.push(`## Task\n${task.task}`)
  if (task.context) sections.push(`## Context\n${task.context}`)
  if (result.files_changed.length) {
    sections.push(`## Files Changed\n${result.files_changed.map(f => `- \`${f}\``).join('\n')}`)
  }
  if (result.message) sections.push(`## Notes\n${result.message}`)
  sections.push(`_Generated by [ranni](https://github.com/filfp/ranni) · task \`${task.id}\`_`)
  return sections.join('\n\n')
}
