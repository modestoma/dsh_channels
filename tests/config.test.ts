/**
 * Configuration schema tests: credential references only, no plaintext.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE_TTL_MS, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('accepts credential reference names', () => {
    const config = resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' })
    expect(config.appId).toBe('FEISHU_APP_ID')
    expect(config.appSecret).toBe('FEISHU_APP_SECRET')
  })

  it('applies defaults', () => {
    const config = resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' })
    expect(config.refreshMs).toBe(500)
    expect(config.baseDir).toBe('./channels-data')
    expect(config.requireMention).toBe(true)
    expect(config.dmMode).toBe('open')
    expect(config.threadFallback).toBe('degrade')
    expect(config.loggerLevel).toBe('info')
    expect(config.agentPreset).toBeUndefined()
  })

  it('accepts an optional agentPreset id', () => {
    const config = resolveConfig({
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      agentPreset: 'channels',
    })
    expect(config.agentPreset).toBe('channels')
  })

  it('rejects non-identifier spellings (the schema cannot tell refs from secrets)', () => {
    expect(() => resolveConfig({ appId: 'cli-123', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/credential reference/)
    expect(() => resolveConfig({ appId: 'cli_123', appSecret: 'FEISHU APP SECRET' })).toThrow(/credential reference/)
  })

  it('rejects the legacy env: indirection', () => {
    expect(() => resolveConfig({ appId: 'env:FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' }))
      .toThrow(/credential reference/)
  })

  it('rejects non-identifier references', () => {
    expect(() => resolveConfig({ appId: '9BAD', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/invalid configuration/)
    expect(() => resolveConfig({ appId: 'FEISHU-APP-ID', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/invalid configuration/)
  })

  it('rejects missing fields with a clear message', () => {
    expect(() => resolveConfig({ appSecret: 'FEISHU_APP_SECRET' })).toThrow(/invalid configuration/)
  })

  it('defaults routeTtlMs to 30 days, accepts 0 (disabled), rejects negatives', () => {
    expect(resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' }).routeTtlMs)
      .toBe(DEFAULT_ROUTE_TTL_MS)
    expect(resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', routeTtlMs: 0 }).routeTtlMs)
      .toBe(0)
    expect(() => resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', routeTtlMs: -1 }))
      .toThrow(/invalid configuration/)
  })
})
