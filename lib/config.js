'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PLACEHOLDER_CREDENTIALS = '~/.cloudflared/<TUNNEL-UUID>.json'

function defaultCloudflaredHome () {
  return path.join(os.homedir(), '.cloudflared')
}

// Finds the tunnel credentials JSON in ~/.cloudflared (any *.json that is
// not cert.pem). Returns null when cloudflared is not set up yet.
function resolveCredentialsFile (cloudflaredHome = defaultCloudflaredHome()) {
  let files
  try {
    files = fs.readdirSync(cloudflaredHome)
  } catch {
    return null
  }
  const cred = files.find(f => f.endsWith('.json') && f !== 'cert.pem')
  return cred ? path.join(cloudflaredHome, cred) : null
}

function serviceFor (entry) {
  const proto = entry.protocol === 'https' ? 'https' : 'http'
  return `${proto}://localhost:${entry.port}`
}

function ruleYaml (entry) {
  const lines = [`  - hostname: ${entry.host}`]
  if (entry.path !== undefined) lines.push(`    path: ${entry.path}`)
  lines.push(`    service: ${serviceFor(entry)}`)
  if (entry.protocol === 'https') lines.push('    noTLSVerify: true')
  return lines.join('\n')
}

// cloudflared matches ingress rules in order, so path rules must come before
// plain hostname rules — otherwise app.example.com would swallow /api. All
// path rules precede all plain rules, keeping map order within each group.
function orderRules (entries) {
  const withPath = []
  const plain = []
  for (const entry of entries) {
    if (entry.path !== undefined) withPath.push(entry)
    else plain.push(entry)
  }
  return [...withPath, ...plain]
}

// Pure generator — no filesystem writes, so --dry-run can print this
// verbatim and `up` can write it to ~/.rootflare/config.yml.
function generateConfig (tunnel, entries, opts = {}) {
  const credentialsFile = opts.credentialsFile ||
    resolveCredentialsFile(opts.cloudflaredHome) ||
    PLACEHOLDER_CREDENTIALS
  const rules = orderRules(entries).map(ruleYaml)
  const lines = [
    `tunnel: ${tunnel}`,
    `credentials-file: ${credentialsFile}`,
    'ingress:',
    ...rules,
    '  - service: http_status:404'
  ]
  return lines.join('\n') + '\n'
}

module.exports = { generateConfig, resolveCredentialsFile }
