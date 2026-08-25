import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { translate } from './messages.js'

const DEFAULT_PORT = 3000
const MIN_PORT = 1
const MAX_PORT = 65535

// Line grammar: <hostname>[/path][:port][:https] — port defaults to 3000.
// Path rules carry their port after the path: app.example.com/api:8080.
const LINE_RE = /^(\S+?)(\/[^\s:#]+)?(?::(\d{1,5}))?(?::(https))?$/
const HOST_RE = /^[a-zA-Z0-9*_-]+(\.[a-zA-Z0-9*_-]+)*$/

const TEMPLATE = [
  '# <hostname>[/path][:port][:https] — port defaults to 3000',
  '# app1.example.com:3000',
  '# app2.example.com:4000',
  '# app.example.com/api:8080',
  '# *.dev.example.com:3000',
  '# secure.example.com:3000:https',
  ''
].join('\n')

function home () {
  return process.env.ROOTFLARE_HOME || path.join(os.homedir(), '.rootflare')
}

function paths () {
  const root = home()
  return {
    root,
    domains: path.join(root, 'domains'),
    tunnel: path.join(root, '.tunnel'),
    pid: path.join(root, '.pid'),
    lock: path.join(root, '.lock'),
    log: path.join(root, 'tunnel.log'),
    config: path.join(root, 'config.yml')
  }
}

// Parses one map line (comments stripped). Returns an entry or null for
// blank/comment lines. Throws Error with a message on malformed input.
function parseLine (raw) {
  const line = raw.split('#')[0].trim()
  if (line === '') return null
  const m = LINE_RE.exec(line)
  if (!m || !HOST_RE.test(m[1])) {
    throw new Error(translate('parse.invalid', { raw: raw.trim() }))
  }
  const port = m[3] === undefined ? DEFAULT_PORT : Number(m[3])
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(translate('parse.invalidPort', { port: m[3], min: MIN_PORT, max: MAX_PORT }))
  }
  const entry = { host: m[1], port, protocol: m[4] === 'https' ? 'https' : 'http' }
  if (m[2] !== undefined) entry.path = m[2]
  return entry
}

// CLI-facing wrapper: parses a spec string into an entry (throws on error).
function parseSpec (spec) {
  const entry = parseLine(spec)
  if (!entry) throw new Error(translate('parse.invalidSpec', { spec }))
  return entry
}

// The tunnel name set by `init` — persisted so `up`/`add`/`remove` know
// which tunnel to drive without repeating the argument.
function getTunnel () {
  const file = paths().tunnel
  if (!fs.existsSync(file)) return null
  const name = fs.readFileSync(file, 'utf8').trim()
  return name || null
}

function setTunnel (name) {
  ensureHome()
  fs.writeFileSync(paths().tunnel, `${name}\n`, { mode: 0o600 })
}

// Uniqueness key: a hostname+path pair. A path rule and a plain rule on the
// same host coexist (path rules sort first in the ingress), but two entries
// with the same host+path would silently shadow each other.
function keyOf (entry) {
  return entry.path !== undefined ? `${entry.host}${entry.path}` : entry.host
}

// Parses whole file content into { entries, errors: [{ line, message }] }.
// Malformed and duplicate lines are reported with their line numbers and
// skipped — they never crash or silently break the generated YAML.
function parseMap (content) {
  const entries = []
  const errors = []
  const seen = new Set()
  content.split(/\r?\n/).forEach((raw, i) => {
    let entry
    try {
      entry = parseLine(raw)
    } catch (err) {
      errors.push({ line: i + 1, message: err.message })
      return
    }
    if (!entry) return
    const key = keyOf(entry)
    if (seen.has(key)) {
      errors.push({ line: i + 1, message: translate('map.duplicateInFile', { host: entry.host, path: entry.path !== undefined ? entry.path : '' }) })
      return
    }
    seen.add(key)
    entries.push(entry)
  })
  return { entries, errors }
}

function serializeEntry (entry) {
  let line = entry.host
  if (entry.path !== undefined) line += entry.path
  line += `:${entry.port}`
  if (entry.protocol === 'https') line += ':https'
  return line
}

function ensureHome () {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 })
}

function readMap () {
  const file = paths().domains
  if (!fs.existsSync(file)) return { entries: [], errors: [] }
  return parseMap(fs.readFileSync(file, 'utf8'))
}

function writeMap (entries) {
  ensureHome()
  const body = entries.map(serializeEntry).join('\n')
  fs.writeFileSync(paths().domains, body ? body + '\n' : '', { mode: 0o600 })
}

// Seeds ~/.rootflare (mode 700) with a commented domains template.
// Idempotent: never overwrites an existing map.
function init () {
  const { root, domains } = paths()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(domains)) {
    fs.writeFileSync(domains, TEMPLATE, { mode: 0o600 })
  }
  return paths()
}

// Single source of truth for the "map has errors" message — used by the
// mutation guards and the applyMap pipeline.
function mapError (errors) {
  return translate('map.errors', { detail: errors.map(e => translate('map.lineError', e)).join('; ') })
}

// Refuses to mutate a map that currently has parse errors — otherwise the
// invalid lines would be silently dropped on the next write.
function assertMapClean () {
  const { errors } = readMap()
  if (errors.length > 0) throw new Error(mapError(errors))
}

function add (entry) {
  assertMapClean()
  const { entries } = readMap()
  if (entries.some(e => keyOf(e) === keyOf(entry))) {
    throw new Error(translate('map.duplicate', { host: entry.host, path: entry.path !== undefined ? entry.path : '' }))
  }
  writeMap([...entries, entry])
  return entry
}

function remove (hostname) {
  assertMapClean()
  const { entries } = readMap()
  const next = entries.filter(e => e.host !== hostname)
  if (next.length === entries.length) return false
  writeMap(next)
  return true
}

function lockFile () {
  return path.join(paths().lock, 'pid')
}

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function takeLock () {
  fs.mkdirSync(paths().lock, { mode: 0o700 })
  fs.writeFileSync(lockFile(), String(process.pid))
}

// mkdir-based mutation lock. Returns true if acquired, false if another
// live process holds it. A stale lock (dead or unreadable pid) is cleaned
// up and taken over.
function acquireLock () {
  try {
    takeLock()
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    let holder = null
    try {
      holder = parseInt(fs.readFileSync(lockFile(), 'utf8'), 10)
    } catch {}
    if (pidAlive(holder)) return false
    try {
      fs.rmSync(paths().lock, { recursive: true, force: true })
    } catch {}
    try {
      takeLock()
      return true
    } catch (err2) {
      if (err2.code === 'EEXIST') return false // lost a race — someone else holds it
      throw err2
    }
  }
}

function releaseLock () {
  fs.rmSync(paths().lock, { recursive: true, force: true })
}

async function withLock (fn) {
  if (!acquireLock()) {
    throw new Error(translate('lock.busy'))
  }
  try {
    return await fn()
  } finally {
    releaseLock()
  }
}

export {
  home,
  paths,
  keyOf,
  parseLine,
  parseSpec,
  parseMap,
  readMap,
  writeMap,
  mapError,
  init,
  add,
  remove,
  getTunnel,
  setTunnel,
  acquireLock,
  releaseLock,
  withLock
}
