'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dns = require('node:dns')
const { spawn, spawnSync } = require('node:child_process')
const { translate } = require('./messages')
const { getLogger, reopenLogger } = require('./logger')
const { paths, readMap, mapError } = require('./state')
const { generateConfig, resolveCredentialsFile } = require('./config')

const POLL_MS = 50
const STOP_TIMEOUT_MS = 5000

function cloudflaredBin () {
  return process.env.ROOTFLARE_CLOUDFLARED || 'cloudflared'
}

function missingHint () {
  return translate('cloudflared.missing')
}

function isInstalled () {
  const res = spawnSync(cloudflaredBin(), ['--version'], { encoding: 'utf8' })
  return !res.error && res.status === 0
}

function runSync (args) {
  const res = spawnSync(cloudflaredBin(), args, { encoding: 'utf8' })
  if (res.error) throw new Error(translate('cloudflared.missingReason', { why: res.error.message }))
  if (res.status !== 0) {
    throw new Error(translate('cloudflared.commandFailed', { command: args.join(' '), exitCode: res.status, stderr: (res.stderr || '').trim() }))
  }
  return res
}

// Shared `tunnel run` invocation: --config must precede the subcommand.
function runArgs (tunnel) {
  return ['tunnel', '--config', paths().config, 'run', tunnel]
}

function routeDns (tunnel, hostname) {
  try {
    runSync(['tunnel', 'route', 'dns', tunnel, hostname])
  } catch (err) {
    if (/zone/i.test(err.message)) {
      throw new Error(`${err.message} — ${translate('cloudflared.zoneHint')}`)
    }
    throw err
  }
}

const CLOUDFLARE_NS_RE = /\.ns\.cloudflare\.com\.?$/
const TUNNEL_CNAME_RE = /\.cfargotunnel\.com\.?$/
// Tunneled hostnames flatten to Cloudflare anycast IPs — not conflicts.
const CLOUDFLARE_ANYCAST_RE = /^(104\.21\.|172\.67\.)/

function withTimeout (promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ])
}

// Walks the hostname up to its registrable zone and reports whether that
// zone is delegated to Cloudflare nameservers. Returns null when it can't
// be determined (best-effort — route dns remains authoritative).
async function zoneIsCloudflare (host) {
  const labels = host.replace(/^\*\./, '').split('.')
  for (let i = 0; i <= labels.length - 2; i++) {
    const zone = labels.slice(i).join('.')
    const ns = await withTimeout(dns.promises.resolveNs(zone).catch(() => null))
    if (ns === null) continue
    return ns.some(name => CLOUDFLARE_NS_RE.test(name))
  }
  return null
}

// The first existing DNS target for the host, or null when it's unused.
async function existingTarget (host) {
  const cname = await withTimeout(dns.promises.resolveCname(host).catch(() => null))
  if (cname && cname.length > 0) return cname[0]
  const a = await withTimeout(dns.promises.resolve4(host).catch(() => null))
  if (a && a.length > 0) return a[0]
  const aaaa = await withTimeout(dns.promises.resolve6(host).catch(() => null))
  if (aaaa && aaaa.length > 0) return aaaa[0]
  return null
}

// Pre-flight domain ownership sanity for add/start:
//  1. fail fast when the zone isn't on Cloudflare,
//  2. warn when the hostname already resolves elsewhere (unless it's our
//     own tunnel CNAME). ROOTFLARE_SKIP_VERIFY=1 turns this off entirely.
async function verifyDomain (host) {
  if (process.env.ROOTFLARE_SKIP_VERIFY === '1') return { warning: null }
  const zone = await zoneIsCloudflare(host)
  if (zone === false) {
    const apex = host.replace(/^\*\./, '').split('.').slice(-2).join('.')
    throw new Error(translate('verify.zoneNotCloudflare', { zone: apex }))
  }
  const target = await existingTarget(host)
  if (target !== null && !TUNNEL_CNAME_RE.test(target) && !CLOUDFLARE_ANYCAST_RE.test(target)) {
    const message = translate('verify.conflict', { host, target })
    getLogger().warn({ event: 'domain.conflict', host, target }, message)
    return { warning: message }
  }
  return { warning: null }
}

// Credentials file for the tunnel: scanned from ~/.cloudflared/*.json,
// falling back to deriving the UUID from `cloudflared tunnel list` (DESIGN).
function tunnelUuidFromList (output, tunnel) {
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length >= 2 && cols[1] === tunnel && /^[0-9a-f-]{36}$/i.test(cols[0])) {
      return cols[0]
    }
  }
  return null
}

function resolveCredentials (tunnel, cloudflaredHome = path.join(os.homedir(), '.cloudflared')) {
  const scanned = resolveCredentialsFile(cloudflaredHome)
  if (scanned) return scanned
  const res = spawnSync(cloudflaredBin(), ['tunnel', 'list'], { encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  const uuid = tunnelUuidFromList(res.stdout, tunnel)
  if (!uuid) return null
  const file = path.join(cloudflaredHome, `${uuid}.json`)
  return fs.existsSync(file) ? file : null
}

function tunnelExists (tunnel) {
  const res = spawnSync(cloudflaredBin(), ['tunnel', 'info', tunnel], { encoding: 'utf8' })
  return !res.error && res.status === 0
}

function createTunnel (tunnel) {
  runSync(['tunnel', 'create', tunnel])
}

// Attached run (up --foreground): streams cloudflared output to the terminal
// and resolves with its exit code when the tunnel stops.
function runForeground (tunnel) {
  if (!isInstalled()) throw new Error(missingHint())
  const child = spawn(cloudflaredBin(), runArgs(tunnel), {
    stdio: 'inherit'
  })
  return new Promise(resolve => child.on('exit', code => resolve(code)))
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

function readPid () {
  const file = paths().pid
  if (!fs.existsSync(file)) return null
  const pid = parseInt(fs.readFileSync(file, 'utf8'), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function writePid (pid) {
  fs.writeFileSync(paths().pid, String(pid))
}

function clearPid () {
  try {
    fs.rmSync(paths().pid, { force: true })
  } catch {}
}

// Running state is derived from the .pid file: a pid pointing at a dead
// process is stale — it gets cleaned up and reported as not running.
function daemonStatus () {
  const pid = readPid()
  if (pid === null) return { running: false, pid: null }
  if (pidAlive(pid)) return { running: true, pid }
  clearPid()
  return { running: false, pid: null }
}

function sleepAsync (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function startDaemon (tunnel) {
  if (!isInstalled()) throw new Error(missingHint())
  const { root, log: logFile } = paths()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const out = fs.openSync(logFile, 'w') // fresh log per session (log rotation)
  reopenLogger() // our pino fd must start from the top of the truncated file
  const child = spawn(cloudflaredBin(), runArgs(tunnel), {
    detached: true,
    stdio: ['ignore', out, out]
  })
  child.on('error', (err) => {
    clearPid()
    getLogger().error({ event: 'daemon.start_failed', err: err.message }, translate('lifecycle.startFailed', { message: err.message }))
  })
  writePid(child.pid)
  child.unref()
  getLogger().info({ event: 'daemon.started', pid: child.pid }, translate('lifecycle.daemonStarted', { pid: child.pid }))
  return child.pid
}

// SIGTERM, wait for exit, escalate to SIGKILL, verify the process is gone.
// Async on purpose: the sleep must let the event loop run, otherwise a dead
// child is never reaped and stays a zombie that kill(pid, 0) reports alive
// forever. Returns true when no daemon is left running.
async function stopDaemon (timeoutMs = STOP_TIMEOUT_MS) {
  const pid = readPid()
  if (pid === null) return true
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && pidAlive(pid)) await sleepAsync(POLL_MS)
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    const killDeadline = Date.now() + 2000
    while (Date.now() < killDeadline && pidAlive(pid)) await sleepAsync(POLL_MS)
  }
  const stopped = !pidAlive(pid)
  clearPid()
  if (stopped) getLogger().info({ event: 'daemon.stopped' }, translate('lifecycle.daemonStopped'))
  return stopped
}
function previousHostnames (configPath) {
  try {
    const cfg = fs.readFileSync(configPath, 'utf8')
    return [...cfg.matchAll(/hostname: (.+)/g)].map(m => m[1])
  } catch {
    return []
  }
}

// Shared mutation pipeline (add / remove / hand-edit-then-up):
// validate map → write config → route dns (new domains only) → restart-if-running.
async function applyMap (tunnel, opts = {}) {
  const { entries, errors } = readMap()
  if (errors.length > 0) throw new Error(mapError(errors))
  const configPath = paths().config
  const previous = previousHostnames(configPath)
  const cfg = generateConfig(tunnel, entries, {
    ...opts,
    credentialsFile: resolveCredentials(tunnel, opts.cloudflaredHome)
  })
  fs.mkdirSync(paths().root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configPath, cfg, { mode: 0o600 })

  const routed = entries.map(e => e.host).filter(host => !previous.includes(host))
  for (const host of routed) routeDns(tunnel, host)

  let restarted = false
  if (daemonStatus().running) {
    await stopDaemon()
    startDaemon(tunnel)
    restarted = true
  }
  return { routed, restarted }
}

module.exports = { isInstalled, routeDns, verifyDomain, tunnelExists, createTunnel, resolveCredentials, startDaemon, stopDaemon, daemonStatus, applyMap, runForeground }
