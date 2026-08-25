'use strict'
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runChecks, installPlan } = require('../lib/doctor')
const { init, setTunnel, paths } = require('../lib/state')

let homeDir
let cfHome
const saved = {}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-doc-'))
  cfHome = path.join(homeDir, 'cloudflared')
  fs.mkdirSync(cfHome)
  for (const key of ['ROOTFLARE_HOME', 'ROOTFLARE_CLOUDFLARED']) {
    saved[key] = process.env[key]
  }
  process.env.ROOTFLARE_HOME = path.join(homeDir, 'rf')
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('doctor reports each missing piece with the right hint', () => {
  process.env.ROOTFLARE_CLOUDFLARED = path.join(homeDir, 'no-cloudflared')
  init()
  fs.writeFileSync(paths().domains, 'app.example.com:3000\nbroken line\n')

  const checks = runChecks({ cloudflaredHome: cfHome })
  const byName = Object.fromEntries(checks.map(c => [c.name, c]))

  assert.strictEqual(byName['cloudflared installed'].ok, false)
  assert.match(byName['cloudflared installed'].hint, /install/)

  assert.strictEqual(byName['logged in to Cloudflare'].ok, false)
  assert.match(byName['logged in to Cloudflare'].hint, /login/)

  assert.strictEqual(byName['tunnel set'].ok, false)
  assert.match(byName['tunnel set'].hint, /init/)

  assert.strictEqual(byName['tunnel exists in Cloudflare'].ok, false)
  assert.match(byName['tunnel exists in Cloudflare'].hint, /init/)

  assert.strictEqual(byName['map valid'].ok, false)
  assert.match(byName['map valid'].hint, /line 2/)
})

test('extra: doctor reports all-clear when everything is in place', () => {
  // a fake cloudflared that answers every command successfully
  const fake = path.join(homeDir, 'cloudflared-fake')
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 })
  process.env.ROOTFLARE_CLOUDFLARED = fake
  init()
  setTunnel('sandbox')
  fs.writeFileSync(path.join(cfHome, 'cert.pem'), 'cert')
  fs.writeFileSync(paths().domains, 'app.example.com:3000\n')

  const checks = runChecks({ cloudflaredHome: cfHome })
  for (const c of checks) {
    assert.strictEqual(c.ok, true, c.name)
  }
})

test('extra: tunnel exists check fails when the tunnel is not in the account', () => {
  const fake = path.join(homeDir, 'cloudflared-missing')
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.exit(1)\n', { mode: 0o755 })
  process.env.ROOTFLARE_CLOUDFLARED = fake
  init()
  setTunnel('ghost-tunnel')
  fs.writeFileSync(path.join(cfHome, 'cert.pem'), 'cert')
  fs.writeFileSync(paths().domains, 'app.example.com:3000\n')

  const byName = Object.fromEntries(runChecks({ cloudflaredHome: cfHome }).map(c => [c.name, c]))
  assert.strictEqual(byName['cloudflared installed'].ok, false)
  assert.strictEqual(byName['tunnel exists in Cloudflare'].ok, false)
  assert.match(byName['tunnel exists in Cloudflare'].hint, /init/)
})

test('installCloudflared detects OS and builds the right command', () => {
  assert.strictEqual(installPlan('darwin', '').kind, 'brew')
  assert.match(installPlan('darwin', '').steps[0], /brew install/)

  assert.strictEqual(installPlan('linux', 'ID=debian').kind, 'apt')
  assert.strictEqual(installPlan('linux', 'ID=ubuntu').kind, 'apt')
  assert.ok(installPlan('linux', 'ID=ubuntu').steps.some(s => s.includes('apt-get install')))

  const download = installPlan('linux', 'ID=arch')
  assert.strictEqual(download.kind, 'download')
  assert.ok(download.steps.some(s => s.includes('curl')), 'direct download step present')

  assert.strictEqual(installPlan('win32', '').kind, 'unsupported')
})
