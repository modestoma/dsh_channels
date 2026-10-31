/**
 * The `feishuTopics` service: spec validation, the root card, the service flow
 * from an accepted launch to a group-shared topic, records written by the
 * former analyze API, and the plugin providing the service.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { buildTopicRootCard } from '../src/cards.ts'
import { MOVED_ANALYZE_NOTICE, movedAnalyzeKeysOf, resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { HostContext } from '../src/dsh-types.ts'
import { rootCardOf } from '../src/domain.ts'
import type { RouteRecord, TopicLaunchRecord } from '../src/domain.ts'
import type { CardActionEvent, ChannelFactory, NormalizedMessage } from '../src/feishu-channel.ts'
import { apply, inject, name } from '../src/index.ts'
import { FeishuService } from '../src/service.ts'
import { OverlayStore } from '../src/settings/overlay.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { FeishuTopicService, TopicLaunchSpec } from '../src/topics/contract.ts'
import { FEISHU_TOPICS_SERVICE, TopicLauncher } from '../src/topics/launcher.ts'
import { followupMessagesOf, makeChannel, makeHostContext, makeMessage } from './helpers.ts'

const PROMPT = '/logalyze https://logs.example/a.zip 分析这些日志'

function spec(partial: Partial<TopicLaunchSpec> = {}): TopicLaunchSpec {
  return {
    key: 'key-1',
    fingerprint: 'fp-1',
    chatId: 'oc_group',
    requesterUserId: 'u_alice',
    card: {
      title: '日志分析',
      taskName: '分析',
      lead: [
        { text: '于 2026-10-22 19:30 发起了对 ' },
        { text: 'camera', bold: true },
        { text: ' 应用 ' },
        { text: 'E1001', bold: true },
        { text: ' 错误码不良日志的分析。' },
      ],
      links: { nameHeader: '日志', linkHeader: '详情页', rows: [{ name: '设备 A 崩溃日志', url: 'https://logs.example/detail/1' }] },
    },
    workspace: { segments: ['analyze', 'camera', 'E1001'], title: '日志分析 · camera · E1001' },
    prompt: PROMPT,
    ...partial,
  }
}

describe('topic root card', () => {
  it('mentions the requester, emphasizes bold runs, and keeps link targets intact', () => {
    const card = { ...spec().card, links: { nameHeader: '日志', linkHeader: '详情页', rows: [{ name: 'a', url: 'https://logs.example/d (1)' }] } }
    const stopped = JSON.stringify(buildTopicRootCard('u_alice', card, { kind: 'stopped' }))
    expect(stopped).toContain('<at id=u_alice></at> 于 2026-10-22 19:30 发起了对 **camera** 应用 **E1001** 错误码不良日志的分析。')
    expect(stopped).toContain('[查看](https://logs.example/d%20%281%29)')
    expect(stopped).toContain('已停止')
    expect(stopped).toContain('"template":"grey"')
  })

  it('names the task in the status texts and escapes caller markdown', () => {
    const card = { title: '巡检', taskName: '巡检', lead: [{ text: '*not bold*' }] }
    const running = JSON.stringify(buildTopicRootCard('u_alice', card, { kind: 'running' }))
    expect(running).toContain('巡检中')
    expect(running).toContain('巡检过程在本卡片下的话题内实时输出')
    expect(running).toContain('\\\\*not bold\\\\*')
    expect(running).not.toContain('"tag":"table"')
  })

  it('redraws records the former analyze API wrote as the card it drew', () => {
    const legacy: TopicLaunchRecord = {
      key: 'req-1', bodyHash: 'h', chatId: 'oc_group', messageId: 'om_1', acceptedAt: 1, status: 'running',
      subject: {
        requesterUserId: 'u_alice', triggeredAt: '2026-10-22 19:30', app: 'camera', errorCode: 'E1001',
        logDetails: [{ name: '设备 A 崩溃日志', url: 'https://logs.example/detail/1' }],
      },
    }
    const root = rootCardOf(legacy)!
    expect(root).toEqual({ requesterUserId: 'u_alice', card: spec().card })
    expect(rootCardOf({ ...legacy, subject: undefined })).toBeUndefined()
  })
})

describe('moved analyze settings', () => {
  it('finds the analyze API keys a config or overlay still sets', () => {
    expect(movedAnalyzeKeysOf({ analyzeEnabled: true, analyzeToken: 'X', baseDir: '/x' })).toEqual(['analyzeEnabled', 'analyzeToken'])
    expect(movedAnalyzeKeysOf({ baseDir: '/x' })).toEqual([])
    expect(movedAnalyzeKeysOf(undefined)).toEqual([])
    expect(resolveConfig({ analyzeEnabled: true })).not.toHaveProperty('analyzeEnabled')
  })

  it('warns once when the Web overlay still sets them, and keeps the other overrides', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-topics-overlay-')), 'settings.json')
    writeFileSync(file, JSON.stringify({ analyzeEnabled: true, refreshMs: 800 }))
    const warn = vi.fn()
    expect(await new OverlayStore(file, { warn }).load()).toEqual({ refreshMs: 800 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(MOVED_ANALYZE_NOTICE, `${file} 中的 analyzeEnabled`)
  })
})

describe('feishuTopics service provision', () => {
  it('provides the launcher, which refuses launches until the channel connects', async () => {
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
    await vi.waitFor(() => expect(ctx.get(FEISHU_TOPICS_SERVICE)).toBeDefined())
    const service = ctx.get(FEISHU_TOPICS_SERVICE) as FeishuTopicService
    expect(service).toBeInstanceOf(TopicLauncher)
    expect(service.version).toBe(1)
    expect(await service.launch(spec())).toMatchObject({ ok: false, code: 'not-connected' })
    await fiber.dispose()
    expect(ctx.get(FEISHU_TOPICS_SERVICE)).toBeUndefined()
    await ctx.fiber.dispose()
    errors.mockRestore()
  })
})

describe('topic launch flow', () => {
  function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
    return resolveConfig({
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-topics-ws-')),
      statusRefreshMs: 60_000,
      accessMode: 'guarded',
      adminUserId: 'u_admin',
      welcomeOnboarding: false,
      topicIsolation: 'subdir',
      ...partial,
    })
  }

  async function setup(partial: Partial<FeishuConfig> = {}) {
    const config = makeConfig(partial)
    const channel = makeChannel()
    const ctxState = makeHostContext()
    const factory: ChannelFactory = () => channel
    const service = new FeishuService(ctxState.ctx, config, factory)
    await service.start()
    const handler = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as
      (msg: NormalizedMessage) => Promise<void>
    const launcher = service.topics()
    return {
      service, channel, ctxState, config, launcher,
      onMessage: (msg: NormalizedMessage) => Promise.resolve(handler(msg)),
      routes: () => [...ctxState.domain.raw.table('routes').entries()].map(([, value]) => value as RouteRecord),
      record: (key: string) => ctxState.domain.raw.table('analyze_requests').get(key) as TopicLaunchRecord | undefined,
    }
  }

  /** Session manager the launcher uses (its guidance mount is the last setup step before the route). */
  function sessionsOf(launcher: TopicLauncher): SessionManager {
    return (launcher as unknown as { deps: { sessions: SessionManager } }).deps.sessions
  }

  /** Hold every launch between Session creation and the first prompt until `release()`. */
  function holdSetup(launcher: TopicLauncher): { release(): void } {
    const sessions = sessionsOf(launcher)
    const mount = sessions.mountGuidance.bind(sessions)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sessions.mountGuidance = async (...args: Parameters<SessionManager['mountGuidance']>) => {
      await gate
      return await mount(...args)
    }
    return { release }
  }

  const waitUntil = async (assert: () => void) => {
    await vi.waitFor(assert, { timeout: 3000, interval: 5 })
  }

  /** Card JSON of the latest update of one message. */
  const lastCard = (h: { channel: ReturnType<typeof makeChannel> }, messageId: string): string =>
    JSON.stringify(h.channel.updated.filter(entry => entry.messageId === messageId).at(-1)?.card)

  it('posts the root card, opens a shared topic with a streaming card, and forwards the prompt verbatim', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const response = await h.launcher.launch(spec())

    expect(response).toEqual({ ok: true, replayed: false, chatId: 'oc_group', messageId: 'om_1' })
    const root = h.channel.sent[0]!
    expect(root.options).toBeUndefined()
    const rootCard = JSON.stringify(root.input)
    expect(rootCard).toContain('<at id=u_alice></at> 于 2026-10-22 19:30 发起了对 **camera** 应用 **E1001** 错误码不良日志的分析。')
    expect(rootCard).toContain('"name":"设备 A 崩溃日志","link":"[查看](https://logs.example/detail/1)"')
    expect(rootCard).toContain('分析中')

    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const streaming = h.channel.sent[1]!
    expect(streaming.options).toEqual({ replyTo: 'om_1', replyInThread: true })
    expect(JSON.stringify(streaming.input)).toContain('推理中')
    expect(h.routes()[0]).toMatchObject({
      key: 'omt_2', kind: 'thread', chatId: 'oc_group', senderUserId: 'u_alice',
      cardMessageId: 'om_2', shared: true,
      workspacePath: path.join(h.config.baseDir, 'analyze', 'camera', 'E1001'),
    })
    const agent = h.ctxState.agents.created[0]!.handle.agent
    expect(followupMessagesOf(agent).map(message => message.content[0]!.text)).toEqual([PROMPT])
  })

  it('streams the first turn in the topic and marks the root card when it settles', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '根因：内存溢出' } } })
    await waitUntil(() => expect(lastCard(h, 'om_2')).toContain('根因：内存溢出'))
    expect(lastCard(h, 'om_1')).toBeUndefined()

    h.ctxState.sessionListeners[0]!(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(h.record('key-1')?.status).toBe('done'))
    expect(lastCard(h, 'om_1')).toContain('已完成')
    expect(lastCard(h, 'om_1')).toContain('"template":"green"')
    expect(h.channel.reactions).toContainEqual({ messageId: 'om_1', emojiType: 'DONE' })
  })

  it('marks the root card failed when the first turn fails', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.sessionListeners[0]!(agent.session, {
      type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { message: 'model down', code: 'DOWN' } } },
    })
    await waitUntil(() => expect(lastCard(h, 'om_1')).toContain('失败'))
    expect(lastCard(h, 'om_1')).toContain('原因见话题')
    expect(lastCard(h, 'om_2')).toContain('model down')
  })

  it('marks analyses a previous instance never finished as interrupted at start', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.launcher.launch(spec({ key: 'key-done' }))
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const first = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.sessionListeners[0]!(first.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(h.record('key-done')?.status).toBe('done'))
    await h.launcher.launch(spec({ key: 'key-open', fingerprint: 'fp-2', prompt: 'second' }))
    await waitUntil(() => expect(h.routes()).toHaveLength(2))
    expect(h.record('key-open')?.status).toBe('running')

    await h.service.shutdown()
    await h.service.start()
    await waitUntil(() => expect(h.record('key-open')?.status).toBe('interrupted'))
    const card = lastCard(h, h.record('key-open')!.messageId)
    expect(card).toContain('已中断')
    expect(card).toContain('"template":"orange"')
    expect(card).toContain('设备 A 崩溃日志')
    expect(h.record('key-done')?.status).toBe('done')
  })

  it('replays a retried key and refuses a reused one', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const [first, concurrent] = await Promise.all([h.launcher.launch(spec()), h.launcher.launch(spec())])
    const replay = await h.launcher.launch(spec())
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(concurrent).toEqual(first)
    expect(replay).toEqual({ ...first, replayed: true })
    expect(h.channel.sent.filter(entry => entry.options === undefined)).toHaveLength(1)
    expect(await h.launcher.launch(spec({ fingerprint: 'fp-other', prompt: 'other' }))).toMatchObject({ ok: false, code: 'key-conflict' })
  })

  it('refuses groups that are not authorized', async () => {
    const h = await setup()
    expect(await h.launcher.launch(spec())).toMatchObject({ ok: false, code: 'forbidden-chat' })
    expect(h.channel.sent).toHaveLength(0)
  })

  it('refuses requests while disconnected', async () => {
    const h = await setup()
    await h.service.shutdown()
    expect(await h.launcher.launch(spec())).toMatchObject({ ok: false, code: 'not-connected' })
  })

  it('waits for an acceptance still sending its root card before shutdown finishes', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const sendMock = vi.mocked(h.channel.send)
    const send = sendMock.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sendMock.mockImplementationOnce(async (...args: Parameters<typeof send>) => {
      await gate
      return await send(...args)
    })
    const accepted = h.launcher.launch(spec())
    let shutDown = false
    const shutdown = h.service.shutdown().then(() => { shutDown = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shutDown).toBe(false)
    release()
    await shutdown
    expect(await accepted).toMatchObject({ ok: true })
    expect(h.record('key-1')).toMatchObject({ messageId: 'om_1' })
  })

  it('refuses launches until the channel start has marked earlier topics interrupted', async () => {
    const config = makeConfig()
    const ctxState = makeHostContext()
    const service = new FeishuService(ctxState.ctx, config, () => makeChannel())
    expect(await service.topics().launch(spec())).toMatchObject({ ok: false, code: 'not-connected' })
  })

  it('refuses invalid specs before posting anything', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const invalid: Array<[string, TopicLaunchSpec]> = [
      ['workspace.segments', spec({ workspace: { segments: ['..'], title: 't' } })],
      ['workspace.segments', spec({ workspace: { segments: ['p2p', 'u_alice'], title: 't' } })],
      ['workspace.segments', spec({ workspace: { segments: [], title: 't' } })],
      ['chatId', spec({ chatId: 'ou_user' })],
      ['requesterUserId', spec({ requesterUserId: 'ou_open_id' })],
      ['key', spec({ key: 'has space' })],
      ['prompt', spec({ prompt: '  ' })],
      ['card.links.rows.0.url', spec({ card: { ...spec().card, links: { nameHeader: 'a', linkHeader: 'b', rows: [{ name: 'x', url: 'javascript:alert(1)' }] } } })],
    ]
    for (const [field, value] of invalid) {
      const result = await h.launcher.launch(value)
      expect(result).toMatchObject({ ok: false, code: 'invalid' })
      if (!result.ok) expect(result.message).toContain(field)
    }
    expect(h.channel.sent).toHaveLength(0)
  })

  it('reports a root card Feishu refuses as send-failed', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    vi.mocked(h.channel.send).mockRejectedValueOnce(new Error('bot not in chat'))
    expect(await h.launcher.launch(spec())).toMatchObject({ ok: false, code: 'send-failed', message: expect.stringContaining('bot not in chat') })
    expect(h.record('key-1')).toBeUndefined()
  })

  it('marks a running record the former analyze API wrote as interrupted at start', async () => {
    const h = await setup()
    await h.ctxState.domain.raw.table('analyze_requests').put('req-legacy', {
      key: 'req-legacy', bodyHash: 'h', chatId: 'oc_group', messageId: 'om_legacy', acceptedAt: 1, status: 'running',
      subject: {
        requesterUserId: 'u_alice', triggeredAt: '2026-10-22 19:30', app: 'camera', errorCode: 'E1001',
        logDetails: [{ name: '设备 A 崩溃日志', url: 'https://logs.example/detail/1' }],
      },
    })
    await h.service.shutdown()
    await h.service.start()
    await waitUntil(() => expect(h.record('req-legacy')?.status).toBe('interrupted'))
    const card = lastCard(h, 'om_legacy')
    expect(card).toContain('已中断')
    expect(card).toContain('<at id=u_alice></at> 于 2026-10-22 19:30 发起了对 **camera** 应用 **E1001** 错误码不良日志的分析。')
    expect(card).toContain('设备 A 崩溃日志')
  })

  it('ends on a failure card without a route when setup fails', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    sessionsOf(h.launcher).mountGuidance = async () => { throw new Error('mount failed') }
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.record('key-1')?.status).toBe('failed'))
    expect(lastCard(h, 'om_1')).toContain('分析未能开始：mount failed')
    expect(lastCard(h, 'om_1')).toContain('"template":"red"')
    expect(lastCard(h, 'om_2')).toContain('分析未能开始：mount failed')
    expect(h.routes()).toHaveLength(0)
    expect(h.ctxState.agents.created[0]!.handle.dispose).toHaveBeenCalled()
  })

  it('holds topic replies posted during setup until the analysis prompt is delivered', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_bob')
    const held = holdSetup(h.launcher)
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatId: 'oc_group', threadId: 'omt_2', mentionedBot: false, senderId: 'u_bob', content: '顺便看下内存',
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(followupMessagesOf(agent)).toHaveLength(0)
    expect(h.ctxState.agents.created).toHaveLength(1)

    held.release()
    await waitUntil(() => expect(followupMessagesOf(agent)).toHaveLength(2))
    expect(followupMessagesOf(agent).map(message => message.content[0]!.text)).toEqual([PROMPT, '顺便看下内存'])
  })

  it('removes the published route when the first prompt cannot be delivered', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const held = holdSetup(h.launcher)
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const { handle } = h.ctxState.agents.created[0]!
    vi.mocked(handle.agent.followup).mockImplementationOnce(() => { throw new Error('session closed') })

    held.release()
    await waitUntil(() => expect(lastCard(h, 'om_1')).toContain('session closed'))
    expect(h.routes()).toHaveLength(0)
    expect(handle.dispose).toHaveBeenCalled()
  })

  it('ends an analysis still starting at shutdown on the failure card', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const held = holdSetup(h.launcher)
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const shutdown = h.service.shutdown()
    held.release()
    await shutdown
    expect(lastCard(h, 'om_1')).toContain('飞书渠道已断开')
    expect(h.routes()).toHaveLength(0)
  })

  it('lets admitted group members, and nobody else, follow up and stop the shared topic', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_bob')
    await h.launcher.launch(spec())
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const thread = { chatId: 'oc_group', threadId: 'omt_2', mentionedBot: false }

    await h.onMessage(makeMessage({ ...thread, senderId: 'u_carol', content: '我也想问' }))
    await h.onMessage(makeMessage({ ...thread, senderId: 'u_bob', content: '为什么内存溢出？' }))
    await waitUntil(() => expect(followupMessagesOf(agent)).toHaveLength(2))
    expect(followupMessagesOf(agent)[1]!.content[0]!.text).toBe('为什么内存溢出？')

    const cancel = vi.fn()
    ;(agent as unknown as { cancel: unknown }).cancel = cancel
    // The first turn is still the active one: its card carries the stop button.
    const stop = (userId: string): CardActionEvent => ({
      messageId: 'om_2',
      chatId: 'oc_group',
      operator: { openId: `ou_${userId}`, userId },
      action: { value: { decision: 'turn-stop' }, tag: 'button' },
    })
    await h.channel.fireCardAction(stop('u_carol'))
    expect(cancel).not.toHaveBeenCalled()
    await h.channel.fireCardAction(stop('u_bob'))
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })
})
