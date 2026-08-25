'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { table, colorize, banner, spinnerFrames, spinner, countdown } = require('../lib/ui')

test('table renders correct borders and column padding', () => {
  const out = table(
    ['HOSTNAME', 'PORT'],
    [
      ['app.example.com', '3000'],
      ['app2.example.com', '4000']
    ]
  )
  const lines = out.split('\n')
  assert.strictEqual(lines[0], '┌──────────────────┬──────┐')
  assert.strictEqual(lines[1], '│ HOSTNAME         │ PORT │')
  assert.strictEqual(lines[2], '├──────────────────┼──────┤')
  assert.strictEqual(lines[3], '│ app.example.com  │ 3000 │')
  assert.strictEqual(lines[4], '│ app2.example.com │ 4000 │')
  assert.strictEqual(lines[5], '└──────────────────┴──────┘')
})

test('non-TTY output is plain (no ANSI escapes)', () => {
  const original = process.stdout.isTTY
  const ESC = String.fromCharCode(27)
  process.stdout.isTTY = false
  try {
    assert.strictEqual(colorize('hello', '31'), 'hello')
    assert.ok(!banner().includes(ESC), 'banner is plain when not a TTY')
  } finally {
    process.stdout.isTTY = original
  }
})

test('banner string contains the ROOTFLARE block', () => {
  const art = banner()
  assert.ok(art.includes('████'), 'block letter R')
  assert.ok(art.includes('█      ███'), 'block letter F/A')
  assert.ok(art.split('\n').length >= 5, 'five block rows')
})

test('spinner frames cycle', () => {
  assert.deepStrictEqual(spinnerFrames(), ['|', '/', '-', '\\'])
})

function fakeOut () {
  return { chunks: [], write (chunk) { this.chunks.push(String(chunk)); return true } }
}

test('extra: spinner redraws frames in place while started, stops cleanly', async () => {
  const original = process.stdout.isTTY
  process.stdout.isTTY = true
  try {
    const out = fakeOut()
    const spin = spinner('working', out)
    spin.start()
    await new Promise(resolve => setTimeout(resolve, 400))
    spin.stop()
    const written = out.chunks.join('')
    assert.ok(written.includes('working'), 'label printed')
    assert.match(written, /\r [|/\\-] working/, 'frames redrawn with carriage return')
    assert.ok(written.endsWith('\r\x1b[K'), 'spinner line erased on stop')
  } finally {
    process.stdout.isTTY = original
  }
})

test('extra: spinner is a no-op when stdout is not a TTY', () => {
  const original = process.stdout.isTTY
  process.stdout.isTTY = false
  try {
    const out = fakeOut()
    const spin = spinner('working', out)
    spin.start()
    spin.stop()
    assert.strictEqual(out.chunks.join(''), '', 'nothing written when not a TTY')
  } finally {
    process.stdout.isTTY = original
  }
})

test('extra: countdown animates in place on a TTY and erases its line', async () => {
  const original = process.stdout.isTTY
  process.stdout.isTTY = true
  try {
    const out = fakeOut()
    await countdown(1, 'warming up', out)
    const written = out.chunks.join('')
    assert.match(written, /\r 1 warming up /, 'countdown frame drawn in place')
    assert.ok(written.endsWith('\r\x1b[K'), 'countdown line erased')
  } finally {
    process.stdout.isTTY = original
  }
})

test('extra: countdown prints one plain line off-TTY; zero seconds skips entirely', async () => {
  const original = process.stdout.isTTY
  process.stdout.isTTY = false
  try {
    const out = fakeOut()
    await countdown(1, 'x', out)
    assert.match(out.chunks.join(''), /waiting 1s for the tunnel to connect/)

    await countdown(0, 'x', out)
    const withoutZero = out.chunks.join('')
    assert.strictEqual(withoutZero.match(/waiting/g)?.length, 1, 'zero seconds adds nothing')
  } finally {
    process.stdout.isTTY = original
  }
})

test('extra: colorize emits ANSI when TTY and NO_COLOR unset', () => {
  const original = process.stdout.isTTY
  const originalNoColor = process.env.NO_COLOR
  const ESC = String.fromCharCode(27)
  process.stdout.isTTY = true
  delete process.env.NO_COLOR
  try {
    const red = colorize('boom', '31')
    assert.ok(red.startsWith(`${ESC}[31m`))
    assert.ok(red.endsWith(`${ESC}[0m`))
    const ansi = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
    assert.strictEqual(red.replace(ansi, ''), 'boom')
  } finally {
    process.stdout.isTTY = original
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  }
})

test('extra: NO_COLOR disables color even on a TTY', () => {
  const original = process.stdout.isTTY
  const originalNoColor = process.env.NO_COLOR
  process.stdout.isTTY = true
  process.env.NO_COLOR = '1'
  try {
    assert.strictEqual(colorize('boom', '31'), 'boom')
  } finally {
    process.stdout.isTTY = original
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  }
})
