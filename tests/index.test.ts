/** Package composition contract for required Host services. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CordisFiberState } from '../src/dsh-types.ts'
import type { HostContext } from '../src/dsh-types.ts'
import { apply, inject, name } from '../src/index.ts'

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
