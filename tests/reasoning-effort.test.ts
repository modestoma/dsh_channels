import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AgentContext, AgentRequestConfig, AgentRequestListener } from '../src/dsh-types.ts'
import { installReasoningEffortOverride } from '../src/reasoning-effort.ts'

type RequestWaterfall = (
  name: 'agent/request',
  payload: { turn: number; step: number; signal: AbortSignal },
  next: () => Promise<AgentRequestConfig>,
) => Promise<AgentRequestConfig>

describe('installReasoningEffortOverride', () => {
  it('wins over a standing listener registered first in a real Cordis waterfall', async () => {
    const ctx = new Context()
    const agentCtx = ctx as unknown as AgentContext
    const standingPreset: AgentRequestListener = async (_payload, next) => ({
      ...(await next()),
      reasoningEffort: 'high',
    })
    agentCtx.on('agent/request', standingPreset)

    const dispose = installReasoningEffortOverride(agentCtx, 'tiny')
    const waterfall = ctx.waterfall.bind(ctx) as unknown as RequestWaterfall
    const result = await waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }),
    )
    expect(result.reasoningEffort).toBe('tiny')

    dispose()
    const restored = await waterfall(
      'agent/request',
      { turn: 2, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }),
    )
    expect(restored.reasoningEffort).toBe('high')
    await ctx.fiber.dispose()
  })
})
