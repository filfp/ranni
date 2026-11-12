import type { Derived, Evidence, Label, PullRequestEvidence } from './types'

/**
 * Whether `text` mentions the identity, case-insensitively. The identity must not be
 * glued to more letters or digits, so WORK-04 is not found inside WORK-042.
 */
export function mentions(text: string, id: string): boolean {
  if (!text || !id) return false
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i').test(text)
}

/**
 * Whether `body` declares the identity on a `Work:` line, the same shape as the commit
 * trailer. Several identities may share one line, separated by commas or spaces. Plain
 * mentions elsewhere in the body ("depends on WORK-041") do not count.
 */
export function declaresWork(body: string, id: string): boolean {
  if (!body || !id) return false
  for (const match of body.matchAll(/^[ \t]*Work:[ \t]*(.+)$/gim)) {
    if (match[1]!.split(/[\s,]+/).some(token => token.toLowerCase() === id.toLowerCase())) return true
  }
  return false
}

export function newest(dates: (string | undefined)[]): string | undefined {
  let best: string | undefined
  let bestT = -Infinity
  for (const d of dates) {
    if (!d) continue
    const t = Date.parse(d)
    if (Number.isNaN(t)) continue
    if (t > bestT) {
      bestT = t
      best = d
    }
  }
  return best
}

export function lastActivity(e: Evidence): string | undefined {
  return newest([...e.git.branches.map(b => b.date), ...e.git.commits.map(c => c.date)])
}

export function isMergedPr(pr: PullRequestEvidence, defaultBranch: string | undefined): boolean {
  if (pr.state !== 'MERGED') return false
  // A PR merged into another branch has not landed on the default branch yet.
  return !defaultBranch || !pr.baseRef || pr.baseRef === defaultBranch
}

export function openPrs(e: Evidence): PullRequestEvidence[] {
  return e.pullRequests.filter(p => p.state === 'OPEN')
}

/**
 * The first label that applies, as in the spec:
 * waiting, ready to close, in review, in flight, not started.
 */
export function deriveLabel(
  item: { waiting?: string },
  e: Evidence,
  defaultBranch: string | undefined,
): Label {
  if (item.waiting !== undefined) return 'waiting'
  if (e.mergedByGit || e.pullRequests.some(p => isMergedPr(p, defaultBranch))) return 'ready-to-close'
  if (openPrs(e).length > 0) return 'in-review'
  if (e.git.branches.length > 0 || e.git.commits.length > 0) return 'in-flight'
  return 'not-started'
}

export function derive(
  item: { waiting?: string },
  e: Evidence,
  defaultBranch: string | undefined,
): Derived {
  return { label: deriveLabel(item, e, defaultBranch), lastActivity: lastActivity(e) }
}

/** Failing check conclusions as GitHub reports them for check runs and status contexts. */
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])

export function countFailingChecks(rollup: unknown): number {
  if (!Array.isArray(rollup)) return 0
  let n = 0
  for (const c of rollup as Record<string, unknown>[]) {
    const v = String(c.conclusion ?? c.state ?? '').toUpperCase()
    if (FAILING.has(v)) n++
  }
  return n
}
