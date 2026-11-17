import { countFailingChecks, declaresWork, mentions } from './derive'
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
  if (/no git remotes|none of the git remotes|not a git repository|could not resolve to a repository/i.test(s)) {
    return 'this repository has no GitHub remote'
  }
  if (/auth|log in|login|token|credentials|401|403/i.test(s)) return 'gh is not authenticated (run `gh auth login`)'
  if (/resolve host|network|timed? ?out|dial tcp|connection|offline/i.test(s)) return 'no network to reach the Git host'
  return `gh failed: ${s.split('\n')[0] || 'no output'}`
}

const LIGHT_FIELDS = 'number,title,body,headRefName,baseRefName,state,url'
const FULL_FIELDS = 'number,title,body,headRefName,baseRefName,state,isDraft,reviewDecision,statusCheckRollup,url'

function parseList(stdout: string): Record<string, unknown>[] | undefined {
  try {
    const list = JSON.parse(stdout)
    return Array.isArray(list) ? list : undefined
  } catch {
    return undefined
  }
}

/**
 * Checks, review decisions and drafts are expensive for the host to compute, and only open pull
 * requests need them. So two listings run in parallel with the repository read: the open pull
 * requests with every field, and all of them with the light fields. An open pull request takes
 * its full record; a merged or closed one keeps the light record (no draft, review or checks).
 */
export async function readHost(run: Runner, cwd: string): Promise<HostRead> {
  const [repoRes, openRes, allRes] = await Promise.all([
    run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd }),
    run('gh', ['pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', FULL_FIELDS], { cwd }),
    run('gh', ['pr', 'list', '--state', 'all', '--limit', String(PR_LIMIT), '--json', LIGHT_FIELDS], { cwd }),
  ])
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

  if (allRes.code !== 0) return { ...NONE, reason: classifyGhFailure(allRes.stderr, allRes.missing) }
  if (openRes.code !== 0) return { ...NONE, reason: classifyGhFailure(openRes.stderr, openRes.missing) }
  const all = parseList(allRes.stdout)
  const open = parseList(openRes.stdout)
  if (!all || !open) return { ...NONE, reason: 'gh pr list returned unreadable output' }

  const full = new Map(open.map(p => [Number(p.number), p]))
  const merged = all.map(p => full.get(Number(p.number)) ?? p)
  // An open pull request older than the all-states window still counts.
  const listed = new Set(all.map(p => Number(p.number)))
  for (const p of open) if (!listed.has(Number(p.number))) merged.push(p)
  return {
    available: true,
    defaultBranch,
    owner,
    repo,
    pullRequests: merged.map(parsePr),
    truncated: all.length >= PR_LIMIT,
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

/**
 * Pull requests tied to the identity: mentioned in the title or head branch, or declared on
 * a `Work:` line in the body. A plain body mention is not evidence, so a PR saying
 * "depends on WORK-041" never makes WORK-041 look landed.
 */
export function prsFor<T extends { title: string; body: string; head: string }>(prs: T[], id: string, key = 'Work'): T[] {
  return prs.filter(p => mentions(p.title, id) || mentions(p.head, id) || declaresWork(p.body, id, key))
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
