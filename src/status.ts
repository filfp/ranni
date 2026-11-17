import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { derive } from './derive'
import { RanniError } from './errors'
import { gitEvidenceFor, markMerged, readMerged, readRepoGit, repoToplevel } from './git'
import type { HostRead } from './host'
import type { RepoGit } from './git'
import { prsFor, readHost, readThreads } from './host'
import { declaresRecordKind, findProjectRoot } from './project'
import { LEGACY_KIND, trailerKey } from './kind'
import { findRanniKind, searchWork } from './relic'
import { listWorktrees, overlayWorktrees, readWorktrees } from './worktree'
import type { Runner } from './runner'
import { LABEL_ORDER } from './types'
import type { Evidence, ItemSource, Label, PullRequestEvidence, WorkItem } from './types'

export interface Deps {
  run: Runner
  now: Date
  cwd: string
  /** Defaults to the nearest relic.yaml ancestor of cwd. Tests may set it. */
  projectRoot?: string
}

export interface StatusOptions {
  /** Unset: the kind ranni.md names, else the legacy work kind. */
  kind?: string
  ids: string[]
}

export interface ItemStatus {
  id: string
  title: string
  path: string
  project?: string[]
  /** Set when the item was read from another worktree; its path is relative to `source.root`. */
  source?: ItemSource
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

interface RepoCtx {
  /** Repository top level (or the folder itself when it is in no repository). */
  dir: string
  git: RepoGit
  host: HostRead
  defaultBranch?: string
}

const realpathOr = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const tag = (ctx: RepoCtx, multi: boolean) => (multi ? `${ctx.dir}: ` : '')

/** A host read started before the kind was known; the host evidence does not depend on it. */
interface Prefetch {
  dir: string
  host: Promise<HostRead>
}

/**
 * Starts the read of the repository, once per repository: the Git and host reads run together.
 * The map is filled synchronously, in call order, so the order repositories are reported in
 * never depends on which read finishes first.
 */
function loadRepo(
  deps: Deps,
  dir: string,
  kind: string,
  repos: Map<string, Promise<RepoCtx>>,
  resolved: boolean,
  prefetch?: Prefetch,
): Promise<RepoCtx> {
  const { run } = deps
  const id = resolved ? realpathOr(dir) : dir
  const known = repos.get(id)
  if (known) return known
  const hostRead = prefetch && realpathOr(prefetch.dir) === realpathOr(dir) ? prefetch.host : readHost(run, dir)
  const ctx = Promise.all([readRepoGit(run, dir, trailerKey(kind)), hostRead]).then(
    ([git, host]): RepoCtx => ({ dir, git, host, defaultBranch: host.defaultBranch ?? git.defaultBranch }),
  )
  repos.set(id, ctx)
  return ctx
}

const sameProject = (a?: string[], b?: string[]) => (a ?? []).join('/') === (b ?? []).join('/')

export async function buildStatus(deps: Deps, options: StatusOptions): Promise<StatusModel> {
  const { run, cwd, now } = deps
  const root = deps.projectRoot ?? findProjectRoot(cwd)
  if (!root) throw new RanniError('No relic.yaml found above this directory. Run `relic init`, then `ranni init`.')
  // The host read needs neither the kind nor the work items, so it starts now and overlaps them.
  const prefetch: Prefetch = { dir: root, host: readHost(run, root) }
  const worktrees = listWorktrees(run, root)
  const opts = { ...options, kind: options.kind ?? (await findRanniKind(run, root)) ?? LEGACY_KIND }

  const notes: string[] = []
  // Agents work in other worktrees and rarely touch the main checkout before their pull
  // request merges, so the copy of an item in the worktree whose branch names it wins.
  const [{ items: checkout, federated, projects }, wtReads] = await Promise.all([
    searchWork(run, root, opts.kind),
    worktrees.then(w => readWorktrees(run, root, opts.kind, w, notes)),
  ])
  const all = overlayWorktrees(checkout, wtReads, notes)

  const wanted = opts.ids.map(i => i.toUpperCase())
  for (const w of wanted) {
    if (!all.some(i => i.id.toUpperCase() === w)) {
      throw new RanniError(`No work item ${w} of kind "${opts.kind}"${all.length ? '' : ' (the kind has no items; has `ranni init` run?)'}.`)
    }
  }

  if (all.length === 0 && !federated && declaresRecordKind(root, opts.kind) === false) {
    notes.push(
      `relic.yaml declares no "${opts.kind}" record kind. Run \`ranni init [--kind <kind>]\` to declare the work kind and name it in ranni.md, or pass --kind with a declared one.`,
    )
  }

  // Evidence is read per Git repository. Without Relic's project roots (or outside a
  // federation) that is the root repository; with them, each member's own folder decides,
  // and members sharing a repository share one read.
  const repos = new Map<string, Promise<RepoCtx>>()
  const repoOf = new Map<string, RepoCtx>()
  let rootCtx: RepoCtx
  if (projects) {
    const realRoot = realpathOr(root)
    const dirs = [realRoot, ...projects.map(p => (p.root === '.' ? realRoot : resolve(realRoot, p.root)))]
    const tops = await Promise.all(dirs.map(d => repoToplevel(run, d)))
    // Started in order (the first claims a repository shared by several members), awaited together.
    const loaded = await Promise.all(dirs.map((d, i) => loadRepo(deps, tops[i] ?? d, opts.kind, repos, true, prefetch)))
    rootCtx = loaded[0]!
    projects.forEach((p, i) => repoOf.set(p.address.join('\0'), p.root === '.' ? rootCtx : loaded[i + 1]!))
  } else {
    rootCtx = await loadRepo(deps, root, opts.kind, repos, false, prefetch)
    if (federated) {
      notes.push(
        'Federation: this Relic does not report member project roots (Relic 2.4.0+ does), so Git evidence comes from the root repository only. Work items of members may show less activity than they have.',
      )
    }
  }
  const ctxFor = (it: WorkItem) => repoOf.get((it.project ?? []).join('\0')) ?? rootCtx

  const key = trailerKey(opts.kind)
  const defaultBranch = rootCtx.defaultBranch
  const loadedRepos = await Promise.all(repos.values())
  const multi = loadedRepos.length > 1
  for (const ctx of loadedRepos) {
    if (!ctx.git.available) notes.push(`${tag(ctx, multi)}Git evidence unavailable: ${ctx.git.reason}.`)
    if (!ctx.host.available) {
      notes.push(
        `${tag(ctx, multi)}Git host evidence unavailable: ${ctx.host.reason}. Showing Git evidence only; pull request state, review decisions, threads and checks are missing.`,
      )
      if (ctx.git.available) {
        markMerged(ctx.git, await readMerged(run, ctx.dir, ctx.git, key))
        if (!ctx.defaultBranch) notes.push(`${tag(ctx, multi)}Default branch unknown: merged branches could not be detected.`)
      }
    } else {
      const matchedOpen = new Map<number, PullRequestEvidence>()
      for (const it of all) {
        if (ctxFor(it) !== ctx) continue
        for (const p of prsFor(ctx.host.pullRequests, it.id, key)) if (p.state === 'OPEN') matchedOpen.set(p.number, p)
      }
      const th = await readThreads(run, ctx.dir, ctx.host, [...matchedOpen.keys()])
      for (const [n, c] of th.counts) matchedOpen.get(n)!.unresolvedThreads = c
      if (th.error) notes.push(`${tag(ctx, multi)}Unresolved review threads unavailable: ${th.error}.`)
      if (th.skipped > 0) notes.push(`${tag(ctx, multi)}Review threads were read for ${matchedOpen.size - th.skipped} of ${matchedOpen.size} open pull requests (bounded).`)
      if (ctx.host.truncated) notes.push(`${tag(ctx, multi)}The pull request listing hit its limit; older pull requests may be missing.`)
    }
  }

  const derived = new Map<WorkItem, { ev: Evidence; label: Label; last?: string }>()
  for (const it of all) {
    const { git: repoGit, host } = ctxFor(it)
    const gitEv = repoGit.available ? gitEvidenceFor(repoGit, it.id) : { branches: [], commits: [] }
    const prs: PullRequestEvidence[] = host.available ? prsFor(host.pullRequests, it.id, key) : []
    const ev: Evidence = {
      git: gitEv,
      pullRequests: prs,
      mergedByGit: !host.available && (gitEv.branches.some(b => b.merged === true) || gitEv.commits.some(c => c.merged === true)),
    }
    const d = derive(it, ev, ctxFor(it).defaultBranch)
    derived.set(it, { ev, label: d.label, last: d.lastActivity })
  }

  const byPath = (it: WorkItem, path: string) =>
    all.find(o => o !== it && o.path === path && sameProject(o.project, it.project) && o.source?.root === it.source?.root) ??
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
        ...(it.source ? { source: it.source } : {}),
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
    sources: {
      relic: { available: true },
      git: { available: rootCtx.git.available, reason: rootCtx.git.reason },
      host: { available: rootCtx.host.available, ...(rootCtx.host.reason ? { reason: rootCtx.host.reason } : {}) },
    },
    notes,
    items: statuses,
  }
}
