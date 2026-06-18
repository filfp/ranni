import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Config, Task } from './types.js';

export type RunLogger = {
  logTask(id: string, stdout: string): void
  updateSummary(tasks: Task[]): void
}

export function initRun(config: Config, configDir: string): RunLogger | null {
  if (!config.persist_runs) return null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(configDir, 'tools', 'ranni', 'runs', ts)
  mkdirSync(runDir, { recursive: true })

  return {
    logTask(id: string, stdout: string): void {
      writeFileSync(join(runDir, `${id}.txt`), stdout, 'utf8')
    },
    updateSummary(tasks: Task[]): void {
      writeFileSync(join(runDir, 'summary.json'), JSON.stringify(tasks, null, 2), 'utf8')
    }
  }
}
