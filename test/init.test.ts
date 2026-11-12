import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorkKind, chooseWorkRoot, runInit, templateDir } from '../src/init'

const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ranni-init-'))
  dirs.push(d)
  return d
}
const io = () => {
  const o = { out: '', err: '' }
  return { o, io: { out: (s: string) => void (o.out += s), err: (s: string) => void (o.err += s) } }
}

const RELIC = `# Relic project
topology:
  specs: .relic/specs # specs live here
  shared: .relic/shared
  records:
    adr: .relic/records/decisions
    # glossary terms
    gl: .relic/records/glossary
federation:
  members:
    api: services/api
`

function project(yaml = RELIC, engines: string[] = ['.claude']) {
  const d = tmp()
  writeFileSync(join(d, 'relic.yaml'), yaml)
  for (const e of engines) {
    mkdirSync(join(d, e, 'skills', 'relic'), { recursive: true })
    writeFileSync(join(d, e, 'skills', 'relic', 'SKILL.md'), '# relic')
  }
  return d
}

describe('addWorkKind', () => {
  test('adds work and keeps comments, ordering and everything else byte for byte', () => {
    const r = addWorkKind(RELIC)
    expect(r.changed).toBe(true)
    expect(r.workRoot).toBe('.relic/records/work')
    expect(r.text).toBe(RELIC.replace('    gl: .relic/records/glossary\n', '    gl: .relic/records/glossary\n    work: .relic/records/work\n'))
  })
  test('is idempotent and leaves an existing work kind alone', () => {
    const once = addWorkKind(RELIC).text
    const twice = addWorkKind(once)
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once)
    const custom = addWorkKind(RELIC.replace('adr:', 'work: tasks/work\n    adr:'))
    expect(custom.changed).toBe(false)
    expect(custom.workRoot).toBe('tasks/work')
  })
  test('creates records when the topology has none', () => {
    const r = addWorkKind('topology:\n  specs: s\n  shared: sh\n')
    expect(r.text).toContain('records:\n    work: .relic/records/work')
  })
  test('picks a sibling of record roots that live elsewhere', () => {
    expect(chooseWorkRoot({ specs: 's', records: { note: 'docs/notes', adr: 'docs/adr' } }).path).toBe('docs/work')
    expect(chooseWorkRoot({ records: { a: 'notes', b: 'docs/adr', c: 'docs/x' } }).path).toBe('docs/work')
    expect(chooseWorkRoot({ records: { a: 'notes' } }).path).toBe('work')
    expect(chooseWorkRoot({ records: { a: '.relic/records/requirements/functional' } }).path).toBe('.relic/records/work')
  })
  test('rejects invalid YAML or a missing topology', () => {
    expect(() => addWorkKind('topology: [')).toThrow(/not valid YAML/)
    expect(() => addWorkKind('foo: 1\n')).toThrow(/no topology/)
  })
})

describe('runInit', () => {
  test('exits non-zero without a relic.yaml and never creates one', () => {
    const d = tmp()
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(1)
    expect(o.err).toContain('relic init')
    expect(existsSync(join(d, 'relic.yaml'))).toBe(false)
  })

  test('exits non-zero without an installed Relic skill and changes nothing', () => {
    const d = project(RELIC, [])
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(1)
    expect(o.err).toContain('relic install')
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toBe(RELIC)
    expect(existsSync(join(d, '.relic'))).toBe(false)
  })

  test('declares work, creates the root, installs the skill, and finds relic.yaml from a subdirectory', () => {
    const d = project()
    mkdirSync(join(d, 'src', 'deep'), { recursive: true })
    const { o, io: i } = io()
    expect(runInit(join(d, 'src', 'deep'), i)).toBe(0)
    const yaml = readFileSync(join(d, 'relic.yaml'), 'utf8')
    expect(yaml).toContain('# specs live here')
    expect(yaml).toContain('# glossary terms')
    expect(yaml).toContain('work: .relic/records/work')
    expect(existsSync(join(d, '.relic/records/work'))).toBe(true)
    expect(readFileSync(join(d, '.claude/skills/ranni/SKILL.md'), 'utf8')).toBe(readFileSync(join(templateDir(), 'SKILL.md'), 'utf8'))
    expect(existsSync(join(d, '.claude/skills/ranni/references/closing.md'))).toBe(true)
    expect(o.out).toContain('declared the "work" record kind')
    expect(o.out).toContain('.claude/skills/ranni: installed')
  })

  test('running again only refreshes the skill', () => {
    const d = project()
    runInit(d, io().io)
    const yaml = readFileSync(join(d, 'relic.yaml'), 'utf8')
    writeFileSync(join(d, '.claude/skills/ranni/SKILL.md'), 'stale')
    writeFileSync(join(d, '.claude/skills/ranni/old.md'), 'gone')
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(0)
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toBe(yaml)
    expect(o.out).toContain('already declares')
    expect(o.out).toContain('updated (~ SKILL.md, - old.md)')
    expect(existsSync(join(d, '.claude/skills/ranni/old.md'))).toBe(false)
    const again = io()
    runInit(d, again.io)
    expect(again.o.out).toContain('.claude/skills/ranni: unchanged')
  })

  test('installs next to every engine that has a Relic skill, and only those', () => {
    const d = project(RELIC, ['.claude', '.codex', '.agents'])
    mkdirSync(join(d, '.cursor', 'skills', 'other'), { recursive: true })
    mkdirSync(join(d, '.github', 'skills', 'relic'), { recursive: true }) // no SKILL.md: ignored
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(0)
    for (const e of ['.claude', '.codex', '.agents']) expect(existsSync(join(d, e, 'skills/ranni/SKILL.md'))).toBe(true)
    expect(existsSync(join(d, '.cursor/skills/ranni'))).toBe(false)
    expect(existsSync(join(d, '.github/skills/ranni'))).toBe(false)
    expect(o.out.match(/skills\/ranni: installed/g)).toHaveLength(3)
  })
})
