'use strict'
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { acquireLock, releaseLock, withLock } = require('../lib/state')

let homeDir

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-lock-'))
  process.env.ROOTFLARE_HOME = homeDir
})

afterEach(() => {
  delete process.env.ROOTFLARE_HOME
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('lock acquired → second acquire blocked', () => {
  assert.strictEqual(acquireLock(), true)
  assert.strictEqual(acquireLock(), false)
  releaseLock()
  assert.strictEqual(acquireLock(), true)
  releaseLock()
})

test('lock released on success and on error', async () => {
  await withLock(() => {})
  assert.strictEqual(acquireLock(), true)
  releaseLock()

  await assert.rejects(() => withLock(() => { throw new Error('boom') }), /boom/)
  assert.strictEqual(acquireLock(), true)
  releaseLock()
})

test('stale lock cleaned up', () => {
  // a pid that is certainly dead: a just-exited child process
  const dead = spawnSync(process.execPath, ['-e', ''])
  assert.strictEqual(dead.status, 0)

  const lock = path.join(homeDir, '.lock')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'pid'), String(dead.pid))
  assert.strictEqual(acquireLock(), true)
  releaseLock()

  // garbage pid file is also stale
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'pid'), 'not-a-pid')
  assert.strictEqual(acquireLock(), true)
  releaseLock()
})

test('extra: live pid blocks acquire (lock held by running process)', () => {
  const lock = path.join(homeDir, '.lock')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
  assert.strictEqual(acquireLock(), false)
})
