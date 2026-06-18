import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const templatesDir = join(import.meta.dir, '..', 'templates')
const cwd = process.cwd()

function copySkill() {
  const src = join(templatesDir, 'ranni')
  const dest = join(cwd, '.claude', 'skills', 'ranni')
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log('✓ Skill installed at .claude/skills/ranni/')
}

function copyAgentsYaml() {
  const dest = join(cwd, '.agents.yaml')
  if (existsSync(dest)) {
    console.log('⚠ .agents.yaml already exists — skipped (edit it to configure your dirs)')
    return
  }
  cpSync(join(templatesDir, '.agents.yaml'), dest)
  console.log('✓ .agents.yaml created — edit dirs to match your project')
}

function mergeMcpJson() {
  const dest = join(cwd, '.mcp.json')

  let existing: Record<string, any> = {}
  if (existsSync(dest)) {
    try {
      existing = JSON.parse(readFileSync(dest, 'utf8'))
    } catch {
      console.error('✗ .mcp.json exists but contains invalid JSON — fix it manually and re-run')
      return
    }
  }

  if (existing.mcpServers?.['ranni-mcp']) {
    console.log('⚠ .mcp.json already has a "ranni-mcp" entry — skipped')
    return
  }

  existing.mcpServers ??= {}
  existing.mcpServers['ranni-mcp'] = {
    command: 'bun',
    args: ['run', 'node_modules/ranni-mcp/src/index.ts']
  }

  writeFileSync(dest, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  console.log('✓ .mcp.json updated with ranni-mcp MCP server entry')
}

copySkill()
copyAgentsYaml()
mergeMcpJson()

console.log('\nDone. Edit .agents.yaml to set your project dirs, then restart Claude Code.')
