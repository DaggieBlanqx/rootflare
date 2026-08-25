'use strict'
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  routeDns,
  verifyDomain,
  startDaemon,
  stopDaemon,
  daemonStatus,
  applyMap,
  resolveCredentials
} = require('../lib/cloudflared')
const { init, add, paths } = require('../lib/state')

// Fake cloudflared: logs every invocation to $FAKE_LOG; `tunnel run` stays
// alive so daemon lifecycle (pid, SIGTERM) can be exercised without the real
// binary.
const FAKE_SRC = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args.includes('run')) setInterval(() => {}, 1000)
`

let homeDir
let fakeBin
let fakeLog
const savedEnv = {}

function readCalls () {
  return fs.readFileSync(fakeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

// startDaemon spawns asynchronously — the fake's log append can lag behind,
// so wait (bounded) for the expected calls instead of racing the child.
async function waitForCalls (predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const calls = readCalls()
    if (predicate(calls)) return calls
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return readCalls()
}

function restoreEnv () {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-cf-'))
  fakeBin = path.join(homeDir, 'cloudflared')
  fakeLog = path.join(homeDir, 'calls.log')
  fs.writeFileSync(fakeBin, FAKE_SRC, { mode: 0o755 })
  for (const key of ['ROOTFLARE_HOME', 'ROOTFLARE_CLOUDFLARED', 'FAKE_LOG']) {
    savedEnv[key] = process.env[key]
  }
  process.env.ROOTFLARE_HOME = path.join(homeDir, 'rootflare')
  process.env.ROOTFLARE_CLOUDFLARED = fakeBin
  process.env.FAKE_LOG = fakeLog
})

afterEach(() => {
  restoreEnv()
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('cloudflared missing → error with install hint', () => {
  process.env.ROOTFLARE_CLOUDFLARED = path.join(homeDir, 'does-not-exist')
  assert.throws(() => routeDns('sandbox', 'app.example.com'), /install/)
})

test('route dns called with correct args', () => {
  routeDns('sandbox', 'app.example.com')
  const calls = readCalls()
  assert.deepStrictEqual(calls[0], ['tunnel', 'route', 'dns', 'sandbox', 'app.example.com'])
})

test('daemon start writes .pid; down sends SIGTERM and verifies exit', async () => {
  startDaemon('sandbox')
  const { pid, running } = daemonStatus()
  assert.strictEqual(running, true)
  assert.ok(Number.isInteger(pid) && pid > 0)
  assert.strictEqual(fs.readFileSync(paths().pid, 'utf8'), String(pid))
  assert.strictEqual(await stopDaemon(), true)
  assert.strictEqual(daemonStatus().running, false)
})

test('stale PID (dead process) detected and cleaned', () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  fs.mkdirSync(paths().root, { recursive: true })
  fs.writeFileSync(paths().pid, String(dead))
  const status = daemonStatus()
  assert.strictEqual(status.running, false)
  assert.ok(!fs.existsSync(paths().pid), 'stale pid file removed')
})

test('ROOTFLARE_CLOUDFLARED override used when set', async () => {
  startDaemon('sandbox')
  const calls = await waitForCalls(cs => cs.some(c => c[0] === 'tunnel' && c.includes('run')))
  assert.ok(
    calls.some(c => c[0] === 'tunnel' && c[3] === 'run' && c[4] === 'sandbox'),
    'fake cloudflared was invoked via the override'
  )
  await stopDaemon()
})

test('applyMap pipeline — config → route dns (new only) → restart-if-running', async () => {
  init()
  add({ host: 'app1.example.com', port: 3000, protocol: 'http' })
  add({ host: 'app2.example.com', port: 4000, protocol: 'http' })

  // no daemon running → routes DNS but does not start or restart
  const first = await applyMap('sandbox')
  assert.deepStrictEqual(first.routed.sort(), ['app1.example.com', 'app2.example.com'])
  assert.strictEqual(first.restarted, false)
  assert.strictEqual(daemonStatus().running, false)

  // running daemon + one NEW domain → route only the new one, restart
  startDaemon('sandbox')
  const pidBefore = daemonStatus().pid
  add({ host: 'app3.example.com', port: 5000, protocol: 'http' })
  const second = await applyMap('sandbox')
  assert.deepStrictEqual(second.routed, ['app3.example.com'])
  assert.strictEqual(second.restarted, true)

  const after = daemonStatus()
  assert.strictEqual(after.running, true)
  assert.notStrictEqual(after.pid, pidBefore, 'daemon restarted with a new pid')

  const configText = fs.readFileSync(paths().config, 'utf8')
  for (const host of ['app1.example.com', 'app2.example.com', 'app3.example.com']) {
    assert.match(configText, new RegExp(`hostname: ${host.replace('.', '\\.')}`))
  }

  const routed = readCalls()
    .filter(c => c[0] === 'tunnel' && c[1] === 'route')
    .map(c => c[4])
  assert.deepStrictEqual(routed, ['app1.example.com', 'app2.example.com', 'app3.example.com'])

  await stopDaemon()
})

test('extra: startDaemon truncates tunnel.log (fresh session per run)', async () => {
  fs.mkdirSync(paths().root, { recursive: true })
  fs.writeFileSync(paths().log, 'old session garbage\nmore garbage\n')
  startDaemon('sandbox')
  const content = fs.readFileSync(paths().log, 'utf8')
  assert.ok(!content.includes('old session garbage'), 'old log truncated on start')
  assert.match(content, /rootflare: daemon started \(pid \d+\)/, 'lifecycle event written after truncation')
  await stopDaemon()
})

test('extra: route dns zone failures get a friendly hint', () => {
  const zoneFake = path.join(homeDir, 'cloudflared-zonefail')
  fs.writeFileSync(zoneFake, `#!/usr/bin/env node
console.error('Unable to find zone for hostname app.example.com')
process.exit(1)
`, { mode: 0o755 })
  process.env.ROOTFLARE_CLOUDFLARED = zoneFake
  assert.throws(() => routeDns('sandbox', 'app.example.com'), /Cloudflare account/)
})

test('extra: credentials fall back to `cloudflared tunnel list` when no json in home', () => {
  const listFake = path.join(homeDir, 'cloudflared-list')
  fs.writeFileSync(listFake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args[1] === 'list') {
  console.log('708f9d1a-8ebe-40ec-b0fb-fd12b1214702 sandbox 2026-07-10T11:58:28Z')
}
`, { mode: 0o755 })
  process.env.ROOTFLARE_CLOUDFLARED = listFake

  const cfHome = path.join(homeDir, 'cf-home')
  fs.mkdirSync(cfHome)
  fs.writeFileSync(path.join(cfHome, '708f9d1a-8ebe-40ec-b0fb-fd12b1214702.json'), '{}')

  const cred = resolveCredentials('sandbox', cfHome)
  assert.ok(cred.endsWith('708f9d1a-8ebe-40ec-b0fb-fd12b1214702.json'), 'uuid derived from tunnel list')
})

test('extra: credentials resolution returns null when nothing can be found', () => {
  const cfHome = path.join(homeDir, 'cf-empty')
  fs.mkdirSync(cfHome)
  assert.strictEqual(resolveCredentials('sandbox', cfHome), null)
})

const dns = require('node:dns')

function dnsError (code) {
  const err = new Error(code)
  err.code = code
  return err
}

test('verifyDomain: cloudflare zone + unused host passes cleanly', async () => {
  const orig = { resolveNs: dns.promises.resolveNs, resolveCname: dns.promises.resolveCname, resolve4: dns.promises.resolve4, resolve6: dns.promises.resolve6 }
  try {
    dns.promises.resolveNs = async () => ['norman.ns.cloudflare.com', 'kehlani.ns.cloudflare.com']
    dns.promises.resolveCname = async () => { throw dnsError('ENOTFOUND') }
    dns.promises.resolve4 = async () => { throw dnsError('ENOTFOUND') }
    dns.promises.resolve6 = async () => { throw dnsError('ENOTFOUND') }
    assert.deepStrictEqual(await verifyDomain('app.example.com'), { warning: null })
  } finally {
    Object.assign(dns.promises, orig)
  }
})

test('verifyDomain: walks up to the zone and fails fast when not Cloudflare', async () => {
  const orig = { resolveNs: dns.promises.resolveNs }
  try {
    dns.promises.resolveNs = async zone => {
      if (zone === 'app.example.com') throw dnsError('ENOTFOUND')
      return ['ns1.other-dns.net'] // the zone is NOT on Cloudflare
    }
    await assert.rejects(() => verifyDomain('app.example.com'), /is not on Cloudflare/)
  } finally {
    dns.promises.resolveNs = orig.resolveNs
  }
})

test('verifyDomain: undetermined zone does not block (route dns stays authoritative)', async () => {
  const orig = { resolveNs: dns.promises.resolveNs, resolveCname: dns.promises.resolveCname, resolve4: dns.promises.resolve4, resolve6: dns.promises.resolve6 }
  try {
    dns.promises.resolveNs = async () => { throw dnsError('ENOTFOUND') }
    dns.promises.resolveCname = async () => { throw dnsError('ENOTFOUND') }
    dns.promises.resolve4 = async () => { throw dnsError('ENOTFOUND') }
    dns.promises.resolve6 = async () => { throw dnsError('ENOTFOUND') }
    assert.deepStrictEqual(await verifyDomain('app.example.com'), { warning: null })
  } finally {
    Object.assign(dns.promises, orig)
  }
})

test('verifyDomain: warns on a conflicting existing record, ignores our own CNAME', async () => {
  const orig = { resolveNs: dns.promises.resolveNs, resolveCname: dns.promises.resolveCname, resolve4: dns.promises.resolve4, resolve6: dns.promises.resolve6 }
  try {
    dns.promises.resolveNs = async () => ['norman.ns.cloudflare.com']
    dns.promises.resolveCname = async () => ['elsewhere.example.com']
    dns.promises.resolve4 = async () => { throw dnsError('ENODATA') }
    dns.promises.resolve6 = async () => { throw dnsError('ENODATA') }
    const conflict = await verifyDomain('app.example.com')
    assert.match(conflict.warning, /already resolves to 'elsewhere\.example\.com'/)

    dns.promises.resolveCname = async () => ['708f9d1a-8ebe-40ec-b0fb-fd12b1214702.cfargotunnel.com']
    assert.deepStrictEqual(await verifyDomain('app.example.com'), { warning: null }, 'our own tunnel CNAME is not a conflict')
  } finally {
    Object.assign(dns.promises, orig)
  }
})

test('verifyDomain: A-record conflict warns too; wildcards are skipped for the conflict check', async () => {
  const orig = { resolveNs: dns.promises.resolveNs, resolveCname: dns.promises.resolveCname, resolve4: dns.promises.resolve4, resolve6: dns.promises.resolve6 }
  try {
    dns.promises.resolveNs = async () => ['norman.ns.cloudflare.com']
    dns.promises.resolveCname = async () => { throw dnsError('ENODATA') }
    dns.promises.resolve4 = async host => (host === 'app.example.com' ? ['203.0.113.7'] : Promise.reject(dnsError('ENODATA')))
    dns.promises.resolve6 = async () => { throw dnsError('ENODATA') }
    const conflict = await verifyDomain('app.example.com')
    assert.match(conflict.warning, /'203\.0\.113\.7'/)

    const wild = await verifyDomain('*.dev.example.com')
    assert.deepStrictEqual(wild, { warning: null }, 'wildcard has no resolvable target')

    // a Cloudflare anycast IP is our own flattened tunnel record, not a conflict
    dns.promises.resolve4 = async () => ['172.67.202.165']
    assert.deepStrictEqual(await verifyDomain('app.example.com'), { warning: null }, 'cloudflare anycast ip is not a conflict')
  } finally {
    Object.assign(dns.promises, orig)
  }
})

test('verifyDomain: ROOTFLARE_SKIP_VERIFY=1 turns the check off', async () => {
  const saved = process.env.ROOTFLARE_SKIP_VERIFY
  process.env.ROOTFLARE_SKIP_VERIFY = '1'
  try {
    assert.deepStrictEqual(await verifyDomain('totally.wrong.example.com'), { warning: null })
  } finally {
    if (saved === undefined) delete process.env.ROOTFLARE_SKIP_VERIFY
    else process.env.ROOTFLARE_SKIP_VERIFY = saved
  }
})
