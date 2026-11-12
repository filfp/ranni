export type Label = 'waiting' | 'ready-to-close' | 'in-review' | 'in-flight' | 'not-started'

export const LABEL_ORDER: Label[] = ['waiting', 'ready-to-close', 'in-review', 'in-flight', 'not-started']

export const LABEL_TEXT: Record<Label, string> = {
  waiting: 'Waiting on you',
  'ready-to-close': 'Ready to close',
  'in-review': 'In review',
  'in-flight': 'In flight',
  'not-started': 'Not started',
}

/** A work item as Relic's search read model describes it. */
export interface WorkItem {
  id: string
  /** Path relative to the owning Relic project. */
  path: string
  title: string
  /** Project address in a federated view, root first. Undefined without federation. */
  project?: string[]
  /** Set when the waiting key is present; empty string when it carries no question. */
  waiting?: string
  /** Outgoing links as resolved by Relic. */
  links: LinkRef[]
}

export interface LinkRef {
  href: string
  text: string
  targetPath?: string
}

export interface BranchEvidence {
  /** Short name, for example work/WORK-042-push or origin/work/WORK-042-push. */
  name: string
  remote: boolean
  tip: string
  /** ISO date of the tip commit. */
  date: string
  /** Fully merged into the default branch. Only computed in Git-only mode. */
  merged?: boolean
}

export interface CommitEvidence {
  sha: string
  date: string
  /** On the default branch. Only computed in Git-only mode. */
  merged?: boolean
}

export interface GitEvidence {
  branches: BranchEvidence[]
  /** Commits carrying a Work: trailer for the identity. */
  commits: CommitEvidence[]
}

export type ReviewDecision = 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | ''

export interface PullRequestEvidence {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  baseRef: string
  reviewDecision: ReviewDecision
  failingChecks: number
  /** Undefined when threads were not fetched or the fetch failed. */
  unresolvedThreads?: number
}

export interface Evidence {
  git: GitEvidence
  pullRequests: PullRequestEvidence[]
  /** Branch fully merged into the default branch counts as merged. */
  mergedByGit: boolean
}

export interface Derived {
  label: Label
  /** Newest commit or branch tip tied to the identity, ISO. */
  lastActivity?: string
}
