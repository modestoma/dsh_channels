/**
 * Configuration schema tests: credential references only, no plaintext.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HISTORY_BOOTSTRAP_LIMIT, DEFAULT_PREFETCH_IMAGE_MAX_BYTES, DEFAULT_PREFETCH_TIMEOUT_MS,
  DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS,
  DEFAULT_PREFETCH_TOTAL_MAX_BYTES, DEFAULT_ROUTE_TTL_MS, DEFAULT_TOPIC_MESSAGES_TIMEOUT_MS,
  MAX_HISTORY_BOOTSTRAP_LIMIT, resolveConfig,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('accepts credential reference names', () => {
    const config = resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' })
    expect(config.appId).toBe('FEISHU_APP_ID')
    expect(config.appSecret).toBe('FEISHU_APP_SECRET')
  })

  it('applies defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.appId).toBe('FEISHU_APP_ID')
    expect(config.appSecret).toBe('FEISHU_APP_SECRET')
    expect(config.refreshMs).toBe(500)
    expect(config.baseDir).toBe('./channels-data')
    expect(config.requireMention).toBe(true)
    expect(config.dmMode).toBe('open')
    expect(config.threadFallback).toBe('degrade')
    expect(config.topicIsolation).toBe('auto')
    expect(config.loggerLevel).toBe('info')
    expect(config.agentPreset).toBeUndefined()
    expect(config.reasoningEffort).toBeUndefined()
  })

  it('ignores the removed workspace-retention keys in older profiles', () => {
    const config = resolveConfig({ workspaceRetention: '30d', workspaceRetentionAuto: true })
    expect(config).not.toHaveProperty('workspaceRetention')
    expect(config).not.toHaveProperty('workspaceRetentionAuto')
  })

  it('ignores the removed settingsFile key in older profiles', () => {
    const config = resolveConfig({ settingsFile: '/custom/path/settings.json' })
    expect(config).not.toHaveProperty('settingsFile')
  })

  it('accepts an optional agentPreset id', () => {
    const config = resolveConfig({
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      agentPreset: 'channels',
    })
    expect(config.agentPreset).toBe('channels')
  })

  it('accepts a non-empty provider-owned reasoning effort id', () => {
    const config = resolveConfig({
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      reasoningEffort: 'high',
    })
    expect(config.reasoningEffort).toBe('high')
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      reasoningEffort: '',
    })).toThrow(/invalid configuration/)
  })

  it('rejects non-identifier spellings (the schema cannot tell refs from secrets)', () => {
    expect(() => resolveConfig({ appId: 'cli-123', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/credential reference/)
    expect(() => resolveConfig({ appId: 'cli_123', appSecret: 'FEISHU APP SECRET' })).toThrow(/credential reference/)
  })

  it('accepts every topic-isolation mode and rejects unknown ones', () => {
    for (const mode of ['auto', 'subdir', 'worktree'] as const) {
      expect(resolveConfig({
        appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', topicIsolation: mode,
      }).topicIsolation).toBe(mode)
    }
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', topicIsolation: 'shared',
    })).toThrow(/invalid configuration/)
  })

  it('rejects the legacy env: indirection', () => {
    expect(() => resolveConfig({ appId: 'env:FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' }))
      .toThrow(/credential reference/)
  })

  it('rejects non-identifier references', () => {
    expect(() => resolveConfig({ appId: '9BAD', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/invalid configuration/)
    expect(() => resolveConfig({ appId: 'FEISHU-APP-ID', appSecret: 'FEISHU_APP_SECRET' })).toThrow(/invalid configuration/)
  })

  it('defaults credential references when the loader passes no config object', () => {
    const config = resolveConfig({})
    expect(config.appId).toBe('FEISHU_APP_ID')
    expect(config.appSecret).toBe('FEISHU_APP_SECRET')
  })

  it('defaults trigger-image prefetch and enforces its bounds', () => {
    const config = resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' })
    expect(config.prefetchImages).toBe(true)
    expect(config.prefetchImageMaxBytes).toBe(DEFAULT_PREFETCH_IMAGE_MAX_BYTES)
    expect(config.prefetchTotalMaxBytes).toBe(DEFAULT_PREFETCH_TOTAL_MAX_BYTES)
    expect(config.prefetchTimeoutMs).toBe(DEFAULT_PREFETCH_TIMEOUT_MS)
    expect(resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', prefetchImages: false,
    }).prefetchImages).toBe(false)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', prefetchImageMaxBytes: 0,
    })).toThrow(/invalid configuration/)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', prefetchTimeoutMs: 1,
    })).toThrow(/invalid configuration/)
  })

  it('defaults history bootstrap and topic-message tool settings, enforcing bounds', () => {
    const config = resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' })
    expect(config.historyBootstrapLimit).toBe(DEFAULT_HISTORY_BOOTSTRAP_LIMIT)
    expect(config.promptContextTimeoutMs).toBe(DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS)
    expect(resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', promptContextTimeoutMs: 100,
    }).promptContextTimeoutMs).toBe(100)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', promptContextTimeoutMs: 50,
    })).toThrow(/invalid configuration/)
    expect(config.feishuTools.topicMessages).toBe(true)
    expect(config.feishuTools.topicMessagesTimeoutMs).toBe(DEFAULT_TOPIC_MESSAGES_TIMEOUT_MS)
    // 0 disables the first-turn history bootstrap.
    expect(resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', historyBootstrapLimit: 0,
    }).historyBootstrapLimit).toBe(0)
    expect(resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET',
      historyBootstrapLimit: MAX_HISTORY_BOOTSTRAP_LIMIT,
    }).historyBootstrapLimit).toBe(MAX_HISTORY_BOOTSTRAP_LIMIT)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET',
      historyBootstrapLimit: MAX_HISTORY_BOOTSTRAP_LIMIT + 1,
    })).toThrow(/invalid configuration/)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', historyBootstrapLimit: -1,
    })).toThrow(/invalid configuration/)
    expect(resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET',
      feishuTools: { topicMessages: false },
    }).feishuTools.topicMessages).toBe(false)
    expect(() => resolveConfig({
      appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET',
      feishuTools: { topicMessagesTimeoutMs: 10 },
    })).toThrow(/invalid configuration/)
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
