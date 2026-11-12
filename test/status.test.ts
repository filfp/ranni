import { describe, expect, test } from 'bun:test'
import { renderHuman, formatAge } from '../src/render'
import { buildStatus } from '../src/status'
import { classifyGhFailure, parsePr } from '../src/host'
import { fail, fakeRunner, ok, searchJson } from './fakes'

const NOW = new Date('2026-06-10T12:00:00Z')
const item = (n: number, extra: object = {}) => ({ id: `WORK-0${n}`, path: `w/WORK-0${n}.md`, label: `Item ${n}`, ...extra })
const FM = (waiting?: string) => `---\nid: x\n${waiting ? `waiting: ${waiting}\n` : ''}---\n`

const refsOut = [
  'refs/heads/main\tm1\t2026-06-01T00:00:00+00:00\t',
  'refs/heads/work/WORK-02-x\tb2\t2026-06-08T12:00:00+00:00\t',
  'refs/remotes/origin/main\tm1\t2026-06-01T00:00:00+00:00\t',
  'refs/remotes/origin/HEAD\tm1\t2026-06-01T00:00:00+00:00\trefs/remotes/origin/main',
].join('\n')
const logOut = ['c1\x1f2026-06-09T12:00:00+00:00\x1fWORK-03\x1e', 'c0\x1f2026-05-01T00:00:00+00:00\x1f\x1e'].join('\n')

const pr = (o: object) => ({
  number: 1,
  title: '',
  body: '',
  headRefName: '',
  baseRefName: 'main',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: '',
  statusCheckRollup: [],
  url: 'u',
  ...o,
})

function baseReplies(items: object[], prs: object[] | null, extra: Record<string, any> = {}) {
  return {
    'relic search': ok(searchJson(items as any)),
    'git for-each-ref --format': ok(refsOut),
    'git for-each-ref --merged=refs/remotes/origin/main': ok('refs/heads/main\nrefs/remotes/origin/main\n'),
    'git log': ok(logOut),
    'gh repo view': prs
      ? ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } }))
      : { code: 127, missing: true },
    'gh pr list': ok(JSON.stringify(prs ?? [])),
    ...extra,
  }
}

const deps = (run: ReturnType<typeof fakeRunner>, files: Record<string, string> = {}) => ({
  run,
  now: NOW,
  cwd: '/proj',
  projectRoot: '/proj',
  readFile: (p: string) => files[p],
})

describe('buildStatus with gh', () => {
  test('derives each label and the links between items', async () => {
    const items = [
      item(1, { links: ['w/WORK-02.md'] }),
      item(2),
      item(3),
      item(4),
      item(5),
    ]
    const prs = [
      pr({ number: 7, title: 'Do WORK-03', state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
      pr({ number: 8, headRefName: 'work/WORK-04-y', state: 'MERGED' }),
    ]
    const run = fakeRunner(
      baseReplies(items, prs, {
        'gh api graphql': ok(JSON.stringify({ data: { repository: { p7: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } } } } })),
      }),
    )
    const m = await buildStatus(deps(run, { '/proj/w/WORK-01.md': FM('Which DB?') }), { kind: 'work', ids: [] })
    const by = Object.fromEntries(m.items.map(i => [i.id, i]))
    expect(by['WORK-01'].label).toBe('waiting')
    expect(by['WORK-01'].waiting).toBe('Which DB?')
    expect(by['WORK-01'].links).toEqual([{ id: 'WORK-02', title: 'Item 2', label: 'in-flight' }])
    expect(by['WORK-02'].label).toBe('in-flight')
    expect(by['WORK-03'].label).toBe('in-review')
    expect(by['WORK-03'].pullRequests[0].unresolvedThreads).toBe(2)
    expect(by['WORK-03'].pullRequests[0].failingChecks).toBe(1)
    expect(by['WORK-04'].label).toBe('ready-to-close')
    expect(by['WORK-05'].label).toBe('not-started')
    expect(m.items.map(i => i.label)).toEqual(['waiting', 'ready-to-close', 'in-review', 'in-flight', 'not-started'])
    expect(m.defaultBranch).toBe('main')
    // one gh PR listing, one graphql, no git-only merged read
    expect(run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'pr')).toHaveLength(1)
    expect(run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'api')).toHaveLength(1)
    expect(run.calls.filter(c => c.cmd === 'git')).toHaveLength(2)
    const text = renderHuman(m)
    expect(text).toContain('changes requested · 2 unresolved threads · 1 failing check')
    expect(text).toContain('→ WORK-02 in flight')
  })

  test('sorts by last activity within a label, newest first', async () => {
    const run = fakeRunner(baseReplies([item(2), item(3)], []))
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.items.map(i => i.id)).toEqual(['WORK-03', 'WORK-02'])
    expect(m.items[0].ageSeconds).toBe(86400)
    expect(Object.keys(m).includes('stale')).toBe(false)
  })

  test('narrows to ids and rejects unknown ones', async () => {
    const run = fakeRunner(baseReplies([item(2), item(3)], []))
    const m = await buildStatus(deps(run), { kind: 'work', ids: ['work-03'] })
    expect(m.items.map(i => i.id)).toEqual(['WORK-03'])
    await expect(buildStatus(deps(run), { kind: 'work', ids: ['WORK-99'] })).rejects.toThrow(/WORK-99/)
  })

  test('federation: root repository only, with a limitation', async () => {
    const run = fakeRunner(baseReplies([item(2, { project: ['root', 'api'] }), item(3)], []))
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.notes.join(' ')).toMatch(/Federation.*root repository only/)
    expect(run.calls.filter(c => c.cmd === 'git' && c.args[0] === 'log')).toHaveLength(1)
  })
})

describe('gh missing fallback', () => {
  test('shows Git evidence only and says what is missing', async () => {
    const run = fakeRunner(baseReplies([item(2), item(3), item(4)], null))
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.sources.host).toEqual({ available: false, reason: 'gh is not installed' })
    expect(m.notes.join(' ')).toContain('gh is not installed')
    expect(m.items.find(i => i.id === 'WORK-02')!.label).toBe('in-flight')
    expect(m.items.every(i => i.pullRequests.length === 0)).toBe(true)
    expect(renderHuman(m)).toContain('! Git host evidence unavailable')
  })

  test('a branch fully merged into the default branch is merged evidence', async () => {
    const run = fakeRunner(
      baseReplies([item(2)], null, {
        'git for-each-ref --merged=refs/remotes/origin/main': ok('refs/heads/main\nrefs/heads/work/WORK-02-x\n'),
      }),
    )
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.items[0].label).toBe('ready-to-close')
    expect(renderHuman(m)).toContain('branch work/WORK-02-x merged into main')
  })

  test('an empty branch on the default tip is not merged evidence', async () => {
    const run = fakeRunner(
      baseReplies([item(2)], null, {
        'git for-each-ref --format': ok(refsOut.replace('b2', 'm1')),
        'git for-each-ref --merged=refs/remotes/origin/main': ok('refs/heads/main\nrefs/heads/work/WORK-02-x\n'),
      }),
    )
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.items[0].label).toBe('in-flight')
  })

  test('relic failures stop the command', async () => {
    const run = fakeRunner({ 'relic search': fail("error: unknown option '--kind'") })
    await expect(buildStatus(deps(run), { kind: 'work', ids: [] })).rejects.toThrow(/structured search/)
  })
})

describe('helpers', () => {
  test('classifies gh failures', () => {
    expect(classifyGhFailure('', true)).toBe('gh is not installed')
    expect(classifyGhFailure('To get started with GitHub CLI, please run: gh auth login', false)).toContain('not authenticated')
    expect(classifyGhFailure('error connecting to api.github.com: dial tcp: lookup', false)).toContain('no network')
    expect(classifyGhFailure('no git remotes found', false)).toContain('no GitHub remote')
  })
  test('parses pull requests', () => {
    const p = parsePr({ number: 3, state: 'merged', baseRefName: 'main', isDraft: true, reviewDecision: 'APPROVED' })
    expect(p).toMatchObject({ number: 3, state: 'MERGED', isDraft: true, reviewDecision: 'APPROVED' })
  })
  test('formats ages', () => {
    expect(formatAge(30)).toBe('now')
    expect(formatAge(3 * 3600)).toBe('3h')
    expect(formatAge(3 * 86400)).toBe('3d')
    expect(formatAge(30 * 86400)).toBe('4w')
  })
})
