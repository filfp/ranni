import type { RunResult, Runner } from '../src/runner'

export interface Call {
  cmd: string
  args: string[]
}

type Reply = Partial<RunResult> | ((args: string[]) => Partial<RunResult>)

/** A runner that answers by `cmd sub-command` prefix, e.g. "gh pr list". Unknown commands are missing. */
export function fakeRunner(replies: Record<string, Reply>): Runner & { calls: Call[] } {
  const calls: Call[] = []
  const r = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const line = [cmd, ...args].join(' ')
    const key = Object.keys(replies)
      .sort((a, b) => b.length - a.length)
      .find(k => line.startsWith(k))
    if (!key) return { code: 127, stdout: '', stderr: `${cmd}: not found`, missing: true }
    const rep = replies[key]
    const v = typeof rep === 'function' ? rep(args) : rep
    return { code: 0, stdout: '', stderr: '', missing: false, ...v }
  }) as Runner & { calls: Call[] }
  r.calls = calls
  return r
}

export const ok = (stdout: string): Partial<RunResult> => ({ stdout })
export const fail = (stderr: string, code = 1): Partial<RunResult> => ({ code, stderr })

export function searchJson(
  items: { id: string; path: string; label?: string; links?: string[]; project?: string[]; metadata?: Record<string, unknown> }[],
): string {
  return JSON.stringify({
    formatVersion: 1,
    query: '',
    results: items.map(i => ({
      type: 'document',
      path: i.path,
      label: i.label ?? i.id,
      id: i.id,
      memberships: ['work'],
      links: (i.links ?? []).map(t => ({ sourcePath: i.path, href: t, text: t, status: 'canonical', targetPath: t })),
      backlinks: [],
      ...(i.project ? { project: i.project } : {}),
      ...(i.metadata ? { metadata: i.metadata } : {}),
    })),
  })
}
