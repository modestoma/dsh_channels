/** Package composition contract for required Host services. */

import { Context, resolveConfig, ValidationError } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CordisFiberState } from '../src/dsh-types.ts'
import type { HostContext } from '../src/dsh-types.ts'
import { apply, Config, inject, name } from '../src/index.ts'
import type { FeishuConfig } from '../src/index.ts'

/** The shape `resolveConfig` reads from a plugin runtime (Cordis loader path). */
type ConfigRuntime = Parameters<typeof resolveConfig>[0]

const runtime = { Config } as unknown as ConfigRuntime

describe('plugin composition', () => {
  it('stays PENDING when commands is absent even if every other dependency is available', async () => {
    expect(inject).toContain('commands')

    const ctx = new Context()
    for (const dependency of inject) {
      if (dependency !== 'commands') ctx.provide(dependency, {})
    }
    const fiber = ctx.plugin({
      name,
      inject: [...inject],
      apply(pluginCtx: Context, config: unknown) {
        apply(pluginCtx as unknown as HostContext, config)
      },
    })

    await Promise.resolve()
    expect(fiber.state).toBe(CordisFiberState.PENDING)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('plugin config declaration', () => {
  it('exposes the zod schema as a Cordis Standard Schema (default-fill + unknown-key strip)', () => {
    const config = resolveConfig(runtime, {
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      unknownKey: 'stripped',
    }) as FeishuConfig

    expect(config.baseDir).toBe('./channels-data')
    expect(config.refreshMs).toBe(500)
    expect(config.dmMode).toBe('open')
    expect(config.requireMention).toBe(true)
    expect(config).not.toHaveProperty('unknownKey')
  })

  it('accepts an omitted config and fills credential-reference defaults', () => {
    const config = resolveConfig(runtime, undefined) as FeishuConfig
    expect(config.appId).toBe('FEISHU_APP_ID')
    expect(config.appSecret).toBe('FEISHU_APP_SECRET')
    expect(config.baseDir).toBe('./channels-data')
  })

  it('fails config validation through the Cordis contract (ValidationError, not a service-start error)', () => {
    expect(() => resolveConfig(runtime, { appId: 'not a credential ref' })).toThrow(ValidationError)
    expect(() => resolveConfig(runtime, { appSecret: 42 })).toThrow(ValidationError)
  })

  it('rejects a malformed loader config before apply runs', async () => {
    const ctx = new Context()
    // A fiber only reaches config validation once its inject set is available.
    for (const dependency of inject) ctx.provide(dependency, {})
    let applied = false
    const plugin: Plugin = {
      name,
      Config,
      inject: [...inject],
      apply() {
        applied = true
      },
    }
    const fiber = ctx.plugin(plugin, { appId: 'not a credential ref' })

    let failure: unknown
    try {
      await fiber
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ValidationError)
    expect(applied).toBe(false)
    expect(fiber.state).toBe(CordisFiberState.FAILED)
    await ctx.fiber.dispose()
  })
})
