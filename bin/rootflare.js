#!/usr/bin/env node
import { banner, cross } from '../lib/ui.js'
import { translate } from '../lib/messages.js'
import { getLogger } from '../lib/logger.js'
import { commands, UsageError } from '../lib/commands.js'
import { createRequire } from 'node:module'

// import.meta.url is empty in the CJS bundle — fall back to __filename there.
const require = createRequire(typeof import.meta.url === 'string' ? import.meta.url : __filename)
const VERSION = require('../package.json').version

function printHelp () {
  console.log(banner())
  console.log()
  console.log(translate('help.usage'))
  console.log()
  console.log(translate('help.commands'))
  for (const cmd of commands) {
    console.log(translate('help.commandLine', { name: cmd.name.padEnd(8), desc: cmd.desc }))
  }
  console.log()
  console.log(translate('help.options'))
  console.log(translate('help.versionFlag'))
  console.log(translate('help.helpFlag'))
}

async function main (argv) {
  const [cmdName, ...rest] = argv
  if (cmdName === undefined || cmdName === '--help' || cmdName === '-h') {
    printHelp()
    return 0
  }
  if (cmdName === '--version' || cmdName === '-v') {
    console.log(banner())
    console.log(translate('version.line', { version: VERSION }))
    return 0
  }
  const cmd = commands.find(c => c.name === cmdName)
  if (!cmd) {
    console.error(translate('help.unknownCommand', { name: cmdName }))
    printHelp()
    return 2
  }
  try {
    await cmd.handler(rest)
    return 0
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message)
      return 2
    }
    console.error(cross(err.message))
    getLogger().error({ event: 'command_failed', err: err.message })
    return 1
  }
}

main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    console.error(cross(err.message || String(err)))
    process.exitCode = 1
  })
