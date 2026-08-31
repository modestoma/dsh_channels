import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AgentContext, AgentRequestConfig, AgentRequestListener, SessionEvent } from '../src/dsh-types.ts'
import { foldReasoningEffortOverride, installReasoningEffortOverride } from '../src/reasoning-effort.ts'

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

    const controller = installReasoningEffortOverride(agentCtx, 'tiny')
    const waterfall = ctx.waterfall.bind(ctx) as unknown as RequestWaterfall
    const result = await waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }),
    )
    expect(result.reasoningEffort).toBe('tiny')

    controller.dispose()
    const restored = await waterfall(
      'agent/request',
      { turn: 2, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }),
    )
    expect(restored.reasoningEffort).toBe('high')
    await ctx.fiber.dispose()
  })

  it('recovers only successful paired /effort selections and honors reset', () => {
    const event = (type: string, seq: number, data: unknown): SessionEvent => (
      { type, seq, time: seq, data } as unknown as SessionEvent
    )
    expect(foldReasoningEffortOverride([
      event('command/run', 0, { commandId: 'one', name: 'effort', args: ' tiny', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'one', kind: 'success' }),
      event('command/run', 2, { commandId: 'two', name: 'effort', args: ' invalid value', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'two', kind: 'success' }),
      event('command/run', 4, { commandId: 'three', name: 'effort', args: ' max', source: { kind: 'user' } }),
      event('command/done', 5, { commandId: 'three', kind: 'error' }),
    ])).toBe('tiny')

    expect(foldReasoningEffortOverride([
      event('command/run', 0, { commandId: 'one', name: 'effort', args: ' tiny', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'one', kind: 'success' }),
      event('command/run', 2, { commandId: 'reset', name: 'effort', args: ' reset', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'reset', kind: 'success' }),
    ])).toBeUndefined()
  })

  it('switches a live controller from config default to Session override', async () => {
    const ctx = new Context()
    const controller = installReasoningEffortOverride(ctx as unknown as AgentContext, 'high')
    controller.sync([{
      type: 'command/run', seq: 0, data: {
        commandId: 'effort-one', name: 'effort', args: ' tiny', source: { kind: 'user' },
      },
    }, {
      type: 'command/done', seq: 1, data: { commandId: 'effort-one', kind: 'success' },
    }] as unknown as SessionEvent[])

    const waterfall = ctx.waterfall.bind(ctx) as unknown as RequestWaterfall
    await expect(waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'p', model: 'm' }),
    )).resolves.toMatchObject({ reasoningEffort: 'tiny' })
    expect(controller.state).toMatchObject({
      configured: 'high', sessionOverride: 'tiny', effective: 'tiny', source: 'session',
    })
    controller.dispose()
    await ctx.fiber.dispose()
  })
})
