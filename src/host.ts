import { countFailingChecks, mentions } from './derive'
import type { Runner } from './runner'
import type { PullRequestEvidence, ReviewDecision } from './types'

export const PR_LIMIT = 200
/** Upper bound of open pull requests whose review threads are fetched in one call. */
export const THREAD_PR_LIMIT = 50

export interface HostRead {
  available: boolean
  /** Why the host evidence is missing. */
  reason?: string
  defaultBranch?: string
  owner?: string
  repo?: string
  /** Every listed pull request, unfiltered. */
  pullRequests: (PullRequestEvidence & { body: string; head: string })[]
  /** True when the listing hit the limit and older pull requests may be missing. */
  truncated: boolean
}

const NONE: HostRead = { available: false, pullRequests: [], truncated: false }

export function classifyGhFailure(stderr: string, missing: boolean): string {
  if (missing) return 'gh is not installed'
  const s = stderr.trim()
  if (/auth|log in|login|token|credentials|401|403/i.test(s)) return 'gh is not authenticated (run `gh auth login`)'
  if (/resolve host|network|timed? ?out|dial tcp|connection|offline/i.test(s)) return 'no network to reach the Git host'
  if (/no git remotes|none of the git remotes|not a git repository|could not resolve to a repository/i.test(s)) {
    return 'this repository has no GitHub remote'
  }
  return `gh failed: ${s.split('\n')[0] || 'no output'}`
}

export async function readHost(run: Runner, cwd: string): Promise<HostRead> {
  const repoRes = await run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd })
  if (repoRes.code !== 0) return { ...NONE, reason: classifyGhFailure(repoRes.stderr, repoRes.missing) }
  let defaultBranch: string | undefined
  let owner: string | undefined
  let repo: string | undefined
  try {
    const j = JSON.parse(repoRes.stdout) as { nameWithOwner?: string; defaultBranchRef?: { name?: string } }
    defaultBranch = j.defaultBranchRef?.name
    const [o, r] = (j.nameWithOwner ?? '').split('/')
    owner = o
    repo = r
  } catch {
    return { ...NONE, reason: 'gh repo view returned unreadable output' }
  }

  const prRes = await run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      String(PR_LIMIT),
      '--json',
      'number,title,body,headRefName,baseRefName,state,isDraft,reviewDecision,statusCheckRollup,url',
    ],
    { cwd },
  )
  if (prRes.code !== 0) return { ...NONE, reason: classifyGhFailure(prRes.stderr, prRes.missing) }
  let list: Record<string, unknown>[]
  try {
    list = JSON.parse(prRes.stdout)
    if (!Array.isArray(list)) throw new Error('not a list')
  } catch {
    return { ...NONE, reason: 'gh pr list returned unreadable output' }
  }
  return {
    available: true,
    defaultBranch,
    owner,
    repo,
    pullRequests: list.map(parsePr),
    truncated: list.length >= PR_LIMIT,
  }
}

export function parsePr(p: Record<string, unknown>): PullRequestEvidence & { body: string; head: string } {
  const state = String(p.state ?? '').toUpperCase()
  return {
    number: Number(p.number),
    title: String(p.title ?? ''),
    body: String(p.body ?? ''),
    head: String(p.headRefName ?? ''),
    url: String(p.url ?? ''),
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: p.isDraft === true,
    baseRef: String(p.baseRefName ?? ''),
    reviewDecision: String(p.reviewDecision ?? '') as ReviewDecision,
    failingChecks: countFailingChecks(p.statusCheckRollup),
  }
}

/** Pull requests mentioning the identity in title, body or head branch. */
export function prsFor<T extends { title: string; body: string; head: string }>(prs: T[], id: string): T[] {
  return prs.filter(p => mentions(p.title, id) || mentions(p.body, id) || mentions(p.head, id))
}

/**
 * Unresolved review threads for the given open pull requests, in one bounded GraphQL
 * call. Returns undefined for a pull request whose count could not be read.
 */
export async function readThreads(
  run: Runner,
  cwd: string,
  host: Pick<HostRead, 'owner' | 'repo'>,
  numbers: number[],
): Promise<{ counts: Map<number, number>; error?: string; skipped: number }> {
  const counts = new Map<number, number>()
  if (numbers.length === 0) return { counts, skipped: 0 }
  const take = numbers.slice(0, THREAD_PR_LIMIT)
  const skipped = numbers.length - take.length
  if (!host.owner || !host.repo || !/^[\w.-]+$/.test(host.owner) || !/^[\w.-]+$/.test(host.repo)) {
    return { counts, error: 'repository owner or name unavailable', skipped }
  }
  const fields = take
    .map(n => `p${n}: pullRequest(number: ${Number(n)}) { reviewThreads(first: 100) { nodes { isResolved } } }`)
    .join(' ')
  const query = `query { repository(owner: "${host.owner}", name: "${host.repo}") { ${fields} } }`
  const res = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd })
  if (res.code !== 0) return { counts, error: classifyGhFailure(res.stderr, res.missing), skipped }
  try {
    const j = JSON.parse(res.stdout) as {
      data?: { repository?: Record<string, { reviewThreads?: { nodes?: { isResolved?: boolean }[] } } | null> }
    }
    const repo = j.data?.repository ?? {}
    for (const n of take) {
      const nodes = repo[`p${n}`]?.reviewThreads?.nodes
      if (Array.isArray(nodes)) counts.set(n, nodes.filter(t => t.isResolved === false).length)
    }
  } catch {
    return { counts, error: 'review thread response was unreadable', skipped }
  }
  return { counts, skipped }
}
