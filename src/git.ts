import { mentions } from './derive'
import type { Runner } from './runner'
import type { BranchEvidence, CommitEvidence, GitEvidence } from './types'

export interface RefInfo extends BranchEvidence {
  /** Short name without the remote prefix, used for identity matching. */
  bare: string
  full: string
  /** Reachable from the default branch tip. Set only in Git-only mode. */
  inDefault?: boolean
}

export interface RepoGit {
  available: boolean
  reason?: string
  refs: RefInfo[]
  /** Commits that carry at least one Work: trailer. */
  trailers: { sha: string; date: string; value: string }[]
  /** Default branch short name as origin/HEAD reports it (or main/master as a last resort). */
  defaultBranch?: string
  defaultTip?: string
}

const NO_GIT: RepoGit = { available: false, refs: [], trailers: [] }

/** One for-each-ref read and one log read. Both are bounded by the repository's own size. */
export async function readRepoGit(run: Runner, cwd: string): Promise<RepoGit> {
  const refsRes = await run(
    'git',
    [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(symref)',
      'refs/heads',
      'refs/remotes',
    ],
    { cwd },
  )
  if (refsRes.missing) return { ...NO_GIT, reason: 'git is not installed' }
  if (refsRes.code !== 0) {
    return { ...NO_GIT, reason: `not a Git repository (${firstLine(refsRes.stderr)})` }
  }
  const { refs, originHead } = parseRefs(refsRes.stdout)

  const logRes = await run(
    'git',
    [
      'log',
      '--all',
      '--no-color',
      '--format=%H%x1f%cI%x1f%(trailers:key=Work,valueonly,unfold,separator=%x1d)%x1e',
    ],
    { cwd },
  )
  // A repository without commits has no log; that is evidence of nothing, not a failure.
  const trailers = logRes.code === 0 ? parseLog(logRes.stdout) : []

  let defaultBranch = originHead
  if (!defaultBranch) {
    const local = ['main', 'master'].find(n => refs.some(r => !r.remote && r.bare === n))
    defaultBranch = local
  }
  const tipRef = defaultBranch ? findDefaultRef(refs, defaultBranch) : undefined
  return {
    available: true,
    refs,
    trailers,
    defaultBranch,
    defaultTip: tipRef?.tip,
  }
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? ''
}

export function parseRefs(out: string): { refs: RefInfo[]; originHead?: string } {
  const refs: RefInfo[] = []
  let originHead: string | undefined
  for (const line of out.split('\n')) {
    if (!line) continue
    const [full, tip, date, symref] = line.split('\t')
    if (!full) continue
    if (full.startsWith('refs/remotes/')) {
      const rest = full.slice('refs/remotes/'.length)
      const slash = rest.indexOf('/')
      const remote = rest.slice(0, slash)
      const bare = rest.slice(slash + 1)
      if (symref) {
        if (remote === 'origin' && bare === 'HEAD') {
          originHead = symref.replace(/^refs\/remotes\/origin\//, '')
        }
        continue
      }
      if (bare === 'HEAD') continue
      refs.push({ full, name: rest, bare, remote: true, tip, date })
    } else if (full.startsWith('refs/heads/')) {
      const bare = full.slice('refs/heads/'.length)
      refs.push({ full, name: bare, bare, remote: false, tip, date })
    }
  }
  return { refs, originHead }
}

export function parseLog(out: string): RepoGit['trailers'] {
  const res: RepoGit['trailers'] = []
  for (const rec of out.split('\x1e')) {
    const [sha, date, value] = rec.replace(/^\n+/, '').split('\x1f')
    if (!sha || !value || !value.trim()) continue
    res.push({ sha, date, value: value.replace(/\x1d/g, '\n') })
  }
  return res
}

function findDefaultRef(refs: RefInfo[], name: string): RefInfo | undefined {
  return refs.find(r => r.full === `refs/remotes/origin/${name}`) ?? refs.find(r => r.full === `refs/heads/${name}`)
}

/**
 * Git-only mode: which refs are fully merged into the default branch. One extra read,
 * made only when the Git host is unavailable.
 */
export async function readMerged(run: Runner, cwd: string, repo: RepoGit): Promise<Set<string>> {
  if (!repo.defaultBranch) return new Set()
  const ref = findDefaultRef(repo.refs, repo.defaultBranch)
  if (!ref) return new Set()
  const res = await run(
    'git',
    ['for-each-ref', `--merged=${ref.full}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'],
    { cwd },
  )
  if (res.code !== 0) return new Set()
  return new Set(res.stdout.split('\n').filter(Boolean))
}

/**
 * Evidence for one identity out of the repository-wide reads. A branch counts as merged
 * only when it is fully merged into the default branch and is not merely sitting on the
 * default tip: a fresh, empty branch is trivially merged. A fast-forwarded branch still
 * counts when commits carry the identity in a Work: trailer.
 */
export function gitEvidenceFor(repo: RepoGit, id: string): GitEvidence {
  const commits: CommitEvidence[] = repo.trailers
    .filter(t => mentions(t.value, id))
    .map(t => ({ sha: t.sha, date: t.date }))
  const branches: BranchEvidence[] = repo.refs
    .filter(r => mentions(r.bare, id))
    .map(r => ({
      name: r.name,
      remote: r.remote,
      tip: r.tip,
      date: r.date,
      merged: r.inDefault === undefined ? undefined : r.inDefault && (r.tip !== repo.defaultTip || commits.length > 0),
    }))
  return { branches, commits }
}

export function markMerged(repo: RepoGit, merged: Set<string>): void {
  for (const r of repo.refs) r.inDefault = merged.has(r.full)
}
