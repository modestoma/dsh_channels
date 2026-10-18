/**
 * Host bundle smoke test: import the built `lib/index.js` as an installed DSH
 * profile would (plain Node ESM, no TypeScript transform) and check the Cordis
 * plugin surface.
 *
 * Run after `pnpm build:host`: node scripts/verify-host-loader.mjs
 */

import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')

assert.equal(plugin.name, 'channels', 'host bundle must export the Cordis plugin name')
assert.equal(typeof plugin.apply, 'function', 'host bundle must export apply()')
assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('agents'), 'inject list is missing')
assert.ok(plugin.Config !== undefined, 'host bundle must export the Config schema')
assert.equal(typeof plugin.FeishuService, 'function', 'host bundle is missing FeishuService')

// The Loader validates a composition entry through Config's Standard Schema;
// the same call must work from the built bundle.
const validated = await plugin.Config['~standard'].validate({
  appId: 'FEISHU_APP_ID',
  appSecret: 'FEISHU_APP_SECRET',
})
assert.equal(validated.issues, undefined, 'minimal config should validate')

console.log('OK: lib/index.js imports as plain ESM and exposes the Cordis plugin surface')
