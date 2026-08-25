'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BIN = path.join(__dirname, '..', 'bin', 'rootflare.js')

const COMMANDS = ['start', 'install', 'init', 'add', 'remove', 'list', 'up', 'down', 'logs', 'doctor']

function run (args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

test('bare rootflare prints help + banner, exit 0', () => {
  const res = run([])
  assert.strictEqual(res.status, 0)
  assert.ok(res.stdout.includes('████'), 'banner present')
  assert.ok(res.stdout.includes('Usage: rootflare'), 'help present')
})

test('unknown command → usage error, exit 2', () => {
  const res = run(['frobnicate'])
  assert.strictEqual(res.status, 2)
  assert.match(res.stderr, /unknown command/)
})

test('--version prints semver', () => {
  const res = run(['--version'])
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /\d+\.\d+\.\d+/)
  assert.ok(res.stdout.includes('████'), 'banner shown with --version')
})

test('--help lists all 10 commands (generated from the registry)', () => {
  const res = run(['--help'])
  assert.strictEqual(res.status, 0)
  for (const cmd of COMMANDS) {
    assert.ok(res.stdout.includes(cmd), `help lists '${cmd}'`)
  }
})

test('NO_COLOR respected', () => {
  const res = run(['--version'], { NO_COLOR: '1' })
  assert.ok(!res.stdout.includes('\x1b'), 'no ANSI escapes with NO_COLOR')
})
