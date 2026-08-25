import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate, messages } from '../lib/messages.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('t interpolates parameters into the template', () => {
  assert.strictEqual(translate('parse.invalidPort', { port: '70000', min: 1, max: 65535 }), 'invalid port \'70000\' (1-65535)')
  assert.strictEqual(translate('tunnel.created', { tunnel: 'sandbox' }), 'tunnel \'sandbox\' created')
  assert.strictEqual(translate('start.mapped', { host: 'app.example.com', port: 3000, path: '' }), 'app.example.com → localhost:3000')
})

test('t leaves unknown placeholders untouched and throws on unknown keys', () => {
  assert.strictEqual(translate('map.empty'), 'map is already empty')
  assert.strictEqual(translate('dryrun.remove', { host: 'x.com' }), '# would remove: x.com')
  assert.throws(() => translate('no.such.key'), /unknown message key/)
})

test('every message key is referenced somewhere in the codebase', () => {
  const root = path.join(__dirname, '..')
  let all = ''
  for (const dir of ['lib', 'bin', 'test']) {
    for (const file of fs.readdirSync(path.join(root, dir))) {
      if (file.endsWith('.js')) {
        all += fs.readFileSync(path.join(root, dir, file), 'utf8')
      }
    }
  }
  for (const key of Object.keys(messages)) {
    assert.ok(
      all.includes(`'${key}'`) || all.includes(`"${key}"`),
      `message key '${key}' is never referenced — remove it from the catalog`
    )
  }
})
