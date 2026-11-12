import { RanniError } from './errors'
import type { Runner } from './runner'
import type { LinkRef, WorkItem } from './types'

export const SUPPORTED_FORMAT_VERSION = 1

const MIN_RELIC =
  'Ranni needs a relic with structured search: `relic search --kind <kind> --json` reporting formatVersion 1 with document metadata.'

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
