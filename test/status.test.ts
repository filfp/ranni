import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHuman, formatAge } from '../src/render'
import { buildStatus } from '../src/status'
import { classifyGhFailure, parsePr } from '../src/host'
import { parseRanniKind } from '../src/relic'
import { fail, fakeRunner, ok, searchJson, withProjects } from './fakes'

const NOW = new Date('2026-06-10T12:00:00Z')
const item = (n: number, extra: object = {}) => ({ id: `WORK-0${n}`, path: `w/WORK-0${n}.md`, label: `Item ${n}`, ...extra })

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

/** What `gh pr list --state all` answers: no draft, review or check fields. */
const light = (p: any) => {
  const { isDraft, reviewDecision, statusCheckRollup, ...rest } = p
  return rest
}

function baseReplies(items: object[], prs: object[] | null, extra: Record<string, any> = {}) {
  return {
    'relic search': ok(searchJson(items as any)),
    'git for-each-ref --format': ok(refsOut),
    'git for-each-ref --merged=refs/remotes/origin/main': ok('refs/heads/main\nrefs/remotes/origin/main\n'),
    'git log': ok(logOut),
    'gh repo view': prs
      ? ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } }))
      : { code: 127, missing: true },
    'gh pr list --state open': ok(JSON.stringify((prs ?? []).filter((p: any) => p.state === 'OPEN'))),
    'gh pr list --state all': ok(JSON.stringify((prs ?? []).map(light))),
    ...extra,
  }
}

const deps = (run: ReturnType<typeof fakeRunner>) => ({
  run,
  now: NOW,
  cwd: '/proj',
  projectRoot: '/proj',
})

describe('buildStatus with gh', () => {
  test('open pull requests keep checks and review; merged ones come from the light listing', async () => {
    const run = fakeRunner(
      baseReplies([item(3), item(4)], [
        pr({ number: 7, title: 'Do WORK-03', isDraft: true, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }] }),
        pr({ number: 8, headRefName: 'work/WORK-04-y', state: 'MERGED', isDraft: true, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
      ]),
    )
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    const prs = (id: string) => m.items.find(i => i.id === id)!.pullRequests
    expect(prs('WORK-03')).toMatchObject([{ number: 7, state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED', failingChecks: 1 }])
    expect(prs('WORK-04')).toMatchObject([{ number: 8, state: 'MERGED', isDraft: false, reviewDecision: '', failingChecks: 0 }])
    expect(m.items.find(i => i.id === 'WORK-04')!.label).toBe('ready-to-close')
    const lists = run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'pr')
    expect(lists.map(c => c.args[3]).sort()).toEqual(['all', 'open'])
    const fields = (state: string) => lists.find(c => c.args[3] === state)!.args.at(-1)!
    expect(fields('open')).toContain('statusCheckRollup')
    expect(fields('all')).not.toMatch(/statusCheckRollup|reviewDecision|isDraft/)
  })

  test('an open pull request missing from the all-states window is still listed, and truncation follows that window', async () => {
    const many = Array.from({ length: 200 }, (_, i) => pr({ number: 1000 + i, state: 'MERGED' }))
    const run = fakeRunner(
      baseReplies([item(3)], many, {
        'gh pr list --state open': ok(JSON.stringify([pr({ number: 5, title: 'Do WORK-03' })])),
      }),
    )
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.items[0]!.pullRequests.map(p => p.number)).toEqual([5])
    expect(m.notes.some(n => n.includes('hit its limit'))).toBe(true)
  })

  test('derives each label and the links between items', async () => {
    const items = [
      item(1, { links: ['w/WORK-02.md'], metadata: { id: 'WORK-01', waiting: 'Which DB?' } }),
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
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
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
    // two gh PR listings (open, all), one graphql, no git-only merged read
    expect(run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'pr')).toHaveLength(2)
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

describe('federated evidence per member root', () => {
  const refs = (branch: string) =>
    `refs/heads/main\tm1\t2026-06-01T00:00:00+00:00\t\nrefs/heads/${branch}\tb\t2026-06-08T12:00:00+00:00\t`
  const members = () => [
    { address: ['root'], root: '.' },
    { address: ['root', 'api'], root: 'api' },
  ]
  const items = [item(1), item(2, { project: ['root', 'api'] })]
  /** Per-folder replies: toplevels maps a folder to its repository top level (absent: not a repository). */
  function runner(projects: { address: string[]; root: string }[] | undefined, toplevels: Record<string, string>, branches: Record<string, string> = {}) {
    const search = searchJson(items as any)
    return fakeRunner({
      'relic search': ok(projects ? withProjects(search, projects) : search),
      'git rev-parse --show-toplevel': (_a, cwd) => (cwd && toplevels[cwd] ? ok(toplevels[cwd] + '\n') : fail('fatal: not a git repository', 128)),
      'git for-each-ref --format': (_a, cwd) => (cwd && branches[cwd] ? ok(refs(branches[cwd])) : fail('fatal: not a git repository', 128)),
      'git log': ok(''),
      'gh repo view': ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } })),
      'gh pr list': ok('[]'),
    })
  }
  const logCalls = (r: ReturnType<typeof fakeRunner>) => r.calls.filter(c => c.cmd === 'git' && c.args[0] === 'log')

  test('a monorepo with two members is read once', async () => {
    const run = runner(members(), { '/proj': '/proj', '/proj/api': '/proj' }, { '/proj': 'work/WORK-02-x' })
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(logCalls(run)).toHaveLength(1)
    expect(run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'pr')).toHaveLength(2)
    expect(m.items.find(i => i.id === 'WORK-02')!.branches).toHaveLength(1)
    expect(m.notes.join(' ')).not.toMatch(/Federation/)
  })

  test('a member with its own nested repository is read in that repository', async () => {
    const run = runner(members(), { '/proj': '/proj', '/proj/api': '/proj/api' }, { '/proj': 'work/WORK-01-x', '/proj/api': 'work/WORK-02-y' })
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(logCalls(run)).toHaveLength(2)
    const by = Object.fromEntries(m.items.map(i => [i.id, i]))
    expect(by['WORK-02'].branches.map(b => b.name)).toEqual(['work/WORK-02-y'])
    expect(by['WORK-01'].branches.map(b => b.name)).toEqual(['work/WORK-01-x'])
  })

  test('without projects the root repository is used, with the pre-2.4.0 note', async () => {
    const run = runner(undefined, { '/proj': '/proj' }, { '/proj': 'work/WORK-02-x' })
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(run.calls.some(c => c.args[0] === 'rev-parse')).toBe(false)
    expect(m.notes.join(' ')).toMatch(/Federation.*2\.4\.0/)
  })

  test('a member outside any repository has no Git evidence and says so', async () => {
    const run = runner(members(), { '/proj': '/proj' }, { '/proj': 'work/WORK-01-x' })
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    const by = Object.fromEntries(m.items.map(i => [i.id, i]))
    expect(by['WORK-02'].branches).toEqual([])
    expect(by['WORK-01'].branches).toHaveLength(1)
    expect(m.notes.join(' ')).toMatch(/\/proj\/api: Git evidence unavailable/)
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

  test('a trailer commit on the default branch is merged evidence after its branch is gone', async () => {
    const run = fakeRunner(baseReplies([item(3)], null, { 'git rev-list': ok('c1\n') }))
    const m = await buildStatus(deps(run), { kind: 'work', ids: [] })
    expect(m.items[0].label).toBe('ready-to-close')
    expect(m.items[0].mergedTrailerCommits).toBe(1)
    expect(renderHuman(m)).toContain('1 trailer commit on main')
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
    expect(classifyGhFailure('none of the git remotes configured point to a known GitHub host. use `gh auth login`', false)).toContain('no GitHub remote')
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

describe('undeclared work kind', () => {
  const withYaml = async (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'ranni-kind-'))
    try {
      writeFileSync(join(dir, 'relic.yaml'), yaml)
      const run = fakeRunner(baseReplies([], []))
      return await buildStatus({ ...deps(run), projectRoot: dir }, { kind: 'work', ids: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('says the kind is not declared and how to fix it', async () => {
    const m = await withYaml('topology:\n  specs: .relic/specs\n  records:\n    adr: .relic/records/decisions\n')
    expect(m.notes.join(' ')).toContain('relic.yaml declares no "work" record kind')
    expect(renderHuman(m)).toContain('Run `ranni init')
  })

  test('stays quiet when the kind is declared but has no items', async () => {
    const m = await withYaml('topology:\n  specs: .relic/specs\n  records:\n    work: .relic/records/work\n')
    expect(m.notes.join(' ')).not.toContain('declares no')
  })
})

describe('the kind ranni.md names', () => {
  const shared = (docs: { path: string; kind?: string; project?: string[] }[]) =>
    JSON.stringify({
      formatVersion: 1,
      results: docs.map(d => ({ type: 'document', path: d.path, id: 'SHARED-ranni', memberships: ['shared'], ...(d.project ? { project: d.project } : {}), metadata: d.kind ? { 'ranni-kind': d.kind } : {} })),
    })

  test('parses it, ignores federation members, and refuses two different kinds', () => {
    expect(parseRanniKind(shared([]))).toBeUndefined()
    expect(parseRanniKind(shared([{ path: '.relic/shared/ranni.md', kind: 'ticket' }]))).toBe('ticket')
    expect(parseRanniKind(shared([{ path: 'a', kind: 'ticket' }, { path: 'b', kind: 'task', project: ['root', 'api'] }]))).toBe('ticket')
    expect(() => parseRanniKind(shared([{ path: 'a', kind: 'ticket' }, { path: 'b', kind: 'task' }]))).toThrow(/different work kinds/)
  })

  test('status without --kind searches that kind and reads its trailer', async () => {
    const run = fakeRunner({
      'relic search --kind shared --meta ranni-kind': ok(shared([{ path: '.relic/shared/ranni.md', kind: 'ticket' }])),
      'relic search --kind ticket': ok(searchJson([{ id: 'TICKET-01', path: 't/TICKET-01.md' }])),
      'git for-each-ref --format': ok(refsOut),
      'git log': ok('c9\x1f2026-06-09T12:00:00+00:00\x1fTICKET-01\x1e'),
      'gh repo view': ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } })),
      'gh pr list --state open': ok(JSON.stringify([pr({ number: 9, body: 'Ticket: TICKET-01' })])),
      'gh pr list --state all': ok(JSON.stringify([light(pr({ number: 9, body: 'Ticket: TICKET-01' }))])),
      'gh api graphql': ok(JSON.stringify({ data: {} })),
    })
    const m = await buildStatus(deps(run), { ids: [] })
    expect(m.kind).toBe('ticket')
    expect(m.items[0]).toMatchObject({ id: 'TICKET-01', label: 'in-review', trailerCommits: 1 })
    const log = run.calls.find(c => c.cmd === 'git' && c.args[0] === 'log')!
    expect(log.args.join(' ')).toContain('trailers:key=Ticket,')
  })

  test('falls back to the work kind when no ranni.md names one', async () => {
    const run = fakeRunner(baseReplies([item(1)], []))
    const m = await buildStatus(deps(run), { ids: [] })
    expect(m.kind).toBe('work')
  })
})
