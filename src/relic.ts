import { parse as parseYaml } from 'yaml'
import { RanniError } from './errors'
import type { Runner } from './runner'
import type { LinkRef, WorkItem } from './types'

export const SUPPORTED_FORMAT_VERSION = 1

const MIN_RELIC =
  'Ranni needs a relic with structured search: `relic search --kind <kind> --json` reporting formatVersion 1.'

export interface ReadFile {
  (path: string): string | undefined
}

/** Validates and converts the JSON of `relic search --json`. Pure. */
export function parseSearch(stdout: string): { items: WorkItem[]; federated: boolean } {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new RanniError(`relic search did not return JSON. ${MIN_RELIC}`)
  }
  const root = json as { formatVersion?: unknown; results?: unknown }
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
    const meta = r.metadata as Record<string, unknown> | undefined
    items.push({
      id: r.id,
      path: r.path,
      title: typeof r.label === 'string' ? r.label : r.id,
      project,
      waiting: meta && 'waiting' in meta ? waitingText(meta.waiting) : undefined,
      links: parseLinks(r.links),
    })
  }
  return { items, federated }
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
 * Reads only the `waiting` key of a work item's frontmatter. Returns undefined when the
 * key is absent. This is the sole place Ranni opens a corpus file.
 */
export function readWaiting(text: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return undefined
  let fm: unknown
  try {
    fm = parseYaml(m[1])
  } catch {
    return undefined
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return undefined
  if (!('waiting' in fm)) return undefined
  return waitingText((fm as Record<string, unknown>).waiting)
}

export async function searchWork(
  run: Runner,
  cwd: string,
  kind: string,
): Promise<{ items: WorkItem[]; federated: boolean }> {
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

/** Fills `waiting` for items whose search result carried no metadata. */
export function fillWaiting(
  items: WorkItem[],
  readFile: ReadFile,
  rootFor: (project: string[] | undefined) => string | undefined,
): { read: number; unreadable: number } {
  let read = 0
  let unreadable = 0
  for (const it of items) {
    if (it.waiting !== undefined) continue
    const root = rootFor(it.project)
    if (root === undefined) {
      unreadable++
      continue
    }
    const text = readFile(`${root.replace(/\/$/, '')}/${it.path}`)
    if (text === undefined) {
      unreadable++
      continue
    }
    read++
    it.waiting = readWaiting(text)
  }
  return { read, unreadable }
}
