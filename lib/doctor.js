import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getTunnel, readMap, home } from './state.js'
import { translate } from './messages.js'
import { isInstalled, tunnelExists } from './cloudflared.js'

function osReleaseText () {
  if (process.platform !== 'linux') return ''
  try {
    return fs.readFileSync('/etc/os-release', 'utf8')
  } catch {
    return ''
  }
}

function parseOsRelease (text) {
  const m = text.match(/^ID=(.+)$/m)
  return m ? m[1].trim().replace(/"/g, '') : ''
}

function downloadUrl () {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
}

// Pure installer plan — the testable heart of `install`. Returns the
// OS-specific steps without executing anything.
function installPlan (platform = process.platform, releaseText = osReleaseText()) {
  if (platform === 'darwin') {
    return { kind: 'brew', steps: ['brew install cloudflared'] }
  }
  if (platform === 'linux') {
    const distro = parseOsRelease(releaseText)
    if (distro === 'debian' || distro === 'ubuntu') {
      return {
        kind: 'apt',
        steps: ['sudo apt-get update', 'sudo apt-get install -y cloudflared']
      }
    }
    const binPath = path.join(home(), 'bin', 'cloudflared')
    return {
      kind: 'download',
      steps: [
        `curl -fsSL ${downloadUrl()} -o ${binPath}`,
        `chmod +x ${binPath}`
      ]
    }
  }
  return {
    kind: 'unsupported',
    steps: [],
    hint: translate('doctor.unsupported')
  }
}

function isLoggedIn (cloudflaredHome = path.join(os.homedir(), '.cloudflared')) {
  return fs.existsSync(path.join(cloudflaredHome, 'cert.pem'))
}

// Preflight checks shared by `doctor` and the CLI's friendly failure hints.
function runChecks (opts = {}) {
  const cloudflaredHome = opts.cloudflaredHome || path.join(os.homedir(), '.cloudflared')
  const { errors } = readMap()
  const tunnelName = getTunnel()
  return [
    {
      name: translate('cloudflared.installed'),
      ok: isInstalled(),
      hint: translate('cloudflared.installHint')
    },
    {
      name: translate('login.done'),
      ok: isLoggedIn(cloudflaredHome),
      hint: translate('login.hint')
    },
    {
      name: translate('doctor.check.tunnelSet'),
      ok: tunnelName !== null,
      hint: translate('tunnel.initHint')
    },
    {
      name: translate('doctor.check.tunnelExists'),
      ok: tunnelName !== null && tunnelExists(tunnelName),
      hint: tunnelName === null
        ? translate('tunnel.initHintFirst')
        : translate('tunnel.initHintCreate')
    },
    {
      name: translate('doctor.check.mapValid'),
      ok: errors.length === 0,
      hint: errors.map(e => translate('map.lineError', e)).join('; ')
    }
  ]
}

// Executes the plan step by step (brew / apt / direct download).
function installCloudflared () {
  const plan = installPlan()
  if (plan.kind === 'unsupported') throw new Error(plan.hint)
  for (const step of plan.steps) {
    const res = spawnSync(step, { shell: true, encoding: 'utf8' })
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${res.status}`
      throw new Error(translate('doctor.installStepFailed', { step, why }))
    }
  }
  return plan
}

export { runChecks, installPlan, installCloudflared, isLoggedIn }
