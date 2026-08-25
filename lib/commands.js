'use strict'

const readline = require('node:readline')
const {
  init: initState,
  remove: removeHost,
  readMap,
  writeMap,
  getTunnel,
  setTunnel,
  parseSpec,
  withLock,
  keyOf,
  mapError
} = require('./state')
const { generateConfig } = require('./config')
const {
  applyMap,
  verifyDomain,
  startDaemon,
  stopDaemon,
  daemonStatus,
  isInstalled,
  runForeground,
  tunnelExists,
  createTunnel
} = require('./cloudflared')
const { table, green, dim, check, cross, statusDot, icon, spinner, countdown } = require('./ui')
const { runChecks, installCloudflared, isLoggedIn } = require('./doctor')
const { logs } = require('./live')
const { translate } = require('./messages')
const { getLogger } = require('./logger')

const DEFAULT_TUNNEL = 'rootflare'

class UsageError extends Error {}

function usage (message) {
  throw new UsageError(message)
}

function flagValue (args, flag) {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1]
  const inline = args.find(a => a.startsWith(`${flag}=`))
  return inline ? inline.slice(flag.length + 1) : null
}

function tunnelOrDie () {
  const tunnel = getTunnel()
  if (!tunnel) {
    throw new Error(translate('tunnel.noTunnel'))
  }
  return tunnel
}

function serviceLabel (entry) {
  const base = `→ localhost:${entry.port}`
  return entry.path !== undefined ? `${base} (${entry.path})` : base
}

// `add`/`remove` apply the map but never start the daemon — tell the user how
// to go live instead of leaving them staring at a Cloudflare 1033.
function daemonHint () {
  if (!daemonStatus().running) {
    console.log(dim(translate('daemon.notRunningHint')))
  }
}

// The only step that cannot be automated: `cloudflared tunnel login` opens a
// browser. On a TTY, pause and continue when the user is done; otherwise fail
// with the hint.
async function ensureLoggedIn () {
  if (isLoggedIn()) return
  if (!process.stdin.isTTY) {
    throw new Error(translate('login.required'))
  }
  console.log(dim(translate('login.prompt')))
  await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin })
    rl.once('line', () => {
      rl.close()
      resolve()
    })
  })
  if (!isLoggedIn()) throw new Error(translate('login.stillMissing'))
}

// Shared map mutation used by `add` (strict) and `start` (update):
// validate → replace-or-append the entry → applyMap, under the mutation lock.
// Returns 'added' | 'updated' | 'unchanged'. Lifecycle logging is the
// caller's job (start logs after the daemon step so the event survives the
// log truncation).
async function ensureMapped (tunnel, entry, opts = {}) {
  const key = keyOf(entry)
  const { entries, errors } = readMap()
  if (errors.length > 0) throw new Error(mapError(errors))
  const existing = entries.find(e => keyOf(e) === key)
  if (existing !== undefined && !opts.update) {
    throw new Error(translate('map.duplicate', { host: entry.host, path: entry.path !== undefined ? entry.path : '' }))
  }
  const changed = existing === undefined || existing.port !== entry.port || existing.protocol !== entry.protocol
  if (!changed) return 'unchanged'
  await withLock(async () => {
    const { entries: current } = readMap()
    const next = current.map(e => (keyOf(e) === key ? { ...e, port: entry.port, protocol: entry.protocol } : e))
    if (!current.some(e => keyOf(e) === key)) next.push(entry)
    writeMap(next)
    await applyMap(tunnel)
  })
  return existing === undefined ? 'added' : 'updated'
}

function logMapped (entry) {
  getLogger().info(
    { event: 'mapped', host: entry.host, path: entry.path !== undefined ? entry.path : '', port: entry.port },
    translate('lifecycle.mapped', { host: entry.host, path: entry.path !== undefined ? entry.path : '', port: entry.port })
  )
}

// One-click bootstrap: install → login → init → add → up → live. Idempotent —
// re-running it just makes sure the domain is still mapped, started, and live.
async function start (args) {
  const dryRun = args.includes('--dry-run')
  const noInstall = args.includes('--no-install')
  const tunnelFlag = flagValue(args, '--tunnel')
  const spec = args.filter(a => !a.startsWith('--')).join(':')
  if (spec === '') usage(translate('usage.start'))
  let entry
  try {
    entry = parseSpec(spec)
  } catch (err) {
    usage(err.message)
  }
  const key = keyOf(entry)
  const tunnel = tunnelFlag || getTunnel() || DEFAULT_TUNNEL

  if (dryRun) {
    const { entries } = readMap()
    const existing = entries.find(e => keyOf(e) === key)
    const lines = [translate('dryrun.banner')]
    if (!isInstalled()) lines.push(translate('dryrun.install'))
    if (!isLoggedIn()) lines.push(translate('dryrun.login'))
    if (getTunnel() === null) lines.push(translate('dryrun.init', { tunnel }))
    if (existing === undefined) lines.push(translate('dryrun.add', { host: entry.host, port: entry.port }))
    else if (existing.port !== entry.port) lines.push(translate('dryrun.updatePort', { host: existing.host, oldPort: existing.port, port: entry.port }))
    if (!daemonStatus().running) lines.push(translate('dryrun.up'))
    const next = existing === undefined
      ? [...entries, entry]
      : entries.map(e => (keyOf(e) === key ? { ...e, port: entry.port, protocol: entry.protocol } : e))
    lines.push(generateConfig(tunnel, next))
    console.log(lines.join('\n'))
    return
  }

  // 0 — pre-flight domain verification (zone on Cloudflare? hostname unused?)
  const { warning } = await verifyDomain(entry.host)
  if (warning) console.log(dim(warning))

  // 1 — cloudflared
  if (!isInstalled()) {
    if (noInstall) throw new Error(translate('cloudflared.missing'))
    const spin = spinner(translate('spin.install'))
    spin.start()
    try {
      const plan = installCloudflared()
      console.log(check(translate('cloudflared.installedVia', { kind: plan.kind })))
    } finally {
      spin.stop()
    }
  } else {
    console.log(check(translate('cloudflared.installed')))
  }

  // 2 — logged in (browser step, pauses on a TTY)
  await ensureLoggedIn()
  console.log(check(translate('login.done')))

  // 3 — tunnel
  if (getTunnel() !== tunnel) {
    initState()
    setTunnel(tunnel)
  }
  if (!tunnelExists(tunnel)) {
    createTunnel(tunnel)
    console.log(check(translate('tunnel.created', { tunnel })))
  } else {
    console.log(check(translate('tunnel.ready', { tunnel })))
  }

  // 4 — map (add or update the port)
  const spin = spinner(translate('spin.apply'))
  spin.start()
  let changed
  try {
    changed = (await ensureMapped(tunnel, entry, { update: true })) !== 'unchanged'
  } finally {
    spin.stop()
  }
  if (changed) {
    console.log(check(translate('start.mapped', { host: entry.host, port: entry.port, path: entry.path !== undefined ? entry.path : '' })))
  } else {
    console.log(dim(translate('start.alreadyMapped', { host: entry.host, port: entry.port })))
  }

  // 5 — daemon
  if (!daemonStatus().running) {
    const daemonSpin = spinner(translate('spin.startDaemon'))
    daemonSpin.start()
    try {
      startDaemon(tunnel)
    } finally {
      daemonSpin.stop()
    }
    console.log(check(translate('daemon.started')))
  } else {
    console.log(dim(translate('daemon.alreadyRunning')))
  }

  // lifecycle event after the daemon step so it survives the log truncation
  if (changed) logMapped(entry)

  // 6 — verify (with a warm-up countdown — the tunnel rarely connects instantly)
  const daemon = daemonStatus()
  console.log(statusDot(daemon.running, daemon.pid))
  if (daemon.running) {
    const waitSeconds = Number(process.env.ROOTFLARE_COUNTDOWN ?? 5) || 0
    await countdown(waitSeconds, translate('countdown.warmup'))
    console.log(check(translate('start.live', { host: entry.host, port: entry.port })))
  } else {
    console.log(cross(translate('daemon.failedToStart')))
  }
}

async function init (args) {
  if (args.length !== 1) usage(translate('usage.init'))
  const tunnel = args[0]
  initState()
  setTunnel(tunnel)
  if (!tunnelExists(tunnel)) {
    createTunnel(tunnel)
    console.log(check(translate('tunnel.createdAndSet', { tunnel })))
  } else {
    console.log(check(translate('tunnel.set', { tunnel })))
  }
}

function dryRunBanner () {
  return translate('dryrun.banner')
}

function dryRunAdd (tunnel, entry) {
  const { entries } = readMap()
  const host = entry.host
  const path = entry.path !== undefined ? entry.path : ''
  if (entries.some(e => e.host === host && (e.path !== undefined ? e.path : '') === path)) {
    throw new Error(translate('map.duplicate', { host, path }))
  }
  const lines = [dryRunBanner()]
  if (!entries.some(e => e.host === host)) {
    lines.push(translate('dryrun.routeDns', { tunnel, host }))
  }
  lines.push(generateConfig(tunnel, [...entries, entry]))
  console.log(lines.join('\n'))
}

async function add (args) {
  if (args.length === 0) usage(translate('usage.add'))
  const dryRun = args.includes('--dry-run')
  const spec = args.filter(a => a !== '--dry-run').join(':')
  let entry
  try {
    entry = parseSpec(spec)
  } catch (err) {
    usage(err.message)
  }
  const tunnel = tunnelOrDie()
  if (dryRun) {
    dryRunAdd(tunnel, entry)
    return
  }
  const { warning } = await verifyDomain(entry.host)
  if (warning) console.log(dim(warning))
  const spin = spinner(translate('spin.routing'))
  spin.start()
  try {
    await ensureMapped(tunnel, entry)
  } finally {
    spin.stop()
  }
  logMapped(entry)
  console.log(check(translate('add.done', { host: entry.host, service: serviceLabel(entry) })))
  daemonHint()
}

async function remove (args) {
  const dryRun = args.includes('--dry-run')
  const all = args.includes('--all')
  const hosts = args.filter(a => a !== '--dry-run' && a !== '--all')
  if (all && hosts.length > 0) usage(translate('usage.removeAllConflict'))
  if (!all && hosts.length !== 1) usage(translate('usage.remove'))
  const tunnel = tunnelOrDie()
  const host = hosts[0]
  if (dryRun) {
    const { entries } = readMap()
    console.log(dryRunBanner())
    if (all) {
      if (entries.length === 0) {
        console.log(dim(translate('map.empty')))
        return
      }
      console.log(translate('dryrun.removeAll', { count: entries.length, noun: entries.length === 1 ? 'entry' : 'entries' }))
      console.log(generateConfig(tunnel, []))
      return
    }
    if (!entries.some(e => e.host === host)) {
      console.log(cross(translate('remove.missing', { host })))
      return
    }
    const lines = [dryRunBanner(), translate('dryrun.remove', { host })]
    lines.push(generateConfig(tunnel, entries.filter(e => e.host !== host)))
    console.log(lines.join('\n'))
    return
  }
  const removed = await withLock(async () => {
    if (all) {
      const { entries } = readMap()
      const count = entries.length
      if (count === 0) return 0
      writeMap([])
      await applyMap(tunnel)
      return count
    }
    const ok = removeHost(host)
    if (ok) await applyMap(tunnel)
    return ok ? 1 : 0
  })
  if (all) {
    if (removed > 0) getLogger().info({ event: 'removed_all', count: removed }, translate('lifecycle.removedAll', { count: removed }))
    console.log(removed > 0
      ? check(translate('removeAll.done', { count: removed, noun: removed === 1 ? 'entry' : 'entries' }))
      : dim('map is already empty'))
  } else {
    if (removed) getLogger().info({ event: 'removed', host }, translate('lifecycle.removed', { host }))
    console.log(removed ? check(translate('remove.done', { host })) : cross(translate('remove.missing', { host })))
  }
  daemonHint()
}

async function list (args) {
  const { entries, errors } = readMap()
  const daemon = daemonStatus()
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      map: entries,
      errors,
      daemon,
      cloudflared: isInstalled() ? 'installed' : 'not installed'
    }, null, 2))
    return
  }
  const dns = isInstalled() ? '✓' : translate('list.dnsMissing')
  const rows = entries.map(entry => [entry.host + (entry.path !== undefined ? entry.path : ''), String(entry.port), dns, serviceLabel(entry)])
  console.log(icon())
  console.log(table([translate('list.header.hostname'), translate('list.header.port'), translate('list.header.dns'), translate('list.header.service')], rows.length ? rows : [['—', '—', '—', '—']]))
  if (errors.length > 0) {
    console.log(dim(translate('list.invalidLines', { count: errors.length })))
  }
  console.log(statusDot(daemon.running, daemon.pid))
  console.log(dim(translate('list.hint')))
}

async function up (args) {
  const tunnel = tunnelOrDie()
  const { entries } = readMap()
  if (args.includes('--dry-run')) {
    console.log(generateConfig(tunnel, entries))
    return
  }
  if (args.includes('--foreground')) {
    // stop any detached daemon first — only one `tunnel run` can hold a tunnel
    const spin = spinner(translate('spin.foreground'))
    spin.start()
    try {
      await stopDaemon()
      await applyMap(tunnel)
    } finally {
      spin.stop()
    }
    process.exitCode = await runForeground(tunnel)
    return
  }
  const spin = spinner(translate('spin.startDaemon'))
  spin.start()
  try {
    await applyMap(tunnel)
    if (!daemonStatus().running) startDaemon(tunnel)
  } finally {
    spin.stop()
  }
  const { pid } = daemonStatus()
  console.log(green(translate('daemon.running', { pid, tunnel })))
}

async function down () {
  const stopped = await stopDaemon()
  console.log(stopped ? check(translate('daemon.stopped')) : cross(translate('daemon.stopFailed')))
}

async function install () {
  const plan = installCloudflared()
  console.log(check(translate('cloudflared.installedVia', { kind: plan.kind })))
}

async function doctor () {
  const checks = runChecks()
  const bad = checks.filter(c => !c.ok).length
  for (const c of checks) {
    console.log(c.ok ? check(c.name) : cross(translate('doctor.checkLine', { name: c.name, hint: c.hint })))
  }
  if (bad > 0) {
    throw new Error(translate('doctor.failed', { count: bad }))
  }
  console.log(check(translate('doctor.allGood')))
}

// The command registry — the single source of truth for names, help text,
// and handlers. `--help` is generated from it in bin/rootflare.js.
const commands = [
  { name: 'start', desc: translate('cmd.desc.start'), handler: start },
  { name: 'install', desc: translate('cmd.desc.install'), handler: install },
  { name: 'init', desc: translate('cmd.desc.init'), handler: init },
  { name: 'add', desc: translate('cmd.desc.add'), handler: add },
  { name: 'remove', desc: translate('cmd.desc.remove'), handler: remove },
  { name: 'list', desc: translate('cmd.desc.list'), handler: list },
  { name: 'up', desc: translate('cmd.desc.up'), handler: up },
  { name: 'down', desc: translate('cmd.desc.down'), handler: down },
  { name: 'logs', desc: translate('cmd.desc.logs'), handler: () => logs() },
  { name: 'doctor', desc: translate('cmd.desc.doctor'), handler: doctor }
]

module.exports = { commands, UsageError }
