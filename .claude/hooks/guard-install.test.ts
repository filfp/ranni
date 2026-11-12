import { expect, test } from 'bun:test'
import { join } from 'node:path'

const hook = join(import.meta.dir, 'guard-install.sh')
const code = (command: string) =>
  Bun.spawnSync([hook], { stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { command } })) }).exitCode

test.each([
  'bun install',
  'bun install --frozen-lockfile 2>&1 | tail -2',
  'bun add --exact zod@4.1.2',
  'bun add -E @scope/pkg@1.0.0 -d',
  'npm view zod version',
  'git commit -m "use npm install"',
])('allows %s', c => expect(code(c)).toBe(0))

test.each([
  'bun add zod',
  'bun add --exact zod@^4.0.0',
  'FOO=1 bun add zod@latest',
  'bun add --exact zod@4.1.2 --trust',
  'bun pm trust esbuild',
  'bun install --minimum-release-age=0',
  'cd x && npm install',
  'echo hi; pnpm add x',
  'yarn',
])('blocks %s', c => expect(code(c)).toBe(2))
