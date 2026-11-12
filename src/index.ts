import { main } from './cli'

const code = await main(process.argv.slice(2), process.cwd(), {
  out: s => process.stdout.write(s),
  err: s => process.stderr.write(s),
})
process.exit(code)
