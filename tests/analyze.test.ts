/**
 * Log-platform analyze API: wire contract, HTTP listener, and the service
 * flow from an accepted request to a group-shared topic.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANALYZE_ROUTE, analyzeRequestHash, chatApplink, parseAnalyzeRequest,
} from '../src/analyze/contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from '../src/analyze/contract.ts'
import type { AnalyzeLauncher } from '../src/analyze/launcher.ts'
import { parseListenAddress, startAnalyzeServer } from '../src/analyze/server.ts'
import type { AnalyzeHandler, AnalyzeServer } from '../src/analyze/server.ts'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { CardActionEvent, ChannelFactory, NormalizedMessage } from '../src/feishu-channel.ts'
import { FeishuService } from '../src/service.ts'
import type { SessionManager } from '../src/session/manager.ts'
import { followupMessagesOf, makeChannel, makeHostContext, makeMessage } from './helpers.ts'

const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** Serve fixed responses per path on 127.0.0.1 (log package fixtures). */

function request(partial: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    requesterUserId: 'u_alice',
    app: 'camera',
    errorCode: 'E1001',
    chatId: 'oc_group',
    prompt: '/log-analyze https://logs.example/a.zip 分析这些日志',
    ...partial,
  }
}

describe('analyze contract', () => {
  it('accepts a complete request and refuses unknown fields', () => {
    expect(parseAnalyzeRequest(request())).toEqual({ ok: true, value: request() })
    const extra = parseAnalyzeRequest({ ...request(), logUrls: ['https://logs.example/a.zip'] })
    expect(extra.ok).toBe(false)
  })

  it('names every invalid field', () => {
    const result = parseAnalyzeRequest({
      ...request(),
      requesterUserId: 'ou_open_id',
      app: '../etc',
      chatId: 'not-a-chat',
      errorCode: '..',
      prompt: '   ',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    for (const field of ['requesterUserId', 'app', 'errorCode', 'chatId', 'prompt']) {
      expect(result.error).toContain(field)
    }
  })

  it('hashes the request content, not the object identity', () => {
    expect(analyzeRequestHash(request())).toBe(analyzeRequestHash(request()))
    expect(analyzeRequestHash(request({ prompt: 'other' }))).not.toBe(analyzeRequestHash(request()))
  })

  it('builds chat applinks with an optional position', () => {
    expect(chatApplink('oc_g')).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_g')
    expect(chatApplink('oc_g', '12')).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_g&position=12')
  })

  it('validates the listen address and token reference in config', () => {
    expect(resolveConfig({ analyzeListen: '0.0.0.0:3090' }).analyzeListen).toBe('0.0.0.0:3090')
    expect(resolveConfig({}).analyzeToken).toBe('DSH_CHANNELS_ANALYZE_TOKEN')
    expect(() => resolveConfig({ analyzeListen: '3090' })).toThrow(/analyzeListen/)
    expect(() => resolveConfig({ analyzeListen: '0.0.0.0:70000' })).toThrow(/analyzeListen/)
    expect(() => resolveConfig({ analyzeToken: 'plain secret' })).toThrow(/analyzeToken/)
    expect(parseListenAddress('[::1]:3090')).toEqual({ host: '::1', port: 3090 })
  })
})

describe('analyze listener', () => {
  async function listen(handler: Partial<AnalyzeHandler> = {}): Promise<{ url: string; calls: unknown[][] }> {
    const calls: unknown[][] = []
    const server: AnalyzeServer = await startAnalyzeServer('127.0.0.1:0', {
      token: handler.token ?? (async () => 'secret-token'),
      analyze: handler.analyze ?? (async (...args): Promise<AnalyzeResponse> => {
        calls.push(args)
        return { status: 202, body: { ok: true, chatId: 'oc_group', messageId: 'om_1', link: 'l' } }
      }),
    }, vi.fn())
    servers.push(server)
    return { url: `http://127.0.0.1:${server.address.port}`, calls }
  }

  const headers = {
    authorization: 'Bearer secret-token',
    'idempotency-key': 'req-1',
    'content-type': 'application/json',
  }

  it('passes a valid request to the handler', async () => {
    const { url, calls } = await listen()
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, messageId: 'om_1' })
    expect(calls).toEqual([[request(), 'req-1']])
  })

  it.each([
    ['unknown path', '/other', {}, JSON.stringify(request()), 404],
    ['wrong method', ANALYZE_ROUTE, { method: 'GET' }, undefined, 405],
    ['wrong token', ANALYZE_ROUTE, { headers: { ...headers, authorization: 'Bearer nope' } }, JSON.stringify(request()), 401],
    ['missing token', ANALYZE_ROUTE, { headers: { ...headers, authorization: '' } }, JSON.stringify(request()), 401],
    ['missing key', ANALYZE_ROUTE, { headers: { ...headers, 'idempotency-key': '' } }, JSON.stringify(request()), 400],
    ['wrong media type', ANALYZE_ROUTE, { headers: { ...headers, 'content-type': 'text/plain' } }, JSON.stringify(request()), 415],
    ['invalid JSON', ANALYZE_ROUTE, {}, '{', 400],
    ['invalid body', ANALYZE_ROUTE, {}, JSON.stringify({ ...request(), prompt: '' }), 400],
    ['oversized body', ANALYZE_ROUTE, {}, JSON.stringify({ ...request(), prompt: 'x'.repeat(1_100_000) }), 413],
  ])('refuses %s', async (_name, route, init, body, status) => {
    const { url, calls } = await listen()
    const res = await fetch(`${url}${route}`, {
      method: 'POST', headers, ...(body === undefined ? {} : { body }), ...init,
    })
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('refuses every request while the token is not configured', async () => {
    const { url, calls } = await listen({ token: async () => undefined })
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('rejects when the address cannot be bound', async () => {
    const first = await startAnalyzeServer('127.0.0.1:0', { token: async () => 't', analyze: vi.fn() }, vi.fn())
    servers.push(first)
    await expect(startAnalyzeServer(`127.0.0.1:${first.address.port}`, {
      token: async () => 't', analyze: vi.fn(),
    }, vi.fn())).rejects.toThrow(/EADDRINUSE/)
  })
})


describe('analyze service flow', () => {
  function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
    return resolveConfig({
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-analyze-ws-')),
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
    const channel = makeChannel({ messagePositionOf: async () => '42' })
    const ctxState = makeHostContext()
    const factory: ChannelFactory = () => channel
    const service = new FeishuService(ctxState.ctx, config, factory)
    await service.start()
    const handler = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as
      (msg: NormalizedMessage) => Promise<void>
    const launcher = (service as unknown as { analyzeLauncher: AnalyzeLauncher }).analyzeLauncher
    return {
      service, channel, ctxState, config, launcher,
      onMessage: (msg: NormalizedMessage) => Promise.resolve(handler(msg)),
      routes: () => [...ctxState.domain.raw.table('routes').entries()].map(([, value]) => value as RouteRecord),
    }
  }

  /** Session manager the launcher uses (its guidance mount is the last setup step before the route). */
  function sessionsOf(launcher: AnalyzeLauncher): SessionManager {
    return (launcher as unknown as { deps: { sessions: SessionManager } }).deps.sessions
  }

  /** Hold every launch between Session creation and the first prompt until `release()`. */
  function holdSetup(launcher: AnalyzeLauncher): { release(): void } {
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

  it('posts the placeholder, opens a shared topic, and forwards the prompt verbatim', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const response = await h.launcher.analyze(request(), 'key-1')

    expect(response).toEqual({
      status: 202,
      body: {
        ok: true, chatId: 'oc_group', messageId: 'om_1',
        link: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_group&position=42',
      },
    })
    const placeholder = h.channel.sent[0]!
    expect(placeholder.options).toBeUndefined()
    expect(JSON.stringify(placeholder.input)).toContain('<at id=u_alice></at> 正在分析 **camera** 应用的 **E1001** 问题。')

    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const hint = h.channel.sent[1]!
    expect(hint.options).toEqual({ replyTo: 'om_1', replyInThread: true })
    expect(h.routes()[0]).toMatchObject({
      key: 'omt_2', kind: 'thread', chatId: 'oc_group', senderUserId: 'u_alice',
      cardMessageId: 'om_1', shared: true,
      workspacePath: path.join(h.config.baseDir, 'analyze', 'camera', 'E1001'),
    })
    const agent = h.ctxState.agents.created[0]!.handle.agent
    expect(followupMessagesOf(agent).map(message => message.content[0]!.text)).toEqual([request().prompt])
  })

  it('renders the first turn once, into the placeholder, with the preface', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.launcher.analyze(request(), 'key-1')
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '根因：内存溢出' } } })
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(h.channel.updated).toHaveLength(0)

    h.ctxState.sessionListeners[0]!(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(h.channel.updated).toHaveLength(1))
    const result = JSON.stringify(h.channel.updated[0]!)
    expect(h.channel.updated[0]!.messageId).toBe('om_1')
    expect(result).toContain('根因：内存溢出')
    expect(result).toContain('发起的日志分析 · 应用 **camera** · 错误码 **E1001**')
    expect(h.channel.reactions).toContainEqual({ messageId: 'om_1', emojiType: 'DONE' })
  })

  it('replays a retried key and refuses a reused one', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const body = request()
    const [first, concurrent] = await Promise.all([h.launcher.analyze(body, 'key-1'), h.launcher.analyze(body, 'key-1')])
    const replay = await h.launcher.analyze(body, 'key-1')
    expect(concurrent).toEqual(first)
    expect(replay).toEqual(first)
    expect(h.channel.sent.filter(entry => entry.options === undefined)).toHaveLength(1)
    expect(await h.launcher.analyze({ ...body, prompt: 'other' }, 'key-1')).toMatchObject({ status: 409 })
  })

  it('refuses groups that are not authorized', async () => {
    const h = await setup()
    expect(await h.launcher.analyze(request(), 'key-1')).toMatchObject({ status: 403 })
    expect(h.channel.sent).toHaveLength(0)
  })

  it('refuses requests while disconnected', async () => {
    const h = await setup()
    await h.service.shutdown()
    expect(await h.launcher.analyze(request(), 'key-1')).toMatchObject({ status: 503 })
  })

  it('ends on a failure card without a route when setup fails', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    sessionsOf(h.launcher).mountGuidance = async () => { throw new Error('mount failed') }
    await h.launcher.analyze(request(), 'key-1')
    await waitUntil(() => expect(h.channel.updated).toHaveLength(1))
    expect(h.channel.updated[0]!.messageId).toBe('om_1')
    expect(JSON.stringify(h.channel.updated[0]!.card)).toContain('日志分析未能开始')
    expect(JSON.stringify(h.channel.updated[0]!.card)).toContain('mount failed')
    expect(h.routes()).toHaveLength(0)
    expect(h.ctxState.agents.created[0]!.handle.dispose).toHaveBeenCalled()
  })

  it('holds topic replies posted during setup until the analysis prompt is delivered', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_bob')
    const held = holdSetup(h.launcher)
    await h.launcher.analyze(request(), 'key-1')
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
    expect(followupMessagesOf(agent).map(message => message.content[0]!.text)).toEqual([request().prompt, '顺便看下内存'])
  })

  it('removes the published route when the first prompt cannot be delivered', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const held = holdSetup(h.launcher)
    await h.launcher.analyze(request(), 'key-1')
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const { handle } = h.ctxState.agents.created[0]!
    vi.mocked(handle.agent.followup).mockImplementationOnce(() => { throw new Error('session closed') })

    held.release()
    await waitUntil(() => expect(h.channel.updated).toHaveLength(1))
    expect(JSON.stringify(h.channel.updated[0]!.card)).toContain('session closed')
    expect(h.routes()).toHaveLength(0)
    expect(handle.dispose).toHaveBeenCalled()
  })

  it('ends an analysis still starting at shutdown on the failure card', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const held = holdSetup(h.launcher)
    await h.launcher.analyze(request(), 'key-1')
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const shutdown = h.service.shutdown()
    held.release()
    await shutdown
    expect(JSON.stringify(h.channel.updated.at(-1)!.card)).toContain('飞书渠道已断开')
    expect(h.routes()).toHaveLength(0)
  })

  it('lets admitted group members, and nobody else, follow up and stop the shared topic', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_bob')
    await h.launcher.analyze(request(), 'key-1')
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const thread = { chatId: 'oc_group', threadId: 'omt_2', mentionedBot: false }

    await h.onMessage(makeMessage({ ...thread, senderId: 'u_carol', content: '我也想问' }))
    await h.onMessage(makeMessage({ ...thread, senderId: 'u_bob', content: '为什么内存溢出？' }))
    await waitUntil(() => expect(followupMessagesOf(agent)).toHaveLength(2))
    expect(followupMessagesOf(agent)[1]!.content[0]!.text).toBe('为什么内存溢出？')

    const cancel = vi.fn()
    ;(agent as unknown as { cancel: unknown }).cancel = cancel
    // The quiet first turn is still the active one: its card is the placeholder.
    const stop = (userId: string): CardActionEvent => ({
      messageId: 'om_1',
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
