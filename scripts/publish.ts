#!/usr/bin/env bun
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const version = process.argv.slice(2).find(a => !a.startsWith('--'))

if (!version) {
  console.error('Error: version is required')
  console.error('')
  console.error('Usage:')
  console.error('  bun run scripts/publish.ts <version>')
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Error: '${version}' is not valid semver (expected x.y.z)`)
  process.exit(1)
}

const tag = `v${version}`
console.log(`Version : ${version}`)
console.log(`Tag     : ${tag}`)
console.log('')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
console.log('  bumped package.json')
console.log('')

const releaseBranch = `release/v${version}`
execSync(`git checkout -b ${releaseBranch}`, { stdio: 'inherit' })
execSync(`git add package.json`, { stdio: 'inherit' })
execSync(`git commit -m "chore: bump version to ${version}"`, { stdio: 'inherit' })
execSync(`git push -u origin ${releaseBranch}`, { stdio: 'inherit' })

console.log('')
console.log(`Branch pushed: ${releaseBranch}`)
console.log('')
console.log('Next:')
console.log(`  1. Merge the PR — the ${tag} tag is created automatically on merge to main`)
console.log(`  2. The tag push triggers CI to publish to npm`)
