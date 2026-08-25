import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { colorizeLogLine, formatPinoLine, tailFrom } from '../lib/live.js'

const ESC = String.fromCharCode(27)
const ansi = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

function plain (line) {
  return line.replace(ansi, '')
}

test('formatPinoLine pretty-prints structured events with fields', () => {
  const line = JSON.stringify({
    level: 30,
    time: 1724580000000,
    event: 'mapped',
    host: 'app.example.com',
    port: 3000,
    msg: 'rootflare: mapped app.example.com → localhost:3000'
  })
  const pretty = formatPinoLine(line)
  assert.match(pretty, /\[10:00:00\] INFO rootflare: mapped app\.example\.com → localhost:3000/)
  assert.match(pretty, /event=mapped host=app\.example\.com port=3000/)
  assert.strictEqual(formatPinoLine('not json at all'), null)
  assert.strictEqual(formatPinoLine('{"level":"nope"}'), null)
})

test('extra: pino JSON lines are colorized by level alongside cloudflared lines', () => {
  const original = process.stdout.isTTY
  const originalNoColor = process.env.NO_COLOR
  process.stdout.isTTY = true
  delete process.env.NO_COLOR
  try {
    const warn = JSON.stringify({ level: 40, time: 1724580000000, event: 'conflict', msg: 'warned' })
    const error = JSON.stringify({ level: 50, time: 1724580000000, event: 'failed', msg: 'boom' })
    assert.ok(colorizeLogLine(warn).includes(`${ESC}[33m`), 'warn yellow')
    assert.ok(colorizeLogLine(error).includes(`${ESC}[31m`), 'error red')
    assert.ok(colorizeLogLine('2026-01-01 INF tunnel up').includes(`${ESC}[32m`), 'cloudflared INF still green')
  } finally {
    process.stdout.isTTY = original
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  }
})

test('extra: log levels are colorized (ERR red, WARN yellow, INF green)', () => {
  const original = process.stdout.isTTY
  const originalNoColor = process.env.NO_COLOR
  process.stdout.isTTY = true
  delete process.env.NO_COLOR
  try {
    assert.ok(colorizeLogLine('2026-01-01 ERR something broke').includes(`${ESC}[31m`))
    assert.ok(colorizeLogLine('2026-01-01 WARN slow request').includes(`${ESC}[33m`))
    assert.ok(colorizeLogLine('2026-01-01 INF tunnel connected').includes(`${ESC}[32m`))
    assert.strictEqual(plain(colorizeLogLine('2026-01-01 INF tunnel connected')), '2026-01-01 INF tunnel connected')
    assert.strictEqual(colorizeLogLine('no level here'), 'no level here')
  } finally {
    process.stdout.isTTY = original
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  }
})

test('extra: tailFrom reads new content past the offset and tracks it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-tail-'))
  try {
    const file = path.join(dir, 'tunnel.log')
    fs.writeFileSync(file, 'line one\nline two\n')
    const first = tailFrom(file, 0)
    assert.strictEqual(first.text, 'line one\nline two\n')
    assert.strictEqual(first.offset, 18)

    fs.appendFileSync(file, 'line three\n')
    const second = tailFrom(file, first.offset)
    assert.strictEqual(second.text, 'line three\n')

    assert.deepStrictEqual(tailFrom(file, second.offset), { text: '', offset: second.offset })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extra: tailFrom handles missing file and truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootflare-tail-'))
  try {
    const file = path.join(dir, 'tunnel.log')
    assert.deepStrictEqual(tailFrom(file, 0), { text: '', offset: 0 })

    fs.writeFileSync(file, 'some content')
    // log rotated/truncated below the tracked offset → restart from zero
    fs.writeFileSync(file, 'new\n')
    const res = tailFrom(file, 999)
    assert.strictEqual(res.text, 'new\n')
    assert.strictEqual(res.offset, 4)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
