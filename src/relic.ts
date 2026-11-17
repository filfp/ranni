import { RanniError } from './errors'
import type { Runner } from './runner'
import { KIND_KEY } from './kind'
import type { LinkRef, WorkItem } from './types'

export const SUPPORTED_FORMAT_VERSION = 1

const MIN_RELIC =
  'Ranni needs a relic with structured search: `relic search --kind <kind> --json` reporting formatVersion 1 with document metadata.'

export interface ProjectRoot {
  address: string[]
  /** Relative to the realpath of the folder holding the selected relic.yaml; `/`-separated, `.` for the root. */
  root: string
}

export interface SearchResult {
  items: WorkItem[]
  federated: boolean
  /** Relic 2.4.0+ federated search. Undefined when the field is absent. */
  projects?: ProjectRoot[]
}

/** Validates and converts the JSON of `relic search --json`. Pure. */
export function parseSearch(stdout: string): SearchResult {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new RanniError(`relic search did not return JSON. ${MIN_RELIC}`)
  }
  const root = json as { formatVersion?: unknown; results?: unknown; projects?: unknown }
  if (root === null || typeof root !== 'object' || root.formatVersion === undefined) {
    throw new RanniError(`relic search output has no formatVersion. ${MIN_RELIC}`)
  }
  if (root.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new RanniError(
      `relic search reports formatVersion ${String(root.formatVersion)}; this Ranni supports ${SUPPORTED_FORMAT_VERSION}. Update Ranni or Relic so they agree.`,
    )
  }
  if (!Array.isArray(root.results)) throw new RanniError('relic search output has no results array.')

  const items: WorkItem[] = []
  let federated = false
  for (const r of root.results as Record<string, unknown>[]) {
    if (r.type !== undefined && r.type !== 'document') continue
    if (typeof r.id !== 'string' || typeof r.path !== 'string') continue
    const project = Array.isArray(r.project) ? (r.project as unknown[]).map(String) : undefined
    if (project && project.length > 1) federated = true
    if (r.metadata === null || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) {
      throw new RanniError(`relic search results carry no metadata. ${MIN_RELIC}`)
    }
    const meta = r.metadata as Record<string, unknown>
    items.push({
      id: r.id,
      path: r.path,
      title: typeof r.label === 'string' ? r.label : r.id,
      project,
      waiting: 'waiting' in meta ? waitingText(meta.waiting) : undefined,
      links: parseLinks(r.links),
    })
  }
  return { items, federated, projects: parseProjects(root.projects) }
}

function parseProjects(v: unknown): ProjectRoot[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new RanniError('relic search output has a malformed projects list.')
  return (v as Record<string, unknown>[]).map(p => {
    const address = p?.address
    const root = p?.root
    if (!Array.isArray(address) || typeof root !== 'string' || !root) {
      throw new RanniError('relic search output has a malformed projects entry.')
    }
    if (root.startsWith('/') || /^[A-Za-z]:/.test(root) || root.split('/').includes('..')) {
      throw new RanniError(`relic search reports an unsafe project root "${root}".`)
    }
    return { address: address.map(String), root }
  })
}

function parseLinks(v: unknown): LinkRef[] {
  if (!Array.isArray(v)) return []
  const out: LinkRef[] = []
  for (const l of v as Record<string, unknown>[]) {
    const target = (l.targetPath ?? l.resolvedPath) as unknown
    out.push({
      href: String(l.href ?? ''),
      text: String(l.text ?? ''),
      targetPath: typeof target === 'string' ? target : undefined,
    })
  }
  return out
}

/** The waiting key is set: show its text. A bare key still escalates, with a placeholder. */
export function waitingText(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  return String(v).replace(/\s+/g, ' ').trim()
}

/**
 * The work kind the root project's shared ranni.md names, from Relic's search JSON, or
 * undefined when no shared document carries the key. Federation members' documents are
 * ignored: the root project decides. Pure.
 */
export function parseRanniKind(stdout: string): string | undefined {
  let json: { results?: unknown }
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new RanniError(`relic search did not return JSON. ${MIN_RELIC}`)
  }
  const kinds = new Set<string>()
  const paths: string[] = []
  for (const r of (Array.isArray(json?.results) ? json.results : []) as Record<string, unknown>[]) {
    if (r.type !== undefined && r.type !== 'document') continue
    if (Array.isArray(r.project) && r.project.length > 1) continue
    const meta = r.metadata as Record<string, unknown> | undefined
    const v = meta && typeof meta === 'object' ? meta[KIND_KEY] : undefined
    if (typeof v !== 'string' || !v.trim()) continue
    kinds.add(v.trim())
    paths.push(`${String(r.path)} (${v.trim()})`)
  }
  if (kinds.size > 1) {
    throw new RanniError(`Shared documents name different work kinds with ${KIND_KEY}: ${paths.join(', ')}. Keep one.`)
  }
  return [...kinds][0]
}

/** Asks Relic which kind ranni.md names. */
export async function findRanniKind(run: Runner, cwd: string): Promise<string | undefined> {
  const res = await run('relic', ['search', '--kind', 'shared', '--meta', KIND_KEY, '--json'], { cwd })
  if (res.missing) throw new RanniError(`relic was not found on PATH. Install Relic. ${MIN_RELIC}`)
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim()
    if (/unknown option/i.test(err)) {
      throw new RanniError(`The installed relic has no structured search (${err.split('\n')[0]}). ${MIN_RELIC}`)
    }
    throw new RanniError(`relic search failed (exit ${res.code}): ${err || 'no output'}`)
  }
  return parseRanniKind(res.stdout)
}

export async function searchWork(
  run: Runner,
  cwd: string,
  kind: string,
): Promise<SearchResult> {
  const res = await run('relic', ['search', '--kind', kind, '--json'], { cwd })
  if (res.missing) {
    throw new RanniError(`relic was not found on PATH. Install Relic. ${MIN_RELIC}`)
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim()
    if (/unknown option/i.test(err)) {
      throw new RanniError(`The installed relic has no structured search (${err.split('\n')[0]}). ${MIN_RELIC}`)
    }
    throw new RanniError(`relic search failed (exit ${res.code}): ${err || 'no output'}`)
  }
  return parseSearch(res.stdout)
}
