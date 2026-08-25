import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseLine,
  parseSpec,
  parseMap,
  mapError,
  readMap,
  writeMap,
  init,
  add,
  remove,
  paths,
  getTunnel,
  setTunnel
} from '../lib/state.js'

let homeDir

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-state-'))
  process.env.ROOTFLARE_HOME = homeDir
})

afterEach(() => {
  delete process.env.ROOTFLARE_HOME
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('parses host:port → host, port, http', () => {
  const entry = parseLine('app.example.com:3000')
  assert.deepStrictEqual(entry, { host: 'app.example.com', port: 3000, protocol: 'http' })
})

test('defaults port to 3000 when omitted', () => {
  const entry = parseLine('app.example.com')
  assert.strictEqual(entry.host, 'app.example.com')
  assert.strictEqual(entry.port, 3000)
  assert.strictEqual(entry.protocol, 'http')
})

test('path rule host/path:port → path and port', () => {
  const entry = parseLine('app.example.com/api:8080')
  assert.strictEqual(entry.host, 'app.example.com')
  assert.strictEqual(entry.path, '/api')
  assert.strictEqual(entry.port, 8080)
})

test('https origin host:port:https → https protocol', () => {
  const entry = parseLine('secure.example.com:3000:https')
  assert.strictEqual(entry.host, 'secure.example.com')
  assert.strictEqual(entry.port, 3000)
  assert.strictEqual(entry.protocol, 'https')
})

test('host/path:port:https parses all three tokens', () => {
  const entry = parseLine('app.example.com/api:8080:https')
  assert.deepStrictEqual(entry, { host: 'app.example.com', path: '/api', port: 8080, protocol: 'https' })
})

test('wildcard hostname preserved', () => {
  const entry = parseLine('*.dev.example.com:3000')
  assert.strictEqual(entry.host, '*.dev.example.com')
  assert.strictEqual(entry.port, 3000)
})

test('comments and blank lines ignored', () => {
  const { entries, errors } = parseMap('# a comment\n\napp.example.com:3000\n# another\n')
  assert.strictEqual(errors.length, 0)
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].host, 'app.example.com')
})

test('malformed lines reported with line number, skipped (no crash)', () => {
  const { entries, errors } = parseMap('app.example.com:3000\nbad line\n:4000\n')
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].host, 'app.example.com')
  assert.strictEqual(errors.length, 2)
  assert.strictEqual(errors[0].line, 2)
  assert.strictEqual(errors[1].line, 3)
})

test('duplicate hostname rejected on add', () => {
  init()
  add({ host: 'app.example.com', port: 3000, protocol: 'http' })
  assert.throws(
    () => add({ host: 'app.example.com', port: 4000, protocol: 'http' }),
    /duplicate/
  )
})

test('non-numeric / out-of-range port rejected', () => {
  assert.throws(() => parseLine('app.example.com:abc'), /port/)
  assert.throws(() => parseLine('app.example.com:0'), /port/)
  assert.throws(() => parseLine('app.example.com:70000'), /port/)
})

test('round-trip: write map → read map → identical', () => {
  init()
  const entries = [
    { host: 'app1.example.com', port: 3000, protocol: 'http' },
    { host: 'app.example.com', path: '/api', port: 8080, protocol: 'http' },
    { host: '*.dev.example.com', port: 3000, protocol: 'http' },
    { host: 'secure.example.com', port: 3000, protocol: 'https' }
  ]
  writeMap(entries)
  const { entries: read, errors } = readMap()
  assert.strictEqual(errors.length, 0)
  assert.deepStrictEqual(read, entries)
})

test('extra: trailing inline comment stripped', () => {
  const entry = parseLine('app1.example.com:3000   # http → localhost:3000')
  assert.deepStrictEqual(entry, { host: 'app1.example.com', port: 3000, protocol: 'http' })
})

test('extra: duplicate hostname inside file reported, not silently merged', () => {
  const { entries, errors } = parseMap('app.example.com:3000\napp.example.com:4000\n')
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(errors.length, 1)
  assert.strictEqual(errors[0].line, 2)
  assert.match(errors[0].message, /duplicate/)
})

test('extra: init seeds a commented template, dir is mode 700', () => {
  init()
  const { root, domains } = paths()
  const mode = fs.statSync(root).mode & 0o777
  assert.strictEqual(mode, 0o700)
  assert.ok(fs.existsSync(domains))
  const { entries, errors } = readMap()
  assert.strictEqual(errors.length, 0)
  assert.strictEqual(entries.length, 0)
})

test('extra: init is idempotent (template not duplicated)', () => {
  init()
  const first = fs.readFileSync(paths().domains, 'utf8')
  init()
  const second = fs.readFileSync(paths().domains, 'utf8')
  assert.strictEqual(first, second)
})

test('extra: readMap on missing file returns empty map', () => {
  const { entries, errors } = readMap()
  assert.deepStrictEqual(entries, [])
  assert.deepStrictEqual(errors, [])
})

test('extra: remove deletes the hostname, returns false when absent', () => {
  init()
  add({ host: 'app.example.com', port: 3000, protocol: 'http' })
  assert.strictEqual(remove('app.example.com'), true)
  assert.strictEqual(remove('nope.example.com'), false)
  const { entries } = readMap()
  assert.deepStrictEqual(entries, [])
})

test('extra: add refuses to rewrite a map that has parse errors (no data loss)', () => {
  init()
  fs.writeFileSync(paths().domains, 'app.example.com:3000\nbroken line\n')
  assert.throws(() => add({ host: 'x.example.com', port: 3000, protocol: 'http' }), /errors/)
  const raw = fs.readFileSync(paths().domains, 'utf8')
  assert.match(raw, /broken line/)
})

test('extra: parseSpec parses a CLI spec string', () => {
  assert.deepStrictEqual(
    parseSpec('app.example.com/api:8080:https'),
    { host: 'app.example.com', path: '/api', port: 8080, protocol: 'https' }
  )
  assert.throws(() => parseSpec('not valid'), /invalid/)
})

test('extra: setTunnel/getTunnel round-trip', () => {
  init()
  assert.strictEqual(getTunnel(), null)
  setTunnel('sandbox')
  assert.strictEqual(getTunnel(), 'sandbox')
})

test('extra: path rule and plain rule on the same host coexist', () => {
  init()
  add({ host: 'app.example.com', port: 3000, protocol: 'http' })
  add({ host: 'app.example.com', path: '/api', port: 8080, protocol: 'http' })
  add({ host: 'app.example.com', path: '/other', port: 9090, protocol: 'http' })
  const { entries } = readMap()
  assert.strictEqual(entries.length, 3)
  assert.throws(
    () => add({ host: 'app.example.com', path: '/api', port: 9999, protocol: 'http' }),
    /duplicate/
  )
})

test('extra: mapError formats parse errors with line numbers', () => {
  const { errors } = parseMap('app.example.com:3000\nbad line\n')
  assert.strictEqual(errors.length, 1)
  const message = mapError(errors)
  assert.match(message, /map has errors — fix ~\/\.rootflare\/domains first/)
  assert.match(message, /line 2/)
})
