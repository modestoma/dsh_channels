/**
 * Client bundle smoke test: load lib/client.js through a minimal
 * __ModuleLoader__ + require shim (same shape as the browser kernel), then
 * call the plugin's apply() against a fake slots registry. Fails loudly if the
 * factory throws, requires an unknown module, or registers the wrong slots.
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
assert.equal(loaded.id, '@modesto_ma/dsh-channels')
const plugin = loaded.module
assert.equal(typeof plugin.apply, 'function', 'bundle did not export apply()')
assert.deepEqual(plugin.inject, ['slots'], 'bundle inject must be the slots registry')
assert.equal(typeof plugin.name, 'string')

const registrations = []
const effects = []
const tabTypes = []
const opened = []
const scopeDeps = []
const openedSessions = []
const fakeSlots = {
  inject: (slot, contribution) => { contribution() },
  register: (declaration, component) => {
    registrations.push({ declaration, component })
    return () => {}
  },
}
plugin.apply({
  effect: callback => { effects.push(callback()) },
  slots: fakeSlots,
  inject: (deps, callback) => {
    scopeDeps.push(deps)
    callback({
      effect: callback => { effects.push(callback()) },
      slots: fakeSlots,
      sidebarRightTabs: { register: definition => { tabTypes.push(definition); return () => {} } },
      sidebarRight: { openTab: kind => { opened.push(kind) } },
      uiWorkspace: { openSession: sessionId => { openedSessions.push(sessionId) } },
    })
  },
})

assert.equal(styles.length, 1, 'stylesheet was not installed')
assert.deepEqual(
  registrations.map(({ declaration }) => declaration.name),
  ['main', 'sidebar.panellist', 'sidebar.right.pane.tab', 'conversation.session.header.actions'],
  'expected the main page, the left-sidebar entry, the origin tab body, and the header entry',
)
const [page, entry, originTab, originAction] = registrations
assert.equal(page.declaration.key, 'feishu-channels')
assert.equal(entry.declaration.id, 'feishu-channels', 'sidebar row id must address the main page key')
assert.equal(entry.declaration.label(), '飞书渠道')
for (const { component } of registrations) assert.equal(typeof component, 'function')

assert.deepEqual(scopeDeps, [['sidebarRightTabs', 'sidebarRight'], ['uiWorkspace']])
assert.equal(tabTypes.length, 1, 'origin tab type was not registered')
assert.equal(originTab.declaration.key, tabTypes[0].id, 'tab body must be keyed by the tab type id')
assert.equal(tabTypes[0].title(''), '飞书来源')
originAction.declaration.inject('s_1').openOrigin()
assert.deepEqual(opened, [tabTypes[0].kind], 'header entry must open the origin tab kind')

assert.ok(effects.some(dispose => typeof dispose === 'function'), 'session navigation must be published as a disposable effect')

console.log('OK: lib/client.js loads through the module-loader shim and registers the 飞书渠道 sidebar entry, page, origin tab, and session navigation')
