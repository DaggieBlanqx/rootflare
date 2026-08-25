'use strict'

const fs = require('node:fs')
const { paths } = require('./state')
const { dim, green, red, yellow } = require('./ui')
const { translate } = require('./messages')

const POLL_MS = 500

const LEVEL_NAMES = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }

function sleepAsync (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Pretty-prints one pino JSON line: [hh:mm:ss] LEVEL msg key=value …
function formatPinoLine (line) {
  try {
    const obj = JSON.parse(line)
    if (typeof obj.level !== 'number') return null
    const level = LEVEL_NAMES[obj.level] || 'INFO'
    const time = obj.time ? new Date(obj.time).toISOString().slice(11, 19) : ''
    const extra = Object.keys(obj)
      .filter(k => !['level', 'time', 'msg', 'pid', 'hostname'].includes(k))
      .filter(k => obj[k] !== '' && obj[k] !== null)
      .map(k => `${k}=${typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : obj[k]}`)
      .join(' ')
    return `[${time}] ${level} ${obj.msg}${extra ? ` ${extra}` : ''}`
  } catch {
    return null
  }
}

// cloudflared logs use INF/ERR/WARN level codes; rootflare's own events are
// pino JSON lines.
function colorizeLogLine (line) {
  const pretty = formatPinoLine(line)
  if (pretty !== null) {
    if (/ERROR|FATAL/.test(pretty)) return red(pretty)
    if (/WARN/.test(pretty)) return yellow(pretty)
    if (/DEBUG|TRACE/.test(pretty)) return dim(pretty)
    return green(pretty)
  }
  if (/ERR|ERROR/.test(line)) return red(line)
  if (/WARN/.test(line)) return yellow(line)
  if (/INF|INFO/.test(line)) return green(line)
  return line
}

// Reads everything past `offset` in the log file. Handles truncation (up
// restarts the log): a file smaller than the offset restarts from zero.
function tailFrom (file, offset) {
  if (!fs.existsSync(file)) return { text: '', offset: 0 }
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < offset) offset = 0
    const buffer = Buffer.alloc(size - offset)
    if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, offset)
    return { text: buffer.toString('utf8'), offset: size }
  } finally {
    fs.closeSync(fd)
  }
}

// Live-tail tunnel.log, colorized, until Ctrl+C.
async function logs () {
  let offset = 0
  let hinted = false
  while (true) {
    const { text } = tailFrom(paths().log, offset)
    if (text) {
      offset += text.length
      process.stdout.write(text.split('\n').map(line => colorizeLogLine(line)).join('\n'))
    } else if (!hinted) {
      console.log(dim(translate('logs.waitingForLog')))
      hinted = true
    }
    await sleepAsync(POLL_MS)
  }
}

module.exports = { colorizeLogLine, formatPinoLine, tailFrom, logs }
