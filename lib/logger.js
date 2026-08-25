import fs from 'node:fs'
import pino from 'pino'
import { paths } from './state.js'

// Structured application logging (pino) into tunnel.log. Created lazily so
// commands that never log don't touch the filesystem; reopened after the
// daemon truncates the log so our file descriptor starts fresh.

let logger = null

function create () {
  fs.mkdirSync(paths().root, { recursive: true, mode: 0o700 })
  return pino(
    {
      level: process.env.ROOTFLARE_LOG_LEVEL || 'info',
      base: undefined // skip pid/hostname noise — the log is per-tunnel already
    },
    pino.destination({ dest: paths().log, append: true, sync: true })
  )
}

function getLogger () {
  if (logger === null) logger = create()
  return logger
}

// Call after tunnel.log is truncated (daemon restart) so pino appends from
// the top of the file instead of a stale offset.
function reopenLogger () {
  if (logger !== null) {
    try {
      logger.flush()
    } catch {}
  }
  logger = null
}

export { getLogger, reopenLogger }
