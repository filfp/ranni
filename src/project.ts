import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

/** Nearest ancestor (or self) directory holding a regular, non-symlinked relic.yaml. */
export function findProjectRoot(from: string): string | undefined {
  let dir = from
  for (;;) {
    try {
      if (lstatSync(join(dir, 'relic.yaml')).isFile()) return dir
    } catch {
      // not here, keep walking
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/**
 * Whether relic.yaml at the root declares the record kind. Undefined when the file cannot
 * be read or parsed: the caller then says nothing rather than guess.
 */
export function declaresRecordKind(root: string, kind: string): boolean | undefined {
  try {
    const doc = parse(readFileSync(join(root, 'relic.yaml'), 'utf8')) as { topology?: { records?: unknown } } | null
    const records = doc?.topology?.records
    return !!records && typeof records === 'object' && Object.hasOwn(records, kind)
  } catch {
    return undefined
  }
}
