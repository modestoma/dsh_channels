/**
 * Log-platform analyze API: wire contract, DSH Web route, and the service
 * flow from an accepted request to a group-shared topic.
 */

import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANALYZE_ROUTE, analyzeRequestHash, parseAnalyzeRequest,
} from '../src/analyze/contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from '../src/analyze/contract.ts'
import type { AnalyzeLauncher } from '../src/analyze/launcher.ts'
import { mountAnalyzeRoute } from '../src/analyze/server.ts'
import type { AnalyzeHandler } from '../src/analyze/server.ts'
import { buildAnalyzeRootCard } from '../src/cards.ts'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { HostContext } from '../src/dsh-types.ts'
import type { AnalyzeRequestRecord, RouteRecord } from '../src/domain.ts'
import type { CardActionEvent, ChannelFactory, NormalizedMessage } from '../src/feishu-channel.ts'
import { FeishuService } from '../src/service.ts'
import type { SessionManager } from '../src/session/manager.ts'
import { followupMessagesOf, makeChannel, makeHostContext, makeMessage } from './helpers.ts'

const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function request(partial: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    requesterUserId: 'u_alice',
    triggeredAt: '2026-10-22 19:30',
    app: 'camera',
    errorCode: 'E1001',
    logDetails: [{ name: '设备 A 崩溃日志', url: 'https://logs.example/detail/1' }],
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
      triggeredAt: ' ',
      app: '../etc',
      chatId: 'not-a-chat',
      errorCode: '..',
      prompt: '   ',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    for (const field of ['requesterUserId', 'triggeredAt', 'app', 'errorCode', 'chatId', 'prompt']) {
      expect(result.error).toContain(field)
    }
  })

  it('requires one to fifty http(s) detail pages', () => {
    const details = (count: number, url = 'https://logs.example/d') =>
      Array.from({ length: count }, (_, index) => ({ name: `日志 ${index}`, url }))
    expect(parseAnalyzeRequest(request({ logDetails: details(50) })).ok).toBe(true)
    for (const logDetails of [details(0), details(51), details(1, 'javascript:alert(1)'), details(1, 'ftp://logs')]) {
      const result = parseAnalyzeRequest(request({ logDetails }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('logDetails')
    }
  })

  it('hashes the request content, not the object identity', () => {
    expect(analyzeRequestHash(request())).toBe(analyzeRequestHash(request()))
    expect(analyzeRequestHash(request({ prompt: 'other' }))).not.toBe(analyzeRequestHash(request()))
    expect(analyzeRequestHash(request({ triggeredAt: 'other' }))).not.toBe(analyzeRequestHash(request()))
    expect(analyzeRequestHash(request({ logDetails: [{ name: 'other', url: 'https://logs.example/detail/1' }] })))
      .not.toBe(analyzeRequestHash(request()))
  })

  it('renders the root card status and keeps detail links intact', () => {
    const subject = { ...request(), logDetails: [{ name: 'a', url: 'https://logs.example/d (1)' }] }
    const stopped = JSON.stringify(buildAnalyzeRootCard(subject, { kind: 'stopped' }))
    expect(stopped).toContain('[查看](https://logs.example/d%20%281%29)')
    expect(stopped).toContain('已停止')
    expect(stopped).toContain('"template":"grey"')
  })

  it('defaults the switch off, validates the token reference, and ignores the removed listen address', () => {
    expect(resolveConfig({}).analyzeEnabled).toBe(false)
    expect(resolveConfig({ analyzeEnabled: true }).analyzeEnabled).toBe(true)
    expect(resolveConfig({}).analyzeToken).toBe('DSH_CHANNELS_ANALYZE_TOKEN')
    expect(() => resolveConfig({ analyzeToken: 'plain secret' })).toThrow(/analyzeToken/)
    expect(resolveConfig({ analyzeListen: '0.0.0.0:3090' })).not.toHaveProperty('analyzeListen')
  })
})

describe('analyze route', () => {
  type Route = { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }

  /** Mount the route on a fake `webServer` served by a real HTTP server (exact match, else 404). */
  async function serve(handler: Partial<AnalyzeHandler> = {}): Promise<{ url: string; calls: unknown[][]; routes: Route[] }> {
    const calls: unknown[][] = []
    const routes: Route[] = []
    const webServer = { register: (route: Route) => { routes.push(route); return () => {} } }
    const ctx = { get: (name: string) => (name === 'webServer' ? webServer : undefined), effect: (fn: () => unknown) => fn() }
    mountAnalyzeRoute(ctx as unknown as HostContext, {
      enabled: handler.enabled ?? (() => true),
      token: handler.token ?? (async () => 'secret-token'),
      analyze: handler.analyze ?? (async (...args): Promise<AnalyzeResponse> => {
        calls.push(args)
        return { status: 202, body: { ok: true, chatId: 'oc_group', messageId: 'om_1' } }
      }),
    }, vi.fn())
    const server = createServer((req, res) => {
      const route = routes.find(entry => entry.path === new URL(req.url ?? '/', 'http://x').pathname)
      if (route === undefined) {
        res.writeHead(404).end()
        return
      }
      void route.handler(req, res)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push({ close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) })
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, routes }
  }

  const headers = {
    authorization: 'Bearer secret-token',
    'idempotency-key': 'req-1',
    'content-type': 'application/json',
  }

  it('registers one exact route under /open-api, outside the DSH /api namespace', async () => {
    const { routes } = await serve()
    expect(ANALYZE_ROUTE).toBe('/open-api/logalyze')
    expect(routes.map(({ kind, path: routePath }) => ({ kind, path: routePath }))).toEqual([{ kind: 'exact', path: ANALYZE_ROUTE }])
  })

  it('mounts nothing on hosts without a Web server', () => {
    const ctx = { get: () => undefined, effect: vi.fn() }
    mountAnalyzeRoute(ctx as unknown as HostContext, { enabled: () => true, token: async () => 't', analyze: vi.fn() }, vi.fn())
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('passes a valid request to the handler', async () => {
    const { url, calls } = await serve()
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, messageId: 'om_1' })
    expect(calls).toEqual([[request(), 'req-1']])
  })

  it.each([
    ['wrong method', { method: 'GET' }, undefined, 405],
    ['wrong token', { headers: { ...headers, authorization: 'Bearer nope' } }, JSON.stringify(request()), 401],
    ['missing token', { headers: { ...headers, authorization: '' } }, JSON.stringify(request()), 401],
    ['missing key', { headers: { ...headers, 'idempotency-key': '' } }, JSON.stringify(request()), 400],
    ['wrong media type', { headers: { ...headers, 'content-type': 'text/plain' } }, JSON.stringify(request()), 415],
    ['invalid JSON', {}, '{', 400],
    ['invalid body', {}, JSON.stringify({ ...request(), prompt: '' }), 400],
    ['oversized body', {}, JSON.stringify({ ...request(), prompt: 'x'.repeat(1_100_000) }), 413],
  ])('refuses %s', async (_name, init, body, status) => {
    const { url, calls } = await serve()
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, {
      method: 'POST', headers, ...(body === undefined ? {} : { body }), ...init,
    })
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('answers 404 while the switch is off, even with a valid token', async () => {
    const token = vi.fn(async () => 'secret-token')
    const { url, calls } = await serve({ enabled: () => false, token })
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('未开启') })
    expect(token).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('refuses every request while the token is not configured', async () => {
    const { url, calls } = await serve({ token: async () => undefined })
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('answers 500 when the handler throws', async () => {
    const { url } = await serve({ analyze: async () => { throw new Error('boom') } })
    const res = await fetch(`${url}${ANALYZE_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(request()) })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('boom') })
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
    const channel = makeChannel()
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
      record: (key: string) => ctxState.domain.raw.table('analyze_requests').get(key) as AnalyzeRequestRecord | undefined,
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

  /** Card JSON of the latest update of one message. */
  const lastCard = (h: { channel: ReturnType<typeof makeChannel> }, messageId: string): string =>
    JSON.stringify(h.channel.updated.filter(entry => entry.messageId === messageId).at(-1)?.card)

  it('posts the root card, opens a shared topic with a streaming card, and forwards the prompt verbatim', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    const response = await h.launcher.analyze(request(), 'key-1')

    expect(response).toEqual({
      status: 202,
      body: {
        ok: true, chatId: 'oc_group', messageId: 'om_1',
      },
    })
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
    expect(followupMessagesOf(agent).map(message => message.content[0]!.text)).toEqual([request().prompt])
  })

  it('streams the first turn in the topic and marks the root card when it settles', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.launcher.analyze(request(), 'key-1')
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
    await h.launcher.analyze(request(), 'key-1')
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
    await h.launcher.analyze(request(), 'key-done')
    await waitUntil(() => expect(h.routes()).toHaveLength(1))
    const first = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.sessionListeners[0]!(first.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(h.record('key-done')?.status).toBe('done'))
    await h.launcher.analyze(request({ prompt: 'second' }), 'key-open')
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
    const accepted = h.launcher.analyze(request(), 'key-1')
    let shutDown = false
    const shutdown = h.service.shutdown().then(() => { shutDown = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shutDown).toBe(false)
    release()
    await shutdown
    expect(await accepted).toMatchObject({ status: 202 })
    expect(h.record('key-1')).toMatchObject({ messageId: 'om_1' })
  })

  it('refuses requests until the channel start has marked earlier analyses interrupted', async () => {
    const config = makeConfig()
    const ctxState = makeHostContext()
    const service = new FeishuService(ctxState.ctx, config, () => makeChannel())
    const launcher = service.analyzeHandler() as AnalyzeLauncher
    expect(await launcher.analyze(request(), 'key-1')).toMatchObject({ status: 503 })
  })

  it('reads the switch from the live config', async () => {
    const h = await setup()
    expect(h.service.analyzeHandler().enabled()).toBe(false)
    h.service.applyOverlay({ analyzeEnabled: true })
    expect(h.service.analyzeHandler().enabled()).toBe(true)
  })

  it('ends on a failure card without a route when setup fails', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    sessionsOf(h.launcher).mountGuidance = async () => { throw new Error('mount failed') }
    await h.launcher.analyze(request(), 'key-1')
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
    await waitUntil(() => expect(lastCard(h, 'om_1')).toContain('session closed'))
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
    expect(lastCard(h, 'om_1')).toContain('飞书渠道已断开')
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
