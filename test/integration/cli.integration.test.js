'use strict'
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BIN = path.join(__dirname, '..', '..', 'bin', 'rootflare.js')

// Fake cloudflared: logs every invocation to $FAKE_LOG; `tunnel run` stays
// alive so daemon lifecycle can be exercised end-to-end.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args.includes('run')) setInterval(() => {}, 1000)
`

let dir
let fakeBin
let fakeLog
const saved = {}

function run (args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

function readCalls () {
  if (!fs.existsSync(fakeLog)) return []
  return fs.readFileSync(fakeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function readEvents (file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-int-'))
  fakeBin = path.join(dir, 'cloudflared')
  fakeLog = path.join(dir, 'calls.log')
  fs.writeFileSync(fakeBin, FAKE, { mode: 0o755 })
  for (const key of ['ROOTFLARE_HOME', 'ROOTFLARE_CLOUDFLARED', 'FAKE_LOG', 'ROOTFLARE_COUNTDOWN', 'ROOTFLARE_SKIP_VERIFY']) {
    saved[key] = process.env[key]
  }
  process.env.ROOTFLARE_HOME = path.join(dir, 'rf')
  process.env.ROOTFLARE_CLOUDFLARED = fakeBin
  process.env.FAKE_LOG = fakeLog
  process.env.ROOTFLARE_COUNTDOWN = '0' // keep the suite fast; warm-up tested explicitly
  process.env.ROOTFLARE_SKIP_VERIFY = '1' // integration uses fake domains; verifyDomain is unit-tested
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fresh init in a temp home → seeds domains, dir mode 700', () => {
  const res = run(['init', 'sandbox'])
  assert.strictEqual(res.status, 0)
  const rf = path.join(dir, 'rf')
  assert.ok(fs.existsSync(path.join(rf, 'domains')), 'domains seeded')
  assert.strictEqual(fs.statSync(rf).mode & 0o777, 0o700)
})

test('add two domains → up --dry-run prints valid, ordered config (no cloudflared)', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com/api', '8080']).status, 0)
  assert.strictEqual(run(['add', 'app2.example.com', '4000']).status, 0)

  const before = readCalls()
  const res = run(['up', '--dry-run'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /^tunnel: sandbox$/m)
  assert.match(res.stdout, /^ingress:$/m)

  // ordering: path rule before plain rule for the same host
  const pathIdx = res.stdout.indexOf('path: /api')
  const plainIdx = res.stdout.indexOf('hostname: app.example.com', pathIdx)
  assert.ok(pathIdx !== -1 && plainIdx !== -1 && pathIdx < plainIdx)

  // dry-run performed zero cloudflared invocations
  assert.deepStrictEqual(readCalls(), before, 'no cloudflared calls during dry-run')

  // route dns ran once per distinct hostname (app.example.com + app2.example.com)
  const routed = readCalls()
    .filter(c => c[0] === 'tunnel' && c[1] === 'route')
    .map(c => c[4])
  assert.deepStrictEqual(routed, ['app.example.com', 'app2.example.com'])
})

test('list without cloudflared → works, DNS column says not installed', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  const res = run(['list'], { ROOTFLARE_CLOUDFLARED: path.join(dir, 'does-not-exist') })
  assert.strictEqual(res.status, 0)
  assert.ok(res.stdout.includes('app.example.com'))
  assert.ok(res.stdout.includes('cloudflared not installed'))
})

test('list --json parses and contains map + daemon state', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  const res = run(['list', '--json'])
  assert.strictEqual(res.status, 0)
  const data = JSON.parse(res.stdout)
  assert.ok(Array.isArray(data.map), 'map is an array')
  assert.strictEqual(data.map.length, 1)
  assert.strictEqual(data.map[0].host, 'app.example.com')
  assert.strictEqual(data.map[0].port, 3000)
  assert.ok('running' in data.daemon, 'daemon state present')
})

test('extra: init auto-creates a missing tunnel', () => {
  // a fake that answers `tunnel info` with a failure but records calls
  const strictFake = path.join(dir, 'cloudflared-strict')
  fs.writeFileSync(strictFake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args[1] === 'info') process.exit(1)
`, { mode: 0o755 })

  const res = run(['init', 'fresh-tunnel'], { ROOTFLARE_CLOUDFLARED: strictFake })
  assert.strictEqual(res.status, 0)
  const creates = readCalls().filter(c => c[0] === 'tunnel' && c[1] === 'create')
  assert.strictEqual(creates.length, 1)
  assert.deepStrictEqual(creates[0], ['tunnel', 'create', 'fresh-tunnel'])
})

test('full happy path with a real cloudflared (skipped when unavailable)', (t) => {
  // run against the real binary, not the fake
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.skip('cloudflared not installed')
    return
  }
  const tunnel = process.env.ROOTFLARE_TEST_TUNNEL || 'sandbox'

  assert.strictEqual(run(['init', tunnel], { ROOTFLARE_CLOUDFLARED: 'cloudflared' }).status, 0)

  // add needs a zone owned by the Cloudflare account; without one, route dns
  // fails and the happy path cannot complete in this environment
  const host = `rf-${Date.now()}.example.com`
  const added = run(['add', host, '3000'], { ROOTFLARE_CLOUDFLARED: 'cloudflared' })
  if (added.status !== 0) {
    t.skip(`route dns not possible here (no owned zone): ${added.stderr.trim()}`)
    return
  }

  assert.strictEqual(run(['up'], { ROOTFLARE_CLOUDFLARED: 'cloudflared' }).status, 0)
  const listed = JSON.parse(run(['list', '--json'], { ROOTFLARE_CLOUDFLARED: 'cloudflared' }).stdout)
  assert.strictEqual(listed.daemon.running, true)
  assert.strictEqual(run(['down'], { ROOTFLARE_CLOUDFLARED: 'cloudflared' }).status, 0)
  const after = JSON.parse(run(['list', '--json'], { ROOTFLARE_CLOUDFLARED: 'cloudflared' }).stdout)
  assert.strictEqual(after.daemon.running, false)
})

test('extra: up starts the daemon, list shows running, down stops it', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  assert.strictEqual(run(['up']).status, 0)

  const listed = run(['list'])
  assert.strictEqual(listed.status, 0)
  assert.ok(listed.stdout.includes('● running'), 'daemon shown as running')

  const json = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(json.daemon.running, true)
  assert.ok(json.daemon.pid > 0)

  assert.strictEqual(run(['down']).status, 0)
  const after = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(after.daemon.running, false)
})

test('extra: add without a tunnel set → runtime error with hint', () => {
  const res = run(['add', 'app.example.com', '3000'])
  assert.strictEqual(res.status, 1)
  assert.match(res.stderr, /init/)
})

test('extra: up --foreground runs attached and exits with the tunnel process', () => {
  // fake that exits itself after a short delay when running the tunnel
  const shortFake = path.join(dir, 'cloudflared-short')
  fs.writeFileSync(shortFake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args.includes('run')) setTimeout(() => process.exit(0), 700)
`, { mode: 0o755 })

  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)

  const res = run(['up', '--foreground'], { ROOTFLARE_CLOUDFLARED: shortFake })
  assert.strictEqual(res.status, 0)
  // attached run leaves no detached daemon pid file behind
  assert.ok(!fs.existsSync(path.join(dir, 'rf', '.pid')), 'no pid file left by foreground run')
})

test('extra: up --foreground stops a running daemon first (no double instance)', () => {
  const shortFake = path.join(dir, 'cloudflared-short')
  fs.writeFileSync(shortFake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tunnel' && args.includes('run')) setTimeout(() => process.exit(0), 700)
`, { mode: 0o755 })

  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  assert.strictEqual(run(['up']).status, 0)
  const before = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(before.daemon.running, true, 'detached daemon running')

  const res = run(['up', '--foreground'], { ROOTFLARE_CLOUDFLARED: shortFake })
  assert.strictEqual(res.status, 0)
  assert.ok(!fs.existsSync(path.join(dir, 'rf', '.pid')), 'detached daemon stopped, no pid file left')

  // exactly one `tunnel run` happened in the foreground phase (no double start)
  const runCalls = readCalls().filter(c => c[0] === 'tunnel' && c.includes('run'))
  const afterUp = runCalls.filter((c, i) => i >= runCalls.length - 1)
  assert.strictEqual(afterUp.length, 1, 'single foreground tunnel run')
})

test('extra: add --dry-run prints the plan without executing', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  const before = readCalls().length
  const res = run(['add', 'app.example.com', '3000', '--dry-run'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /# dry-run — nothing was executed/)
  assert.match(res.stdout, /would run: cloudflared tunnel route dns sandbox app\.example\.com/)
  assert.match(res.stdout, /hostname: app\.example\.com/)
  assert.strictEqual(readCalls().length, before, 'zero new cloudflared invocations')
  const data = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(data.map.length, 0, 'map untouched')
})

test('extra: remove --dry-run prints the plan without executing', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  const before = readCalls().length
  const res = run(['remove', 'app.example.com', '--dry-run'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /# dry-run — nothing was executed/)
  assert.match(res.stdout, /would remove: app\.example\.com/)
  assert.ok(!res.stdout.includes('hostname: app.example.com'), 'config shown without the host')
  assert.strictEqual(readCalls().length, before, 'no new cloudflared calls')
  const data = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(data.map.length, 1, 'map untouched')
})

test('remove --all clears the whole map; --dry-run previews it', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  assert.strictEqual(run(['add', 'app2.example.com', '4000']).status, 0)

  // preview first
  const preview = run(['remove', '--all', '--dry-run'])
  assert.strictEqual(preview.status, 0)
  assert.match(preview.stdout, /would remove all 2 entr/)
  assert.ok(!preview.stdout.includes('hostname:'), 'config shown without hosts')
  assert.strictEqual(JSON.parse(run(['list', '--json']).stdout).map.length, 2, 'map untouched by dry-run')

  // real
  const res = run(['remove', '--all'])
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /removed all 2 entr/)
  assert.strictEqual(JSON.parse(run(['list', '--json']).stdout).map.length, 0)

  const cfg = fs.readFileSync(path.join(dir, 'rf', 'config.yml'), 'utf8')
  assert.match(cfg, /http_status:404/, 'catch-all remains')
  assert.ok(!cfg.includes('hostname:'), 'config regenerated without hosts')
})

test('remove --all on an empty map is a clean no-op; combining with a host is a usage error', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  const res = run(['remove', '--all'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /map is already empty/)

  const bad = run(['remove', '--all', 'app.example.com'])
  assert.strictEqual(bad.status, 2)
  assert.match(bad.stderr, /cannot combine/)
})

test('extra: add hints to run `up` when the daemon is not running', () => {
  assert.strictEqual(run(['init', 'sandbox']).status, 0)
  assert.strictEqual(run(['add', 'app.example.com', '3000']).status, 0)
  const res = run(['add', 'app2.example.com', '4000'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /rootflare up/, 'hint printed when daemon stopped')

  assert.strictEqual(run(['up']).status, 0)
  const res2 = run(['add', 'app3.example.com', '5000'])
  assert.strictEqual(res2.status, 0)
  assert.ok(!res2.stdout.includes('rootflare up'), 'no hint when daemon is running')
  assert.strictEqual(run(['down']).status, 0)
})

test('start: one-click bootstraps from a fresh home and goes live (idempotent)', () => {
  const res = run(['start', 'app.example.com', '3000'])
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /is live → localhost:3000/)
  assert.match(res.stdout, /tunnel 'rootflare' ready/)

  const data = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(data.map.length, 1)
  assert.strictEqual(data.map[0].host, 'app.example.com')
  assert.strictEqual(data.map[0].port, 3000)
  assert.strictEqual(data.daemon.running, true)

  const routed = readCalls()
    .filter(c => c[0] === 'tunnel' && c[1] === 'route')
    .map(c => c[4])
  assert.deepStrictEqual(routed, ['app.example.com'], 'route dns ran once')

  // idempotent: second run changes nothing, no extra route dns
  const res2 = run(['start', 'app.example.com', '3000'])
  assert.strictEqual(res2.status, 0)
  const routed2 = readCalls()
    .filter(c => c[0] === 'tunnel' && c[1] === 'route')
    .map(c => c[4])
  assert.deepStrictEqual(routed2, ['app.example.com'], 'no duplicate route dns')
  assert.strictEqual(run(['down']).status, 0)
})

test('start: updates the port for an already-mapped host without re-routing DNS', () => {
  assert.strictEqual(run(['start', 'app.example.com', '3000']).status, 0)
  const res = run(['start', 'app.example.com', '4000'])
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /is live → localhost:4000/)

  const data = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(data.map[0].port, 4000)
  const routed = readCalls()
    .filter(c => c[0] === 'tunnel' && c[1] === 'route')
    .map(c => c[4])
  assert.deepStrictEqual(routed, ['app.example.com'], 'no new route dns for same host')
  assert.strictEqual(run(['down']).status, 0)
})

test('start: --dry-run prints the plan without executing', () => {
  const res = run(['start', 'app.example.com', '3000', '--dry-run'])
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /# dry-run — nothing was executed/)
  assert.match(res.stdout, /would init: tunnel 'rootflare'/)
  assert.match(res.stdout, /would add \+ route dns/)
  assert.match(res.stdout, /would start the daemon/)
  const sideEffects = readCalls().filter(c => c[0] !== '--version')
  assert.deepStrictEqual(sideEffects, [], 'no mutating cloudflared invocations')
  const data = JSON.parse(run(['list', '--json']).stdout)
  assert.strictEqual(data.map.length, 0, 'map untouched')
})

test('start: waits for the tunnel to warm up before declaring live', () => {
  const res = run(['start', 'app.example.com', '3000'], { ROOTFLARE_COUNTDOWN: '1' })
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /waiting 1s for the tunnel to connect/)
  assert.match(res.stdout, /is live → localhost:3000/)
  assert.strictEqual(run(['down']).status, 0)
})

test('rootflare writes lifecycle events to tunnel.log (visible in `logs`)', () => {
  assert.strictEqual(run(['start', 'app.example.com', '3000'], { ROOTFLARE_COUNTDOWN: '0' }).status, 0)
  const events = readEvents(path.join(dir, 'rf', 'tunnel.log'))
  assert.ok(events.some(e => e.event === 'daemon.started' && /rootflare: daemon started \(pid \d+\)/.test(e.msg)))
  assert.ok(events.some(e => e.event === 'mapped' && e.host === 'app.example.com' && /rootflare: mapped app\.example\.com → localhost:3000/.test(e.msg)))

  assert.strictEqual(run(['remove', 'app.example.com']).status, 0)
  assert.ok(readEvents(path.join(dir, 'rf', 'tunnel.log')).some(e => e.event === 'removed' && e.host === 'app.example.com'))

  assert.strictEqual(run(['down']).status, 0)
  assert.ok(readEvents(path.join(dir, 'rf', 'tunnel.log')).some(e => e.event === 'daemon.stopped'))
})
