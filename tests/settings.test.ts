/**
 * Web settings panel: overlay persistence, Host view-model (surface), HTTP
 * routes, and FeishuService config hot-apply / reconnect integration.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { HostContext } from '../src/dsh-types.ts'
import { FeishuService } from '../src/service.ts'
import { HEALTH_DEPENDENCY_NAMES } from '../src/health.ts'
import type { HealthSnapshot } from '../src/health.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import {
  CONFIG_ROUTE,
  EDITABLE_KEYS,
  PANEL_ROUTE,
  RECONNECT_ROUTE,
  RESTART_KEYS,
  STATUS_ROUTE,
} from '../src/settings/contract.ts'
import type { EditableValues } from '../src/settings/contract.ts'
import {
  OverlayStore,
  defaultOverlayPath,
  mergeOverlay,
  normalizeOverlay,
  parseOverlay,
  pickEditable,
  resolveDshHome,
} from '../src/settings/overlay.ts'
import {
  FIELD_DESCRIPTORS,
  SettingsSurface,
  readOnlyFields,
} from '../src/settings/surface.ts'
import type { SettingsTarget } from '../src/settings/surface.ts'
import { isSameOriginRequest, registerSettingsRoutes } from '../src/settings/routes.ts'
import type { HostWebServer } from '../src/settings/routes.ts'
import { makeChannel, makeHostContext } from './helpers.ts'

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    ...resolveConfig({ appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET' }),
    baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-settings-')),
    ...partial,
  }
}

function tempOverlayFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'dsh-channels-overlay-')), 'settings.json')
}

function healthySnapshot(partial: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    level: 'healthy',
    fibers: { active: 3, pending: 0, loading: 0, failed: 0, unloading: 0 },
    dependencies: Object.fromEntries(HEALTH_DEPENDENCY_NAMES.map(name => [name, true])) as HealthSnapshot['dependencies'],
    connection: { state: 'connected', reconnectAttempts: 0 },
    botOpenIdTail: '…abcd',
    started: true,
    routeCount: 2,
    liveAgentCount: 1,
    inflightTurnCount: 0,
    ...partial,
  }
}

class FakeTarget implements SettingsTarget {
  config: FeishuConfig
  readonly base: FeishuConfig
  running: FeishuConfig | undefined
  runningFlag = true
  restarting = false
  startErrorText: string | undefined
  credentials = { appId: true, appSecret: true }
  applied: Partial<FeishuConfig> | undefined
  restartCalls = 0
  failRestart: string | undefined
  healthState = healthySnapshot()

  constructor(config: FeishuConfig) {
    this.base = { ...config }
    this.config = { ...config }
    this.running = { ...config }
  }

  isRunning(): boolean { return this.runningFlag }
  isRestarting(): boolean { return this.restarting }
  health(): HealthSnapshot { return this.healthState }
  startedAtMs(): number | undefined { return 1_000 }
  uptimeMs(): number | undefined { return this.runningFlag ? 60_000 : undefined }
  startError(): string | undefined { return this.startErrorText }
  configSnapshot(): FeishuConfig { return { ...this.config } }
  baseConfigSnapshot(): FeishuConfig { return { ...this.base } }
  runningConfigSnapshot(): FeishuConfig | undefined {
    return this.running === undefined ? undefined : { ...this.running }
  }

  applyOverlay(overlay: Partial<FeishuConfig>): void {
    this.applied = overlay
    this.config = { ...this.base, ...overlay }
  }

  async restart(): Promise<void> {
    this.restartCalls++
    if (this.failRestart !== undefined) throw new Error(this.failRestart)
    this.running = { ...this.config }
  }

  async credentialStates(): Promise<{ appId: boolean; appSecret: boolean }> {
    return this.credentials
  }
}

function makeSurface(partial: Partial<FeishuConfig> = {}): {
  surface: SettingsSurface
  target: FakeTarget
  store: OverlayStore
  file: string
} {
  const file = tempOverlayFile()
  const target = new FakeTarget(makeConfig(partial))
  const store = new OverlayStore(file)
  return { surface: new SettingsSurface(target, store), target, store, file }
}

describe('overlay paths and validation', () => {
  it('honours DSH_HOME and falls back to ~/.dsh', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/home' } as NodeJS.ProcessEnv)).toBe('/custom/home')
    expect(resolveDshHome({ DSH_HOME: '   ' } as NodeJS.ProcessEnv)).toBe(resolveDshHome({} as NodeJS.ProcessEnv))
    expect(resolveDshHome({} as NodeJS.ProcessEnv).endsWith(path.join(path.sep, '.dsh'))).toBe(true)
    expect(defaultOverlayPath({ DSH_HOME: '/custom/home' } as NodeJS.ProcessEnv))
      .toBe('/custom/home/dsh-channels/settings.json')
  })

  it('validates values with the canonical config schema and strips unknown keys', () => {
    const ok = parseOverlay({ dmMode: 'disabled', refreshMs: 800, provider: '', unknown: 1 })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.patch).toEqual({ dmMode: 'disabled', refreshMs: 800 })

    const bad = parseOverlay({ dmMode: 'never', refreshMs: 10 })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['dmMode', 'refreshMs']))
  })

  it('merges over the profile config and keeps empty optional text out of the overlay', () => {
    const base = makeConfig({ provider: 'deepseek-official' })
    const merged = mergeOverlay(base, normalizeOverlay({ provider: '', dmMode: 'disabled' }))
    expect(merged.provider).toBe('deepseek-official')
    expect(merged.dmMode).toBe('disabled')
    expect(pickEditable(merged).dmMode).toBe('disabled')
  })
})

describe('OverlayStore', () => {
  it('degrades a missing file to an empty overlay', async () => {
    await expect(new OverlayStore(tempOverlayFile()).load()).resolves.toEqual({})
  })

  it('round-trips a saved overlay and clears it', async () => {
    const file = tempOverlayFile()
    const store = new OverlayStore(file)
    await store.save({ requireMention: false, refreshMs: 750 })
    await expect(store.load()).resolves.toEqual({ requireMention: false, refreshMs: 750 })
    await store.clear()
    await expect(store.load()).resolves.toEqual({})
  })

  it('degrades corrupt or schema-invalid files with a warning', async () => {
    const corrupt = tempOverlayFile()
    writeFileSync(corrupt, '{not json')
    const warn = vi.fn()
    await expect(new OverlayStore(corrupt, { warn }).load()).resolves.toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)

    const invalid = tempOverlayFile()
    writeFileSync(invalid, JSON.stringify({ dmMode: 'nope' }))
    await expect(new OverlayStore(invalid).load()).resolves.toEqual({})
  })
})

describe('field descriptors', () => {
  it('describes exactly the editable keys, in order, with the restart flags', () => {
    expect(FIELD_DESCRIPTORS.map(field => field.key)).toEqual([...EDITABLE_KEYS])
    const restart = new Set<string>(RESTART_KEYS)
    for (const field of FIELD_DESCRIPTORS) {
      expect(field.restartRequired).toBe(restart.has(field.key))
      expect(field.label.length).toBeGreaterThan(0)
    }
    expect(new Set(FIELD_DESCRIPTORS.map(field => field.kind)))
      .toEqual(new Set(['boolean', 'number', 'text', 'select']))
  })

  it('renders the read-only advanced facts from the effective config', () => {
    const fields = readOnlyFields(makeConfig({ maxTokens: 4096, routeTtlMs: 0 }))
    const byKey = new Map(fields.map(field => [field.key, field.value]))
    expect(byKey.get('maxTokens')).toBe('4096 tokens')
    expect(byKey.get('routeTtlMs')).toBe('关闭（不过期）')
  })
})

describe('SettingsSurface', () => {
  it('builds the panel with provenance, credentials, and read-only facts', async () => {
    const file = tempOverlayFile()
    const target = new FakeTarget(makeConfig({ provider: 'deepseek-official' }))
    const store = new OverlayStore(file)
    await store.save({ dmMode: 'disabled' })
    target.config = mergeOverlay(target.base, { dmMode: 'disabled' })
    target.running = { ...target.config }
    const surface = new SettingsSurface(target, store)

    const panel = await surface.panel()
    expect(panel.status.running).toBe(true)
    expect(panel.status.connection?.state).toBe('connected')
    expect(panel.status.version.length).toBeGreaterThan(0)
    expect(panel.status.overlayPath).toBe(file)
    expect(panel.config.overriddenKeys).toEqual(['dmMode'])
    expect(panel.config.overlay).toEqual({ dmMode: 'disabled' })
    expect(panel.config.effective.dmMode).toBe('disabled')
    expect(panel.config.base.dmMode).toBe('open')
    expect(panel.config.credentials.appId).toEqual({ ref: 'FEISHU_APP_ID', configured: true })
    expect(panel.config.fields).toHaveLength(EDITABLE_KEYS.length)
    expect(panel.config.restartPendingKeys).toEqual([])
  })

  it('reports restart-pending keys when the live connection predates the edit', async () => {
    const target = new FakeTarget(makeConfig({ refreshMs: 500 }))
    target.config = { ...target.base, refreshMs: 900 }
    target.running = { ...target.base }
    const store = new OverlayStore(tempOverlayFile())
    await store.save({ refreshMs: 900 })
    const panel = await new SettingsSurface(target, store).panel()
    expect(panel.config.restartPendingKeys).toEqual(['refreshMs'])
  })

  it('saves validated values, applies them live, and persists the overlay', async () => {
    const { surface, target, store } = makeSurface()
    const result = await surface.save({ requireMention: false, maxImagesPerMessage: 2, provider: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.clearedKeys).toEqual(['provider'])
    await expect(store.load()).resolves.toEqual({ requireMention: false, maxImagesPerMessage: 2 })
    expect(target.applied).toEqual({ requireMention: false, maxImagesPerMessage: 2 })
    expect(result.panel.config.overriddenKeys).toEqual(['requireMention', 'maxImagesPerMessage'])
  })

  it('rejects unknown keys and invalid values with per-field issues', async () => {
    const { surface, store } = makeSurface()
    const unknown = await surface.save({ nope: true } as unknown as EditableValues)
    expect(unknown.ok).toBe(false)

    const invalid = await surface.save({ dmMode: 'nope', refreshMs: 20 } as unknown as EditableValues)
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues?.map(issue => issue.key)).toEqual(expect.arrayContaining(['dmMode', 'refreshMs']))
    await expect(store.load()).resolves.toEqual({})
  })

  it('clears every override and falls back to the profile config', async () => {
    const { surface, target, store } = makeSurface()
    await store.save({ dmMode: 'disabled' })
    target.config = mergeOverlay(target.base, { dmMode: 'disabled' })
    const result = await surface.clear()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.panel.config.overriddenKeys).toEqual([])
    expect(target.applied).toEqual({})
    await expect(store.load()).resolves.toEqual({})
  })

  it('surfaces reconnect failures', async () => {
    const { surface, target } = makeSurface()
    target.failRestart = 'connect ECONNREFUSED'
    const failure = await surface.reconnect()
    expect(failure.ok).toBe(false)
    if (failure.ok) return
    expect(failure.error).toContain('ECONNREFUSED')

    target.failRestart = undefined
    const success = await surface.reconnect()
    expect(success.ok).toBe(true)
    expect(target.restartCalls).toBe(2)
  })
})

interface CapturedResponse {
  status: number
  headers: Record<string, unknown>
  body: string
}

function makeRequest(options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
} = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  const stream = Readable.from(chunks)
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage
}

function makeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      res.headersSent = true
      return res
    },
    setHeader() {},
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) captured.body += String(chunk)
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function call(routes: Map<string, RouteHandler>, route: string, req: IncomingMessage): Promise<CapturedResponse> {
  const handler = routes.get(route)
  if (handler === undefined) throw new Error(`route not registered: ${route}`)
  const { res, captured } = makeResponse()
  await handler(req, res)
  return captured
}

function makeWebServer(): { server: HostWebServer; routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>()
  const server: HostWebServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  return { server, routes }
}

describe('settings routes', () => {
  it('recognises same-origin and cross-origin mutations', () => {
    expect(isSameOriginRequest(makeRequest())).toBe(true)
    expect(isSameOriginRequest(makeRequest({
      headers: { origin: 'http://127.0.0.1:52555', host: '127.0.0.1:52555' },
    }))).toBe(true)
    expect(isSameOriginRequest(makeRequest({
      headers: { origin: 'https://evil.example', host: '127.0.0.1:52555' },
    }))).toBe(false)
    expect(isSameOriginRequest(makeRequest({
      headers: { origin: 'null', host: '127.0.0.1:52555' },
    }))).toBe(false)
  })

  it('serves status and panel, and rejects other methods with 405', async () => {
    const { surface } = makeSurface()
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const status = await call(routes, STATUS_ROUTE, makeRequest())
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body).running).toBe(true)

    const panel = await call(routes, PANEL_ROUTE, makeRequest())
    expect(panel.status).toBe(200)
    expect(JSON.parse(panel.body).config.fields).toHaveLength(EDITABLE_KEYS.length)

    const notAllowed = await call(routes, STATUS_ROUTE, makeRequest({ method: 'POST' }))
    expect(notAllowed.status).toBe(405)
    expect(notAllowed.headers.allow).toBe('GET, HEAD')
  })

  it('writes config via PUT and enforces same-origin + JSON', async () => {
    const { surface, store } = makeSurface()
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const crossSite = await call(routes, CONFIG_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:52555' },
      body: JSON.stringify({ values: { dmMode: 'disabled' } }),
    }))
    expect(crossSite.status).toBe(403)

    const wrongType = await call(routes, CONFIG_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'text/plain', host: '127.0.0.1:52555' },
      body: JSON.stringify({ values: { dmMode: 'disabled' } }),
    }))
    expect(wrongType.status).toBe(415)

    const ok = await call(routes, CONFIG_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:52555' },
      body: JSON.stringify({ values: { dmMode: 'disabled' } }),
    }))
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).ok).toBe(true)
    await expect(store.load()).resolves.toEqual({ dmMode: 'disabled' })

    const invalid = await call(routes, CONFIG_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:52555' },
      body: JSON.stringify({ values: { refreshMs: 1 } }),
    }))
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body).issues[0].key).toBe('refreshMs')
  })

  it('clears overrides via DELETE and reconnects via POST', async () => {
    const { surface, store, target } = makeSurface()
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)
    await store.save({ dmMode: 'disabled' })

    const cleared = await call(routes, CONFIG_ROUTE, makeRequest({ method: 'DELETE', headers: { host: 'h' } }))
    expect(cleared.status).toBe(200)
    await expect(store.load()).resolves.toEqual({})

    const reconnected = await call(routes, RECONNECT_ROUTE, makeRequest({ method: 'POST', headers: { host: 'h' } }))
    expect(reconnected.status).toBe(200)
    expect(target.restartCalls).toBe(1)

    target.failRestart = 'still down'
    const failed = await call(routes, RECONNECT_ROUTE, makeRequest({ method: 'POST', headers: { host: 'h' } }))
    expect(failed.status).toBe(500)
  })
})

describe('apply() web wiring', () => {
  it('mounts the panel routes through an optional webServer and boots the channel', async () => {
    const { apply } = await import('../src/index.ts')
    const { ctx: base } = makeHostContext()
    const { server, routes } = makeWebServer()
    const cleanups: Array<() => void | Promise<void>> = []
    const effect = (callback: () => void | (() => void | Promise<void>)): void => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    const childCtx = {
      ...base,
      effect,
      get: (name: string) => (name === 'webServer' ? server : base.get?.(name)),
    }
    const ctx = {
      ...base,
      effect,
      inject: (_dependencies: string[], callback: (child: HostContext) => void) => callback(childCtx as unknown as HostContext),
    } as unknown as HostContext

    const channel = makeChannel()
    apply(ctx, {
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      settingsFile: tempOverlayFile(),
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-apply-')),
      channelFactory: () => channel,
    })

    expect(routes.has(PANEL_ROUTE)).toBe(true)
    expect(routes.has(STATUS_ROUTE)).toBe(true)
    expect(routes.has(CONFIG_ROUTE)).toBe(true)
    expect(routes.has(RECONNECT_ROUTE)).toBe(true)

    const panel = await call(routes, PANEL_ROUTE, makeRequest())
    expect(panel.status).toBe(200)
    expect(JSON.parse(panel.body).config.fields).toHaveLength(EDITABLE_KEYS.length)

    await vi.waitFor(async () => {
      const status = await call(routes, STATUS_ROUTE, makeRequest())
      expect(JSON.parse(status.body).running).toBe(true)
    })

    const saved = await call(routes, CONFIG_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { requireMention: false } }),
    }))
    expect(saved.status).toBe(200)

    for (const cleanup of cleanups.reverse()) await cleanup()
  })
})

describe('FeishuService settings integration', () => {  function harness(overlay: Record<string, unknown> = {}): {
    ctx: HostContext
    channel: FeishuChannel
    config: FeishuConfig
    store: OverlayStore
    file: string
  } {
    const file = tempOverlayFile()
    if (Object.keys(overlay).length > 0) writeFileSync(file, JSON.stringify(overlay))
    return {
      ctx: makeHostContext().ctx,
      channel: makeChannel(),
      config: makeConfig(),
      store: new OverlayStore(file),
      file,
    }
  }

  it('boot applies the Web overlay before connecting and snapshots the running config', async () => {
    const h = harness({ requireMention: false, refreshMs: 900 })
    const calls: Array<Record<string, unknown>> = []
    const service = new FeishuService(h.ctx, h.config, options => {
      calls.push(options as unknown as Record<string, unknown>)
      return h.channel
    }, undefined, h.store)

    await service.boot()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.requireMention).toBe(false)
    expect(service.configSnapshot().refreshMs).toBe(900)
    expect(service.runningConfigSnapshot()?.refreshMs).toBe(900)
    expect(service.isRunning()).toBe(true)
    expect(service.startError()).toBeUndefined()
    expect(service.health().level).toBe('degraded') // fake channel exposes no connection status

    expect(await service.credentialStates()).toEqual({ appId: true, appSecret: true })
    await service.shutdown()
  })

  it('restart re-reads the overlay and reconnects with the new values', async () => {
    const h = harness({ dmMode: 'disabled' })
    const calls: Array<Record<string, unknown>> = []
    const service = new FeishuService(h.ctx, h.config, options => {
      calls.push(options as unknown as Record<string, unknown>)
      return h.channel
    }, undefined, h.store)
    await service.boot()
    expect(calls[0]?.dmMode).toBe('disabled')

    writeFileSync(h.file, JSON.stringify({ dmMode: 'open', loggerLevel: 'warn' }))
    await service.restart()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.dmMode).toBe('open')
    await service.shutdown()
  })

  it('leaves the service stopped when a reconnect fails mid-start', async () => {
    const h = harness()
    const failing = Object.assign(makeChannel(), {
      connect: vi.fn(async () => { throw new Error('handshake refused') }),
    })
    let calls = 0
    const service = new FeishuService(h.ctx, h.config, () => {
      calls++
      return calls === 1 ? h.channel : failing
    }, undefined, h.store)
    await service.boot()
    expect(service.isRunning()).toBe(true)
    await expect(service.restart()).rejects.toThrow('handshake refused')
    expect(service.isRunning()).toBe(false)
    expect(service.startError()).toContain('handshake refused')
    expect(service.runningConfigSnapshot()).toBeUndefined()
  })

  it('records a failed boot for the panel and reports not running', async () => {    const h = harness()
    const failing = Object.assign(makeChannel(), {
      connect: vi.fn(async () => { throw new Error('ws handshake failed') }),
    })
    const service = new FeishuService(h.ctx, h.config, () => failing, undefined, h.store)
    await expect(service.boot()).rejects.toThrow('ws handshake failed')
    expect(service.isRunning()).toBe(false)
    expect(service.startError()).toContain('ws handshake failed')

    const panel = await new SettingsSurface(service, h.store).panel()
    expect(panel.status.running).toBe(false)
    expect(panel.status.lastStartError).toContain('ws handshake failed')
  })

  it('applies a validated overlay live, and a later apply starts from the profile base', async () => {
    const h = harness()
    const config = { ...h.config, provider: 'deepseek-official' }
    const service = new FeishuService(h.ctx, config, () => h.channel, undefined, h.store)
    await service.boot()
    service.applyOverlay({ requireMention: false, provider: 'other-provider' })
    expect(service.configSnapshot().requireMention).toBe(false)
    expect(service.configSnapshot().provider).toBe('other-provider')
    service.applyOverlay({})
    expect(service.configSnapshot().requireMention).toBe(true)
    expect(service.configSnapshot().provider).toBe('deepseek-official')
    await service.shutdown()
  })
})
