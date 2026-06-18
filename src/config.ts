import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';

const ConfigSchema = z.object({
  worker: z.object({
    command: z.string(),
    args: z.array(z.string()).default([])
  }),
  max_workers: z.number().int().min(1).default(3),
  persist_runs: z.boolean().default(false),
  dirs: z.record(z.string()),
  manager_context: z.string().optional()
})

function findConfigDir(startDir: string): string | null {
  let dir = startDir
  while (true) {
    if (existsSync(join(dir, '.agents.yaml'))) return dir
    if (existsSync(join(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadConfig(startDir = process.cwd()): { config: Config; configDir: string } {
  const configDir = findConfigDir(startDir)
  if (!configDir) {
    throw new Error(
      `No .agents.yaml found. Walk from "${startDir}" to git root found nothing.\n` +
        `Create .agents.yaml at your repo root. Run: bun node_modules/ranni/src/init.ts`
    )
  }

  const raw = readFileSync(join(configDir, '.agents.yaml'), 'utf8')
  const parsed = parse(raw)
  const result = ConfigSchema.safeParse(parsed)

  if (!result.success) {
    throw new Error(
      `.agents.yaml is invalid:\n${result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`
    )
  }

  const config = result.data as Config

  for (const [key, rel] of Object.entries(config.dirs)) {
    const abs = join(configDir, rel)
    if (!existsSync(abs)) {
      throw new Error(`.agents.yaml dirs.${key} = "${rel}" does not exist (resolved to "${abs}")`)
    }
    config.dirs[key] = abs
  }

  return { config, configDir }
}
