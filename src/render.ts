import { isMergedPr } from './derive'
import type { ItemStatus, StatusModel } from './status'
import { LABEL_ORDER, LABEL_TEXT } from './types'

export function formatAge(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d`
  const w = Math.floor(d / 7)
  if (d < 90) return `${w}w`
  const mo = Math.floor(d / 30)
  if (d < 365) return `${mo}mo`
  return `${Math.floor(d / 365)}y`
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function prLine(p: ItemStatus['pullRequests'][number]): string {
  const bits: string[] = []
  if (p.reviewDecision === 'CHANGES_REQUESTED') bits.push('changes requested')
  else if (p.reviewDecision === 'APPROVED') bits.push('approved')
  if (p.unresolvedThreads) bits.push(plural(p.unresolvedThreads, 'unresolved thread'))
  if (p.failingChecks) bits.push(plural(p.failingChecks, 'failing check'))
  const draft = p.isDraft ? ' (draft)' : ''
  return `PR #${p.number}${draft}${bits.length ? ' ' + bits.join(' · ') : ''}`
}

/** Evidence lines shown under an item, depending on its label. Pure. */
export function detailLines(it: ItemStatus, defaultBranch?: string): string[] {
  const lines: string[] = []
  if (it.label === 'waiting') lines.push(`? ${it.waiting || '(no question written)'}`)
  const merged = it.pullRequests.filter(p => isMergedPr(p, defaultBranch))
  const open = it.pullRequests.filter(p => p.state === 'OPEN')
  if (it.label === 'ready-to-close') {
    for (const p of merged) lines.push(`PR #${p.number} merged`)
    const mb = it.branches.filter(b => b.merged)
    if (merged.length === 0 && mb.length) lines.push(`branch ${mb[0].name} merged into ${defaultBranch ?? 'the default branch'}`)
  }
  if (it.label === 'in-review' || it.label === 'waiting') {
    for (const p of open) lines.push(prLine(p))
  }
  if (it.label === 'in-flight') {
    const parts: string[] = []
    if (it.branches.length) parts.push(plural(it.branches.length, 'branch'))
    if (it.trailerCommits) parts.push(plural(it.trailerCommits, 'trailer commit'))
    lines.push(parts.join(' · '))
  }
  for (const l of it.links) lines.push(`→ ${l.id} ${LABEL_TEXT[l.label].toLowerCase()}`)
  return lines
}

export function renderHuman(m: StatusModel): string {
  const out: string[] = []
  const n = m.items.length
  out.push(`${m.kind} · ${plural(n, 'item')}${m.defaultBranch ? ` · default branch ${m.defaultBranch}` : ''}`)
  for (const note of m.notes) out.push(`! ${note}`)
  if (n === 0) {
    out.push('', `No work items of kind "${m.kind}".`)
    return out.join('\n') + '\n'
  }
  const idW = Math.max(...m.items.map(i => i.id.length))
  for (const label of LABEL_ORDER) {
    const group = m.items.filter(i => i.label === label)
    if (group.length === 0) continue
    out.push('', `${LABEL_TEXT[label]} (${group.length})`)
    for (const it of group) {
      const age = it.ageSeconds !== undefined ? formatAge(it.ageSeconds) : '-'
      const where = it.project && it.project.length > 1 ? `[${it.project.slice(1).join('/')}] ` : ''
      out.push(`  ${it.id.padEnd(idW)}  ${where}${it.title}  ·  ${age}`)
      for (const l of detailLines(it, m.defaultBranch)) out.push(`  ${' '.repeat(idW)}  ${l}`)
    }
  }
  return out.join('\n') + '\n'
}
