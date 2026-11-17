import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorkKind, chooseKind, chooseWorkRoot, kindFromDoc, ranniDocFor, ranniDocText, runInit, templateDir } from '../src/init'

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
    expect(r.workRoot).toBe('.relic/records/ticket')
    expect(r.text).toBe(RELIC.replace('    gl: .relic/records/glossary\n', '    gl: .relic/records/glossary\n    ticket: .relic/records/ticket\n'))
    expect(addWorkKind(RELIC, 'task').workRoot).toBe('.relic/records/task')
  })
  test('is idempotent and leaves an existing work kind alone', () => {
    const once = addWorkKind(RELIC).text
    const twice = addWorkKind(once)
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once)
    const custom = addWorkKind(RELIC.replace('adr:', 'work: tasks/work\n    adr:'), 'work')
    expect(custom.changed).toBe(false)
    expect(custom.workRoot).toBe('tasks/work')
  })
  test('creates records when the topology has none', () => {
    const r = addWorkKind('topology:\n  specs: s\n  shared: sh\n')
    expect(r.text).toContain('records:\n    ticket: .relic/records/ticket')
  })
  test('picks a sibling of record roots that live elsewhere', () => {
    expect(chooseWorkRoot({ specs: 's', records: { note: 'docs/notes', adr: 'docs/adr' } }, 'work').path).toBe('docs/work')
    expect(chooseWorkRoot({ records: { a: 'notes', b: 'docs/adr', c: 'docs/x' } }).path).toBe('docs/ticket')
    expect(chooseWorkRoot({ records: { a: 'notes' } }).path).toBe('ticket')
    expect(chooseWorkRoot({ records: { a: '.relic/records/requirements/functional' } }).path).toBe('.relic/records/ticket')
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

  test('declares ticket, creates the root, installs the skill, and finds relic.yaml from a subdirectory', () => {
    const d = project()
    mkdirSync(join(d, 'src', 'deep'), { recursive: true })
    const { o, io: i } = io()
    expect(runInit(join(d, 'src', 'deep'), i)).toBe(0)
    const yaml = readFileSync(join(d, 'relic.yaml'), 'utf8')
    expect(yaml).toContain('# specs live here')
    expect(yaml).toContain('# glossary terms')
    expect(yaml).toContain('ticket: .relic/records/ticket')
    expect(existsSync(join(d, '.relic/records/ticket'))).toBe(true)
    expect(readFileSync(join(d, '.relic/shared/ranni.md'), 'utf8')).toBe(ranniDocText('ticket'))
    expect(readFileSync(join(d, '.claude/skills/ranni/SKILL.md'), 'utf8')).toBe(readFileSync(join(templateDir(), 'SKILL.md'), 'utf8'))
    expect(existsSync(join(d, '.claude/skills/ranni/references/closing.md'))).toBe(true)
    expect(o.out).toContain('declared the "ticket" record kind')
    expect(o.out).toContain('.relic/shared/ranni.md: created (ranni-kind: ticket)')
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

describe('runInit stays inside the project', () => {
  test('refuses a work root that relic.yaml places outside, and changes nothing', () => {
    const yaml = 'topology:\n  specs: .relic/specs\n  shared: .relic/shared\n  records:\n    adr: ../elsewhere/decisions\n'
    const d = project(yaml)
    const { o, io: x } = io()
    expect(runInit(d, x)).toBe(1)
    expect(o.err).toContain('outside the project root')
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toBe(yaml)
    expect(existsSync(join(d, '..', 'elsewhere'))).toBe(false)
    expect(existsSync(join(d, '.claude', 'skills', 'ranni'))).toBe(false)
  })

  test('refuses an engine directory that is a symbolic link out of the project', () => {
    const outside = tmp()
    mkdirSync(join(outside, 'skills', 'relic'), { recursive: true })
    writeFileSync(join(outside, 'skills', 'relic', 'SKILL.md'), '# relic')
    mkdirSync(join(outside, 'skills', 'ranni'), { recursive: true })
    writeFileSync(join(outside, 'skills', 'ranni', 'keep.txt'), 'not yours')
    const d = project(RELIC, [])
    symlinkSync(outside, join(d, '.claude'))
    const { o, io: x } = io()
    expect(runInit(d, x)).toBe(1)
    expect(o.err).toContain('.claude/skills/ranni resolves to')
    expect(readFileSync(join(outside, 'skills', 'ranni', 'keep.txt'), 'utf8')).toBe('not yours')
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toBe(RELIC)
  })

  test('refuses a skill directory that is itself a symbolic link', () => {
    const d = project()
    const elsewhere = tmp()
    symlinkSync(elsewhere, join(d, '.claude', 'skills', 'ranni'))
    const { o, io: x } = io()
    expect(runInit(d, x)).toBe(1)
    expect(o.err).toMatch(/outside the project root|is a symbolic link/)
  })
})

describe('the work kind and ranni.md', () => {
  test('chooseKind: option, then ranni.md, then a declared legacy work kind, then ticket', () => {
    expect(chooseKind('task', 'ticket', { work: 'w' })).toBe('task')
    expect(chooseKind(undefined, 'issue', { work: 'w' })).toBe('issue')
    expect(chooseKind(undefined, undefined, { work: 'w' })).toBe('work')
    expect(chooseKind(undefined, undefined, { adr: 'a' })).toBe('ticket')
    expect(() => chooseKind('Ticket', undefined, undefined)).toThrow(/not a valid record kind/)
    expect(() => chooseKind('shared', undefined, undefined)).toThrow(/reserved/)
  })

  test('ranniDocFor regenerates a generated doc and only edits the key of a hand-edited one', () => {
    expect(kindFromDoc(ranniDocText('task'))).toBe('task')
    expect(ranniDocFor('ticket', ranniDocText('task'))).toBe(ranniDocText('ticket'))
    const edited = '---\nid: SHARED-ranni\nranni-kind: task # ours\nowner: me\n---\n\n# Our rules\n'
    const next = ranniDocFor('ticket', edited)
    expect(kindFromDoc(next)).toBe('ticket')
    expect(next).toContain('owner: me')
    expect(next).toContain('# Our rules')
    expect(ranniDocFor('ticket', next)).toBe(next)
    expect(kindFromDoc(ranniDocFor('ticket', '# no frontmatter\n'))).toBe('ticket')
  })

  test('init --kind declares that kind and names it in ranni.md', () => {
    const d = project()
    const { o, io: i } = io()
    expect(runInit(d, i, undefined, 'task')).toBe(0)
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toContain('task: .relic/records/task')
    expect(kindFromDoc(readFileSync(join(d, '.relic/shared/ranni.md'), 'utf8'))).toBe('task')
    expect(o.out).toContain('declared the "task" record kind')
  })

  test('init without --kind keeps the kind ranni.md names', () => {
    const d = project()
    runInit(d, io().io, undefined, 'issue')
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(0)
    expect(o.out).toContain('already declares the "issue" record kind')
    expect(o.out).toContain('ranni.md: unchanged (ranni-kind: issue)')
  })

  test('a project that already declares work keeps it and gets a ranni.md naming it', () => {
    const d = project(RELIC.replace('adr:', 'work: .relic/records/work\n    adr:'))
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(0)
    expect(o.out).toContain('already declares the "work" record kind')
    expect(kindFromDoc(readFileSync(join(d, '.relic/shared/ranni.md'), 'utf8'))).toBe('work')
  })

  test('refuses a relic.yaml without topology.shared and changes nothing', () => {
    const yaml = 'topology:\n  specs: .relic/specs\n  records:\n    adr: docs/adr\n'
    const d = project(yaml)
    const { o, io: i } = io()
    expect(runInit(d, i)).toBe(1)
    expect(o.err).toContain('topology.shared')
    expect(readFileSync(join(d, 'relic.yaml'), 'utf8')).toBe(yaml)
  })
})
