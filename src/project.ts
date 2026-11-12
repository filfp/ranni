import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
