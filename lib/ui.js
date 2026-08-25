'use strict'

const RESET = '\x1b[0m'
const { translate } = require('./messages')

function isTTY () {
  return Boolean(process.stdout.isTTY)
}

// Colors on only when stdout is a TTY and NO_COLOR is not set (the de-facto
// standard: presence of NO_COLOR, whatever its value, disables color).
function colorEnabled () {
  return isTTY() && process.env.NO_COLOR === undefined
}

function colorize (str, code) {
  return colorEnabled() ? `\x1b[${code}m${str}${RESET}` : str
}

function orange (str) {
  return colorize(str, '38;5;208')
}

function green (str) {
  return colorize(str, '32')
}

function yellow (str) {
  return colorize(str, '33')
}

function red (str) {
  return colorize(str, '31')
}

function dim (str) {
  return colorize(str, '2')
}

function check (text) {
  return green(`✓ ${text}`)
}

function cross (text) {
  return red(`✗ ${text}`)
}

function statusDot (running, pid) {
  return running ? green(translate('ui.dot.running', { pid })) : dim(translate('ui.dot.stopped'))
}

const ICON = [
  '         ✦',
  '        /|\\',
  '       / | \\',
  '      /  |  \\',
  '  ═══════╪═══════',
  '         │',
  '        ┌┴┐',
  '        │ │',
  '       ─┴─┴─'
].join('\n')

function icon () {
  return dim(ICON)
}

const BANNER = [
  '████   ███   ███  █████ █████ █      ███  ████  █████',
  '█  █ █   █ █   █   █   █     █     █   █ █  █ █',
  '███  █   █ █   █   █   ████  █     █████ ███  ████',
  '█ █  █   █ █   █   █   █     █     █   █ █ █  █',
  '█  █  ███   ███    █   █     █████ █   █ █  █ █████'
].join('\n')

function banner () {
  return orange(BANNER)
}

// Bordered box-drawing table: first row is the header, columns are sized to
// the widest cell (content width + 2 padding).
function table (headers, rows) {
  const widths = headers.map((header, i) => {
    const max = Math.max(header.length, ...rows.map(row => String(row[i]).length))
    return max + 2
  })
  const border = (left, mid, right) =>
    left + widths.map(w => '─'.repeat(w)).join(mid) + right
  const render = cells => cells
    .map((cell, i) => ` ${String(cell).padEnd(widths[i] - 2)} `)
    .join('│')
  return [
    border('┌', '┬', '┐'),
    `│${render(headers)}│`,
    border('├', '┼', '┤'),
    ...rows.map(row => `│${render(row)}│`),
    border('└', '┴', '┘')
  ].join('\n')
}

const SPINNER_FRAMES = ['|', '/', '-', '\\']

function spinnerFrames () {
  return SPINNER_FRAMES
}

// Animated |/-\ spinner for long operations (route dns, restarts). TTY-only:
// on a pipe it renders nothing, so scripts and redirected output stay clean.
// Always call stop() (ideally in a finally) to clear the line and the timer.
// `out` is injectable for tests (defaults to process.stdout).
function spinner (text = '', out = process.stdout) {
  let frame = 0
  let timer = null
  let active = false
  function draw () {
    out.write(`\r ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text} `)
    frame++
  }
  return {
    start () {
      if (!isTTY() || active) return
      active = true
      draw()
      timer = setInterval(draw, 120)
    },
    stop () {
      if (!active) return
      active = false
      clearInterval(timer)
      timer = null
      out.write('\r\x1b[K') // erase the spinner line
    }
  }
}

function sleepAsync (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Animated in-place countdown (5… 4… 3… 2… 1) — a warm-up beat for `start`,
// since a tunnel rarely goes live the instant the daemon starts. On a pipe it
// prints one plain line and waits; seconds <= 0 skips the wait entirely
// (ROOTFLARE_COUNTDOWN=0 for scripts). `out` is injectable for tests.
async function countdown (seconds = 5, label = '', out = process.stdout) {
  if (seconds <= 0) return
  const labelText = label ? ` ${label}` : ''
  if (isTTY()) {
    for (let i = seconds; i > 0; i--) {
      out.write(`\r ${i}${labelText} `)
      await sleepAsync(1000)
    }
    out.write('\r\x1b[K') // erase the countdown line
  } else {
    out.write(`${translate('countdown.waiting', { seconds })}\n`)
    await sleepAsync(seconds * 1000)
  }
}

module.exports = {
  table,
  colorize,
  banner,
  spinnerFrames,
  spinner,
  countdown,
  green,
  yellow,
  red,
  dim,
  check,
  cross,
  statusDot,
  icon
}
