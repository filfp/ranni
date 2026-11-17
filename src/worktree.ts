import { lstatSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { mentions } from './derive'
import { idPrefix } from './kind'
import { searchWork } from './relic'
import type { Runner } from './runner'
import type { ItemSource, WorkItem } from './types'

export interface WorktreeEntry {
  path: string
  /** Short branch name; undefined for a detached HEAD or a bare repository. */
  branch?: string
  /** Git reports the worktree's folder as gone. */
  prunable: boolean
}

/** Parses `git worktree list --porcelain`. Pure. */
export function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of out.split(/\n\s*\n/)) {
    let path: string | undefined
    let branch: string | undefined
    let prunable = false
    let bare = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') bare = true
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true
    }
    if (path && !bare) entries.push({ path, branch, prunable })
  }
  return entries
}

/** The worktrees of the repository holding `cwd`, or [] when there is none or Git cannot say. */
export async function listWorktrees(run: Runner, cwd: string): Promise<WorktreeEntry[]> {
  const res = await run('git', ['worktree', 'list', '--porcelain'], { cwd })
  return res.code === 0 ? parseWorktrees(res.stdout) : []
}

export interface WorktreeRead {
  source: ItemSource
  /** Items of that worktree whose identity its branch names. */
  items: WorkItem[]
}

const realpathOr = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/**
 * Reads the work items an agent is changing in another worktree of the project's repository.
 * Only worktrees whose branch names an identity of the kind are searched, and from each only
 * the items its branch names are kept: the executor contract already ties a branch to its
 * work item, so nothing else is guessed. Search failures become notes, never errors.
 */
export async function readWorktrees(
  run: Runner,
  root: string,
  kind: string,
  entries: WorktreeEntry[],
  notes: string[],
): Promise<WorktreeRead[]> {
  const realRoot = realpathOr(root)
  const withReal = entries.map(e => ({ ...e, real: realpathOr(e.path) }))
  // The worktree status runs in: the deepest one containing the project.
  const here = withReal.filter(e => inside(e.real, realRoot)).sort((a, b) => b.real.length - a.real.length)[0]
  if (!here) return []
  const prefix = relative(here.real, realRoot)
  const pattern = `${idPrefix(kind)}-`
  const others = withReal.filter(
    e => e !== here && !e.prunable && e.branch && e.branch.toUpperCase().includes(pattern),
  )
  const reads = await Promise.all(
    others.map(async (e): Promise<WorktreeRead | undefined> => {
      const dir = prefix ? join(e.path, prefix) : e.path
      try {
        if (!lstatSync(join(dir, 'relic.yaml')).isFile()) return undefined
      } catch {
        return undefined
      }
      try {
        const { items } = await searchWork(run, dir, kind)
        const named = items.filter(it => mentions(e.branch!, it.id))
        return named.length ? { source: { root: dir, branch: e.branch! }, items: named } : undefined
      } catch (err) {
        notes.push(`Worktree ${e.path} (${e.branch}) could not be read: ${(err as Error).message}`)
        return undefined
      }
    }),
  )
  return reads.filter((r): r is WorktreeRead => r !== undefined)
}

const key = (it: WorkItem) => [...(it.project ?? []), it.id.toUpperCase()].join('\0')

/**
 * The checkout's items with each one a worktree's branch names replaced by that worktree's copy,
 * and items that exist only there added. When two worktrees name the same item, the first in
 * Git's listing wins and a note says so.
 */
export function overlayWorktrees(items: WorkItem[], reads: WorktreeRead[], notes: string[]): WorkItem[] {
  const out = [...items]
  const index = new Map(out.map((it, i) => [key(it), i]))
  const taken = new Map<string, ItemSource>()
  for (const { source, items: wt } of reads) {
    for (const it of wt) {
      const k = key(it)
      const first = taken.get(k)
      if (first) {
        notes.push(`${it.id} is named by branches ${first.branch} and ${source.branch} in two worktrees; showing ${first.branch}.`)
        continue
      }
      taken.set(k, source)
      const copy: WorkItem = { ...it, source }
      const i = index.get(k)
      if (i === undefined) {
        index.set(k, out.length)
        out.push(copy)
      } else out[i] = copy
    }
  }
  return out
}
