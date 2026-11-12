import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, parseDocument } from 'yaml'
import { RanniError } from './errors'
import { findProjectRoot } from './project'

export const WORK_KIND = 'work'
const DEFAULT_ROOT = '.relic/records/work'

const norm = (p: string) => posix.normalize(p).replace(/\/+$/, '')

export interface WorkRoot {
  path: string
  /** Why this path, for the user. */
  why: string
}

/** Picks the root for the work kind from the roots already declared. Pure. */
export function chooseWorkRoot(topology: { specs?: unknown; shared?: unknown; records?: Record<string, unknown> }): WorkRoot {
  const records = Object.values(topology.records ?? {}).filter((v): v is string => typeof v === 'string').map(norm)
  const taken = new Set(
    [topology.specs, topology.shared, ...records].filter((v): v is string => typeof v === 'string').map(norm),
  )
  let candidate: string
  let why: string
  if (records.length === 0 || records.every(r => r.startsWith('.relic/records/'))) {
    candidate = DEFAULT_ROOT
    why = records.length === 0 ? 'no record roots declared yet' : 'the other records live under .relic/records'
  } else {
    // Sibling of the existing roots: the most common parent directory, first seen wins ties.
    const counts = new Map<string, number>()
    for (const r of records) counts.set(posix.dirname(r), (counts.get(posix.dirname(r)) ?? 0) + 1)
    let parent = posix.dirname(records[0])
    let best = 0
    for (const [p, c] of counts) if (c > best) { best = c; parent = p }
    candidate = parent === '.' ? WORK_KIND : `${parent}/${WORK_KIND}`
    why = `a sibling of the existing record roots (${parent === '.' ? 'project root' : parent})`
  }
  if (taken.has(candidate)) {
    candidate = `${candidate}-items`
    why += `; ${norm(candidate.replace(/-items$/, ''))} is already a Relic root`
  }
  return { path: candidate, why }
}

export interface YamlEdit {
  text: string
  changed: boolean
  /** The declared or added root of the work kind. */
  workRoot: string
  why?: string
}

/**
 * Declares the work record kind when none exists, with the yaml Document API so comments
 * and formatting survive. Pure.
 */
export function addWorkKind(source: string): YamlEdit {
  const doc = parseDocument(source)
  if (doc.errors.length) throw new RanniError(`relic.yaml is not valid YAML: ${doc.errors[0].message}`)
  const topology = doc.get('topology', true)
  if (!isMap(topology)) throw new RanniError('relic.yaml has no topology map. Run `relic verify` to see what Relic expects.')
  const records = topology.get('records', true)
  if (isMap(records) && records.has(WORK_KIND)) {
    const existing = records.get(WORK_KIND)
    return { text: source, changed: false, workRoot: String(existing) }
  }
  const plain = doc.toJS() as { topology: { specs?: unknown; shared?: unknown; records?: Record<string, unknown> } }
  const { path, why } = chooseWorkRoot(plain.topology)
  if (isMap(records)) records.set(WORK_KIND, path)
  else topology.set('records', doc.createNode({ [WORK_KIND]: path }))
  return { text: doc.toString({ lineWidth: 0 }), changed: true, workRoot: path, why }
}

export interface SkillChange {
  dir: string
  action: 'installed' | 'updated' | 'unchanged'
  detail: string[]
}

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(dir, p).split('\\').join('/'), readFileSync(p, 'utf8'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** Every `<dot-dir>/skills/relic/` of the project that holds a SKILL.md. */
export function findRelicSkillDirs(projectRoot: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(projectRoot).sort()) {
    if (!name.startsWith('.') || name === '.git') continue
    const base = join(projectRoot, name)
    try {
      if (!statSync(base).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(base, 'skills', 'relic', 'SKILL.md'))) found.push(base)
  }
  return found
}

export function templateDir(): string {
  return fileURLToPath(new URL('../templates/ranni', import.meta.url))
}

/** Copies the template over `<engine>/skills/ranni`, replacing the previous copy. */
export function syncSkill(engineDir: string, template: string): SkillChange {
  const dest = join(engineDir, 'skills', 'ranni')
  const next = readTree(template)
  const prev = readTree(dest)
  const detail: string[] = []
  for (const [f, c] of next) {
    if (!prev.has(f)) detail.push(`+ ${f}`)
    else if (prev.get(f) !== c) detail.push(`~ ${f}`)
  }
  for (const f of prev.keys()) if (!next.has(f)) detail.push(`- ${f}`)
  const dir = join(basename(engineDir), 'skills', 'ranni')
  if (!existsSync(dest)) {
    cpSync(template, dest, { recursive: true })
    return { dir, action: 'installed', detail: [`${next.size} files`] }
  }
  if (detail.length === 0) return { dir, action: 'unchanged', detail }
  rmSync(dest, { recursive: true, force: true })
  cpSync(template, dest, { recursive: true })
  return { dir, action: 'updated', detail }
}

/**
 * Where `path` really lands: the real path of its nearest existing ancestor, plus the parts
 * that do not exist yet. Symbolic links on the way are followed, so a linked `.claude` or a
 * `../` in relic.yaml resolves to wherever it points.
 */
export function realTarget(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest)
    } catch {
      const up = dirname(existing)
      if (up === existing) return join(existing, ...rest)
      rest.unshift(basename(existing))
      existing = up
    }
  }
}

/** Why `path` is not a safe place for `ranni init` to write inside `root`, or undefined. */
export function escapeReason(root: string, path: string): string | undefined {
  const realRoot = realpathSync(root)
  const target = realTarget(path)
  const rel = relative(realRoot, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `${relative(root, path) || '.'} resolves to ${target}, outside the project root ${realRoot}`
  }
  try {
    if (lstatSync(path).isSymbolicLink()) return `${relative(root, path)} is a symbolic link`
  } catch {
    // does not exist yet
  }
  return undefined
}

export interface Io {
  out: (s: string) => void
  err: (s: string) => void
}

export function runInit(cwd: string, io: Io, template = templateDir()): number {
  const root = findProjectRoot(cwd)
  if (!root) {
    io.err('ranni: no relic.yaml found in this directory or above. Run `relic init` first; ranni never creates one.\n')
    return 1
  }
  // Check every precondition before changing anything.
  const engines = findRelicSkillDirs(root)
  if (engines.length === 0) {
    io.err('ranni: no Relic skill is installed (looked for <dot-dir>/skills/relic/SKILL.md). Run `relic install` first.\n')
    return 1
  }
  const yamlPath = join(root, 'relic.yaml')
  const edit = addWorkKind(readFileSync(yamlPath, 'utf8'))
  // Every path init writes, replaces or deletes must stay inside the project, symbolic links
  // included: a linked `.claude` or a `../` record root would otherwise reach elsewhere.
  const targets = [
    ...(edit.changed ? [join(root, edit.workRoot)] : []),
    ...engines.map(e => join(e, 'skills', 'ranni')),
  ]
  const escapes = targets.map(t => escapeReason(root, t)).filter((r): r is string => r !== undefined)
  if (escapes.length > 0) {
    io.err(`ranni: refusing to write outside the project; nothing was changed:\n${escapes.map(r => `  ${r}\n`).join('')}`)
    return 1
  }

  const lines: string[] = []
  if (edit.changed) {
    writeFileSync(yamlPath, edit.text)
    lines.push(`relic.yaml: declared the "${WORK_KIND}" record kind at ${edit.workRoot} (${edit.why})`)
    const dir = join(root, edit.workRoot)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      lines.push(`created ${edit.workRoot}/`)
    }
  } else {
    lines.push(`relic.yaml: already declares the "${WORK_KIND}" record kind at ${edit.workRoot}`)
  }
  for (const eng of engines) {
    const ch = syncSkill(eng, template)
    lines.push(`${ch.dir}: ${ch.action}${ch.detail.length ? ' (' + ch.detail.join(', ') + ')' : ''}`)
  }
  io.out(lines.join('\n') + '\n')
  return 0
}
