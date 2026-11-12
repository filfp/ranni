import { execFile } from 'node:child_process'

export interface RunResult {
  /** Exit code; 127 when the executable could not be started. */
  code: number
  stdout: string
  stderr: string
  /** True when the executable does not exist or cannot be started. */
  missing: boolean
}

export interface RunOptions {
  cwd?: string
}

/** The only way Ranni talks to `relic`, `git` and `gh`. Tests inject a fake. */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, missing: false })
        const e = err as NodeJS.ErrnoException & { code?: number | string }
        if (e.code === 'ENOENT' || e.code === 'EACCES') {
          return resolve({ code: 127, stdout: '', stderr: e.message, missing: true })
        }
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          missing: false,
        })
      },
    )
  })
