/**
 * Client bundle smoke test: load lib/client.js through a minimal
 * __ModuleLoader__ + require shim (same shape as the browser kernel), then
 * call the plugin's apply() against a fake slots registry. Fails loudly if the
 * factory throws, requires an unknown module, or registers the wrong section.
 *
 * Run after `pnpm build:client`: node scripts/verify-client-loader.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The platform module table entries this bundle is allowed to require.
const moduleTable = {
  react: () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
}

let loaded

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.equal(loaded, undefined, 'bundle registered twice')
      loaded = { id, module: factory(name => {
        const resolve = moduleTable[name]
        if (resolve === undefined) throw new Error(`bundle requires unknown module: ${name}`)
        return resolve()
      }) }
    },
  },
}

// Minimal DOM shim: the module body must not touch document before apply(),
// and apply() only installs a style element.
const styles = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { append: element => styles.push(element) },
}

await import('../lib/client.js')

assert.ok(loaded, 'bundle did not call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-channels')
const plugin = loaded.module
assert.equal(typeof plugin.apply, 'function', 'bundle did not export apply()')
assert.deepEqual(plugin.inject, ['slots'], 'bundle inject must be the slots registry')
assert.equal(typeof plugin.name, 'string')

const registrations = []
const effects = []
plugin.apply({
  effect: callback => { effects.push(callback()) },
  slots: {
    inject: (slot, contribution) => { contribution() },
    register: (declaration, component) => {
      registrations.push({ declaration, component })
      return () => {}
    },
  },
})

assert.equal(styles.length, 1, 'stylesheet was not installed')
assert.equal(registrations.length, 1, 'expected exactly one slot registration')
const [registration] = registrations
assert.equal(registration.declaration.name, 'settings.section')
assert.equal(registration.declaration.id, 'feishu-channels')
assert.equal(typeof registration.component, 'function')

console.log('OK: lib/client.js loads through the module-loader shim and registers 设置 → 飞书渠道')
