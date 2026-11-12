import { derive } from './derive'
import { RanniError } from './errors'
import { gitEvidenceFor, markMerged, readMerged, readRepoGit } from './git'
import { prsFor, readHost, readThreads } from './host'
import { declaresRecordKind, findProjectRoot } from './project'
import { searchWork } from './relic'
import type { Runner } from './runner'
import { LABEL_ORDER } from './types'
import type { Evidence, Label, PullRequestEvidence, WorkItem } from './types'

export interface Deps {
  run: Runner
  now: Date
  cwd: string
  /** Defaults to the nearest relic.yaml ancestor of cwd. Tests may set it. */
  projectRoot?: string
}

export interface StatusOptions {
  kind: string
  ids: string[]
}

export interface ItemStatus {
  id: string
  title: string
  path: string
  project?: string[]
  label: Label
  waiting?: string
  lastActivity?: string
  ageSeconds?: number
  branches: { name: string; remote: boolean; date: string; merged?: boolean }[]
  trailerCommits: number
  /** Trailer commits on the default branch. Only present in Git-only mode. */
  mergedTrailerCommits?: number
  pullRequests: PullRequestEvidence[]
  links: { id: string; title: string; label: Label }[]
}

export interface SourceState {
  available: boolean
  reason?: string
}

export interface StatusModel {
  formatVersion: 1
  kind: string
  generatedAt: string
  root: string
  defaultBranch?: string
  sources: { relic: SourceState; git: SourceState; host: SourceState }
  /** Limitations the reader should know about, in plain language. */
  notes: string[]
  items: ItemStatus[]
}

const sameProject = (a?: string[], b?: string[]) => (a ?? []).join('/') === (b ?? []).join('/')

export async function buildStatus(deps: Deps, opts: StatusOptions): Promise<StatusModel> {
  const { run, cwd, now } = deps
  const root = deps.projectRoot ?? findProjectRoot(cwd)
  if (!root) throw new RanniError('No relic.yaml found above this directory. Run `relic init`, then `ranni init`.')

  const notes: string[] = []
  const { items: all, federated } = await searchWork(run, root, opts.kind)

  const wanted = opts.ids.map(i => i.toUpperCase())
  for (const w of wanted) {
    if (!all.some(i => i.id.toUpperCase() === w)) {
      throw new RanniError(`No work item ${w} of kind "${opts.kind}"${all.length ? '' : ' (the kind has no items; has `ranni init` run?)'}.`)
    }
  }

  if (all.length === 0 && !federated && declaresRecordKind(root, opts.kind) === false) {
    notes.push(
      `relic.yaml declares no "${opts.kind}" record kind. Run \`ranni init\` to declare the work kind, or pass --kind with a declared one.`,
    )
  }

  if (federated) {
    notes.push(
      'Federation: Relic reports member project addresses but not their filesystem roots, so Git evidence comes from the root repository only. Work items of members may show less activity than they have.',
    )
  }

  // Git: one for-each-ref and one log for the whole repository.
  const repoGit = await readRepoGit(run, root)
  const git = { available: repoGit.available, reason: repoGit.reason }
  if (!repoGit.available) notes.push(`Git evidence unavailable: ${repoGit.reason}.`)

  // Git host: one PR listing, plus one bounded GraphQL call for open matching PRs.
  const host = await readHost(run, root)
  let defaultBranch = host.defaultBranch ?? repoGit.defaultBranch
  if (!host.available) {
    notes.push(
      `Git host evidence unavailable: ${host.reason}. Showing Git evidence only; pull request state, review decisions, threads and checks are missing.`,
    )
    if (repoGit.available) {
      markMerged(repoGit, await readMerged(run, root, repoGit))
      if (!defaultBranch) notes.push('Default branch unknown: merged branches could not be detected.')
    }
  } else {
    const matchedOpen = new Map<number, PullRequestEvidence>()
    for (const it of all) {
      for (const p of prsFor(host.pullRequests, it.id)) if (p.state === 'OPEN') matchedOpen.set(p.number, p)
    }
    const th = await readThreads(run, root, host, [...matchedOpen.keys()])
    for (const [n, c] of th.counts) matchedOpen.get(n)!.unresolvedThreads = c
    if (th.error) notes.push(`Unresolved review threads unavailable: ${th.error}.`)
    if (th.skipped > 0) notes.push(`Review threads were read for ${matchedOpen.size - th.skipped} of ${matchedOpen.size} open pull requests (bounded).`)
    if (host.truncated) notes.push('The pull request listing hit its limit; older pull requests may be missing.')
  }

  const derived = new Map<WorkItem, { ev: Evidence; label: Label; last?: string }>()
  for (const it of all) {
    const gitEv = repoGit.available ? gitEvidenceFor(repoGit, it.id) : { branches: [], commits: [] }
    const prs: PullRequestEvidence[] = host.available ? prsFor(host.pullRequests, it.id) : []
    const ev: Evidence = {
      git: gitEv,
      pullRequests: prs,
      mergedByGit: !host.available && (gitEv.branches.some(b => b.merged === true) || gitEv.commits.some(c => c.merged === true)),
    }
    const d = derive(it, ev, defaultBranch)
    derived.set(it, { ev, label: d.label, last: d.lastActivity })
  }

  const byPath = (it: WorkItem, path: string) =>
    all.find(o => o !== it && o.path === path && sameProject(o.project, it.project))

  const statuses: ItemStatus[] = all
    .filter(it => wanted.length === 0 || wanted.includes(it.id.toUpperCase()))
    .map(it => {
      const { ev, label, last } = derived.get(it)!
      const seen = new Set<string>()
      const links: ItemStatus['links'] = []
      for (const l of it.links) {
        if (!l.targetPath) continue
        const t = byPath(it, l.targetPath)
        if (!t || seen.has(t.id)) continue
        seen.add(t.id)
        links.push({ id: t.id, title: t.title, label: derived.get(t)!.label })
      }
      return {
        id: it.id,
        title: it.title,
        path: it.path,
        ...(it.project ? { project: it.project } : {}),
        label,
        ...(it.waiting !== undefined ? { waiting: it.waiting } : {}),
        ...(last ? { lastActivity: last, ageSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(last)) / 1000)) } : {}),
        branches: ev.git.branches.map(b => ({ name: b.name, remote: b.remote, date: b.date, ...(b.merged !== undefined ? { merged: b.merged } : {}) })),
        trailerCommits: ev.git.commits.length,
        ...(ev.git.commits.some(c => c.merged !== undefined)
          ? { mergedTrailerCommits: ev.git.commits.filter(c => c.merged).length }
          : {}),
        pullRequests: ev.pullRequests,
        links,
      }
    })

  statuses.sort((a, b) => {
    const la = LABEL_ORDER.indexOf(a.label)
    const lb = LABEL_ORDER.indexOf(b.label)
    if (la !== lb) return la - lb
    const ta = a.lastActivity ? Date.parse(a.lastActivity) : -Infinity
    const tb = b.lastActivity ? Date.parse(b.lastActivity) : -Infinity
    if (ta !== tb) return tb - ta
    return a.id.localeCompare(b.id)
  })

  return {
    formatVersion: 1,
    kind: opts.kind,
    generatedAt: now.toISOString(),
    root,
    ...(defaultBranch ? { defaultBranch } : {}),
    sources: { relic: { available: true }, git, host: { available: host.available, ...(host.reason ? { reason: host.reason } : {}) } },
    notes,
    items: statuses,
  }
}
