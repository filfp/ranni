import { describe, expect, test } from 'bun:test'
import { RanniError } from '../src/errors'
import { fillWaiting, parseSearch, readWaiting, searchWork } from '../src/relic'
import type { WorkItem } from '../src/types'
import { fail, fakeRunner, ok, searchJson } from './fakes'

describe('parseSearch', () => {
  test('reads items, titles and outgoing links', () => {
    const { items, federated } = parseSearch(
      searchJson([{ id: 'WORK-001', path: 'a.md', label: 'A', links: ['b.md'] }, { id: 'WORK-002', path: 'b.md' }]),
    )
    expect(federated).toBe(false)
    expect(items.map(i => i.id)).toEqual(['WORK-001', 'WORK-002'])
    expect(items[0].title).toBe('A')
    expect(items[0].links[0].targetPath).toBe('b.md')
  })
  test('requires formatVersion 1', () => {
    expect(() => parseSearch('{"results":[]}')).toThrow(RanniError)
    expect(() => parseSearch('{"formatVersion":2,"results":[]}')).toThrow(/formatVersion 2/)
    expect(() => parseSearch('not json')).toThrow(/structured search/)
  })
  test('flags federated results', () => {
    const { federated } = parseSearch(searchJson([{ id: 'W-1', path: 'a.md', project: ['root', 'api'] }]))
    expect(federated).toBe(true)
  })
  test('uses metadata when the search result carries it', () => {
    const { items } = parseSearch(searchJson([{ id: 'W-1', path: 'a.md', metadata: { waiting: 'Which?' } }]))
    expect(items[0].waiting).toBe('Which?')
  })
})

describe('searchWork', () => {
  test('asks relic for the kind as JSON', async () => {
    const run = fakeRunner({ 'relic search': ok(searchJson([])) })
    await searchWork(run, '/p', 'work')
    expect(run.calls[0].args).toEqual(['search', '--kind', 'work', '--json'])
  })
  test('missing relic gives a clear error', async () => {
    await expect(searchWork(fakeRunner({}), '/p', 'work')).rejects.toThrow(/relic was not found.*structured search/)
  })
  test('older relic without --kind names the minimum', async () => {
    const run = fakeRunner({ 'relic search': fail("error: unknown option '--kind'", 1) })
    await expect(searchWork(run, '/p', 'work')).rejects.toThrow(/no structured search/)
  })
  test('output without formatVersion is rejected', async () => {
    const run = fakeRunner({ 'relic search': ok('{"query":"","results":[]}') })
    await expect(searchWork(run, '/p', 'work')).rejects.toThrow(/formatVersion/)
  })
})

describe('waiting from frontmatter', () => {
  test('reads only the waiting key', () => {
    expect(readWaiting('---\nid: W-1\nwaiting: Use Postgres or SQLite?\n---\n# T\nwaiting: no\n')).toBe('Use Postgres or SQLite?')
    expect(readWaiting('---\nid: W-1\n---\n# T\n')).toBeUndefined()
    expect(readWaiting('# no frontmatter')).toBeUndefined()
  })
  test('a bare key still escalates', () => {
    expect(readWaiting('---\nid: W-1\nwaiting:\n---\n')).toBe('')
  })
  test('fillWaiting reads each result file once and skips unreachable projects', () => {
    const items: WorkItem[] = [
      { id: 'W-1', path: 'a.md', title: 'a', links: [] },
      { id: 'W-2', path: 'b.md', title: 'b', links: [], project: ['root', 'api'] },
      { id: 'W-3', path: 'c.md', title: 'c', links: [], waiting: 'kept' },
    ]
    const reads: string[] = []
    const r = fillWaiting(items, p => (reads.push(p), '---\nid: x\nwaiting: Q?\n---\n'), pr => (!pr || pr.length <= 1 ? '/root' : undefined))
    expect(reads).toEqual(['/root/a.md'])
    expect(r).toEqual({ read: 1, unreadable: 1 })
    expect(items[0].waiting).toBe('Q?')
    expect(items[1].waiting).toBeUndefined()
    expect(items[2].waiting).toBe('kept')
  })
})
