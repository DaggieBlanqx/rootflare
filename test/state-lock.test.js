import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireLock, releaseLock, withLock } from '../lib/state.js'

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
