import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEvidenceFor, markMerged, parseLog, parseRefs, readMerged, readRepoGit } from '../src/git'
import { run } from '../src/runner'

const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' },
  })
}
function commit(cwd: string, msg: string, date: string) {
  writeFileSync(join(cwd, 'f.txt'), msg + Math.random())
  git(cwd, 'add', '.')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
}

describe('parsers', () => {
  test('parseRefs reads origin/HEAD as the default branch and skips it', () => {
    const { refs, originHead } = parseRefs(
      'refs/heads/main\ta\t2026-01-01T00:00:00+00:00\t\nrefs/remotes/origin/HEAD\ta\t2026-01-01T00:00:00+00:00\trefs/remotes/origin/main\nrefs/remotes/origin/work/W-1\tb\t2026-01-02T00:00:00+00:00\t\n',
    )
    expect(originHead).toBe('main')
    expect(refs.map(r => [r.name, r.bare, r.remote])).toEqual([
      ['main', 'main', false],
      ['origin/work/W-1', 'work/W-1', true],
    ])
  })
  test('parseLog keeps only commits with trailers', () => {
    const t = parseLog('a\x1f2026-01-01\x1fWORK-1\x1d WORK-2\x1e\nb\x1f2026-01-02\x1f\x1e')
    expect(t).toHaveLength(1)
    expect(t[0].value).toContain('WORK-2')
  })
})

describe('real git repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ranni-git-'))
  dirs.push(repo)
  git(repo, 'init', '-q', '-b', 'main')
  commit(repo, 'base', '2026-01-01T00:00:00Z')
  git(repo, 'checkout', '-q', '-b', 'work/WORK-042-push')
  commit(repo, 'feat: push\n\nWork: WORK-042', '2026-02-01T00:00:00Z')
  commit(repo, 'fix: more\n\nWork: work-042', '2026-02-05T00:00:00Z')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-q', '-b', 'WORK-043-lands')
  commit(repo, 'feat: lands\n\nWork: WORK-043', '2026-02-10T00:00:00Z')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge 043', 'WORK-043-lands')
  git(repo, 'branch', 'work/WORK-04-other')

  test('reads branches, trailers, dates and the default branch in two git reads', async () => {
    const calls: string[][] = []
    const spy: typeof run = (c, a, o) => (calls.push(a), run(c, a, o))
    const rg = await readRepoGit(spy, repo)
    expect(calls).toHaveLength(2)
    expect(rg.available).toBe(true)
    expect(rg.defaultBranch).toBe('main')

    const e42 = gitEvidenceFor(rg, 'WORK-042')
    expect(e42.branches.map(b => b.name)).toEqual(['work/WORK-042-push'])
    expect(e42.commits).toHaveLength(2)
    expect(e42.commits.map(c => Date.parse(c.date))).toContain(Date.parse('2026-02-05T00:00:00Z'))
    // WORK-04 must not match WORK-042
    expect(gitEvidenceFor(rg, 'WORK-04').commits).toHaveLength(0)
    expect(gitEvidenceFor(rg, 'WORK-04').branches.map(b => b.name)).toEqual(['work/WORK-04-other'])
  })

  test('detects branches merged into the default branch', async () => {
    const rg = await readRepoGit(run, repo)
    markMerged(rg, await readMerged(run, repo, rg))
    expect(gitEvidenceFor(rg, 'WORK-043').branches[0].merged).toBe(true)
    expect(gitEvidenceFor(rg, 'WORK-042').branches[0].merged).toBe(false)
    // a fresh branch on the default tip with no trailer commits is not merged evidence
    expect(gitEvidenceFor(rg, 'WORK-04').branches[0].merged).toBe(false)
  })

  test('a directory that is not a repository is reported, not thrown', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ranni-plain-'))
    dirs.push(plain)
    const rg = await readRepoGit(run, plain)
    expect(rg.available).toBe(false)
    expect(rg.reason).toContain('not a Git repository')
  })
})
