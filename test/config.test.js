import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateConfig } from '../lib/config.js'
import { parseLine } from '../lib/state.js'

const noCreds = { credentialsFile: '/mock/creds.json' }

test('emits tunnel + credentials-file + ingress header', () => {
  const cfg = generateConfig('sandbox', [], noCreds)
  assert.match(cfg, /^tunnel: sandbox$/m)
  assert.match(cfg, /^credentials-file: \/mock\/creds\.json$/m)
  assert.match(cfg, /^ingress:$/m)
})

test('one rule per map entry (hostname + service)', () => {
  const entries = [parseLine('app.example.com:3000'), parseLine('app2.example.com:4000')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  assert.match(cfg, /hostname: app\.example\.com/)
  assert.match(cfg, /service: http:\/\/localhost:3000/)
  assert.match(cfg, /hostname: app2\.example\.com/)
  assert.match(cfg, /service: http:\/\/localhost:4000/)
})

test('path rules generated before plain hostname rules for the same host', () => {
  const entries = [parseLine('app.example.com:3000'), parseLine('app.example.com/api:8080')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  const pathIdx = cfg.indexOf('path: /api')
  const plainIdx = cfg.indexOf('hostname: app.example.com', pathIdx)
  assert.ok(pathIdx !== -1, 'path rule present')
  assert.ok(plainIdx !== -1, 'plain rule present')
  assert.ok(pathIdx < plainIdx, 'path rule before plain rule')
})

test('https origin emits service https:// + noTLSVerify: true', () => {
  const entries = [parseLine('secure.example.com:3000:https')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  assert.match(cfg, /service: https:\/\/localhost:3000/)
  assert.match(cfg, /noTLSVerify: true/)
})

test('wildcard hostname emitted as-is', () => {
  const entries = [parseLine('*.dev.example.com:3000')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  assert.match(cfg, /hostname: \*\.dev\.example\.com/)
  assert.match(cfg, /service: http:\/\/localhost:3000/)
})

test('catch-all http_status: 404 always last', () => {
  const entries = [parseLine('app.example.com:3000'), parseLine('app.example.com/api:8080')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  const lines = cfg.trimEnd().split('\n')
  assert.strictEqual(lines[lines.length - 1].trim(), '- service: http_status:404')
})

test('credentials file auto-resolved from mock ~/.cloudflared/*.json', () => {
  const cfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-cf-'))
  try {
    fs.writeFileSync(path.join(cfHome, 'abcdef-1234.json'), '{}')
    fs.writeFileSync(path.join(cfHome, 'cert.pem'), 'not a credential')
    const cfg = generateConfig('sandbox', [], { cloudflaredHome: cfHome })
    assert.match(cfg, /^credentials-file: .*abcdef-1234\.json$/m)
  } finally {
    fs.rmSync(cfHome, { recursive: true, force: true })
  }
})

test('--dry-run style: identical config on repeat calls, zero side effects', () => {
  const cfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-cf-'))
  try {
    const entries = [parseLine('app.example.com/api:8080'), parseLine('secure.example.com:3000:https')]
    const opts = { cloudflaredHome: cfHome }
    const a = generateConfig('sandbox', entries, opts)
    const b = generateConfig('sandbox', entries, opts)
    assert.strictEqual(a, b)
    assert.deepStrictEqual(fs.readdirSync(cfHome), [])
  } finally {
    fs.rmSync(cfHome, { recursive: true, force: true })
  }
})

test('extra: https + path rule emits path, https service, noTLSVerify', () => {
  const entries = [parseLine('secure.example.com/api:8080:https')]
  const cfg = generateConfig('sandbox', entries, noCreds)
  assert.match(cfg, /path: \/api/)
  assert.match(cfg, /service: https:\/\/localhost:8080/)
  assert.match(cfg, /noTLSVerify: true/)
})

test('extra: all path rules come before all plain rules', () => {
  const entries = [
    parseLine('z.example.com:3000'),
    parseLine('a.example.com/api:8080'),
    parseLine('m.example.com:3000'),
    parseLine('a.example.com/x:9000')
  ]
  const cfg = generateConfig('sandbox', entries, noCreds)
  const firstPlain = cfg.indexOf('service: http://localhost:3000')
  const lastPath = cfg.lastIndexOf('path: /')
  assert.ok(lastPath < firstPlain, `path rules before plain rules (${lastPath} < ${firstPlain})`)
})

test('extra: placeholder credentials-file when none found', () => {
  const cfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-cf-'))
  try {
    const cfg = generateConfig('sandbox', [], { cloudflaredHome: cfHome })
    assert.match(cfg, /credentials-file: ~\/\.cloudflared\/<TUNNEL-UUID>\.json/)
  } finally {
    fs.rmSync(cfHome, { recursive: true, force: true })
  }
})
