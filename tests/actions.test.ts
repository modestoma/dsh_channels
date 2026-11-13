/**
 * End-to-end unit & integration suite for `feishuActions` v1 (`src/actions/*`),
 * Card 2.0 action proposal rendering (`src/cards/action-proposal.ts`), the
 * `propose_actions` model tool (`src/feishu/propose-actions.ts`), and button
 * click permission pre-checks, atomic state transitions, Session wake-up,
 * invalidation, and 14-day GC (`src/routing/card-actions.ts`, `src/service.ts`).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  FEISHU_ACTIONS_SERVICE,
  FEISHU_ACTIONS_VERSION,
  fingerprintProposalSpec,
  RESERVED_DISMISS_ACTION_ID,
} from '../src/actions/contract.ts'
import type { ActionProposalSpec, FeishuActionsService } from '../src/actions/contract.ts'
import { FeishuActions } from '../src/actions/service.ts'
import {
  ACTION_PROPOSAL_TTL_MS,
  proposalIdOfKey,
} from '../src/actions/store.ts'
import type { ActionProposalRecord } from '../src/actions/store.ts'
import {
  ACTION_PROPOSAL_DECISION,
  buildActionProposalCard,
  parseActionProposalClick,
} from '../src/cards/index.ts'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { CardActionEvent, ChannelFactory, NormalizedMessage } from '../src/feishu-channel.ts'
import {
  presentProposeActionsCall,
  presentProposeActionsResult,
  PROPOSE_ACTIONS_TOOL_NAME,
  renderProposeActionsResult,
} from '../src/feishu/propose-actions.ts'
import type { ProposeActionsValue } from '../src/feishu/propose-actions.ts'
import type { HostContext, PreToolDecision, Session, ToolDefinition, ToolExecution, UserMessage } from '../src/host/index.ts'
import { apply, inject, name } from '../src/index.ts'
import { formatActionSelectedPrompt } from '../src/routing/card-actions.ts'
import {
  followupMessagesOf,
  makeAgent,
  makeAgentContext,
  makeChannel,
  makeHostContext,
  makeMessage,
  makeSession,
  makeToolsRuntime,
  sessionEvents,
  TestFeishuService as FeishuService,
} from './helpers.ts'

function sampleSpec(partial: Partial<ActionProposalSpec> = {}): ActionProposalSpec {
  return {
    key: 'proposal-key-1',
    sessionId: 'session-1',
    prompt: '已完成检查，可选择后续可选动作：',
    actions: [
      {
        id: 'apply_patch',
        label: '应用改动',
        style: 'primary',
        requiredAccess: 'code-write',
        followUpPrompt: '请基于上述结论在工作区应用改动并运行验证。',
      },
      {
        id: 'update_wiki',
        label: '同步知识库',
        requiredAccess: 'wiki-write',
        followUpPrompt: '请将本次整理的操作要点同步写入知识库页面。',
      },
    ],
    ...partial,
  }
}

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return resolveConfig({
    baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-actions-ws-')),
    statusRefreshMs: 60_000,
    accessMode: 'guarded',
    welcomeOnboarding: false,
    topicIsolation: 'subdir',
    ...partial,
  })
}

async function setupService(partial: Partial<FeishuConfig> = {}) {
  const config = makeConfig(partial)
  const channel = makeChannel()
  const toolsByAgent = new Map<string, ReturnType<typeof makeToolsRuntime>>()
  const ctxState = makeHostContext(undefined, undefined, {
    agentExtras: {},
  })
  // Attach a fresh per-agent ToolRuntime so mounted tools can be inspected per Session.
  const origCreate = ctxState.agents.registry.create.bind(ctxState.agents.registry)
  ctxState.agents.registry.create = async (options) => {
    const tools = makeToolsRuntime()
    toolsByAgent.set(options.sessionId, tools)
    const wrappedSetup = options.setup
    return await origCreate({
      ...options,
      async setup(agentCtx) {
        ;(agentCtx as { tools?: unknown }).tools = tools
        await wrappedSetup?.(agentCtx)
      },
    })
  }
  const origResume = ctxState.agents.registry.resume.bind(ctxState.agents.registry)
  ctxState.agents.registry.resume = async (options) => {
    const tools = makeToolsRuntime()
    toolsByAgent.set(options.resumeSessionId, tools)
    const wrappedSetup = options.setup
    return await origResume({
      ...options,
      async setup(agentCtx) {
        ;(agentCtx as { tools?: unknown }).tools = tools
        await wrappedSetup?.(agentCtx)
      },
    })
  }

  const factory: ChannelFactory = () => channel
  const service = new FeishuService(ctxState.ctx, config, factory)
  await service.start()
  await service.accessAdmin.addUser('u_admin')
  await service.accessAdmin.setPermission('u_admin', 'admin', true)
  await service.accessAdmin.addUser('u_alice')
  await service.accessAdmin.addUser('u_bob')

  const handler = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as
    (msg: NormalizedMessage) => Promise<void>

  const waitUntil = async (assertion: () => void): Promise<void> => {
    await vi.waitFor(assertion, { timeout: 3_000, interval: 5 })
  }

  const routes = (): RouteRecord[] =>
    [...ctxState.domain.raw.table('routes').entries()].map(([, value]) => value as RouteRecord)

  const proposals = (): ActionProposalRecord[] =>
    [...ctxState.domain.raw.table('action_proposals').entries()].map(([, value]) => value as ActionProposalRecord)

  const lastPatchedCard = (messageId: string): string | undefined => {
    const entry = channel.updated.filter(item => item.messageId === messageId).at(-1)
    return entry === undefined ? undefined : JSON.stringify(entry.card)
  }

  const clickButton = async (opts: {
    messageId: string
    chatId: string
    userId?: string
    proposalId: string
    actionId: string
  }): Promise<void> => {
    const event: CardActionEvent = {
      messageId: opts.messageId,
      chatId: opts.chatId,
      operator: {
        openId: `ou_${opts.userId ?? 'anon'}`,
        ...(opts.userId === undefined ? {} : { userId: opts.userId }),
      },
      action: {
        tag: 'button',
        value: {
          decision: ACTION_PROPOSAL_DECISION,
          proposalId: opts.proposalId,
          actionId: opts.actionId,
        },
      },
    }
    await channel.fireCardAction(event)
  }

  return {
    service,
    actions: service.actions(),
    channel,
    ctxState,
    config,
    toolsByAgent,
    onMessage: (msg: NormalizedMessage) => Promise.resolve(handler(msg)),
    waitUntil,
    routes,
    proposals,
    lastPatchedCard,
    clickButton,
  }
}

describe('feishuActions Cordis service provision', () => {
  it('provides feishuActions v1 and refuses proposals until connected', async () => {
    const ctx = new Context()
    for (const dependency of inject) ctx.provide(dependency, {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fiber = ctx.plugin({
      name,
      inject: [...inject],
      apply(pluginCtx: Context, config: unknown) {
        apply(pluginCtx as unknown as HostContext, config)
      },
    })
    await vi.waitFor(() => expect(ctx.get(FEISHU_ACTIONS_SERVICE)).toBeDefined())
    const provided = ctx.get(FEISHU_ACTIONS_SERVICE) as FeishuActionsService
    expect(provided).toBeInstanceOf(FeishuActions)
    expect(provided.version).toBe(FEISHU_ACTIONS_VERSION)
    expect(provided.version).toBe(1)
    expect(await provided.propose(sampleSpec())).toMatchObject({
      ok: false,
      code: 'not-connected',
    })
    await fiber.dispose()
    expect(ctx.get(FEISHU_ACTIONS_SERVICE)).toBeUndefined()
    await ctx.fiber.dispose()
    errors.mockRestore()
  })
})

describe('Card 2.0 action proposal builder', () => {
  const baseProposal: ActionProposalRecord = {
    proposalId: proposalIdOfKey('k-card'),
    key: 'k-card',
    fingerprint: 'fp',
    sessionId: 'sess-card',
    routeKey: 'omt_1',
    chatId: 'oc_group',
    cardMessageId: 'om_card',
    prompt: '请确认后续动作 **不解析 Markdown** <at id=all></at>',
    actions: [
      {
        id: 'act_1',
        label: '首选操作',
        style: 'primary',
        requiredAccess: 'chat',
        followUpPrompt: '执行首选操作',
        independent: true,
        status: 'triggered',
        triggeredBy: 'u_alice',
        triggeredAt: 1_000,
      },
      {
        id: 'act_2',
        label: '次选操作',
        style: 'default',
        requiredAccess: 'code-write',
        followUpPrompt: '执行次选操作',
        independent: true,
        status: 'pending',
      },
    ],
    createdAt: 500,
  }

  it('renders plain_text prompt, triggered summary lines, pending buttons, and trailing dismiss button', () => {
    const card = buildActionProposalCard(baseProposal) as {
      body: { elements: Array<Record<string, unknown>> }
    }
    const elements = card.body.elements
    expect(elements[0]).toEqual({ tag: 'markdown', content: '**💡 后续可选动作**' })
    // Second element is plain_text so untrusted prompt text cannot inject mentions or Markdown.
    expect(elements[1]).toEqual({
      tag: 'div',
      text: { tag: 'plain_text', content: '请确认后续动作 **不解析 Markdown** <at id=all></at>' },
    })
    const serialized = JSON.stringify(card)
    expect(serialized).toContain('✅ 已选择：首选操作')
    const buttons = elements.filter(el => el.tag === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toMatchObject({
      type: 'default',
      text: { tag: 'plain_text', content: '次选操作' },
      behaviors: [{
        type: 'callback',
        value: { decision: ACTION_PROPOSAL_DECISION, proposalId: baseProposal.proposalId, actionId: 'act_2' },
      }],
    })
    expect(buttons[1]).toMatchObject({
      type: 'default',
      text: { tag: 'plain_text', content: '暂不处理' },
      behaviors: [{
        type: 'callback',
        value: { decision: ACTION_PROPOSAL_DECISION, proposalId: baseProposal.proposalId, actionId: RESERVED_DISMISS_ACTION_ID },
      }],
    })
    const callbackValue = (buttons[0] as { behaviors: Array<{ value: unknown }> }).behaviors[0]!.value
    expect(parseActionProposalClick(callbackValue)).toEqual({
      decision: ACTION_PROPOSAL_DECISION,
      proposalId: baseProposal.proposalId,
      actionId: 'act_2',
    })
    expect(parseActionProposalClick({ decision: 'other', proposalId: 'x', actionId: 'y' })).toBeUndefined()
  })

  it('keeps pending buttons clickable when rendering a permission-denial notice', () => {
    const card = buildActionProposalCard(baseProposal, { notice: '当前群未开启「改代码」权限' }) as {
      body: { elements: Array<Record<string, unknown>> }
    }
    const buttons = card.body.elements.filter(el => el.tag === 'button')
    expect(buttons).toHaveLength(2)
    expect(JSON.stringify(card)).toContain('⚠️ 当前群未开启「改代码」权限')
  })

  it('retires buttons for superseded, dismissed, expired, and unbound states', () => {
    const supersededWithReason = buildActionProposalCard({
      ...baseProposal,
      supersededReason: '已产生新版方案',
      actions: [
        baseProposal.actions[0]!,
        { ...baseProposal.actions[1]!, status: 'superseded' },
      ],
    })
    expect(JSON.stringify(supersededWithReason)).toContain('✅ 已选择：首选操作')
    expect(JSON.stringify(supersededWithReason)).toContain('已被后续新提议替代：已产生新版方案')
    expect(JSON.stringify(supersededWithReason)).not.toContain('"tag":"button"')

    const dismissedAll = buildActionProposalCard({
      ...baseProposal,
      actions: [{ ...baseProposal.actions[1]!, status: 'dismissed' }],
    })
    expect(JSON.stringify(dismissedAll)).toContain('已暂不处理')
    expect(JSON.stringify(dismissedAll)).not.toContain('"tag":"button"')

    const expired = buildActionProposalCard(baseProposal, { invalidation: 'expired' })
    expect(JSON.stringify(expired)).toContain('该提议已过期，请直接在话题中输入指令')
    expect(JSON.stringify(expired)).not.toContain('"tag":"button"')

    const unbound = buildActionProposalCard(baseProposal, { invalidation: 'unbound' })
    expect(JSON.stringify(unbound)).toContain('该话题已切换新会话或已结束，此动作提议已失效')
    expect(JSON.stringify(unbound)).not.toContain('"tag":"button"')
  })
})

describe('feishuActions.propose validation, idempotency, and supersede', () => {
  it('validates prompt, actions, reserved dismiss id, duplicate ids, and idempotency key bounds', async () => {
    const h = await setupService()
    const invalidCases: Array<Partial<ActionProposalSpec>> = [
      { prompt: '   ' },
      { prompt: '字'.repeat(121) },
      { actions: [] },
      {
        actions: [1, 2, 3, 4, 5].map(n => ({
          id: `a_${n}`,
          label: `动作${n}`,
          followUpPrompt: `执行动作 ${n}`,
        })),
      },
      {
        actions: [{ id: 'dismiss', label: '冲突保留字', followUpPrompt: '执行' }],
      },
      {
        actions: [
          { id: 'dup', label: '动作一', followUpPrompt: '一' },
          { id: 'dup', label: '动作二', followUpPrompt: '二' },
        ],
      },
      {
        actions: [{ id: 'bad id with space', label: '动作', followUpPrompt: '执行' }],
      },
      {
        actions: [{ id: 'ok_id', label: '   ', followUpPrompt: '执行' }],
      },
      {
        actions: [{ id: 'ok_id', label: '字'.repeat(33), followUpPrompt: '执行' }],
      },
      {
        actions: [{ id: 'ok_id', label: '正常按钮', followUpPrompt: '   ' }],
      },
      {
        actions: [{ id: 'ok_id', label: '正常按钮', followUpPrompt: 'x'.repeat(8_001) }],
      },
      { key: '' },
      { key: 'key with space' },
      { key: '中文key' },
      { key: 'k'.repeat(201) },
      { sessionId: '   ' },
    ]

    for (const override of invalidCases) {
      const res = await h.actions.propose(sampleSpec(override))
      expect(res.ok, `expected invalid for ${JSON.stringify(override)}`).toBe(false)
      if (!res.ok) expect(res.code).toBe('invalid')
    }

    expect(await h.actions.propose(sampleSpec({ sessionId: 'non-existent-session' }))).toMatchObject({
      ok: false,
      code: 'unrouted-session',
    })
    await h.service.shutdown()
  })

  it('posts a proposal card, replays identical keys idempotently, and rejects conflicting reuse', async () => {
    const h = await setupService()
    await h.onMessage(makeMessage({ chatId: 'oc_group', chatType: 'group', senderId: 'u_alice', content: '你好', mentionedBot: true }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!

    const first = await h.actions.propose(sampleSpec({
      key: 'idem-1',
      sessionId: route.sessionId,
      prompt: '  可选择后续处理：  ',
    }))
    expect(first).toEqual({ ok: true, replayed: false, cardMessageId: 'om_2' })
    expect(h.channel.sent.at(-1)?.options).toEqual({
      replyTo: route.cardMessageId,
      replyInThread: true,
    })

    // Replay with explicit default fields matches canonical fingerprint.
    const replay = await h.actions.propose({
      key: 'idem-1',
      sessionId: route.sessionId,
      prompt: '可选择后续处理：',
      actions: [
        {
          id: 'apply_patch',
          label: '应用改动',
          style: 'primary',
          requiredAccess: 'code-write',
          followUpPrompt: '请基于上述结论在工作区应用改动并运行验证。',
          independent: false,
        },
        {
          id: 'update_wiki',
          label: '同步知识库',
          style: 'default',
          requiredAccess: 'wiki-write',
          followUpPrompt: '请将本次整理的操作要点同步写入知识库页面。',
          independent: false,
        },
      ],
    })
    expect(replay).toEqual({ ok: true, replayed: true, cardMessageId: 'om_2' })
    expect(h.proposals()).toHaveLength(1)

    // Same key with different prompt is rejected with code='invalid'.
    const conflict = await h.actions.propose(sampleSpec({
      key: 'idem-1',
      sessionId: route.sessionId,
      prompt: '另一个不同的标题',
    }))
    expect(conflict).toMatchObject({ ok: false, code: 'invalid' })

    // Concurrent in-flight calls with identical key + spec deduplicate to one card send.
    const [concA, concB] = await Promise.all([
      h.actions.propose(sampleSpec({ key: 'idem-concurrent', sessionId: route.sessionId })),
      h.actions.propose(sampleSpec({ key: 'idem-concurrent', sessionId: route.sessionId })),
    ])
    expect(concA).toMatchObject({ ok: true, replayed: false })
    expect(concB).toMatchObject({ ok: true, replayed: true })
    if (concA.ok && concB.ok) expect(concB.cardMessageId).toBe(concA.cardMessageId)

    // Channel send failure returns send-failed without persisting a broken record.
    vi.spyOn(h.channel, 'send').mockRejectedValueOnce(new Error('feishu network down'))
    const failedSend = await h.actions.propose(sampleSpec({ key: 'idem-fail', sessionId: route.sessionId }))
    expect(failedSend).toMatchObject({ ok: false, code: 'send-failed' })
    expect(h.proposals().find(item => item.key === 'idem-fail')).toBeUndefined()

    await h.service.shutdown()
  })

  it('auto-supersedes prior pending items in the same Session while preserving triggered selections, and supports explicit supersede()', async () => {
    const h = await setupService()
    await h.onMessage(makeMessage({ chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: '开始任务' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!

    // Post an independent multi-action proposal and trigger action 1.
    const p1 = await h.actions.propose({
      key: 'multi-1',
      sessionId: route.sessionId,
      prompt: '第一版可选动作：',
      actions: [
        { id: 'step_one', label: '执行步骤一', independent: true, followUpPrompt: '请执行步骤一' },
        { id: 'step_two', label: '执行步骤二', independent: true, followUpPrompt: '请执行步骤二' },
      ],
    })
    expect(p1.ok).toBe(true)
    if (!p1.ok) return

    await h.clickButton({
      messageId: p1.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('multi-1'),
      actionId: 'step_one',
    })
    await h.waitUntil(() => {
      const stored = h.proposals().find(r => r.key === 'multi-1')
      expect(stored?.actions.map(a => a.status)).toEqual(['triggered', 'pending'])
    })

    // Posting a second proposal in the same Session auto-supersedes step_two while keeping step_one 'triggered'!
    const p2 = await h.actions.propose({
      key: 'multi-2',
      sessionId: route.sessionId,
      prompt: '第二版可选动作：',
      actions: [
        { id: 'step_three', label: '执行步骤三', followUpPrompt: '请执行步骤三' },
      ],
    })
    expect(p2.ok).toBe(true)
    if (!p2.ok) return

    await h.waitUntil(() => {
      const stored1 = h.proposals().find(r => r.key === 'multi-1')
      expect(stored1?.actions.map(a => a.status)).toEqual(['triggered', 'superseded'])
      const patched1 = h.lastPatchedCard(p1.cardMessageId)
      expect(patched1).toContain('✅ 已选择：执行步骤一')
      expect(patched1).toContain('已被后续新提议替代')
      expect(patched1).not.toContain('"tag":"button"')
    })

    // Explicit supersede(key, reason) updates p2 and refreshes its card.
    await h.actions.supersede('multi-2', '已有人工跟进')
    await h.waitUntil(() => {
      const stored2 = h.proposals().find(r => r.key === 'multi-2')
      expect(stored2?.actions.map(a => a.status)).toEqual(['superseded'])
      expect(stored2?.supersededReason).toBe('已有人工跟进')
      expect(h.lastPatchedCard(p2.cardMessageId)).toContain('已被后续新提议替代：已有人工跟进')
    })

    // Supersede on unknown or invalid keys is a no-op.
    await expect(h.actions.supersede('unknown-key')).resolves.toBeUndefined()
    await expect(h.actions.supersede('invalid key with spaces')).resolves.toBeUndefined()

    await h.service.shutdown()
  })
})

describe('propose_actions model tool', () => {
  it('mounts on root Feishu sessions, enforces 1-per-turn limit, and politely skips when inbox has queued user messages', async () => {
    const h = await setupService({ hostTurnCards: false })
    await h.onMessage(makeMessage({ chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: '帮我检查项目' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const tool = h.toolsByAgent.get(route.sessionId)?.definitions.get(PROPOSE_ACTIONS_TOOL_NAME) as ToolDefinition | undefined
    expect(tool).toBeDefined()
    if (tool === undefined) return

    const signal = new AbortController().signal

    // Invalid schema throws without consuming the turn's 1-call quota.
    await expect(tool.execute({ prompt: '', actions: [] }, { signal })).rejects.toThrow(/propose_actions: invalid/)

    // First valid call in Turn 1 succeeds and sends a proposal card.
    const first = await tool.execute({
      prompt: '检查已完成，可选择后续操作：',
      actions: [
        { id: 'clean_temp', label: '清理临时文件', style: 'primary', followUpPrompt: '请清理临时目录并汇报结果' },
      ],
    }, { signal }) as ProposeActionsValue
    expect(first).toMatchObject({
      ok: true,
      skipped: false,
      action_count: 1,
    })
    expect(presentProposeActionsCall({ prompt: '检查已完成', actions: [{}] })).toContain('检查已完成')
    expect(presentProposeActionsResult(first)).toContain('已发送后续动作提议卡片')
    expect(renderProposeActionsResult(first)[0]).toMatchObject({ type: 'text' })

    // Second call in the SAME turn is refused with TURN_LIMIT_EXCEEDED.
    const secondSameTurn = await tool.execute({
      prompt: '再次提议：',
      actions: [
        { id: 'other_act', label: '其他动作', followUpPrompt: '执行其他动作' },
      ],
    }, { signal }) as ProposeActionsValue
    expect(secondSameTurn).toMatchObject({
      ok: false,
      code: 'TURN_LIMIT_EXCEEDED',
    })

    // End Turn 1 and start Turn 2 + queue another user message behind Turn 2.
    for (const listener of h.ctxState.sessionListeners) {
      listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }
    const turn2Msg: UserMessage = {
      id: 'msg-t2' as UserMessage['id'],
      role: 'user',
      content: [{ type: 'text', text: '继续第二轮' }],
      source: { kind: 'user' },
    }
    const turn3QueuedMsg: UserMessage = {
      id: 'msg-t3' as UserMessage['id'],
      role: 'user',
      content: [{ type: 'text', text: '我还有补充要求' }],
      source: { kind: 'user' },
    }
    h.ctxState.driver.followup(agent.session, turn2Msg)
    h.ctxState.driver.followup(agent.session, turn3QueuedMsg)
    expect(agent.inbox.nextTurn).toHaveLength(1)

    // Because `agent.inbox.nextTurn` is non-empty, `propose_actions` politely skips without sending a card!
    const sentBeforeSkip = h.channel.sent.length
    const skipped = await tool.execute({
      prompt: '本应跳过的提议：',
      actions: [{ id: 'skip_me', label: '跳过动作', followUpPrompt: '不发送' }],
    }, { signal }) as ProposeActionsValue
    expect(skipped).toMatchObject({
      ok: true,
      skipped: true,
    })
    expect(h.channel.sent.length).toBe(sentBeforeSkip)

    // Remove the queued message; also verify `agent.inbox.nextStep` (steered message) politely skips.
    agent.inbox.remove(turn3QueuedMsg.id)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    const steeredAgent = {
      ...agent,
      inbox: { ...agent.inbox, nextTurn: [], nextStep: [turn3QueuedMsg] },
    }
    const skippedOnSteer = await tool.execute({
      prompt: '插队跳过测试：',
      actions: [{ id: 'skip_steer', label: '跳过动作', followUpPrompt: '不发送' }],
    }, { signal, agent: steeredAgent } as unknown as ToolExecution) as ProposeActionsValue
    expect(skippedOnSteer).toMatchObject({ ok: true, skipped: true })

    // Turn 2 still has its quota intact and succeeds!
    const afterQueueCleared = await tool.execute({
      prompt: '队列清空后的提议：',
      actions: [{ id: 'valid_t2', label: '执行第二轮后续', followUpPrompt: '请继续执行第二轮后续任务' }],
    }, { signal }) as ProposeActionsValue
    expect(afterQueueCleared).toMatchObject({
      ok: true,
      skipped: false,
      action_count: 1,
    })

    await h.service.shutdown()
  })

  it('refuses subagents at mount, tools/pre-execute, and execute, and respects feishuTools.proposeActions=false', async () => {
    const h = await setupService()
    await h.onMessage(makeMessage({ chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: '主会话启动' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!
    const rootTool = h.toolsByAgent.get(route.sessionId)?.definitions.get(PROPOSE_ACTIONS_TOOL_NAME)!

    // Construct a subagent Session (`delegationDepth: 1`, `parentSession` set).
    const subSession: Session = {
      ...makeSession('subagent-session-1'),
      header: {
        version: 0,
        id: 'subagent-session-1' as Session['id'],
        createdAt: Date.now(),
        delegationDepth: 1,
        parentSession: route.sessionId as Session['id'],
      },
    }
    const subTools = makeToolsRuntime()
    const subAgent = makeAgent(subSession, {}, makeAgentContext(undefined, { tools: subTools }))

    // 1) `tools/pre-execute` waterfall denies subagent calls to `propose_actions`.
    const runPreExecute = async (): Promise<PreToolDecision> => {
      const listeners = h.ctxState.preExecuteListeners
      const exec = {
        name: PROPOSE_ACTIONS_TOOL_NAME,
        args: { prompt: 'x', actions: [{ id: 'a', label: 'b', followUpPrompt: 'c' }] },
        agent: subAgent,
        turn: 1,
        step: 0,
        callId: 'call-1',
        signal: new AbortController().signal,
      }
      const step = (idx: number): Promise<PreToolDecision> => {
        const listener = listeners[idx]
        return listener === undefined ? Promise.resolve({ kind: 'allow' }) : listener(exec, () => step(idx + 1))
      }
      return await step(0)
    }
    expect(await runPreExecute()).toMatchObject({ kind: 'deny' })

    // 2) Direct tool `execute` with a subagent `exec.agent` returns SUBAGENT_FORBIDDEN.
    const subExecResult = await rootTool.execute(
      { prompt: '子代理尝试', actions: [{ id: 'sub', label: '子动作', followUpPrompt: '不可执行' }] },
      { signal: new AbortController().signal, agent: subAgent } as unknown as ToolExecution,
    ) as ProposeActionsValue
    expect(subExecResult).toMatchObject({ ok: false, code: 'SUBAGENT_FORBIDDEN' })

    // 3) Disabling `feishuTools.proposeActions` omits the tool on newly created sessions.
    const disabled = await setupService({ feishuTools: resolveConfig({ feishuTools: { proposeActions: false } }).feishuTools })
    await disabled.onMessage(makeMessage({ chatId: 'oc_p2p_2', chatType: 'p2p', senderId: 'u_alice', content: '新会话' }))
    await disabled.waitUntil(() => expect(disabled.routes()).toHaveLength(1))
    const disabledRoute = disabled.routes()[0]!
    expect(disabled.toolsByAgent.get(disabledRoute.sessionId)?.definitions.has(PROPOSE_ACTIONS_TOOL_NAME)).toBe(false)

    await disabled.service.shutdown()
    await h.service.shutdown()
  })
})

describe('TurnCardActions button click handling, access pre-checks, invalidation, and 14-day GC', () => {
  it('handles single-select, multi-select (independent=true), and dismiss clicks, waking the Session as the clicker principal', async () => {
    const h = await setupService()
    await h.onMessage(makeMessage({ chatId: 'oc_group', chatType: 'group', senderId: 'u_alice', content: '创建群话题', mentionedBot: true }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!
    const agent = h.ctxState.agents.created[0]!.handle.agent
    for (const listener of h.ctxState.sessionListeners) {
      listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }

    // 1) Dismiss button closes pending items without starting a turn.
    const dismissProposal = await h.actions.propose({
      key: 'dismiss-case',
      sessionId: route.sessionId,
      prompt: '是否需要进一步整理？',
      actions: [{ id: 'organize', label: '整理归档', followUpPrompt: '请整理归档' }],
    })
    expect(dismissProposal.ok).toBe(true)
    if (!dismissProposal.ok) return
    const promptsBeforeDismiss = followupMessagesOf(agent).length
    await h.clickButton({
      messageId: dismissProposal.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_bob',
      proposalId: proposalIdOfKey('dismiss-case'),
      actionId: RESERVED_DISMISS_ACTION_ID,
    })
    await h.waitUntil(() => {
      expect(h.proposals().find(r => r.key === 'dismiss-case')?.actions[0]?.status).toBe('dismissed')
      expect(h.lastPatchedCard(dismissProposal.cardMessageId)).toContain('已暂不处理')
    })
    expect(followupMessagesOf(agent).length).toBe(promptsBeforeDismiss)

    // 2) Single-select (`independent: false` default): u_bob clicks action A -> A='triggered', B='dismissed',
    //    wakes Session with `<feishu_action_selected .../>` + followUpPrompt as `{ kind: 'feishu-group', chatId: 'oc_group', userId: 'u_bob' }`.
    const single = await h.actions.propose({
      key: 'single-case',
      sessionId: route.sessionId,
      prompt: '选择一个后续操作：',
      actions: [
        { id: 'opt_a', label: '生成摘要 "A"', followUpPrompt: '请生成详细摘要 A' },
        { id: 'opt_b', label: '生成摘要 B', followUpPrompt: '请生成详细摘要 B' },
      ],
    })
    expect(single.ok).toBe(true)
    if (!single.ok) return

    await h.clickButton({
      messageId: single.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_bob',
      proposalId: proposalIdOfKey('single-case'),
      actionId: 'opt_a',
    })
    await h.waitUntil(() => expect(followupMessagesOf(agent).length).toBe(promptsBeforeDismiss + 1))

    const storedSingle = h.proposals().find(r => r.key === 'single-case')!
    expect(storedSingle.actions.map(a => a.status)).toEqual(['triggered', 'dismissed'])
    expect(storedSingle.actions[0]?.triggeredBy).toBe('u_bob')
    expect(h.lastPatchedCard(single.cardMessageId)).toContain('✅ 已选择：生成摘要 \\"A\\"')
    expect(h.lastPatchedCard(single.cardMessageId)).not.toContain('"tag":"button"')

    const submitted = followupMessagesOf(agent).at(-1)!
    expect(submitted.content[0]?.text).toBe(
      formatActionSelectedPrompt('opt_a', '生成摘要 "A"', '请生成详细摘要 A'),
    )
    expect(submitted.content[0]?.text).toBe(
      '<feishu_action_selected id="opt_a" label="生成摘要 &quot;A&quot;"/>\n\n请生成详细摘要 A',
    )
    expect(submitted.source).toMatchObject({
      kind: 'user',
      principal: { kind: 'feishu-group', chatId: 'oc_group', userId: 'u_bob' },
    })
    expect(h.routes()[0]?.lastSpeakerUserId).toBe('u_bob')

    // Commit trailers on this turn record u_bob as the Feishu-User speaker!
    const trailers: Array<[string, string]> = []
    await h.ctxState.commitTrailerListeners[0]!({
      session: route.sessionId,
      dir: route.workspacePath,
      add: (token, value) => { trailers.push([token, value]) },
    })
    expect(trailers).toContainEqual(['Feishu-User', 'u_bob'])

    // Finish turn 2 before testing multi-select.
    for (const listener of h.ctxState.sessionListeners) {
      listener(agent.session, { type: 'turn/end', seq: 2, data: { turn: 2 } } as never)
    }

    // 3) Multi-select (`independent: true`): click m_1 then duplicate m_1 (ignored) then click m_2.
    const multi = await h.actions.propose({
      key: 'multi-click',
      sessionId: route.sessionId,
      prompt: '可先后独立执行：',
      actions: [
        { id: 'm_1', label: '导出配置', independent: true, followUpPrompt: '请导出当前配置' },
        { id: 'm_2', label: '归档说明', independent: true, followUpPrompt: '请归档本次说明' },
      ],
    })
    expect(multi.ok).toBe(true)
    if (!multi.ok) return

    const beforeMulti = followupMessagesOf(agent).length
    await h.clickButton({
      messageId: multi.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('multi-click'),
      actionId: 'm_1',
    })
    await h.waitUntil(() => expect(followupMessagesOf(agent).length).toBe(beforeMulti + 1))
    expect(h.proposals().find(r => r.key === 'multi-click')?.actions.map(a => a.status)).toEqual(['triggered', 'pending'])
    expect(h.lastPatchedCard(multi.cardMessageId)).toContain('✅ 已选择：导出配置')
    expect(h.lastPatchedCard(multi.cardMessageId)).toContain('归档说明')

    // Duplicate click on already-triggered m_1 is ignored.
    await h.clickButton({
      messageId: multi.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('multi-click'),
      actionId: 'm_1',
    })
    expect(followupMessagesOf(agent).length).toBe(beforeMulti + 1)

    for (const listener of h.ctxState.sessionListeners) {
      listener(agent.session, { type: 'turn/end', seq: 3, data: { turn: 3 } } as never)
    }

    // Clicking m_2 fails transiently if `channel.send` throws once -> m_2 rolls back to `pending`, then retry succeeds!
    const origSend = h.channel.send.bind(h.channel)
    let failNextSend = true
    h.channel.send = async (...args) => {
      if (failNextSend) {
        failNextSend = false
        throw new Error('transient network timeout')
      }
      return await origSend(...args)
    }
    await h.clickButton({
      messageId: multi.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_bob',
      proposalId: proposalIdOfKey('multi-click'),
      actionId: 'm_2',
    })
    // Wait for the route queue turn to finish rolling back.
    await h.waitUntil(() => expect(failNextSend).toBe(false))
    expect(h.proposals().find(r => r.key === 'multi-click')?.actions.map(a => a.status)).toEqual(['triggered', 'pending'])
    expect(followupMessagesOf(agent).length).toBe(beforeMulti + 1)

    // Clicking m_2 again now triggers m_2 and retires all buttons.
    await h.clickButton({
      messageId: multi.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_bob',
      proposalId: proposalIdOfKey('multi-click'),
      actionId: 'm_2',
    })
    await h.waitUntil(() => expect(followupMessagesOf(agent).length).toBe(beforeMulti + 2))
    expect(h.proposals().find(r => r.key === 'multi-click')?.actions.map(a => a.status)).toEqual(['triggered', 'triggered'])
    expect(h.lastPatchedCard(multi.cardMessageId)).not.toContain('"tag":"button"')

    await h.service.shutdown()
  })

  it('pre-checks ownership and requiredAccess non-destructively (keeping buttons clickable until permission is granted)', async () => {
    const h = await setupService()

    // A) Group route: test non-admitted user, code-write off -> on, wiki-write off -> on, and admin forbidden in group.
    await h.onMessage(makeMessage({ chatId: 'oc_group', chatType: 'group', senderId: 'u_alice', content: '群会话', mentionedBot: true }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const groupRoute = h.routes()[0]!
    const groupAgent = h.ctxState.agents.created[0]!.handle.agent
    for (const listener of h.ctxState.sessionListeners) {
      listener(groupAgent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }

    const groupProp = await h.actions.propose({
      key: 'perm-group',
      sessionId: groupRoute.sessionId,
      prompt: '受权限保护的动作：',
      actions: [
        { id: 'edit_code', label: '修改代码', requiredAccess: 'code-write', independent: true, followUpPrompt: '请修改代码' },
        { id: 'edit_wiki', label: '写入知识库', requiredAccess: 'wiki-write', independent: true, followUpPrompt: '请写入知识库' },
        { id: 'admin_op', label: '管理操作', requiredAccess: 'admin', independent: true, followUpPrompt: '请执行管理操作' },
      ],
    })
    expect(groupProp.ok).toBe(true)
    if (!groupProp.ok) return

    const groupPromptsBefore = followupMessagesOf(groupAgent).length

    // Non-admitted user u_stranger gets chat admission hint; buttons remain pending!
    await h.clickButton({
      messageId: groupProp.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_stranger',
      proposalId: proposalIdOfKey('perm-group'),
      actionId: 'edit_code',
    })
    await h.waitUntil(() => expect(h.lastPatchedCard(groupProp.cardMessageId)).toContain('对话准入'))
    expect(h.proposals().find(r => r.key === 'perm-group')?.actions.every(a => a.status === 'pending')).toBe(true)
    expect(followupMessagesOf(groupAgent).length).toBe(groupPromptsBefore)

    // Admitted u_alice clicks `edit_code` while group codeWrite is false -> gets group code-write hint, stays pending!
    await h.clickButton({
      messageId: groupProp.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('perm-group'),
      actionId: 'edit_code',
    })
    await h.waitUntil(() => expect(h.lastPatchedCard(groupProp.cardMessageId)).toContain('群权限'))
    expect(h.lastPatchedCard(groupProp.cardMessageId)).toContain('"tag":"button"')
    expect(h.proposals().find(r => r.key === 'perm-group')?.actions[0]?.status).toBe('pending')

    // Even u_admin clicking `admin_op` inside a group is refused because admin actions require private chat!
    await h.clickButton({
      messageId: groupProp.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_admin',
      proposalId: proposalIdOfKey('perm-group'),
      actionId: 'admin_op',
    })
    await h.waitUntil(() => expect(h.lastPatchedCard(groupProp.cardMessageId)).toContain('私聊'))
    expect(h.proposals().find(r => r.key === 'perm-group')?.actions[2]?.status).toBe('pending')

    // Now enable `codeWrite` on `oc_group` and click `edit_code` again -> succeeds!
    await h.service.accessAdmin.setGroupPermission('oc_group', 'codeWrite', true)
    await h.clickButton({
      messageId: groupProp.cardMessageId,
      chatId: 'oc_group',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('perm-group'),
      actionId: 'edit_code',
    })
    await h.waitUntil(() => expect(followupMessagesOf(groupAgent).length).toBe(groupPromptsBefore + 1))
    expect(h.proposals().find(r => r.key === 'perm-group')?.actions[0]?.status).toBe('triggered')

    // B) Private-chat route: non-owner refusal + `/auth set code on` hint when user lacks codeWrite.
    await h.onMessage(makeMessage({ chatId: 'oc_dm_alice', chatType: 'p2p', senderId: 'u_alice', content: '私聊会话' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(2))
    const dmRoute = h.routes().find(r => r.chatId === 'oc_dm_alice')!
    const dmAgent = h.ctxState.agents.created[1]!.handle.agent
    for (const listener of h.ctxState.sessionListeners) {
      listener(dmAgent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }

    const dmProp = await h.actions.propose({
      key: 'perm-dm',
      sessionId: dmRoute.sessionId,
      prompt: '私聊后续动作：',
      actions: [
        { id: 'dm_code', label: '提交代码修改', requiredAccess: 'code-write', followUpPrompt: '请提交代码修改' },
      ],
    })
    expect(dmProp.ok).toBe(true)
    if (!dmProp.ok) return

    // Another user clicking in dm chat is refused with owner-only notice.
    await h.clickButton({
      messageId: dmProp.cardMessageId,
      chatId: 'oc_dm_alice',
      userId: 'u_bob',
      proposalId: proposalIdOfKey('perm-dm'),
      actionId: 'dm_code',
    })
    await h.waitUntil(() => expect(h.lastPatchedCard(dmProp.cardMessageId)).toContain('仅发起该会话的用户本人可操作此卡片'))
    expect(h.proposals().find(r => r.key === 'perm-dm')?.actions[0]?.status).toBe('pending')

    // u_alice clicks before `codeWrite` is granted -> hint names `/auth set code on`, stays pending!
    await h.clickButton({
      messageId: dmProp.cardMessageId,
      chatId: 'oc_dm_alice',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('perm-dm'),
      actionId: 'dm_code',
    })
    await h.waitUntil(() => expect(h.lastPatchedCard(dmProp.cardMessageId)).toContain('/auth set code on'))
    expect(h.proposals().find(r => r.key === 'perm-dm')?.actions[0]?.status).toBe('pending')

    // Grant `codeWrite` to u_alice -> same button now succeeds as `{ kind: 'feishu-user', userId: 'u_alice' }`!
    await h.service.accessAdmin.setPermission('u_alice', 'codeWrite', true)
    const dmBefore = followupMessagesOf(dmAgent).length
    await h.clickButton({
      messageId: dmProp.cardMessageId,
      chatId: 'oc_dm_alice',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('perm-dm'),
      actionId: 'dm_code',
    })
    await h.waitUntil(() => expect(followupMessagesOf(dmAgent).length).toBe(dmBefore + 1))
    expect(followupMessagesOf(dmAgent).at(-1)?.source).toMatchObject({
      kind: 'user',
      principal: { kind: 'feishu-user', userId: 'u_alice' },
    })

    await h.service.shutdown()
  })

  it('invalidates proposals after /renew or >14-day expiry, ignores spoofed chatIds, and prunes >14d rows in GC even when routeTtlMs=0', async () => {
    const h = await setupService({ routeTtlMs: 0 })
    await h.onMessage(makeMessage({ chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: '第一轮会话' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const initialRoute = h.routes()[0]!
    const initialAgent = h.ctxState.agents.created[0]!.handle.agent
    for (const listener of h.ctxState.sessionListeners) {
      listener(initialAgent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }

    const beforeRenew = await h.actions.propose({
      key: 'renew-prop',
      sessionId: initialRoute.sessionId,
      prompt: '换绑前动作：',
      actions: [{ id: 'act_old', label: '旧会话操作', followUpPrompt: '不应执行' }],
    })
    expect(beforeRenew.ok).toBe(true)
    if (!beforeRenew.ok) return

    // Cross-chat spoofed click must NOT touch or retire the live card.
    const updatesBeforeSpoof = h.channel.updated.filter(u => u.messageId === beforeRenew.cardMessageId).length
    await h.clickButton({
      messageId: beforeRenew.cardMessageId,
      chatId: 'oc_other_chat',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('renew-prop'),
      actionId: 'act_old',
    })
    expect(h.channel.updated.filter(u => u.messageId === beforeRenew.cardMessageId).length).toBe(updatesBeforeSpoof)

    // Run `/renew` in the topic so the route binds a brand-new Session.
    await h.onMessage(makeMessage({
      chatId: 'oc_p2p',
      chatType: 'p2p',
      senderId: 'u_alice',
      threadId: initialRoute.key,
      content: '/renew',
    }))
    await h.waitUntil(() => expect(h.routes()[0]?.sessionId).not.toBe(initialRoute.sessionId))

    // Clicking the old Session's proposal card refreshes it in-place as `unbound` without starting any turn!
    const createdAgentsCount = h.ctxState.agents.created.length
    const oldFollowups = followupMessagesOf(initialAgent).length
    await h.clickButton({
      messageId: beforeRenew.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('renew-prop'),
      actionId: 'act_old',
    })
    await h.waitUntil(() => {
      expect(h.lastPatchedCard(beforeRenew.cardMessageId)).toContain('该话题已切换新会话或已结束，此动作提议已失效')
    })
    expect(followupMessagesOf(initialAgent).length).toBe(oldFollowups)
    expect(h.ctxState.agents.created.length).toBe(createdAgentsCount)

    // Post a proposal on the renewed Session, backdate its `createdAt` beyond 14 days, and verify click + GC.
    const renewedRoute = h.routes()[0]!
    const aged = await h.actions.propose({
      key: 'aged-prop',
      sessionId: renewedRoute.sessionId,
      prompt: '超期测试：',
      actions: [{ id: 'aged_act', label: '超期按钮', followUpPrompt: '不应执行' }],
    })
    expect(aged.ok).toBe(true)
    if (!aged.ok) return

    const agedId = proposalIdOfKey('aged-prop')
    const table = h.ctxState.domain.raw.table('action_proposals')
    const agedRecord = table.get(agedId) as ActionProposalRecord
    await table.put(agedId, {
      ...agedRecord,
      createdAt: Date.now() - ACTION_PROPOSAL_TTL_MS - 60_000,
    })

    // Clicking an expired (>14d) proposal patches it to `expired` without starting a turn.
    const renewedAgent = h.ctxState.agents.created.at(-1)!.handle.agent
    const renewedFollowups = followupMessagesOf(renewedAgent).length
    await h.clickButton({
      messageId: aged.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: agedId,
      actionId: 'aged_act',
    })
    await h.waitUntil(() => {
      expect(h.lastPatchedCard(aged.cardMessageId)).toContain('该提议已过期，请直接在话题中输入指令')
    })
    expect(followupMessagesOf(renewedAgent).length).toBe(renewedFollowups)

    // `gcExpiredEntries` prunes >14d `action_proposals` even though `routeTtlMs === 0`, while keeping fresh rows!
    await (h.service as unknown as { gcExpiredEntries(): Promise<void> }).gcExpiredEntries()
    expect(table.get(agedId)).toBeUndefined()
    expect(table.get(proposalIdOfKey('renew-prop'))).toBeDefined()

    // Clicking a button whose durable row was already pruned renders the pruned expired fallback card.
    await h.clickButton({
      messageId: 'om_pruned_card',
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: agedId,
      actionId: 'aged_act',
    })
    await h.waitUntil(() => {
      expect(h.lastPatchedCard('om_pruned_card')).toContain('该提议已过期，请直接在话题中输入指令')
    })

    await h.service.shutdown()
  })

  it('produces deterministic SHA-256 fingerprints normalized across optional defaults', () => {
    const a = fingerprintProposalSpec({
      key: 'k1',
      sessionId: 's1',
      prompt: '标题',
      actions: [{ id: 'x', label: '按钮', followUpPrompt: '指令' }],
    })
    const b = fingerprintProposalSpec({
      key: 'k2',
      sessionId: 's1',
      prompt: '标题',
      actions: [{
        id: 'x',
        label: '按钮',
        style: 'default',
        requiredAccess: 'chat',
        followUpPrompt: '指令',
        independent: false,
      }],
    })
    const c = fingerprintProposalSpec({
      key: 'k1',
      sessionId: 's1',
      prompt: '标题',
      actions: [{
        id: 'x',
        label: '按钮',
        style: 'primary',
        requiredAccess: 'chat',
        followUpPrompt: '指令',
        independent: false,
      }],
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('preserves supersession on failed in-flight rollback, clears repair snapshots on exceptional exits, and reconciles unfinished reservations on restart', async () => {
    const h = await setupService()
    await h.onMessage(makeMessage({ chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: '开启测试话题' }))
    await h.waitUntil(() => expect(h.routes()).toHaveLength(1))
    const route = h.routes()[0]!
    const agent = h.ctxState.agents.created[0]!.handle.agent
    for (const listener of h.ctxState.sessionListeners) {
      listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } } as never)
    }

    // 1) Finding #3: New proposal posted while a non-independent click is awaiting delivery; delivery fails -> rolls back to `superseded`, NEVER `pending`.
    const p1 = await h.actions.propose({
      key: 'race-supersede-1',
      sessionId: route.sessionId,
      prompt: '旧提议（二选一）：',
      actions: [
        { id: 'opt_a', label: '选项 A', followUpPrompt: '执行 A' },
        { id: 'opt_b', label: '选项 B', followUpPrompt: '执行 B' },
      ],
    })
    expect(p1.ok).toBe(true)
    if (!p1.ok) return

    const origSend = h.channel.send.bind(h.channel)
    let resolveSendStarted!: () => void
    const sendStarted = new Promise<void>((resolve) => { resolveSendStarted = resolve })
    let resolveReleaseSend!: () => void
    const releaseSend = new Promise<void>((resolve) => { resolveReleaseSend = resolve })
    let interceptReplySend = true
    h.channel.send = async (chatId, content, options) => {
      if (interceptReplySend && options?.replyTo === p1.cardMessageId) {
        interceptReplySend = false
        resolveSendStarted()
        await releaseSend
        throw new Error('feishu send failed after supersession')
      }
      return await origSend(chatId, content, options)
    }

    const click1Done = h.clickButton({
      messageId: p1.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('race-supersede-1'),
      actionId: 'opt_a',
    })
    await sendStarted

    // While `opt_a` delivery is suspended (`opt_a: triggered`, `opt_b: dismissed`), post p2!
    const p2 = await h.actions.propose({
      key: 'race-supersede-2',
      sessionId: route.sessionId,
      prompt: '新提议：',
      actions: [
        { id: 'opt_c', label: '选项 C', followUpPrompt: '执行 C' },
      ],
    })
    expect(p2.ok).toBe(true)
    if (!p2.ok) return

    // Now let `opt_a` delivery fail: rollback must transition BOTH items to `superseded`, not `pending`!
    resolveReleaseSend()
    await click1Done
    await h.waitUntil(() => {
      const stored1 = h.proposals().find(r => r.key === 'race-supersede-1')
      expect(stored1?.superseded).toBe(true)
      expect(stored1?.actions.map(a => a.status)).toEqual(['superseded', 'superseded'])
      expect(stored1?.reservations).toBeUndefined()
      expect(h.lastPatchedCard(p1.cardMessageId)).not.toContain('"tag":"button"')
    })

    // 2) Finding #2: Exception thrown AFTER `repair.write()` (e.g. `routes.put` throws) retires the `inflight` snapshot before reopening buttons.
    const routesTable = h.ctxState.domain.raw.table('routes')
    const origPut = routesTable.put.bind(routesTable)
    let failNextRoutePut = true
    routesTable.put = async (k: string, v: unknown) => {
      if (failNextRoutePut) {
        failNextRoutePut = false
        throw new Error('simulated disk error in routes.put')
      }
      await origPut(k, v)
    }

    await h.clickButton({
      messageId: p2.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: proposalIdOfKey('race-supersede-2'),
      actionId: 'opt_c',
    })
    await h.waitUntil(() => expect(failNextRoutePut).toBe(false))
    await h.waitUntil(() => {
      const stored2 = h.proposals().find(r => r.key === 'race-supersede-2')
      expect(stored2?.actions.map(a => a.status)).toEqual(['pending'])
      expect(stored2?.reservations).toBeUndefined()
    })
    expect([...h.ctxState.domain.raw.table('inflight').entries()]).toHaveLength(0)

    // 3) Finding #1: Simulate an unclean process exit right after `triggerAction()` committed (before `repair.write()`), then restart -> startup reconciles back to `pending`!
    const p2Id = proposalIdOfKey('race-supersede-2')
    const proposalsTable = h.ctxState.domain.raw.table('action_proposals')
    const currentP2 = proposalsTable.get(p2Id) as ActionProposalRecord
    await proposalsTable.put(p2Id, {
      ...currentP2,
      actions: currentP2.actions.map(item => ({
        ...item,
        status: 'triggered' as const,
        triggeredBy: 'u_alice',
        triggeredAt: Date.now(),
      })),
      reservations: [{
        requestId: 'orphaned-req-before-repair-write',
        actionId: 'opt_c',
        changedIds: ['opt_c'],
        createdAt: Date.now(),
      }],
    })

    await h.service.restart()
    await h.waitUntil(() => {
      const reconciled = h.proposals().find(r => r.key === 'race-supersede-2')
      expect(reconciled?.actions.map(a => a.status)).toEqual(['pending'])
      expect(reconciled?.reservations).toBeUndefined()
    })

    // 4) Borrowed Session running another turn while snapshot prompt is absent from both log and inbox:
    // `repairAll()` settles snapshot as interrupted without replaying, so reconciliation MUST also roll back the reservation!
    await h.service.shutdown()
    const borrowed = makeAgent(makeSession(route.sessionId, route.workspacePath))
    ;(borrowed as { status: string }).status = 'running'
    const currentP2BeforeBorrow = proposalsTable.get(p2Id) as ActionProposalRecord
    await proposalsTable.put(p2Id, {
      ...currentP2BeforeBorrow,
      actions: currentP2BeforeBorrow.actions.map(item => ({
        ...item,
        status: 'triggered' as const,
        triggeredBy: 'u_alice',
        triggeredAt: Date.now(),
      })),
      reservations: [{
        requestId: 'req-unsubmitted-on-running-borrowed-agent',
        actionId: 'opt_c',
        changedIds: ['opt_c'],
        createdAt: Date.now(),
      }],
    })
    await h.ctxState.domain.raw.table('inflight').put('card_unsubmitted_borrowed', {
      key: 'card_unsubmitted_borrowed',
      sessionId: route.sessionId,
      chatId: 'oc_p2p',
      routeKey: route.key,
      prompt: {
        requestId: 'req-unsubmitted-on-running-borrowed-agent',
        principal: { kind: 'feishu-user', userId: 'u_alice' },
        content: [{ type: 'text', text: '执行 C' }],
      },
      cards: [{ messageId: 'card_unsubmitted_borrowed', mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })
    h.ctxState.agents.liveAgents.set(route.sessionId, {
      agent: borrowed,
      dispose: vi.fn(async () => {}),
    })
    await h.service.start()
    await h.waitUntil(() => {
      const reconciled = h.proposals().find(r => r.key === 'race-supersede-2')
      expect(reconciled?.actions.map(a => a.status)).toEqual(['pending'])
      expect(reconciled?.reservations).toBeUndefined()
    })
    // User can now click `opt_c` on that borrowed Session and execute it cleanly!
    ;(borrowed as { status: string }).status = 'idle'
    await h.clickButton({
      messageId: p2.cardMessageId,
      chatId: 'oc_p2p',
      userId: 'u_alice',
      proposalId: p2Id,
      actionId: 'opt_c',
    })
    await h.waitUntil(() => {
      expect(followupMessagesOf(borrowed).length).toBe(1)
    })
    expect(h.proposals().find(r => r.key === 'race-supersede-2')?.actions.map(a => a.status)).toEqual(['triggered'])
    expect(h.proposals().find(r => r.key === 'race-supersede-2')?.reservations).toBeUndefined()

    // 5) Snapshotless reservation whose turn already ran (`confirmTrigger()` failed or crashed after `inflight` clear):
    // Startup checks the Session log even without an `inflight` snapshot and CONFIRMS instead of rolling back!
    const p3 = await h.actions.propose({
      key: 'snapshotless-confirm-1',
      sessionId: route.sessionId,
      prompt: '测试无快照已执行确认：',
      actions: [
        { id: 'opt_done', label: '已执行动作', independent: true, followUpPrompt: '执行已落盘动作' },
        { id: 'opt_inbox', label: '队列中动作', independent: true, followUpPrompt: '执行队列动作' },
      ],
    })
    expect(p3.ok).toBe(true)
    if (!p3.ok) return
    const p3Id = proposalIdOfKey('snapshotless-confirm-1')

    // Append a completed turn with `rpcId: 'req-completed-without-snapshot'` to `borrowed.session`,
    // and queue a second message with `rpcId: 'req-inbox-without-snapshot'` in `borrowed.inbox.nextTurn`!
    const events = sessionEvents(borrowed.session)
    events.push(
      {
        type: 'user/message',
        seq: events.length,
        data: {
          id: 'msg-done-1' as UserMessage['id'],
          role: 'user',
          content: [{ type: 'text', text: '执行已落盘动作' }],
          source: { kind: 'user', rpcId: 'req-completed-without-snapshot', principal: { kind: 'feishu-user', userId: 'u_alice' } },
        },
      } as never,
      {
        type: 'turn/end',
        seq: events.length + 1,
        data: { turn: 2, reason: { kind: 'completed' } },
      } as never,
    )
    ;(borrowed.inbox.nextTurn as UserMessage[]).push({
      id: 'msg-inbox-1' as UserMessage['id'],
      role: 'user',
      content: [{ type: 'text', text: '执行队列动作' }],
      source: { kind: 'user', rpcId: 'req-inbox-without-snapshot', principal: { kind: 'feishu-user', userId: 'u_alice' } },
    })

    // Ensure `inflight` table is completely empty (no snapshots at all), while `action_proposals` holds both reservations:
    const inflightTable = h.ctxState.domain.raw.table('inflight')
    for (const [k] of [...inflightTable.entries()]) {
      await inflightTable.delete(k)
    }
    expect([...inflightTable.entries()]).toHaveLength(0)
    const currentP3 = proposalsTable.get(p3Id) as ActionProposalRecord
    await proposalsTable.put(p3Id, {
      ...currentP3,
      actions: currentP3.actions.map(item => ({
        ...item,
        status: 'triggered' as const,
        triggeredBy: 'u_alice',
        triggeredAt: Date.now(),
      })),
      reservations: [
        {
          requestId: 'req-completed-without-snapshot',
          actionId: 'opt_done',
          changedIds: ['opt_done'],
          createdAt: Date.now(),
        },
        {
          requestId: 'req-inbox-without-snapshot',
          actionId: 'opt_inbox',
          changedIds: ['opt_inbox'],
          createdAt: Date.now(),
        },
      ],
    })

    await h.service.restart()
    await h.waitUntil(() => {
      const reconciledP3 = h.proposals().find(r => r.key === 'snapshotless-confirm-1')
      expect(reconciledP3?.actions.map(a => a.status)).toEqual(['triggered', 'triggered'])
      expect(reconciledP3?.reservations).toBeUndefined()
    })

    // 6) Replay-eligible snapshot whose replay submission encounters a gateway error:
    // Reservation stays deferred until replay settles; failed replay clears snapshot and rolls back to `pending`.
    const p4 = await h.actions.propose({
      key: 'replay-settlement-1',
      sessionId: route.sessionId,
      prompt: '测试重放提交结算：',
      actions: [
        { id: 'opt_replay', label: '重放动作', independent: true, followUpPrompt: '执行重放动作' },
      ],
    })
    expect(p4.ok).toBe(true)
    if (!p4.ok) return
    const p4Id = proposalIdOfKey('replay-settlement-1')

    await h.service.shutdown()
    h.ctxState.agents.liveAgents.clear()
    const baseP4 = proposalsTable.get(p4Id) as ActionProposalRecord
    await proposalsTable.put(p4Id, {
      ...baseP4,
      actions: baseP4.actions.map(item => ({
        ...item,
        status: 'triggered' as const,
        triggeredBy: 'u_alice',
        triggeredAt: Date.now(),
      })),
      reservations: [{
        requestId: 'req-replay-gateway-fail',
        actionId: 'opt_replay',
        changedIds: ['opt_replay'],
        createdAt: Date.now(),
      }],
    })
    await inflightTable.put('card_replay_fail', {
      key: 'card_replay_fail',
      sessionId: route.sessionId,
      chatId: 'oc_p2p',
      routeKey: route.key,
      prompt: {
        requestId: 'req-replay-gateway-fail',
        principal: { kind: 'feishu-user', userId: 'u_alice' },
        content: [{ type: 'text', text: '执行重放失败测试' }],
      },
      cards: [{ messageId: 'card_replay_fail', mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
      replays: 0,
    })

    const origGatewayInvoke = h.ctxState.remote.gateway.invoke
    let failReplayOnce = true
    h.ctxState.remote.gateway.invoke = vi.fn(async (request) => {
      const reqPayload = request.args.request as { requestId?: string } | undefined
      if (failReplayOnce && reqPayload?.requestId === 'req-replay-gateway-fail') {
        failReplayOnce = false
        throw new Error('transient gateway outage during replay')
      }
      return await origGatewayInvoke(request)
    })

    await h.service.start()
    await h.waitUntil(() => {
      expect(failReplayOnce).toBe(false)
      const rolledBackP4 = h.proposals().find(r => r.key === 'replay-settlement-1')
      expect(rolledBackP4?.actions.map(a => a.status)).toEqual(['pending'])
      expect(rolledBackP4?.reservations).toBeUndefined()
      expect(inflightTable.get('card_replay_fail')).toBeUndefined()
    })

    // 7) Successful pending replay confirms the deferred reservation once submission succeeds.
    await h.service.shutdown()
    h.ctxState.agents.liveAgents.clear()
    h.ctxState.remote.gateway.invoke = origGatewayInvoke
    const reopenedP4 = proposalsTable.get(p4Id) as ActionProposalRecord
    await proposalsTable.put(p4Id, {
      ...reopenedP4,
      actions: reopenedP4.actions.map(item => ({
        ...item,
        status: 'triggered' as const,
        triggeredBy: 'u_alice',
        triggeredAt: Date.now(),
      })),
      reservations: [{
        requestId: 'req-replay-gateway-ok',
        actionId: 'opt_replay',
        changedIds: ['opt_replay'],
        createdAt: Date.now(),
      }],
    })
    await inflightTable.put('card_replay_ok', {
      key: 'card_replay_ok',
      sessionId: route.sessionId,
      chatId: 'oc_p2p',
      routeKey: route.key,
      prompt: {
        requestId: 'req-replay-gateway-ok',
        principal: { kind: 'feishu-user', userId: 'u_alice' },
        content: [{ type: 'text', text: '执行重放成功测试' }],
      },
      cards: [{ messageId: 'card_replay_ok', mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
      replays: 0,
    })

    await h.service.start()
    await h.waitUntil(() => {
      const confirmedP4 = h.proposals().find(r => r.key === 'replay-settlement-1')
      expect(confirmedP4?.actions.map(a => a.status)).toEqual(['triggered'])
      expect(confirmedP4?.reservations).toBeUndefined()
    })

    await h.service.shutdown()
  })
})
