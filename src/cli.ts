import { readFileSync } from 'node:fs'
import { RanniError } from './errors'
import { runInit } from './init'
import type { Io } from './init'
import { renderHuman } from './render'
import { run } from './runner'
import { buildStatus } from './status'

const HELP = `ranni: the work frontier agents leave behind

Usage:
  ranni init                              Declare the work kind in relic.yaml and install the Ranni skill
  ranni status [id...] [--json] [--kind <kind>]
                                          Board derived from Relic, Git and the Git host (default kind: work)
  ranni --help | --version
`


export async function main(argv: string[], cwd: string, io: Io): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.out(HELP)
        return cmd === undefined ? 1 : 0
      case '-V':
      case '--version': {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        io.out(`${pkg.version}\n`)
        return 0
      }
      case 'init': {
        if (rest.length) throw new RanniError(`ranni init takes no arguments (got "${rest[0]}").`)
        return runInit(cwd, io)
      }
      case 'status': {
        let json = false
        let kind = 'work'
        const ids: string[] = []
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]
          if (a === '--json') json = true
          else if (a === '--kind') {
            const v = rest[++i]
            if (!v || v.startsWith('-')) throw new RanniError('--kind needs a value.')
            kind = v
          } else if (a.startsWith('--kind=')) kind = a.slice('--kind='.length)
          else if (a.startsWith('-')) throw new RanniError(`Unknown option ${a}.`)
          else ids.push(a)
        }
        const model = await buildStatus(
          { run, readFile: p => { try { return readFileSync(p, 'utf8') } catch { return undefined } }, now: new Date(), cwd },
          { kind, ids },
        )
        io.out(json ? JSON.stringify(model, null, 2) + '\n' : renderHuman(model))
        return 0
      }
      default:
        throw new RanniError(`Unknown command "${cmd}". Try ranni --help.`)
    }
  } catch (e) {
    if (e instanceof RanniError) {
      io.err(`ranni: ${e.message}\n`)
      return 1
    }
    throw e
  }
}
