import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ROOT = path.join(__dirname, '..', '..')
const DIST = path.join(ROOT, 'dist', 'rootflare.cjs')

test('build: esbuild bundles + minifies a working dist/rootflare.js', () => {
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', cwd: ROOT })
  assert.strictEqual(build.status, 0, build.stderr || build.stdout)
  assert.ok(fs.existsSync(DIST), 'dist/rootflare.cjs produced')

  const version = spawnSync(process.execPath, [DIST, '--version'], { encoding: 'utf8' })
  assert.strictEqual(version.status, 0)
  assert.match(version.stdout, /\d+\.\d+\.\d+/, 'built binary prints the version')

  // minified: no source comments, small, keeps its shebang
  const content = fs.readFileSync(DIST, 'utf8')
  assert.ok(content.startsWith('#!/usr/bin/env node'), 'shebang preserved')
  assert.ok(!content.includes('// Phase 0 stub'), 'source comments stripped')
  const size = fs.statSync(DIST).size
  assert.ok(size < 100 * 1024, `bundle is small (${size} bytes)`)
})
