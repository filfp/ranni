import { describe, expect, test } from 'bun:test'
import { countFailingChecks, deriveLabel, lastActivity, mentions } from '../src/derive'
import type { Evidence, PullRequestEvidence } from '../src/types'

const pr = (o: Partial<PullRequestEvidence> = {}): PullRequestEvidence => ({
  number: 1,
  title: '',
  url: '',
  state: 'OPEN',
  isDraft: false,
  baseRef: 'main',
  reviewDecision: '',
  failingChecks: 0,
  ...o,
})
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  git: { branches: [], commits: [] },
  pullRequests: [],
  mergedByGit: false,
  ...o,
})
const branch = { name: 'work/WORK-1-x', remote: false, tip: 'a', date: '2026-01-02T00:00:00Z' }

describe('mentions', () => {
  test('is case-insensitive and bounded', () => {
    expect(mentions('work/work-042-push', 'WORK-042')).toBe(true)
    expect(mentions('Work: WORK-042', 'WORK-042')).toBe(true)
    expect(mentions('WORK-0421', 'WORK-042')).toBe(false)
    expect(mentions('WORK-04', 'WORK-042')).toBe(false)
    expect(mentions('xWORK-042', 'WORK-042')).toBe(false)
    expect(mentions('', 'WORK-042')).toBe(false)
  })
})

describe('deriveLabel', () => {
  const dflt = 'main'
  test('not started without traces', () => {
    expect(deriveLabel({}, ev(), dflt)).toBe('not-started')
  })
  test('in flight with a branch or a trailer commit', () => {
    expect(deriveLabel({}, ev({ git: { branches: [branch], commits: [] } }), dflt)).toBe('in-flight')
    expect(deriveLabel({}, ev({ git: { branches: [], commits: [{ sha: 'a', date: 'x' }] } }), dflt)).toBe('in-flight')
  })
  test('in review with an open pull request', () => {
    expect(deriveLabel({}, ev({ pullRequests: [pr()] }), dflt)).toBe('in-review')
  })
  test('closed unmerged pull requests are not review', () => {
    expect(deriveLabel({}, ev({ pullRequests: [pr({ state: 'CLOSED' })] }), dflt)).toBe('not-started')
  })
  test('ready to close once a pull request merged into the default branch', () => {
    expect(deriveLabel({}, ev({ pullRequests: [pr({ state: 'MERGED' })] }), dflt)).toBe('ready-to-close')
  })
  test('a pull request merged elsewhere has not landed', () => {
    const e = ev({ pullRequests: [pr({ state: 'MERGED', baseRef: 'feature' })], git: { branches: [branch], commits: [] } })
    expect(deriveLabel({}, e, dflt)).toBe('in-flight')
  })
  test('ready to close beats in review', () => {
    const e = ev({ pullRequests: [pr(), pr({ number: 2, state: 'MERGED' })] })
    expect(deriveLabel({}, e, dflt)).toBe('ready-to-close')
  })
  test('git-only merged branch counts as merged evidence', () => {
    expect(deriveLabel({}, ev({ mergedByGit: true, git: { branches: [branch], commits: [] } }), dflt)).toBe('ready-to-close')
  })
  test('waiting beats everything, even an empty question', () => {
    const e = ev({ pullRequests: [pr({ state: 'MERGED' })] })
    expect(deriveLabel({ waiting: 'Which DB?' }, e, dflt)).toBe('waiting')
    expect(deriveLabel({ waiting: '' }, e, dflt)).toBe('waiting')
  })
})

describe('lastActivity', () => {
  test('is the newest of branch tips and trailer commits', () => {
    const e = ev({
      git: {
        branches: [branch],
        commits: [{ sha: 'b', date: '2026-03-01T00:00:00Z' }, { sha: 'c', date: '2026-02-01T00:00:00Z' }],
      },
    })
    expect(lastActivity(e)).toBe('2026-03-01T00:00:00Z')
    expect(lastActivity(ev())).toBeUndefined()
  })
})

describe('countFailingChecks', () => {
  test('counts failing check runs and status contexts', () => {
    expect(
      countFailingChecks([
        { conclusion: 'SUCCESS' },
        { conclusion: 'FAILURE' },
        { state: 'ERROR' },
        { conclusion: 'TIMED_OUT' },
        { status: 'IN_PROGRESS', conclusion: '' },
      ]),
    ).toBe(3)
    expect(countFailingChecks(undefined)).toBe(0)
  })
})

describe('declaresWork and prsFor', () => {
  test('only a Work: line in the body counts', async () => {
    const { declaresWork } = await import('../src/derive')
    expect(declaresWork('Summary\n\nWork: WORK-042', 'WORK-042')).toBe(true)
    expect(declaresWork('work: work-042, WORK-043', 'WORK-043')).toBe(true)
    expect(declaresWork('Depends on WORK-041', 'WORK-041')).toBe(false)
    expect(declaresWork('Work: WORK-0421', 'WORK-042')).toBe(false)
    expect(declaresWork('Homework: WORK-042', 'WORK-042')).toBe(false)
  })

  test('a plain body mention does not tie a PR to a work item', async () => {
    const { prsFor } = await import('../src/host')
    const prs = [
      { title: 'feat: api', body: 'Work: WORK-042\nDepends on WORK-041', head: 'feature/api' },
      { title: 'WORK-041 ui', body: '', head: 'x' },
      { title: 'misc', body: '', head: 'work/WORK-041-ui' },
    ]
    expect(prsFor(prs, 'WORK-042').map(p => p.title)).toEqual(['feat: api'])
    expect(prsFor(prs, 'WORK-041').map(p => p.title)).toEqual(['WORK-041 ui', 'misc'])
  })
})
