import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  Agent, AgentContext, AgentModel, AgentRequestConfig, AgentRequestListener, ModelSelection, SessionEvent,
} from '../src/dsh-types.ts'
import { foldEffortOverride, foldModelOverride, installRequestPolicy } from '../src/session/request-policy.ts'

type RequestWaterfall = (
  name: 'agent/request',
  payload: { turn: number; step: number; signal: AbortSignal },
  next: () => Promise<AgentRequestConfig>,
) => Promise<AgentRequestConfig>

describe('installRequestPolicy', () => {
  it('wins over a standing listener registered first in a real Cordis waterfall', async () => {
    const ctx = new Context()
    const agentCtx = ctx as unknown as AgentContext
    const standingPreset: AgentRequestListener = async (_payload, next) => ({
      ...(await next()),
      reasoningEffort: 'high',
    })
    agentCtx.on('agent/request', standingPreset)

    const controller = installRequestPolicy(agentCtx, { effort: 'tiny' })
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
    expect(foldEffortOverride([
      event('command/run', 0, { commandId: 'one', name: 'effort', args: ' tiny', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'one', kind: 'success' }),
      event('command/run', 2, { commandId: 'two', name: 'effort', args: ' invalid value', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'two', kind: 'success' }),
      event('command/run', 4, { commandId: 'three', name: 'effort', args: ' max', source: { kind: 'user' } }),
      event('command/done', 5, { commandId: 'three', kind: 'error' }),
    ])).toBe('tiny')

    expect(foldEffortOverride([
      event('command/run', 0, { commandId: 'one', name: 'effort', args: ' tiny', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'one', kind: 'success' }),
      event('command/run', 2, { commandId: 'reset', name: 'effort', args: ' reset', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'reset', kind: 'success' }),
    ])).toBeUndefined()
  })

  it('switches a live controller from config default to Session override', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext, { effort: 'high' })
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
      configuredEffort: 'high', effortOverride: 'tiny', effectiveEffort: 'tiny', effortSource: 'session',
    })
    controller.dispose()
    await ctx.fiber.dispose()
  })
})

describe('model override folding', () => {
  const event = (type: string, seq: number, data: unknown): SessionEvent => (
    { type, seq, time: seq, data } as unknown as SessionEvent
  )

  it('folds only successful /model lifecycles and honors reset', () => {
    expect(foldModelOverride([
      event('command/run', 0, { commandId: 'm1', name: 'model', args: ' deepseek-v4-pro', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'm1', kind: 'success' }),
      // A malformed value and a failed run are both inert.
      event('command/run', 2, { commandId: 'm2', name: 'model', args: ' two words', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'm2', kind: 'success' }),
      event('command/run', 4, { commandId: 'm3', name: 'model', args: ' other-model', source: { kind: 'user' } }),
      event('command/done', 5, { commandId: 'm3', kind: 'error' }),
    ])).toEqual({ model: 'deepseek-v4-pro' })

    expect(foldModelOverride([
      event('command/run', 0, { commandId: 'm1', name: 'model', args: ' provider-a/model-x', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'm1', kind: 'success' }),
    ])).toEqual({ provider: 'provider-a', model: 'model-x' })

    expect(foldModelOverride([
      event('command/run', 0, { commandId: 'm1', name: 'model', args: ' deepseek-v4-pro', source: { kind: 'user' } }),
      event('command/done', 1, { commandId: 'm1', kind: 'success' }),
      event('command/run', 2, { commandId: 'm2', name: 'model', args: ' reset', source: { kind: 'user' } }),
      event('command/done', 3, { commandId: 'm2', kind: 'success' }),
    ])).toBeUndefined()
  })
})

describe('installRequestPolicy model switching', () => {
  it('writes provider/model and effort into the composed request', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext, {
      effort: 'high', provider: 'provider-a', model: 'model-a',
    })
    const waterfall = ctx.waterfall.bind(ctx) as unknown as RequestWaterfall

    await expect(waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deployment', model: 'default-model' }),
    )).resolves.toEqual({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })

    controller.sync([{
      type: 'command/run', seq: 0, data: {
        commandId: 'model-one', name: 'model', args: ' provider-b/model-b', source: { kind: 'user' },
      },
    }, {
      type: 'command/done', seq: 1, data: { commandId: 'model-one', kind: 'success' },
    }] as unknown as SessionEvent[])

    await expect(waterfall(
      'agent/request',
      { turn: 2, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deployment', model: 'default-model' }),
    )).resolves.toEqual({ provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' })
    expect(controller.state).toMatchObject({
      modelOverride: { provider: 'provider-b', model: 'model-b' },
      modelSource: 'session',
      effortSource: 'config',
    })

    controller.dispose()
    await ctx.fiber.dispose()
  })
})

describe('installRequestPolicy on hosts that own model selection', () => {
  const event = (type: string, seq: number, data: unknown): SessionEvent => (
    { type, seq, time: seq, data } as unknown as SessionEvent
  )
  const command = (seq: number, id: string, name: string, args: string): SessionEvent[] => [
    event('command/run', seq, { commandId: id, name, args: ` ${args}`, source: { kind: 'user' } }),
    event('command/done', seq + 1, { commandId: id, kind: 'success' }),
  ]

  function selectingAgent(options: { provider?: string; model?: string } = { provider: 'deployment', model: 'default-model' }) {
    let recorded: ModelSelection | undefined
    const selections: ModelSelection[] = []
    const model: AgentModel = {
      current: () => recorded ?? (options.provider !== undefined && options.model !== undefined
        ? { provider: options.provider, model: options.model }
        : undefined),
      select: (selection) => {
        recorded = { ...selection }
        selections.push(recorded)
      },
    }
    const agent = { options, model } as unknown as Agent
    return { agent, selections }
  }

  it('passes the composed request through instead of rewriting the route', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext, {
      effort: 'high', provider: 'provider-a', model: 'model-a',
    })
    const { agent } = selectingAgent()
    const waterfall = ctx.waterfall.bind(ctx) as unknown as (
      name: 'agent/request',
      payload: { turn: number; step: number; signal: AbortSignal; agent: Agent },
      next: () => Promise<AgentRequestConfig>,
    ) => Promise<AgentRequestConfig>
    await expect(waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal, agent },
      async () => ({ provider: 'deployment', model: 'default-model' }),
    )).resolves.toEqual({ provider: 'deployment', model: 'default-model' })
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('records config defaults and Session overrides through agent.model.select', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext, { effort: 'high' })
    const { agent, selections } = selectingAgent()

    controller.sync([], agent)
    expect(selections).toEqual([{ provider: 'deployment', model: 'default-model', reasoningEffort: 'high' }])

    // An unchanged policy records nothing more.
    controller.sync([], agent)
    expect(selections).toHaveLength(1)

    const events = [...command(0, 'm1', 'model', 'provider-b/model-b'), ...command(2, 'e1', 'effort', 'tiny')]
    controller.sync(events, agent)
    expect(selections.at(-1)).toEqual({ provider: 'provider-b', model: 'model-b', reasoningEffort: 'tiny' })

    // A bare model keeps the selected provider.
    controller.sync([...events, ...command(4, 'm2', 'model', 'model-c')], agent)
    expect(selections.at(-1)).toEqual({ provider: 'provider-b', model: 'model-c', reasoningEffort: 'tiny' })

    // Reset returns to the Agent's live (deployment-default) route and the config effort.
    controller.sync([
      ...events, ...command(4, 'm2', 'model', 'model-c'),
      ...command(6, 'm3', 'model', 'reset'), ...command(8, 'e2', 'effort', 'reset'),
    ], agent)
    expect(selections.at(-1)).toEqual({ provider: 'deployment', model: 'default-model', reasoningEffort: 'high' })

    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('lets a settled reset clear a selection persisted before this controller existed', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext)
    const { agent, selections } = selectingAgent()
    // An earlier plugin instance (or a since-removed config default) recorded these.
    agent.model!.select({ provider: 'provider-old', model: 'model-old', reasoningEffort: 'high' })
    selections.length = 0

    controller.sync([], agent)
    expect(selections).toEqual([])

    controller.sync(command(0, 'e1', 'effort', 'reset'), agent, 'effort')
    expect(selections.at(-1)).toEqual({ provider: 'provider-old', model: 'model-old' })

    controller.sync([...command(0, 'e1', 'effort', 'reset'), ...command(2, 'm1', 'model', 'reset')], agent, 'model')
    expect(selections.at(-1)).toEqual({ provider: 'deployment', model: 'default-model' })

    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('records nothing without a policy or a resolvable route', async () => {
    const ctx = new Context()
    const noPolicy = installRequestPolicy(ctx as unknown as AgentContext)
    const first = selectingAgent()
    noPolicy.sync([], first.agent)
    expect(first.selections).toEqual([])

    const effortOnly = installRequestPolicy(ctx as unknown as AgentContext, { effort: 'high' })
    const routeless = selectingAgent({})
    effortOnly.sync([], routeless.agent)
    expect(routeless.selections).toEqual([])

    noPolicy.dispose()
    effortOnly.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the request override on hosts without agent.model', async () => {
    const ctx = new Context()
    const controller = installRequestPolicy(ctx as unknown as AgentContext, { effort: 'high' })
    const legacyAgent = { options: {} } as unknown as Agent
    controller.sync(command(0, 'e1', 'effort', 'tiny'), legacyAgent)
    const waterfall = ctx.waterfall.bind(ctx) as unknown as RequestWaterfall
    await expect(waterfall(
      'agent/request',
      { turn: 1, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'p', model: 'm' }),
    )).resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'tiny' })
    controller.dispose()
    await ctx.fiber.dispose()
  })
})
