import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHuman } from '../src/render'
import { buildStatus } from '../src/status'
import { parseWorktrees } from '../src/worktree'
import { fail, fakeRunner, ok, searchJson } from './fakes'

const NOW = new Date('2026-06-10T12:00:00Z')

describe('parseWorktrees', () => {
  test('reads paths and branches, flags prunable, skips bare', () => {
    const out = [
      'worktree /r',
      'HEAD a',
      'branch refs/heads/main',
      '',
      'worktree /r/.wt/a',
      'HEAD b',
      'detached',
      '',
      'worktree /wt/b',
      'HEAD c',
      'branch refs/heads/ticket/TICKET-012-x',
      'locked claude agent',
      '',
      'worktree /gone',
      'HEAD d',
      'branch refs/heads/ticket/TICKET-013-y',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /bare.git',
      'bare',
      '',
    ].join('\n')
    expect(parseWorktrees(out)).toEqual([
      { path: '/r', branch: 'main', prunable: false },
      { path: '/r/.wt/a', branch: undefined, prunable: false },
      { path: '/wt/b', branch: 'ticket/TICKET-012-x', prunable: false },
      { path: '/gone', branch: 'ticket/TICKET-013-y', prunable: true },
    ])
  })
})

describe('status with worktrees', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A repository at <tmp>/repo with the project in app/, and worktrees at <tmp>/wt-*. */
  function layout(worktrees: { name: string; branch?: string; project?: boolean }[]) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ranni-wt-')))
    dirs.push(base)
    const repo = join(base, 'repo')
    mkdirSync(join(repo, 'app'), { recursive: true })
    writeFileSync(join(repo, 'app', 'relic.yaml'), '')
    const porcelain = [`worktree ${repo}\nHEAD a\nbranch refs/heads/main`]
    for (const w of worktrees) {
      const p = join(base, w.name)
      mkdirSync(join(p, 'app'), { recursive: true })
      if (w.project !== false) writeFileSync(join(p, 'app', 'relic.yaml'), '')
      porcelain.push(`worktree ${p}\nHEAD b\n${w.branch ? `branch refs/heads/${w.branch}` : 'detached'}`)
    }
    return { base, root: join(repo, 'app'), porcelain: porcelain.join('\n\n') + '\n' }
  }

  const t = (n: number, extra: object = {}) => ({ id: `TICKET-00${n}`, path: `t/TICKET-00${n}.md`, label: `T${n}`, ...extra })

  function runner(porcelain: string, byCwd: Record<string, object[] | 'fail'>) {
    return fakeRunner({
      'relic search --kind shared': ok(searchJson([])),
      'relic search --kind ticket': (_a, cwd) => {
        const v = byCwd[cwd ?? '']
        if (v === 'fail') return fail('boom')
        return ok(searchJson((v ?? []) as any))
      },
      'git worktree list': ok(porcelain),
      'git for-each-ref --format': ok(''),
      'git log': ok(''),
      'gh repo view': { code: 127, missing: true },
    })
  }

  test("the worktree whose branch names an item wins; other items stay the checkout's", async () => {
    const { base, root, porcelain } = layout([
      { name: 'wt-a', branch: 'ticket/TICKET-001-a' },
      { name: 'wt-b', branch: 'feature/no-ticket' },
      { name: 'wt-c' },
    ])
    const run = runner(porcelain, {
      [root]: [t(1), t(2)],
      [join(base, 'wt-a', 'app')]: [t(1, { metadata: { id: 'TICKET-001', waiting: 'Ship it?' } }), t(2, { label: 'stale copy' }), t(3)],
    })
    const m = await buildStatus({ run, now: NOW, cwd: root, projectRoot: root }, { kind: 'ticket', ids: [] })
    const by = Object.fromEntries(m.items.map(i => [i.id, i]))
    expect(by['TICKET-001'].waiting).toBe('Ship it?')
    expect(by['TICKET-001'].source).toEqual({ root: join(base, 'wt-a', 'app'), branch: 'ticket/TICKET-001-a' })
    expect(by['TICKET-002'].title).toBe('T2')
    expect(by['TICKET-002'].source).toBeUndefined()
    expect(by['TICKET-003']).toBeUndefined()
    // Only the worktree whose branch carries an identity of the kind is searched.
    const searched = run.calls.filter(c => c.cmd === 'relic' && c.args[2] === 'ticket')
    expect(searched).toHaveLength(2)
    expect(renderHuman(m)).toContain('worktree ticket/TICKET-001-a')
  })

  test('an item that exists only in its worktree is added', async () => {
    const { base, root, porcelain } = layout([{ name: 'wt-a', branch: 'ticket/TICKET-004-new' }])
    const run = runner(porcelain, { [root]: [t(1)], [join(base, 'wt-a', 'app')]: [t(1), t(4)] })
    const m = await buildStatus({ run, now: NOW, cwd: root, projectRoot: root }, { kind: 'ticket', ids: [] })
    expect(m.items.map(i => i.id).sort()).toEqual(['TICKET-001', 'TICKET-004'])
    expect(m.items.find(i => i.id === 'TICKET-004')!.source?.branch).toBe('ticket/TICKET-004-new')
  })

  test('two worktrees naming one item: the first wins, with a note; a failed read is a note', async () => {
    const { base, root, porcelain } = layout([
      { name: 'wt-a', branch: 'ticket/TICKET-001-a' },
      { name: 'wt-b', branch: 'ticket/TICKET-001-b' },
      { name: 'wt-c', branch: 'ticket/TICKET-002-c' },
      { name: 'wt-d', branch: 'ticket/TICKET-002-d', project: false },
    ])
    const run = runner(porcelain, {
      [root]: [t(1), t(2)],
      [join(base, 'wt-a', 'app')]: [t(1, { label: 'from a' })],
      [join(base, 'wt-b', 'app')]: [t(1, { label: 'from b' })],
      [join(base, 'wt-c', 'app')]: 'fail',
    })
    const m = await buildStatus({ run, now: NOW, cwd: root, projectRoot: root }, { kind: 'ticket', ids: [] })
    expect(m.items.find(i => i.id === 'TICKET-001')!.title).toBe('from a')
    expect(m.items.find(i => i.id === 'TICKET-002')!.source).toBeUndefined()
    expect(m.notes.some(n => n.includes('TICKET-001 is named by branches ticket/TICKET-001-a and ticket/TICKET-001-b'))).toBe(true)
    expect(m.notes.some(n => n.includes('wt-c') && n.includes('could not be read'))).toBe(true)
  })

  test('without Git worktrees, status reads the checkout only', async () => {
    const { root } = layout([])
    const run = fakeRunner({
      'relic search --kind shared': ok(searchJson([])),
      'relic search --kind ticket': ok(searchJson([t(1)])),
      'git worktree list': fail('fatal: not a git repository', 128),
    })
    const m = await buildStatus({ run, now: NOW, cwd: root, projectRoot: root }, { kind: 'ticket', ids: [] })
    expect(m.items.map(i => i.id)).toEqual(['TICKET-001'])
  })
})
