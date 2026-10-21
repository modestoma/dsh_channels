/**
 * `feishu_attachment_fetch` runtime tests: tool registration, the per-route
 * authorization whitelist, image/file results, limits/cancellation, and merged
 * forward resources.
 *
 * The stubs mirror the real seams: a fake `ctx.attachments`, a fake
 * `ctx.tools` registry and a Feishu channel whose resource/message reads are
 * scripted per test.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { RouteRecord } from '../src/domain.ts'
import type {
  AdmittedPromptContentPart, AttachmentAdmissionPart, AttachmentStore, FileAttachmentRef,
  ImageAttachmentRef, ImageAttachmentLimits,
} from '../src/host/attachments.ts'
import type { AgentContext, ToolDefinition, ToolRuntime } from '../src/host/agent.ts'
import type { FeishuChannel, RawMessageListParams } from '../src/feishu-channel.ts'
import {
  ATTACHMENT_FETCH_TOOL_NAME,
  AttachmentFetchToolRuntime,
  RouteAttachmentWhitelist,
  TOPIC_MESSAGES_TOOL_NAME,
  TopicMessagesToolRuntime,
  attachmentFetchArgsSchema,
  attachmentFetchFailureReason,
  presentAttachmentFetchResult,
  renderAttachmentFetchResult,
  renderTopicMessagesResult,
  topicMessagesArgsSchema,
  type AttachmentFetchRoute,
  type AttachmentFetchValue,
  type KnownAttachmentResource,
  type TopicMessagesValue,
} from '../src/feishu/tools.ts'
import { SessionManager } from '../src/session/manager.ts'
import type { SessionId } from '../src/dsh-types.ts'
import {
  makeAgent, makeAgentContext, makeAgentPresets, makeChannel, makeHostContext, makeMessage,
  makeMessageGetResponse, makeMessageListResponse, makeRawMessage, makeSession,
} from './helpers.ts'

// ---- Shared fakes -------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Valid PNG-prefixed bytes of `size` bytes (the store only sniffs the header). */
function pngBytes(size = 16): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, PNG_SIGNATURE.length))
  bytes.set(PNG_SIGNATURE, 0)
  return bytes
}

function fileBytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function streamOf(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface FakeStore extends AttachmentStore {
  readonly images: ImageAttachmentRef[]
  readonly files: Array<{ ref: FileAttachmentRef; bytes: Uint8Array }>
  readonly aborted: { count: number }
}

interface FakeStoreOptions {
  imageLimits?: ImageAttachmentLimits
  fileHostPath?: (ref: FileAttachmentRef) => string | undefined
  imageHostPath?: (ref: ImageAttachmentRef) => string | undefined
}

function makeAttachmentStore(options: FakeStoreOptions = {}): FakeStore {
  const images: ImageAttachmentRef[] = []
  const files: Array<{ ref: FileAttachmentRef; bytes: Uint8Array }> = []
  const aborted = { count: 0 }
  const store: FakeStore = {
    images,
    files,
    aborted,
    imageLimits: options.imageLimits ?? {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 10 * 1024 * 1024,
      maxImagePixels: 100_000_000,
      maxImageDimension: 10_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImage(input) {
      const ref: ImageAttachmentRef = {
        attachmentId: `sha256:${digest(input.data)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 640,
        height: 480,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
      images.push(ref)
      return ref
    },
    async saveFileStream(input) {
      const chunks: Uint8Array[] = []
      const abortedSignal = () => aborted.count > 0
      const onAbort = (): void => { aborted.count += 1 }
      if (input.signal?.aborted === true) {
        aborted.count += 1
        throw abortError()
      }
      input.signal?.addEventListener('abort', onAbort)
      try {
        for await (const chunk of input.data) {
          if (abortedSignal()) throw abortError()
          chunks.push(chunk)
        }
        if (abortedSignal()) throw abortError()
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const ref: FileAttachmentRef = {
        attachmentId: `sha256:${digest(bytes)}`,
        name: input.name ?? 'file.bin',
        bytes: bytes.byteLength,
      }
      files.push({ ref, bytes })
      return ref
    },
    fileHostPath: options.fileHostPath
      ?? (ref => `/host/attachments/files/${ref.attachmentId}.bin`),
    imageHostPath: options.imageHostPath
      ?? (ref => `/host/attachments/images/${ref.attachmentId}`),
    async admitPromptContent(parts: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]> {
      return parts as unknown as AdmittedPromptContentPart[]
    },
  }
  return store
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

type DownloadHandler = (
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>

interface TestChannel extends FeishuChannel {
  readonly downloaded: Array<{ messageId: string; fileKey: string; type: 'image' | 'file' }>
  messageGet: (messageId: string) => Promise<unknown>
}

function makeTestChannel(handlers: {
  download?: DownloadHandler
  messageGet?: (messageId: string) => Promise<unknown>
  messageMget?: (messageIds: readonly string[]) => Promise<unknown>
  messageList?: (params: RawMessageListParams) => Promise<unknown>
} = {}): TestChannel {
  const base = makeChannel()
  const channel = base as unknown as TestChannel
  const downloaded: Array<{ messageId: string; fileKey: string; type: 'image' | 'file' }> = []
  Object.assign(channel, { downloaded })
  channel.downloadResource = async (messageId, fileKey, type) => {
    downloaded.push({ messageId, fileKey, type })
    if (handlers.download !== undefined) return await handlers.download(messageId, fileKey, type)
    return type === 'image' ? streamOf([pngBytes()]) : streamOf([fileBytes(1, 2, 3)])
  }
  channel.messageGet = async (messageId: string) => {
    if (handlers.messageGet === undefined) throw new Error('unexpected message.get')
    return await handlers.messageGet(messageId)
  }
  if (handlers.messageMget !== undefined) {
    channel.messageMget = async (messageIds: readonly string[]) =>
      await handlers.messageMget?.(messageIds)
  }
  if (handlers.messageList !== undefined) {
    channel.messageList = async (params: RawMessageListParams) => await handlers.messageList?.(params)
  }
  return channel
}

function makeConfig(
  overrides: Omit<Partial<FeishuConfig>, 'feishuTools'> = {},
  tools: Partial<FeishuConfig['feishuTools']> = {},
): FeishuConfig {
  const base = resolveConfig({})
  return { ...base, ...overrides, feishuTools: { ...base.feishuTools, ...tools } }
}

const DEFAULT_ROUTE: AttachmentFetchRoute = {
  key: 'omt_thread_1',
  kind: 'thread',
  chatId: 'oc_chat',
  chatType: 'group',
  senderUserId: 'u_user',
}

interface RuntimeHarness {
  runtime: AttachmentFetchToolRuntime
  topic: TopicMessagesToolRuntime
  ctx: AgentContext
  definitions: Map<string, ToolDefinition>
  register: ReturnType<typeof vi.fn>
  route: AttachmentFetchRoute
  config: FeishuConfig
  channel: TestChannel
  store: FakeStore
  warn: ReturnType<typeof vi.fn>
  mount(): Promise<ToolDefinition>
  definition(): ToolDefinition
  mountTopic(): Promise<ToolDefinition>
  topicDefinition(): ToolDefinition
}

interface SetupOptions {
  /** `null` simulates a disconnected channel (deps return undefined). */
  channel?: TestChannel | null
  store?: FakeStore
  config?: FeishuConfig
  route?: AttachmentFetchRoute
  sessionId?: string
  /** Simulate a session that has no durable route binding (unbound agent). */
  unbound?: boolean
  includeTools?: boolean
  includeAttachments?: boolean
  /** Whether the deployment offers `feishu_attachment_fetch` (topic tool hint). */
  fetchAvailable?: () => boolean
}

function setupRuntime(options: SetupOptions = {}): RuntimeHarness {
  const config = options.config ?? makeConfig()
  const configuredChannel = options.channel === undefined ? makeTestChannel() : options.channel
  const channel = configuredChannel ?? makeTestChannel()
  const store = options.store ?? makeAttachmentStore()
  const route = options.route ?? DEFAULT_ROUTE
  const sessionId = options.sessionId ?? 'session-tools'
  const warn = vi.fn()
  const ctx = makeAgentContext()
  const definitions = new Map<string, ToolDefinition>()
  const register = vi.fn((definition: ToolDefinition) => {
    definitions.set(definition.name, definition)
    return () => { definitions.delete(definition.name) }
  })
  if (options.includeTools !== false) ctx.tools = { register } as unknown as ToolRuntime
  if (options.includeAttachments !== false) ctx.attachments = store
  const runtime = new AttachmentFetchToolRuntime({
    config: () => config,
    channel: () => configuredChannel ?? undefined,
    routeOfSession: id => (options.unbound === true || id !== sessionId ? undefined : route),
    warn,
    now: () => 1_700_000_000_000,
  })
  // The topic-messages runtime shares the fetch runtime's whitelist, exactly as
  // the service wires it (AC5: a message discovered by the tool is fetchable).
  const topic = new TopicMessagesToolRuntime({
    config: () => config,
    channel: () => configuredChannel ?? undefined,
    routeOfSession: id => (options.unbound === true || id !== sessionId ? undefined : route),
    noteKnownMessage: (knownRoute, message, source) =>
      runtime.noteKnownMessage(knownRoute, message, source),
    isKnownMessage: (knownRoute, messageId) => runtime.isKnownMessage(knownRoute, messageId),
    ...(options.fetchAvailable === undefined ? {} : { fetchAvailable: options.fetchAvailable }),
    warn,
  })
  const definition = (): ToolDefinition => {
    const found = definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    if (found === undefined) throw new Error('tool was not mounted')
    return found
  }
  const topicDefinition = (): ToolDefinition => {
    const found = definitions.get(TOPIC_MESSAGES_TOOL_NAME)
    if (found === undefined) throw new Error('topic tool was not mounted')
    return found
  }
  return {
    runtime, topic, ctx, definitions, register, route, config, channel, store, warn,
    definition,
    async mount(): Promise<ToolDefinition> {
      await runtime.mount(ctx, sessionId)
      return definition()
    },
    async mountTopic(): Promise<ToolDefinition> {
      await topic.mount(ctx, sessionId)
      return topicDefinition()
    },
    topicDefinition,
  }
}

function knownFile(
  harness: RuntimeHarness,
  options: {
    messageId?: string
    fileKey?: string
    fileName?: string
    kind?: 'message' | 'merge_forward'
    resources?: readonly KnownAttachmentResource[]
    route?: AttachmentFetchRoute
    source?: 'trigger' | 'quote' | 'manual'
  } = {},
): string {
  const messageId = options.messageId ?? 'om_known'
  harness.runtime.noteKnownMessage(
    options.route ?? harness.route,
    {
      messageId,
      kind: options.kind ?? 'message',
      resources: options.resources ?? [{
        type: 'file',
        fileKey: options.fileKey ?? 'file_key_1',
        fileName: options.fileName ?? 'report.pdf',
      }],
    },
    options.source ?? 'trigger',
  )
  return messageId
}

async function runTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AttachmentFetchValue> {
  const value = await definition.execute(args, { signal: signal ?? new AbortController().signal })
  return value as AttachmentFetchValue
}

async function runTopicTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TopicMessagesValue> {
  const value = await definition.execute(args, { signal: signal ?? new AbortController().signal })
  return value as TopicMessagesValue
}

/** Assert a tool value is lossless JSON (P0 lesson: no `undefined`). */
function expectLosslessJson(value: unknown): void {
  const seen = new WeakSet<object>()
  const walk = (candidate: unknown, path: string): void => {
    if (candidate === undefined) throw new Error(`${path} is undefined (not lossless JSON)`)
    if (typeof candidate === 'function' || typeof candidate === 'symbol' || typeof candidate === 'bigint') {
      throw new Error(`${path} has non-JSON type ${typeof candidate}`)
    }
    if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
      throw new Error(`${path} is not a finite number`)
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (typeof candidate === 'object' && candidate !== null) {
      if (seen.has(candidate)) throw new Error(`${path} is circular`)
      seen.add(candidate)
      for (const [key, entry] of Object.entries(candidate)) walk(entry, `${path}.${key}`)
    }
  }
  walk(value, 'value')
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

// ---- AC1: registration ------------------------------------------------

describe('feishu attachment-fetch registration', () => {
  it('registers the model-facing tool after the tools/attachments injection', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()

    expect(harness.register).toHaveBeenCalledTimes(1)
    expect(definition.name).toBe(ATTACHMENT_FETCH_TOOL_NAME)
    expect(definition.description).toContain('Feishu')
    expect(definition.description).toContain('file_key')
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['message_id'],
    })
    expect(definition.output.schema).toMatchObject({
      type: 'object',
      required: ['message_id', 'ok', 'summary', 'results'],
    })
    expect(definition.isConcurrencySafe?.()).toBe(false)
    expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(definition.parameters)

    // Mounting the same scope twice must not register a duplicate row.
    await harness.runtime.mount(harness.ctx, 'session-tools')
    expect(harness.register).toHaveBeenCalledTimes(1)
  })

  it('warns once and skips registration when the tools service is missing', async () => {
    const first = setupRuntime({ includeTools: false })
    await first.mount().catch(() => undefined)
    expect(first.definitions.size).toBe(0)
    expect(first.warn).toHaveBeenCalledTimes(1)
    expect(String(first.warn.mock.calls[0]?.[0])).toContain('tools')

    const second = setupRuntime({ includeTools: false })
    await second.runtime.mount(second.ctx, 'session-tools')
    // The warning is runtime-scoped; a second scope of the same runtime reuses it.
    // (A second runtime would warn again — one warning per runtime instance.)
    expect(second.warn).toHaveBeenCalledTimes(1)
    expect(second.definitions.size).toBe(0)
  })

  it('warns once and skips registration when the attachments service is missing', async () => {
    const harness = setupRuntime({ includeAttachments: false })
    await harness.mount().catch(() => undefined)
    expect(harness.definitions.size).toBe(0)
    expect(harness.register).not.toHaveBeenCalled()
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('attachments')
  })

  it('does not inject or register when the feature switch is off', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetch: false }) })
    const inject = vi.spyOn(harness.ctx, 'inject')
    await harness.runtime.mount(harness.ctx, 'session-tools')
    expect(inject).not.toHaveBeenCalled()
    expect(harness.definitions.size).toBe(0)
  })

  it('reports a readable failure when the switch is turned off after registration', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)
    const config = harness.config as FeishuConfig & { feishuTools: FeishuConfig['feishuTools'] }
    config.feishuTools = { ...config.feishuTools, attachmentFetch: false }

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('已禁用')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('warns once when real cordis settles an injection without calling back', async () => {
    // Real cordis behavior when a required dependency never appears: the
    // injection fiber settles without ever invoking the callback.
    const harness = setupRuntime()
    vi.spyOn(harness.ctx, 'inject').mockImplementation((() => Promise.resolve()) as typeof harness.ctx.inject)
    await harness.runtime.mount(harness.ctx, 'session-tools')
    expect(harness.definitions.size).toBe(0)
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('不可用')

    // A second scope without the services reuses the one-time warning.
    const second = makeAgentContext()
    vi.spyOn(second, 'inject').mockImplementation((() => Promise.resolve()) as typeof second.inject)
    await harness.runtime.mount(second, 'session-tools')
    expect(harness.warn).toHaveBeenCalledTimes(1)
  })

  it('dedupes the mount attempt on the outer agent scope even with a different callback context', async () => {
    const harness = setupRuntime()
    const callbackCtx = makeAgentContext()
    callbackCtx.tools = { register: harness.register } as unknown as ToolRuntime
    callbackCtx.attachments = harness.store
    const inject = vi.spyOn(harness.ctx, 'inject').mockImplementation((((
      _deps: readonly string[],
      callback: (ctx: AgentContext) => void,
    ) => {
      callback(callbackCtx)
      return Promise.resolve()
    }) as typeof harness.ctx.inject))

    await harness.runtime.mount(harness.ctx, 'session-tools')
    await harness.runtime.mount(harness.ctx, 'session-tools')
    // The outer-scope WeakMap must prevent a second injection altogether.
    expect(inject).toHaveBeenCalledTimes(1)
    expect(harness.register).toHaveBeenCalledTimes(1)
    expect(harness.definitions.size).toBe(1)
  })

  it('re-registers the tool after the host service reloads the injection', async () => {
    const harness = setupRuntime()
    const callbackCtx = makeAgentContext()
    let active = 0
    const disposers: Array<() => void> = []
    const register = vi.fn(() => {
      active += 1
      const dispose = (): void => { active -= 1 }
      disposers.push(dispose)
      return dispose
    })
    callbackCtx.tools = { register } as unknown as ToolRuntime
    callbackCtx.attachments = harness.store
    let callback: ((ctx: AgentContext) => void) | undefined
    vi.spyOn(harness.ctx, 'inject').mockImplementation((((
      _deps: readonly string[],
      cb: (ctx: AgentContext) => void,
    ) => {
      callback = cb
      cb(callbackCtx)
      return Promise.resolve()
    }) as typeof harness.ctx.inject))

    await harness.runtime.mount(harness.ctx, 'session-tools')
    expect(active).toBe(1)
    // Cordis unloads the injection fiber (service remount): its effects are
    // disposed and the SAME callback context is invoked again.
    disposers[0]?.()
    expect(active).toBe(0)
    callback?.(callbackCtx)
    expect(active).toBe(1)
    expect(register).toHaveBeenCalledTimes(2)
  })

  it('logs one warning and keeps the session alive when the injection fails', async () => {
    const harness = setupRuntime()
    vi.spyOn(harness.ctx, 'inject').mockRejectedValueOnce(new Error('no such service'))
    await expect(harness.runtime.mount(harness.ctx, 'session-tools')).resolves.toBeUndefined()
    expect(harness.definitions.size).toBe(0)
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('mounting')
  })

  it('does not block session creation when the host services never appear in time', async () => {
    vi.useFakeTimers()
    try {
      const harness = setupRuntime()
      let release!: () => void
      const injection = new Promise<void>((resolve) => { release = resolve })
      let callback: ((ctx: AgentContext) => void) | undefined
      vi.spyOn(harness.ctx, 'inject').mockImplementation(((_deps: readonly string[], cb: (ctx: AgentContext) => void) => {
        callback = cb
        return injection as unknown as PromiseLike<unknown>
      }) as typeof harness.ctx.inject)

      const mounting = harness.runtime.mount(harness.ctx, 'session-tools')
      await vi.advanceTimersByTimeAsync(2_100)
      await mounting
      expect(harness.definitions.size).toBe(0)
      expect(harness.warn).toHaveBeenCalledTimes(1)
      expect(String(harness.warn.mock.calls[0]?.[0])).toContain('不可用')

      // The services mount later: the pending injection still registers the tool.
      callback?.(harness.ctx)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.definitions.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mounts after the preset setup and threads the session id', async () => {
    const presets = makeAgentPresets()
    const ctxState = makeHostContext(undefined, presets)
    const order: string[] = []
    presets.mount.mockImplementation(async (agentCtx: AgentContext, id?: string) => {
      order.push('preset')
      return { id: id ?? presets.defaultId, path: '/presets/standard' }
    })
    const mountTools = vi.fn(async (agentCtx: AgentContext, sessionId: string) => {
      expect(agentCtx).toBeDefined()
      expect(sessionId).toBe('session-create')
      order.push('tools')
    })
    const manager = new SessionManager({
      ctx: ctxState.ctx,
      config: resolveConfig({}),
      persistRoute: async () => {},
      started: () => true,
      detachStream: () => {},
      mountTools,
      warn: vi.fn(),
    })

    await manager.createSession('session-create' as SessionId, '/tmp/ws')

    expect(order).toEqual(['preset', 'tools'])
    expect(mountTools).toHaveBeenCalledTimes(1)
  })

  it('mounts on cold resume and backfills a borrowed live agent once', async () => {
    const presets = makeAgentPresets()
    const ctxState = makeHostContext(undefined, presets)
    const mountTools = vi.fn(async () => {})
    const manager = new SessionManager({
      ctx: ctxState.ctx,
      config: resolveConfig({}),
      persistRoute: async () => {},
      started: () => true,
      detachStream: () => {},
      mountTools,
      warn: vi.fn(),
    })
    const record: RouteRecord = {
      key: 'omt_thread_1',
      kind: 'thread',
      sessionId: 'session-resume',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_user',
      workspacePath: '/tmp/ws',
      cardMessageId: 'om_card',
      createdAt: 1,
      lastActivityAt: 1,
    }

    await manager.ensureLive(record)
    expect(mountTools).toHaveBeenCalledWith(expect.anything(), 'session-resume')

    // A second ensureLive is served from the plugin's own live registry.
    await manager.ensureLive(record)
    expect(mountTools).toHaveBeenCalledTimes(1)

    // A foreign live agent (web UI / previous instance) is borrowed and gets
    // exactly one best-effort tool backfill.
    const borrowState = makeHostContext(undefined, makeAgentPresets())
    const borrowMount = vi.fn(async () => {})
    const borrowManager = new SessionManager({
      ctx: borrowState.ctx,
      config: resolveConfig({}),
      persistRoute: async () => {},
      started: () => true,
      detachStream: () => {},
      mountTools: borrowMount,
      warn: vi.fn(),
    })
    const foreign = makeAgent(makeSession('session-foreign' as SessionId))
    borrowState.agents.liveAgents.set('session-foreign', { agent: foreign, dispose: async () => {} })
    const foreignRecord: RouteRecord = { ...record, sessionId: 'session-foreign' }
    const live = await borrowManager.ensureLive(foreignRecord)
    expect(live.agent).toBe(foreign)
    expect(borrowMount).toHaveBeenCalledWith(foreign.ctx, 'session-foreign')
    await borrowManager.ensureLive(foreignRecord)
    expect(borrowMount).toHaveBeenCalledTimes(1)
  })

  it('keeps session creation alive when tool mounting fails', async () => {
    const presets = makeAgentPresets()
    const ctxState = makeHostContext(undefined, presets)
    const warn = vi.fn()
    const manager = new SessionManager({
      ctx: ctxState.ctx,
      config: resolveConfig({}),
      persistRoute: async () => {},
      started: () => true,
      detachStream: () => {},
      mountTools: async () => { throw new Error('tool service exploded') },
      warn,
    })

    await expect(manager.createSession('session-mount-fail' as SessionId, '/tmp/ws')).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(
      'dsh-channels: mounting channel tools for session %s failed: %s',
      'session-mount-fail',
      expect.stringContaining('tool service exploded'),
    )
  })
})

// ---- AC2: authorization whitelist -------------------------------------

describe('feishu attachment-fetch authorization', () => {
  it('keeps the whitelist per route and rejects a reused key with another owner', () => {
    const whitelist = new RouteAttachmentWhitelist()
    whitelist.register(DEFAULT_ROUTE, {
      messageId: 'om_1', kind: 'message', resources: [{ type: 'file', fileKey: 'k1' }],
    })
    expect(whitelist.lookup(DEFAULT_ROUTE, 'om_1')?.messageId).toBe('om_1')
    expect(whitelist.lookup({ ...DEFAULT_ROUTE, chatId: 'oc_other' }, 'om_1')).toBeUndefined()
    expect(whitelist.lookup({ ...DEFAULT_ROUTE, senderUserId: 'u_other' }, 'om_1')).toBeUndefined()
    expect(whitelist.lookup({
      key: 'omt_other', kind: 'thread', chatId: 'oc_chat', chatType: 'group', senderUserId: 'u_user',
    }, 'om_1')).toBeUndefined()
    expect(whitelist.size(DEFAULT_ROUTE.key)).toBe(1)
  })

  it('evicts the least recently used known message', () => {
    const whitelist = new RouteAttachmentWhitelist(2)
    const message = (messageId: string) => ({
      messageId, kind: 'message' as const, resources: [{ type: 'file' as const, fileKey: `${messageId}-key` }],
    })
    whitelist.register(DEFAULT_ROUTE, message('om_1'))
    whitelist.register(DEFAULT_ROUTE, message('om_2'))
    // Touch om_1 so om_2 becomes the eviction candidate.
    expect(whitelist.lookup(DEFAULT_ROUTE, 'om_1')).toBeDefined()
    whitelist.register(DEFAULT_ROUTE, message('om_3'))
    expect(whitelist.lookup(DEFAULT_ROUTE, 'om_1')).toBeDefined()
    expect(whitelist.lookup(DEFAULT_ROUTE, 'om_2')).toBeUndefined()
    expect(whitelist.lookup(DEFAULT_ROUTE, 'om_3')).toBeDefined()
  })

  it('drops whitelist buckets for retired routes', () => {
    const harness = setupRuntime()
    knownFile(harness)
    harness.runtime.noteKnownMessage(
      { ...DEFAULT_ROUTE, key: 'omt_other' },
      { messageId: 'om_other', kind: 'message', resources: [] },
      'trigger',
    )
    expect(harness.runtime.whitelist.size()).toBe(2)

    expect(harness.runtime.pruneRoutes(key => key === DEFAULT_ROUTE.key)).toBe(1)
    expect(harness.runtime.whitelist.size()).toBe(1)
    harness.runtime.forgetRoute(DEFAULT_ROUTE.key)
    expect(harness.runtime.whitelist.size()).toBe(0)
    harness.runtime.clear()
  })

  it('fetches a whitelisted message and records it for later turns', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(true)
    expect(value.results[0]?.ok).toBe(true)
    expect(harness.channel.downloaded).toEqual([
      { messageId, fileKey: 'file_key_1', type: 'file' },
    ])
    expectLosslessJson(value)
    // A later turn can fetch the same message again from the whitelist alone.
    const again = await runTool(definition, { message_id: messageId })
    expect(again.ok).toBe(true)
  })

  it('refuses an unknown message id without touching the channel', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()

    const value = await runTool(definition, { message_id: 'om_unknown' })
    expect(value.ok).toBe(false)
    expect(value.results).toEqual([])
    expect(value.summary).toContain('授权范围')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('reports a missing route binding instead of throwing', async () => {
    const harness = setupRuntime({ unbound: true })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('尚未绑定飞书对话')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('refuses a file_key that does not belong to the known message', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId, file_key: 'file_key_other' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('file_key')
    expect(value.summary).toContain('file_key_1')
    expect(harness.channel.downloaded).toEqual([])
  })

  /** Script `message.get` to return one raw message (or fail) and count the calls. */
  function readBack(
    harness: RuntimeHarness,
    message: Parameters<typeof makeRawMessage>[0] | Error,
  ): { calls: string[] } {
    const calls: string[] = []
    harness.channel.messageGet = async (messageId: string) => {
      calls.push(messageId)
      if (message instanceof Error) throw message
      return makeMessageGetResponse([makeRawMessage(message)])
    }
    return { calls }
  }

  const ownerFile = (messageId: string, partial: Parameters<typeof makeRawMessage>[0] = {}) => ({
    message_id: messageId,
    msg_type: 'file',
    chat_id: DEFAULT_ROUTE.chatId,
    thread_id: DEFAULT_ROUTE.key,
    sender_type: 'user',
    sender_id: DEFAULT_ROUTE.senderUserId,
    content: { file_key: `${messageId}_key`, file_name: 'owned.pdf' },
    ...partial,
  })

  it('authorizes the route owner\'s own topic message read back from Feishu and remembers it', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const { calls } = readBack(harness, ownerFile('om_owned'))

    const value = await runTool(definition, { message_id: 'om_owned' })
    expect(value.ok).toBe(true)
    expect(harness.channel.downloaded[0]).toEqual({
      messageId: 'om_owned', fileKey: 'om_owned_key', type: 'file',
    })
    // The resolved message joins the whitelist: a retry needs no second read.
    const retry = await runTool(definition, { message_id: 'om_owned' })
    expect(retry.ok).toBe(true)
    expect(calls).toEqual(['om_owned'])
  })

  it('refuses read-back messages of another sender, topic, chat, or the main timeline, and deleted ones', async () => {
    const cases: Array<Parameters<typeof makeRawMessage>[0]> = [
      ownerFile('om_foreign', { sender_id: 'u_someone_else' }),
      ownerFile('om_foreign', { thread_id: 'omt_other_topic' }),
      // An unregistered main-timeline message never joins a topic route.
      ownerFile('om_foreign', { thread_id: undefined }),
      ownerFile('om_foreign', { chat_id: 'oc_other_chat' }),
      ownerFile('om_foreign', { chat_id: undefined }),
      ownerFile('om_foreign', { deleted: true }),
    ]
    for (const message of cases) {
      const harness = setupRuntime()
      const definition = await harness.mount()
      readBack(harness, message)
      const value = await runTool(definition, { message_id: 'om_foreign' })
      expect(value.ok).toBe(false)
      expect(value.summary).toContain(attachmentFetchFailureReason('AUTHORIZATION_DENIED'))
      expect(harness.channel.downloaded).toEqual([])
    }
  })

  it('fails closed when the read-back fails', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    readBack(harness, new Error('missing scope'))

    const value = await runTool(definition, { message_id: 'om_unreadable' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain(attachmentFetchFailureReason('AUTHORIZATION_DENIED'))
    expect(harness.channel.downloaded).toEqual([])
  })

  it('never reads back a malformed or oversized message id', async () => {
    for (const messageId of ['om_x/../chats?page_size=1', 'not_a_message', `om_${'a'.repeat(200)}`]) {
      const harness = setupRuntime()
      const definition = await harness.mount()
      const { calls } = readBack(harness, ownerFile(messageId))
      const value = await runTool(definition, { message_id: messageId })
      expect(value.ok).toBe(false)
      expect(value.summary).toContain(attachmentFetchFailureReason('AUTHORIZATION_DENIED'))
      expect(calls).toEqual([])
    }
  })

  it('validates the arguments with zod (message_id required, unknown keys rejected)', () => {
    expect(attachmentFetchArgsSchema.safeParse({ message_id: 'om_1' }).success).toBe(true)
    expect(attachmentFetchArgsSchema.safeParse({ file_key: 'k1' }).success).toBe(false)
    expect(attachmentFetchArgsSchema.safeParse({ message_id: 'om_1', extra: 1 }).success).toBe(false)
  })

  it('throws a readable error for invalid arguments instead of a raw object', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    await expect(runTool(definition, { file_key: 'k1' })).rejects.toThrow(/invalid message_id/u)
  })
})

// ---- AC3: image results -----------------------------------------------

describe('feishu attachment-fetch images', () => {
  it('returns an ImageBlock plus text metadata and the read-only path', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [{ type: 'image', fileKey: 'img_key_1', fileName: 'shot.png' }],
    })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(true)
    const item = value.results[0]
    expect(item?.kind).toBe('image')
    expect(item?.bytes).toBeGreaterThanOrEqual(PNG_SIGNATURE.length)
    expect(item?.width).toBe(640)
    expect(item?.height).toBe(480)
    expect(item?.media_type).toBe('image/png')
    expect(item?.read_path).toContain('/host/attachments/images/')
    expect(item?.attachment).toBe(harness.store.images[0])
    expectLosslessJson(value)

    const blocks = definition.output.render({}, value)
    expect(blocks[0]?.type).toBe('text')
    const text = String((blocks[0] as { text?: unknown }).text)
    expect(text).toContain('图片')
    expect(text).toContain('640×480')
    expect(text).toContain('image/png')
    expect(text).toContain('无法查看图片')
    const imageBlock = blocks.find(block => block.type === 'image')
    expect(imageBlock?.attachment).toBe(harness.store.images[0])
  })

  it('reports one unsupported image as a structured failure without failing the call shape', async () => {
    const channel = makeTestChannel({ download: () => streamOf([fileBytes(1, 2, 3, 4)]) })
    const harness = setupRuntime({ channel })
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [{ type: 'image', fileKey: 'img_bad' }],
    })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]).toMatchObject({ ok: false, kind: 'image', code: 'UNSUPPORTED_IMAGE_TYPE' })
    expect(harness.store.images).toEqual([])
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('获取失败')
  })

  it('enforces the host image byte limit before storing', async () => {
    const store = makeAttachmentStore({
      imageLimits: {
        maxImageBytes: 8,
        maxImagesPerMessage: 10,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100_000_000,
        maxImageDimension: 10_000,
        mediaTypes: ['image/png'],
      },
    })
    const channel = makeTestChannel({ download: () => streamOf([pngBytes(16)]) })
    const harness = setupRuntime({ channel, store })
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [{ type: 'image', fileKey: 'img_large' }],
    })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('IMAGE_TOO_LARGE')
    expect(harness.store.images).toEqual([])
  })

  it('enforces the call byte budget for images', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetchMaxBytes: 5 }) })
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [{ type: 'image', fileKey: 'img_budget' }],
    })
    harness.channel.downloadResource = async () => streamOf([pngBytes(16)])

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('BYTES_LIMIT')
    expect(harness.store.images).toEqual([])
  })
})

// ---- AC4: file results -------------------------------------------------

describe('feishu attachment-fetch files', () => {
  it('streams a file into the native library and returns a FileBlock with handle text', async () => {
    const payload = fileBytes(10, 20, 30, 40, 50)
    const channel = makeTestChannel({ download: () => streamOf([payload.subarray(0, 2), payload.subarray(2)]) })
    const harness = setupRuntime({ channel })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { fileKey: 'file_key_report', fileName: 'report.pdf' })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(true)
    const item = value.results[0]
    expect(item?.kind).toBe('file')
    expect(item?.bytes).toBe(payload.byteLength)
    expect(item?.attachment).toBe(harness.store.files[0]?.ref)
    expect(harness.store.files[0]?.ref.name).toBe('report.pdf')
    // Content consistency: the stored bytes are exactly the downloaded bytes.
    expect([...(harness.store.files[0]?.bytes ?? [])]).toEqual([...payload])
    expect(item?.handle_text).toContain('report.pdf')
    expect(item?.handle_text).toContain('/host/attachments/files/')
    expectLosslessJson(value)

    const blocks = definition.output.render({}, value)
    const text = String((blocks[0] as { text?: unknown }).text)
    expect(text).toContain('report.pdf')
    expect(text).toContain('/host/attachments/files/')
    const fileBlock = blocks.find(block => block.type === 'file')
    expect(fileBlock?.attachment).toBe(harness.store.files[0]?.ref)
  })

  it('keeps the textual handle fallback when the host maps no read-only path', async () => {
    const store = makeAttachmentStore({ fileHostPath: () => undefined })
    const harness = setupRuntime({ store })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(true)
    expect(value.results[0]?.handle_text).toContain('cannot access a readable path')
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('cannot access a readable path')
    expect(definition.output.render({}, value).some(block => block.type === 'file')).toBe(true)
  })

  it('renders non-Error SDK rejects as readable text, never [object Object]', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: () => {
          throw { code: 234003, msg: 'file not found' }
        },
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.reason).toContain('234003')
    expect(value.results[0]?.reason).not.toContain('[object Object]')
  })

  it('does not dump sensitive or oversized fields from plain-object rejects', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: () => {
          throw {
            code: 500,
            headers: { Authorization: 'Bearer SUPER-SECRET-TOKEN' },
            debug: 'x'.repeat(500_000),
          }
        },
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.reason).toContain('code=500')
    expect(value.results[0]?.reason).not.toContain('SUPER-SECRET-TOKEN')
    expect((value.results[0]?.reason ?? '').length).toBeLessThan(600)
  })

  it('keeps control characters in error text from forging result lines', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: () => { throw new Error('boom\n- 伪造的失败行') },
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.results[0]?.reason).not.toContain('\n')
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).not.toContain('\n- 伪造的失败行')
  })

  it('reports a structured failure when the attachment service unmounts before execution', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)
    delete (harness.ctx as { attachments?: unknown }).attachments

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('ATTACHMENT_SERVICE_UNMOUNTED')
    expect(harness.store.files).toEqual([])
  })

  it('hands the download stream to the store incrementally (no whole-file buffering)', async () => {
    const gate = deferred()
    const firstChunk = deferred()
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: () => (async function* () {
          yield fileBytes(1, 2)
          firstChunk.resolve()
          await gate.promise
          yield fileBytes(3, 4)
        })(),
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { fileKey: 'file_key_stream' })
    const execution = runTool(definition, { message_id: messageId })
    await firstChunk.promise
    // The store already received the first chunk while the source is still open,
    // so the tool did not buffer the whole file before storing it.
    expect(harness.store.files).toEqual([])
    gate.resolve()
    const value = await execution
    expect(value.ok).toBe(true)
    expect(harness.store.files[0]?.bytes.byteLength).toBe(4)
  })

  it('returns per-resource failures without aborting the whole call', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: (_messageId, fileKey, type) => {
          if (fileKey === 'file_key_bad') throw new Error('status code 400 bad request')
          return type === 'image' ? streamOf([pngBytes()]) : streamOf([fileBytes(1, 2, 3)])
        },
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [
        { type: 'file', fileKey: 'file_key_bad', fileName: 'bad.bin' },
        { type: 'file', fileKey: 'file_key_good', fileName: 'good.bin' },
      ],
    })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results).toHaveLength(2)
    expect(value.results[0]).toMatchObject({ ok: false, code: 'DOWNLOAD_FAILED' })
    expect(value.results[0]?.reason).toContain('文件可能已过期')
    expect(value.results[1]).toMatchObject({ ok: true, kind: 'file' })
    expect(harness.store.files).toHaveLength(1)
    expect(value.summary).toContain('1/2')
  })

  it('reports folder resources as unsupported without downloading', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [{ type: 'file', fileKey: 'folder_key', folder: true }],
    })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('FOLDER_UNSUPPORTED')
    expect(harness.channel.downloaded).toEqual([])
  })
})

// ---- AC5: limits and cancellation -------------------------------------

describe('feishu attachment-fetch limits and cancellation', () => {
  it('refuses a message over the per-call resource limit before downloading', async () => {
    const resources: KnownAttachmentResource[] = [1, 2, 3].map(index => ({
      type: 'file' as const, fileKey: `file_key_${index}`,
    }))
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetchMaxResources: 2 }) })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { resources })

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('上限')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('accepts a file that fits the byte budget exactly', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetchMaxBytes: 3 }) })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { fileKey: 'file_key_exact' })
    harness.channel.downloadResource = async () => streamOf([fileBytes(1, 2, 3)])

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(true)
    expect(harness.store.files[0]?.ref.bytes).toBe(3)
  })

  it('enforces the total byte budget while streaming and commits no file', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetchMaxBytes: 4 }) })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { fileKey: 'file_key_budget' })
    harness.channel.downloadResource = async () => streamOf([fileBytes(1, 2, 3), fileBytes(4, 5)])

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('BYTES_LIMIT')
    expect(harness.store.files).toEqual([])
  })

  it('enforces the byte budget across several resources', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { attachmentFetchMaxBytes: 4 }) })
    const definition = await harness.mount()
    const messageId = knownFile(harness, {
      resources: [
        { type: 'file', fileKey: 'file_key_first', fileName: 'first.bin' },
        { type: 'file', fileKey: 'file_key_second', fileName: 'second.bin' },
      ],
    })
    harness.channel.downloadResource = async () => streamOf([fileBytes(1, 2, 3)])

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.ok).toBe(true)
    expect(value.results[1]?.code).toBe('BYTES_LIMIT')
    expect(harness.store.files).toHaveLength(1)
  })

  it('reports a message-read failure when expanding a known message id', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => { throw new Error('boom') } }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_expand_fail', kind: 'message', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_expand_fail' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('读取飞书消息内容失败')
  })

  it('reports a message without downloadable resources', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => ({
          data: { items: [{ message_id: 'om_text', msg_type: 'text', body: { content: '{"text":"hi"}' } }] },
        }),
      }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_text', kind: 'message', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_text' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('不包含可下载')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('reports a disconnected channel per resource', async () => {
    const harness = setupRuntime({ channel: null })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('CHANNEL_UNAVAILABLE')
  })

  it('performs no download for an already-aborted call', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)
    const controller = new AbortController()
    controller.abort()

    const value = await runTool(definition, { message_id: messageId }, controller.signal)
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('取消')
    expect(harness.channel.downloaded).toEqual([])
    expect(harness.store.files).toEqual([])
  })

  it('cancels a mid-stream file download without committing a partial file', async () => {
    const gate = deferred()
    const firstChunk = deferred()
    const harness = setupRuntime({
      channel: makeTestChannel({
        download: () => (async function* () {
          yield fileBytes(1, 2)
          firstChunk.resolve()
          await gate.promise
          yield fileBytes(3)
        })(),
      }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness, { fileKey: 'file_key_cancel' })
    const controller = new AbortController()
    const execution = runTool(definition, { message_id: messageId }, controller.signal)
    await firstChunk.promise
    controller.abort()
    gate.resolve()

    const value = await execution
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('ABORTED')
    expect(harness.store.files).toEqual([])
    expect(harness.store.aborted.count).toBeGreaterThan(0)
  })

  it('times out with a readable reason and leaves no committed file', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred()
      const harness = setupRuntime({
        config: makeConfig({}, { attachmentFetchTimeoutMs: 1_000 }),
        channel: makeTestChannel({
          download: () => (async function* () {
            yield fileBytes(1, 2)
            await gate.promise
          })(),
        }),
      })
      const definition = await harness.mount()
      const messageId = knownFile(harness, {
        resources: [
          { type: 'file', fileKey: 'file_key_timeout_1', fileName: 'a.bin' },
          { type: 'file', fileKey: 'file_key_timeout_2', fileName: 'b.bin' },
        ],
      })
      const execution = runTool(definition, { message_id: messageId })
      await vi.advanceTimersByTimeAsync(1_100)
      const value = await execution
      expect(value.ok).toBe(false)
      expect(value.results[0]?.code).toBe('TIMEOUT')
      // The remaining resources are not attempted after the deadline.
      expect(value.results[1]?.code).toBe('TIMEOUT')
      expect(value.summary).toContain('超时')
      expect(harness.store.files).toEqual([])
      expect(harness.channel.downloaded).toHaveLength(1)
      gate.resolve()
      await vi.runOnlyPendingTimersAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a readable reason when every resource fails', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ download: () => { throw new Error('boom') } }),
    })
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    const value = await runTool(definition, { message_id: messageId })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('下载失败')
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('获取失败')
  })
})

// ---- AC6: merged forward ----------------------------------------------

describe('feishu attachment-fetch merged forward', () => {
  const mergeForwardResponse = {
    code: 0,
    data: {
      items: [
        { message_id: 'om_container', msg_type: 'merge_forward', body: { content: 'Merged and forwarded messages' }, chat_id: 'oc_chat' },
        { message_id: 'om_child_text', msg_type: 'text', body: { content: '{"text":"hello"}' }, chat_id: 'oc_chat' },
        {
          message_id: 'om_child_image',
          msg_type: 'image',
          body: { content: '{"image_key":"img_key_forwarded"}' },
          chat_id: 'oc_chat',
          upper_message_id: 'om_container',
        },
      ],
    },
  }

  it('expands the container and downloads children through the container message id', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => mergeForwardResponse }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(
      harness.route,
      { messageId: 'om_container', kind: 'merge_forward', resources: [] },
      'trigger',
    )

    const value = await runTool(definition, { message_id: 'om_container' })
    expect(value.ok).toBe(true)
    expect(value.results[0]).toMatchObject({ ok: true, kind: 'image', file_key: 'img_key_forwarded' })
    expect(harness.channel.downloaded).toEqual([
      { messageId: 'om_container', fileKey: 'img_key_forwarded', type: 'image' },
    ])
    expectLosslessJson(value)
  })

  it('downloads a registered child resource through its container id, never the child id', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(
      harness.route,
      {
        messageId: 'om_child_message',
        kind: 'message',
        resources: [{
          type: 'file',
          fileKey: 'file_key_child',
          fileName: 'child.txt',
          containerMessageId: 'om_container',
        }],
      },
      'quote',
    )

    const value = await runTool(definition, { message_id: 'om_child_message' })
    expect(value.ok).toBe(true)
    expect(harness.channel.downloaded).toEqual([
      { messageId: 'om_container', fileKey: 'file_key_child', type: 'file' },
    ])
  })

  it('refuses an unregistered child message id', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => mergeForwardResponse }),
    })
    const definition = await harness.mount()

    const value = await runTool(definition, { message_id: 'om_child_image' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('授权范围')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('finds post files[] and locale-wrapped elements when expanding a message id', async () => {
    const postContent = {
      zh_cn: {
        title: '报告',
        content: [[
          { tag: 'text', text: 'see attached' },
          { tag: 'img', image_key: 'img_post_inline' },
        ]],
        files: [{ file_key: 'file_post_top', file_name: '数据.xlsx' }],
      },
    }
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => ({
          data: {
            items: [{
              message_id: 'om_post',
              msg_type: 'post',
              body: { content: JSON.stringify(postContent) },
            }],
          },
        }),
      }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_post', kind: 'message', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_post' })
    expect(value.ok).toBe(true)
    expect(value.results.map(item => item.file_key).sort()).toEqual(['file_post_top', 'img_post_inline'])
    expect(harness.channel.downloaded.map(entry => entry.fileKey).sort())
      .toEqual(['file_post_top', 'img_post_inline'])
  })

  it('expands post children of a merged-forward container without losing files', async () => {
    const childPost = {
      content: [[{ tag: 'img', image_key: 'img_child_post' }]],
      files: [{ file_key: 'file_child_post', file_name: 'child.pdf' }],
    }
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => ({
          data: {
            items: [
              { message_id: 'om_container2', msg_type: 'merge_forward', body: { content: 'Merged and forwarded messages' } },
              { message_id: 'om_child_post', msg_type: 'post', body: { content: JSON.stringify(childPost) } },
            ],
          },
        }),
      }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_container2', kind: 'merge_forward', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_container2' })
    expect(value.ok).toBe(true)
    expect(
      harness.channel.downloaded
        .map(entry => `${entry.messageId}:${entry.fileKey}`)
        .sort(),
    ).toEqual([
      'om_container2:file_child_post',
      'om_container2:img_child_post',
    ])
  })

  it('reports folder entries inside post files as unsupported', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => ({
          data: {
            items: [{
              message_id: 'om_post_folder',
              msg_type: 'post',
              body: {
                content: JSON.stringify({
                  content: [[{ tag: 'text', text: 'folder' }]],
                  files: [{ file_key: 'folder_key_post', file_name: '资料', is_folder: true }],
                }),
              },
            }],
          },
        }),
      }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_post_folder', kind: 'message', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_post_folder' })
    expect(value.ok).toBe(false)
    expect(value.results[0]?.code).toBe('FOLDER_UNSUPPORTED')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('blocks a merged-forward expansion that exceeds the resource cap', async () => {
    const items = [{ message_id: 'om_big_container', msg_type: 'merge_forward', body: { content: 'Merged and forwarded messages' } }]
    for (let index = 0; index < 12; index += 1) {
      items.push({
        message_id: `om_big_child_${index}`,
        msg_type: 'image',
        body: { content: JSON.stringify({ image_key: `img_big_${index}` }) },
      })
    }
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => ({ data: { items } }) }),
      config: makeConfig({}, { attachmentFetchMaxResources: 10 }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_big_container', kind: 'merge_forward', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_big_container' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('上限')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('ignores non-standard nested files/tag fields outside the post body shape', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => ({
          data: {
            items: [{
              message_id: 'om_post_extra',
              msg_type: 'post',
              body: {
                content: JSON.stringify({
                  content: [[{ tag: 'text', text: 'no attachment here' }]],
                  extra: { files: [{ file_key: 'metadata_file_key' }] },
                }),
              },
            }],
          },
        }),
      }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(harness.route, {
      messageId: 'om_post_extra', kind: 'message', resources: [],
    }, 'trigger')

    const value = await runTool(definition, { message_id: 'om_post_extra' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('不包含可下载')
    expect(harness.channel.downloaded).toEqual([])
  })

  it('filters merged-forward children by file_key', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => mergeForwardResponse }),
    })
    const definition = await harness.mount()
    harness.runtime.noteKnownMessage(
      harness.route,
      { messageId: 'om_container', kind: 'merge_forward', resources: [] },
      'trigger',
    )

    const value = await runTool(definition, { message_id: 'om_container', file_key: 'img_key_forwarded' })
    expect(value.ok).toBe(true)
    expect(harness.channel.downloaded).toHaveLength(1)

    const missing = await runTool(definition, { message_id: 'om_container', file_key: 'img_missing' })
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('file_key')
    expect(harness.channel.downloaded).toHaveLength(1)
  })
})

// ---- P2: feishu_topic_messages registration ---------------------------

describe('feishu topic-messages registration', () => {
  it('registers the model-facing tool after the tools injection', async () => {
    const harness = setupRuntime()
    const definition = await harness.mountTopic()

    expect(harness.register).toHaveBeenCalledTimes(1)
    expect(definition.name).toBe(TOPIC_MESSAGES_TOOL_NAME)
    expect(definition.description).toContain('Feishu')
    expect(definition.description).toContain('message_id')
    expect(definition.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        cursor: { type: 'string' },
      },
    })
    const limitParameter = (definition.parameters as {
      properties: { limit: { description: string } }
    }).properties.limit
    expect(limitParameter.description).toContain('default 10')
    expect(limitParameter.description).toContain('maximum 50')
    expect(definition.output.schema).toMatchObject({
      type: 'object',
      required: ['ok', 'summary', 'container', 'order', 'message_count', 'has_more', 'messages'],
    })
    expect(definition.isConcurrencySafe?.()).toBe(true)
    expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(definition.parameters)

    // Mounting the same scope twice must not register a duplicate row.
    await harness.topic.mount(harness.ctx, 'session-tools')
    expect(harness.register).toHaveBeenCalledTimes(1)
  })

  it('warns once and skips registration when the tools service is missing', async () => {
    const harness = setupRuntime({ includeTools: false })
    await harness.topic.mount(harness.ctx, 'session-tools')
    expect(harness.definitions.size).toBe(0)
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('tools')
  })

  it('does not inject or register when the feature switch is off', async () => {
    const harness = setupRuntime({ config: makeConfig({}, { topicMessages: false }) })
    const inject = vi.spyOn(harness.ctx, 'inject')
    await harness.topic.mount(harness.ctx, 'session-tools')
    expect(inject).not.toHaveBeenCalled()
    expect(harness.definitions.size).toBe(0)
  })

  it('reports a readable TOOL_DISABLED failure when the switch turns off after mount', async () => {
    const harness = setupRuntime()
    const definition = await harness.mountTopic()
    const config = harness.config as FeishuConfig & { feishuTools: FeishuConfig['feishuTools'] }
    config.feishuTools = { ...config.feishuTools, topicMessages: false }

    const value = await runTopicTool(definition, {})
    expect(value.ok).toBe(false)
    expect(value.code).toBe('TOOL_DISABLED')
    expect(value.summary).toContain('已禁用')
    expect(value.messages).toEqual([])
    expectLosslessJson(value)
  })

  it('warns once when real cordis settles an injection without calling back', async () => {
    const harness = setupRuntime()
    vi.spyOn(harness.ctx, 'inject').mockImplementation((() => Promise.resolve()) as typeof harness.ctx.inject)
    await harness.topic.mount(harness.ctx, 'session-tools')
    expect(harness.definitions.size).toBe(0)
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('不可用')
  })

  it('logs one warning and keeps the session alive when the injection fails', async () => {
    const harness = setupRuntime()
    vi.spyOn(harness.ctx, 'inject').mockRejectedValueOnce(new Error('no such service'))
    await expect(harness.topic.mount(harness.ctx, 'session-tools')).resolves.toBeUndefined()
    expect(harness.definitions.size).toBe(0)
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(String(harness.warn.mock.calls[0]?.[0])).toContain('mounting')
  })

  it('does not block session creation when the tools service never appears in time', async () => {
    vi.useFakeTimers()
    try {
      const harness = setupRuntime()
      let release!: () => void
      const injection = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(harness.ctx, 'inject').mockImplementation(((
        _deps: readonly string[],
        _callback: (ctx: AgentContext) => void,
      ) => injection) as typeof harness.ctx.inject)

      const mounting = harness.topic.mount(harness.ctx, 'session-tools')
      await vi.advanceTimersByTimeAsync(2_100)
      await mounting
      expect(harness.definitions.size).toBe(0)
      expect(harness.warn).toHaveBeenCalledTimes(1)
      expect(String(harness.warn.mock.calls[0]?.[0])).toContain('不可用')
      release()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- P2: feishu_topic_messages argument validation ---------------------

describe('feishu topic-messages argument validation', () => {
  it('validates the arguments with zod (bounds, integers, unknown keys)', () => {
    expect(topicMessagesArgsSchema.safeParse({}).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'om_1' }).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ limit: 1 }).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ limit: 50 }).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ cursor: 'page_token' }).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ limit: 2.5 }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ message_id: '' }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'om_1', cursor: 't' }).success).toBe(true)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'om_1', extra: 1 }).success).toBe(false)
  })

  it('throws readable errors for invalid arguments instead of a raw object', async () => {
    const harness = setupRuntime()
    const definition = await harness.mountTopic()

    await expect(runTopicTool(definition, { limit: 0 })).rejects.toThrow(/invalid limit/u)
    await expect(runTopicTool(definition, { limit: 51 })).rejects.toThrow(/invalid limit/u)
    await expect(runTopicTool(definition, { limit: 2.5 })).rejects.toThrow(/invalid limit/u)
    await expect(runTopicTool(definition, { message_id: 'om_1', cursor: 'page_token' }))
      .rejects.toThrow(/不能同时/u)
    await expect(runTopicTool(definition, { unknown_argument: true }))
      .rejects.toThrow(/feishu_topic_messages: invalid/u)
  })

  it('rejects a malformed or oversized message_id before touching the channel', async () => {
    const harness = setupRuntime()
    const definition = await harness.mountTopic()

    for (const messageId of [
      '../../chats?x=1',
      'om_x?foo=1',
      'om_x/../other',
      'x'.repeat(5_000),
    ]) {
      await expect(runTopicTool(definition, { message_id: messageId }))
        .rejects.toThrow(/invalid message_id/u)
    }
    // The shape gate is part of the schema, not of the read path.
    expect(topicMessagesArgsSchema.safeParse({ message_id: '../../chats?x=1' }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'om_x?foo=1' }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'x'.repeat(5_000) }).success).toBe(false)
    expect(topicMessagesArgsSchema.safeParse({ message_id: 'om_Abc-123_xyz' }).success).toBe(true)
    // Oversized cursors are refused as well; Feishu page tokens are short.
    expect(topicMessagesArgsSchema.safeParse({ cursor: 'x'.repeat(2_049) }).success).toBe(false)
    await expect(runTopicTool(definition, { cursor: 'x'.repeat(2_049) }))
      .rejects.toThrow(/invalid cursor/u)
  })
})

// ---- P2: feishu_topic_messages single read ----------------------------

describe('feishu topic-messages single read', () => {
  const TIME = 1792508690777

  it('reports a missing route binding as a readable ROUTE_NOT_FOUND', async () => {
    const harness = setupRuntime({ unbound: true })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, {})
    expect(value.ok).toBe(false)
    expect(value.code).toBe('ROUTE_NOT_FOUND')
    expect(value.summary).toContain('尚未绑定飞书话题')
    expect(value.messages).toEqual([])
    expectLosslessJson(value)
  })

  it('reads a main-timeline message on a degraded chat route', async () => {
    const chatRoute: AttachmentFetchRoute = {
      key: 'chat:oc_chat',
      kind: 'chat',
      chatId: DEFAULT_ROUTE.chatId,
      chatType: 'group',
      senderUserId: DEFAULT_ROUTE.senderUserId,
    }
    const harness = setupRuntime({
      route: chatRoute,
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_chat_main',
            chat_id: DEFAULT_ROUTE.chatId,
            content: { text: 'chat main timeline' },
          }),
        ]),
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_chat_main' })
    expect(value.ok).toBe(true)
    expect(value.container).toEqual({ type: 'chat', id: DEFAULT_ROUTE.chatId })
    expect(value.messages[0]?.text).toBe('chat main timeline')
  })

  it('fails closed without a chat_id and never admits topic rows on a chat route', async () => {
    // A raw item without chat_id has no membership proof: refused on a topic route too.
    const topicHarness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_no_chat_id',
            thread_id: DEFAULT_ROUTE.key,
            content: { text: 'missing chat id' },
          }),
        ]),
      }),
    })
    const topicDefinition = await topicHarness.mountTopic()
    const noChatId = await runTopicTool(topicDefinition, { message_id: 'om_no_chat_id' })
    expect(noChatId.ok).toBe(false)
    expect(noChatId.code).toBe('MESSAGE_OUT_OF_ROUTE')

    // Degraded chat route: a topic message is refused even when it was already
    // admitted to this route (the tightened membership rule has no known bypass).
    const chatRoute: AttachmentFetchRoute = {
      key: 'chat:oc_chat',
      kind: 'chat',
      chatId: DEFAULT_ROUTE.chatId,
      chatType: 'group',
      senderUserId: DEFAULT_ROUTE.senderUserId,
    }
    const chatHarness = setupRuntime({
      route: chatRoute,
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_known_topic_row',
            chat_id: chatRoute.chatId,
            thread_id: 'omt_any_topic',
            content: { text: 'topic row' },
          }),
        ]),
      }),
    })
    chatHarness.runtime.noteKnownMessage(
      chatRoute,
      { messageId: 'om_known_topic_row', kind: 'message', resources: [] },
      'quote',
    )
    const chatDefinition = await chatHarness.mountTopic()
    const refused = await runTopicTool(chatDefinition, { message_id: 'om_known_topic_row' })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('MESSAGE_OUT_OF_ROUTE')
  })

  it('reads one message by id and returns lossless JSON with bounded text', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_quoted',
            msg_type: 'text',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            create_time: TIME,
            sender_id: 'u_alice',
            content: { text: 'quoted hello' },
          }),
        ]),
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_quoted' })
    expect(value.ok).toBe(true)
    expect(value.order).toBe('single')
    expect(value.container).toEqual({ type: 'thread', id: DEFAULT_ROUTE.key })
    expect(value.message_count).toBe(1)
    expect(value.has_more).toBe(false)
    expect(value.code).toBeUndefined()
    expect(value.reason).toBeUndefined()
    expect(value.messages[0]).toEqual({
      message_id: 'om_quoted',
      type: 'text',
      sender: 'user',
      time: '10-20 23:04',
      text: 'quoted hello',
    })
    expectLosslessJson(value)

    const blocks = definition.output.render({}, value)
    expect(blocks[0]?.type).toBe('text')
    const text = String((blocks[0] as { text?: unknown }).text)
    expect(text).toContain('quoted hello')
    expect(text).toContain('om_quoted')
    expect(text).not.toContain('[object Object]')
  })

  it('refuses a message id from another chat or another topic (AC5 isolation)', async () => {
    let response: unknown = makeMessageGetResponse([
      makeRawMessage({
        message_id: 'om_other_chat',
        chat_id: 'oc_other_chat',
        content: { text: 'not here' },
      }),
    ])
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => response }),
    })
    const definition = await harness.mountTopic()

    const otherChat = await runTopicTool(definition, { message_id: 'om_other_chat' })
    expect(otherChat.ok).toBe(false)
    expect(otherChat.code).toBe('MESSAGE_OUT_OF_ROUTE')
    expect(otherChat.summary).toContain('不在当前会话')
    expect(otherChat.messages).toEqual([])
    expectLosslessJson(otherChat)

    // Same chat, but another topic of it: must not leak into this thread route.
    response = makeMessageGetResponse([
      makeRawMessage({
        message_id: 'om_other_topic',
        chat_id: DEFAULT_ROUTE.chatId,
        thread_id: 'omt_other_topic',
        content: { text: 'other topic' },
      }),
    ])
    const otherTopic = await runTopicTool(definition, { message_id: 'om_other_topic' })
    expect(otherTopic.code).toBe('MESSAGE_OUT_OF_ROUTE')
    // An out-of-route read is not registered for fetches.
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_other_topic')).toBe(false)
  })

  it('allows an admitted main-timeline message in a topic route (known quote)', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_quoted_main',
            chat_id: DEFAULT_ROUTE.chatId,
            content: { text: 'main timeline quote' },
          }),
        ]),
      }),
    })
    // A quote happens before the topic exists: the message has no thread id but
    // the admission/quote layer already authorized it for this route.
    harness.runtime.noteKnownMessage(
      DEFAULT_ROUTE,
      { messageId: 'om_quoted_main', kind: 'message', resources: [] },
      'quote',
    )
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_quoted_main' })
    expect(value.ok).toBe(true)
    expect(value.messages[0]?.text).toBe('main timeline quote')
  })

  it('refuses the owner\'s unregistered main-timeline message in a topic route', async () => {
    const harness = setupRuntime()
    harness.channel.messageGet = async () => makeMessageGetResponse([
      makeRawMessage({
        message_id: 'om_owner_main',
        msg_type: 'file',
        chat_id: DEFAULT_ROUTE.chatId,
        sender_type: 'user',
        sender_id: DEFAULT_ROUTE.senderUserId,
        content: { file_key: 'file_key_owner_main', file_name: 'owner.pdf' },
      }),
    ])
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_owner_main' })
    expect(value.ok).toBe(false)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_owner_main')).toBe(false)
  })

  it('exposes isKnownMessage over the whitelist', async () => {
    const harness = setupRuntime()
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_unknown')).toBe(false)

    const knownId = knownFile(harness)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, knownId)).toBe(true)
    expect(harness.runtime.isKnownMessage({ ...DEFAULT_ROUTE, key: 'omt_other' }, knownId)).toBe(false)

    // 'history' is a valid registration source for the shared whitelist.
    harness.runtime.noteKnownMessage(
      DEFAULT_ROUTE,
      { messageId: 'om_history_known', kind: 'message', resources: [] },
      'history',
    )
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_history_known')).toBe(true)
  })

  it('expands a merged-forward container into child messages and notes the child count', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_fwd',
            msg_type: 'merge_forward',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: {},
          }),
          makeRawMessage({
            message_id: 'om_fwd_text',
            msg_type: 'text',
            chat_id: DEFAULT_ROUTE.chatId,
            upper_message_id: 'om_fwd',
            content: { text: '子消息文本' },
          }),
          makeRawMessage({
            message_id: 'om_fwd_image',
            msg_type: 'image',
            chat_id: DEFAULT_ROUTE.chatId,
            upper_message_id: 'om_fwd',
            content: { image_key: 'img_fwd' },
          }),
        ]),
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_fwd' })
    expect(value.ok).toBe(true)
    expect(value.message_count).toBe(3)
    expect(value.summary).toContain('合并转发')
    expect(value.summary).toContain('2 条子消息')
    expect(value.messages.map(message => message.message_id))
      .toEqual(['om_fwd', 'om_fwd_text', 'om_fwd_image'])
    expectLosslessJson(value)

    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('子消息文本')
    expect(text).toContain('图片×1')
    // The container is registered (merged-forward child bytes download through it).
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_fwd')).toBe(true)
  })

  it('finds the merged-forward container even when children are returned first', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_child_text_first',
            msg_type: 'text',
            upper_message_id: 'om_shuffled_container',
            chat_id: DEFAULT_ROUTE.chatId,
            content: { text: '乱序子消息' },
          }),
          makeRawMessage({
            message_id: 'om_child_image_first',
            msg_type: 'image',
            upper_message_id: 'om_shuffled_container',
            chat_id: DEFAULT_ROUTE.chatId,
            content: { image_key: 'img_shuffled' },
          }),
          makeRawMessage({
            message_id: 'om_shuffled_container',
            msg_type: 'merge_forward',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: {},
          }),
        ]),
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_shuffled_container' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('2 条子消息')
    expect(value.messages.map(message => message.message_id)).toEqual([
      'om_shuffled_container',
      'om_child_text_first',
      'om_child_image_first',
    ])
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_shuffled_container')).toBe(true)
    expectLosslessJson(value)
  })

  it('bounds a single merged-forward read to 50 messages and notes the hidden count', async () => {
    const items: unknown[] = [makeRawMessage({
      message_id: 'om_huge_fwd',
      msg_type: 'merge_forward',
      chat_id: DEFAULT_ROUTE.chatId,
      thread_id: DEFAULT_ROUTE.key,
      content: {},
    })]
    for (let index = 0; index < 200; index += 1) {
      items.push(makeRawMessage({
        message_id: `om_huge_child_${index}`,
        msg_type: 'text',
        chat_id: DEFAULT_ROUTE.chatId,
        upper_message_id: 'om_huge_fwd',
        content: { text: `child ${index}` },
      }))
    }
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => makeMessageGetResponse(items) }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_huge_fwd' })
    expect(value.ok).toBe(true)
    expect(value.messages.length).toBe(50)
    expect(value.message_count).toBe(value.messages.length)
    expect(value.summary).toContain('另有 151 条消息未展示')
    expectLosslessJson(value)

    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('未展示')
  })

  it('reports a missing message as a readable failure', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => makeMessageGetResponse([]) }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_gone' })
    expect(value.ok).toBe(false)
    expect(value.code).toBe('MESSAGE_READ_FAILED')
    expect(value.reason).toContain('未返回该消息')
    expect(value.messages).toEqual([])
    expectLosslessJson(value)
  })

  it('maps a Feishu permission failure to a readable PERMISSION_DENIED', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => {
          throw Object.assign(new Error('request failed'), {
            response: { status: 403, data: { code: 99991672, msg: 'No permission to read messages' } },
          })
        },
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_denied' })
    expect(value.ok).toBe(false)
    expect(value.code).toBe('PERMISSION_DENIED')
    expect(value.reason).toContain('权限')
    expect(value.summary).toContain('权限')
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain('[object Object]')
    expect(serialized).not.toContain('undefined')
    expectLosslessJson(value)
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('PERMISSION_DENIED')
    expect(text).not.toContain('[object Object]')
  })

  it('keeps non-Error SDK rejects readable (never [object Object])', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => {
          throw { code: 234003, msg: 'message not found' }
        },
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_plain_object' })
    expect(value.ok).toBe(false)
    expect(value.code).toBe('MESSAGE_READ_FAILED')
    expect(value.reason).toContain('234003')
    expect(value.reason).not.toContain('[object Object]')
    expectLosslessJson(value)
  })

  it('reports ABORTED with a readable reason when exec.signal is aborted mid-read', async () => {
    let release!: (value: unknown) => void
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: () => new Promise((resolve) => { release = resolve }),
      }),
    })
    const definition = await harness.mountTopic()
    const controller = new AbortController()
    const execution = runTopicTool(definition, { message_id: 'om_slow' }, controller.signal)
    controller.abort()

    const value = await execution
    expect(value.ok).toBe(false)
    expect(value.code).toBe('ABORTED')
    expect(value.summary).toContain('取消')
    expect(value.reason).not.toContain('[object Object]')
    expectLosslessJson(value)
    release(makeMessageGetResponse([]))
  })

  it('reports TIMEOUT with a readable reason on the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const harness = setupRuntime({
        config: makeConfig({}, { topicMessagesTimeoutMs: 1_000 }),
        channel: makeTestChannel({ messageGet: () => new Promise(() => {}) }),
      })
      const definition = await harness.mountTopic()
      const execution = runTopicTool(definition, { message_id: 'om_timeout' })
      await vi.advanceTimersByTimeAsync(1_100)

      const value = await execution
      expect(value.ok).toBe(false)
      expect(value.code).toBe('TIMEOUT')
      expect(value.summary).toContain('超时')
      expectLosslessJson(value)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- P2: feishu_topic_messages list -----------------------------------

describe('feishu topic-messages list', () => {
  const listedItems = (): unknown[] => [
    makeRawMessage({
      message_id: 'om_new',
      chat_id: DEFAULT_ROUTE.chatId,
      thread_id: DEFAULT_ROUTE.key,
      create_time: 1792508690777,
      content: { text: 'newest message' },
    }),
    makeRawMessage({
      message_id: 'om_old',
      msg_type: 'file',
      chat_id: DEFAULT_ROUTE.chatId,
      thread_id: DEFAULT_ROUTE.key,
      create_time: 1792508600000,
      content: { file_key: 'file_key_listed', file_name: 'older.pdf' },
    }),
  ]

  it('lists the topic newest-first with page size, sort and cursor passthrough', async () => {
    const calls: RawMessageListParams[] = []
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageList: async (params) => {
          calls.push(params)
          return makeMessageListResponse(listedItems(), { hasMore: true, pageToken: 'token_next' })
        },
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { limit: 2 })
    expect(value.ok).toBe(true)
    expect(value.order).toBe('newest_first')
    expect(value.container).toEqual({ type: 'thread', id: DEFAULT_ROUTE.key })
    expect(value.message_count).toBe(2)
    expect(value.has_more).toBe(true)
    expect(value.cursor).toBe('token_next')
    expect(value.messages.map(message => message.message_id)).toEqual(['om_new', 'om_old'])
    expect(calls[0]).toMatchObject({
      container_id_type: 'thread',
      container_id: DEFAULT_ROUTE.key,
      page_size: 2,
      sort_type: 'ByCreateTimeDesc',
    })
    expect(calls[0]?.page_token).toBeUndefined()
    expectLosslessJson(value)

    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text).toContain('newest message')
    expect(text).toContain('om_new')
    // The opaque cursor must be visible in the rendered output: the model only
    // sees render text, and real-device pagination failed without it.
    expect(text).toContain('token_next')
    expect(text).toContain('下一页 cursor')

    // The cursor is forwarded as page_token; the default page size is 10.
    const secondPage = await runTopicTool(definition, { cursor: 'token_next' })
    expect(secondPage.ok).toBe(true)
    expect(calls[1]?.page_token).toBe('token_next')
    expect(calls[1]?.page_size).toBe(10)

    // The documented maximum is accepted as-is.
    await runTopicTool(definition, { limit: 50 })
    expect(calls[2]?.page_size).toBe(50)

    // Attachment rows discovered in the listing are registered for the fetch
    // tool (AC5); plain-text rows are not (they carry nothing to fetch and
    // would churn the shared LRU).
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_new')).toBe(false)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_old')).toBe(true)
  })

  it('lists the chat main timeline on a degraded chat route and filters other topics', async () => {
    const chatRoute: AttachmentFetchRoute = {
      key: 'chat:oc_chat',
      kind: 'chat',
      chatId: DEFAULT_ROUTE.chatId,
      chatType: 'group',
      senderUserId: DEFAULT_ROUTE.senderUserId,
    }
    const calls: RawMessageListParams[] = []
    const harness = setupRuntime({
      route: chatRoute,
      channel: makeTestChannel({
        messageList: async (params) => {
          calls.push(params)
          return makeMessageListResponse([
            makeRawMessage({
              message_id: 'om_main',
              chat_id: DEFAULT_ROUTE.chatId,
              content: { text: 'main timeline' },
            }),
            makeRawMessage({
              message_id: 'om_other_topic',
              chat_id: DEFAULT_ROUTE.chatId,
              thread_id: 'omt_other_topic',
              content: { text: 'other topic' },
            }),
            makeRawMessage({
              message_id: 'om_other_chat',
              chat_id: 'oc_other_chat',
              content: { text: 'other chat' },
            }),
          ])
        },
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, {})
    expect(value.ok).toBe(true)
    expect(calls[0]).toMatchObject({
      container_id_type: 'chat',
      container_id: DEFAULT_ROUTE.chatId,
      page_size: 10,
      sort_type: 'ByCreateTimeDesc',
    })
    expect(value.container).toEqual({ type: 'chat', id: DEFAULT_ROUTE.chatId })
    expect(value.order).toBe('newest_first')
    // Topic messages and other chats never leak into a chat route.
    expect(value.messages.map(message => message.message_id)).toEqual(['om_main'])
  })

  it('maps a list failure to a readable structured value', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageList: async () => {
          throw Object.assign(new Error('request failed'), {
            response: { status: 403, data: { code: 99991672, msg: 'No permission' } },
          })
        },
      }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, {})
    expect(value.ok).toBe(false)
    expect(value.code).toBe('PERMISSION_DENIED')
    expect(value.summary).toContain('权限')
    expect(value.messages).toEqual([])
    expectLosslessJson(value)
  })

  it('does not let plain-text history evict authorized resources from the whitelist', async () => {
    const textPage = (prefix: string): unknown[] => Array.from({ length: 50 }, (_, index) =>
      makeRawMessage({
        message_id: `om_${prefix}_${index}`,
        chat_id: DEFAULT_ROUTE.chatId,
        thread_id: DEFAULT_ROUTE.key,
        content: { text: `${prefix} ${index}` },
      }))
    let page = 0
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageList: async () => {
          page += 1
          return makeMessageListResponse(textPage(`page${page}`), {
            hasMore: page === 1,
            ...(page === 1 ? { pageToken: 'token_2' } : {}),
          })
        },
      }),
    })
    const triggerMessageId = knownFile(harness)
    const topicDefinition = await harness.mountTopic()
    const fetchDefinition = await harness.mount()

    await runTopicTool(topicDefinition, { limit: 50 })
    await runTopicTool(topicDefinition, { limit: 50, cursor: 'token_2' })

    // 100 plain-text rows must not churn the shared LRU (cap 128 per route):
    // the trigger registration survives and its attachment stays fetchable.
    expect(harness.runtime.whitelist.size(DEFAULT_ROUTE.key)).toBe(1)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_page1_0')).toBe(false)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, triggerMessageId)).toBe(true)

    const fetched = await runTool(fetchDefinition, { message_id: triggerMessageId })
    expect(fetched.ok).toBe(true)
    expect(harness.channel.downloaded).toEqual([
      { messageId: triggerMessageId, fileKey: 'file_key_1', type: 'file' },
    ])
  })

  it('still registers history rows that carry attachments or merged-forward containers', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageList: async () => makeMessageListResponse([
          makeRawMessage({
            message_id: 'om_text_row',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: { text: 'plain row' },
          }),
          makeRawMessage({
            message_id: 'om_file_row',
            msg_type: 'file',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: { file_key: 'file_key_row', file_name: 'row.pdf' },
          }),
          makeRawMessage({
            message_id: 'om_fwd_row',
            msg_type: 'merge_forward',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: {},
          }),
        ]),
      }),
    })
    const definition = await harness.mountTopic()

    await runTopicTool(definition, {})
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_file_row')).toBe(true)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_fwd_row')).toBe(true)
    expect(harness.runtime.isKnownMessage(DEFAULT_ROUTE, 'om_text_row')).toBe(false)
  })
})

// ---- P2: AC5 authorization chain --------------------------------------

describe('feishu topic-messages authorization chain (AC5)', () => {
  it('makes a discovered file fetchable and keeps undiscovered ids refused', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageGet: async () => makeMessageGetResponse([
          makeRawMessage({
            message_id: 'om_topic_file',
            msg_type: 'file',
            chat_id: DEFAULT_ROUTE.chatId,
            thread_id: DEFAULT_ROUTE.key,
            content: { file_key: 'file_key_topic', file_name: 'topic.pdf' },
          }),
        ]),
      }),
    })
    const topicDefinition = await harness.mountTopic()
    const fetchDefinition = await harness.mount()

    // 1. Before discovery a message id is not a capability: the fetch tool refuses.
    const denied = await runTool(fetchDefinition, { message_id: 'om_topic_file' })
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('授权范围')
    expect(harness.channel.downloaded).toEqual([])

    // 2. The topic tool reads the message and registers its resource.
    const read = await runTopicTool(topicDefinition, { message_id: 'om_topic_file' })
    expect(read.ok).toBe(true)
    expect(read.messages[0]?.resources?.[0]).toMatchObject({
      type: 'file', file_key: 'file_key_topic',
    })

    // 3. The REAL attachment-fetch tool definition can now download it.
    const fetched = await runTool(fetchDefinition, { message_id: 'om_topic_file' })
    expect(fetched.ok).toBe(true)
    expect(fetched.results[0]?.ok).toBe(true)
    expect(harness.channel.downloaded).toEqual([
      { messageId: 'om_topic_file', fileKey: 'file_key_topic', type: 'file' },
    ])
  })
})

// ---- P2: rendering and presentation -----------------------------------

describe('feishu topic-messages rendering and presentation', () => {
  it('projects concise call and result lines for host-local cards', async () => {
    const harness = setupRuntime({
      channel: makeTestChannel({
        messageList: async () => makeMessageListResponse([]),
      }),
    })
    const definition = await harness.mountTopic()

    expect(definition.presentCall?.({})).toBe('读取飞书话题消息（最近 10 条）')
    expect(definition.presentCall?.({ limit: 3 })).toBe('读取飞书话题消息（最近 3 条）')
    expect(definition.presentCall?.({ limit: 3, cursor: 't' }))
      .toBe('读取飞书话题消息（最近 3 条，翻页）')
    expect(definition.presentCall?.({ message_id: 'om_1' })).toBe('读取飞书消息 om_1')
    const value = await runTopicTool(definition, {})
    expect(definition.presentResult?.({}, value)).toBe(value.summary)
  })

  it('bounds the rendered transcript of a long merged-forward message', async () => {
    const items: unknown[] = [makeRawMessage({
      message_id: 'om_long_fwd',
      msg_type: 'merge_forward',
      chat_id: DEFAULT_ROUTE.chatId,
      thread_id: DEFAULT_ROUTE.key,
      content: {},
    })]
    for (let index = 0; index < 60; index += 1) {
      items.push(makeRawMessage({
        message_id: `om_fwd_child_${index}`,
        msg_type: 'text',
        chat_id: DEFAULT_ROUTE.chatId,
        upper_message_id: 'om_long_fwd',
        content: { text: `child ${index} ${'x'.repeat(300)}` },
      }))
    }
    const harness = setupRuntime({
      channel: makeTestChannel({ messageGet: async () => makeMessageGetResponse(items) }),
    })
    const definition = await harness.mountTopic()

    const value = await runTopicTool(definition, { message_id: 'om_long_fwd' })
    expect(value.ok).toBe(true)
    const text = String((definition.output.render({}, value)[0] as { text?: unknown }).text)
    expect(text.length).toBeLessThanOrEqual(12_000 + 200)
    expect(text.split('\n').length).toBeLessThanOrEqual(52)
    expect(text).toContain('其余')
  })

  it('renders a safe fallback for replayed or malformed values', () => {
    const absent = renderTopicMessagesResult(undefined)
    expect(absent).toHaveLength(1)
    expect(absent[0]?.type).toBe('text')
    const malformed = renderTopicMessagesResult({
      ok: false,
      summary: '读取失败',
      messages: [null, { message_id: 'om_1' }],
    })
    expect(malformed).toHaveLength(1)
    expect(String((malformed[0] as { text?: unknown }).text)).toContain('读取失败')
  })

  it('documents the merged-forward container rule and the archive fetch hint', async () => {
    const available = await setupRuntime().mountTopic()
    // The refuted child-id assumption is stated explicitly (P0 rule).
    expect(available.description).toContain('Merged-forward child message ids are NOT downloadable')
    expect(available.description).toContain('top-level container message_id')
    expect(available.description).not.toContain('feishu_attachment_fetch is unavailable')

    // A deployment without the fetch tool gets one extra actionable sentence.
    const archive = await setupRuntime({ fetchAvailable: () => false }).mountTopic()
    expect(archive.description).toContain('feishu_attachment_fetch is unavailable')
    expect(archive.description).toContain('report attachment metadata')

    // Default (undefined) is treated as available.
    const undefinedProbe = await setupRuntime({ fetchAvailable: () => true }).mountTopic()
    expect(undefinedProbe.description).not.toContain('feishu_attachment_fetch is unavailable')
  })
})

// ---- Presentation and configuration -----------------------------------

describe('feishu attachment-fetch presentation and configuration', () => {
  it('projects a readable call line and result summary for host-local cards', async () => {
    const harness = setupRuntime()
    const definition = await harness.mount()
    const messageId = knownFile(harness)

    expect(definition.presentCall?.({ message_id: messageId })).toBe(`获取飞书附件 ${messageId}`)
    expect(definition.presentCall?.({ message_id: messageId, file_key: 'file_key_1' }))
      .toBe(`获取飞书附件 ${messageId}（file_key_1）`)
    const value = await runTool(definition, { message_id: messageId })
    expect(definition.presentResult?.({ message_id: messageId }, value)).toBe(value.summary)
  })

  it('renders a safe fallback for a null/absent value from replay projections', () => {
    const blocks = renderAttachmentFetchResult(undefined)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(presentAttachmentFetchResult(null)).toBe(ATTACHMENT_FETCH_TOOL_NAME)
    // A malformed replayed results array must not throw inside the projection.
    const malformed = renderAttachmentFetchResult({
      message_id: 'om_1', ok: false, summary: 'x', results: [null, { ok: true, kind: 'image' }],
    })
    expect(malformed[0]?.type).toBe('text')
  })

  it('does not mount when attachments are globally disabled', async () => {
    const harness = setupRuntime({ config: makeConfig({ acceptAttachments: false }) })
    await harness.runtime.mount(harness.ctx, 'session-tools')
    expect(harness.definitions.size).toBe(0)
    expect(harness.register).not.toHaveBeenCalled()
  })

  it('defaults the feature switch, limits and timeout', () => {
    const config = resolveConfig({})
    expect(config.feishuTools).toEqual({
      attachmentFetch: true,
      attachmentFetchMaxResources: 10,
      attachmentFetchMaxBytes: 100 * 1024 * 1024,
      attachmentFetchTimeoutMs: 120_000,
      topicMessages: true,
      topicMessagesTimeoutMs: 20_000,
    })
  })

  it('accepts nested overrides and rejects out-of-range limits', () => {
    const config = resolveConfig({
      feishuTools: {
        attachmentFetch: false,
        attachmentFetchMaxResources: 3,
        attachmentFetchMaxBytes: 1024,
        attachmentFetchTimeoutMs: 5_000,
      },
    })
    expect(config.feishuTools).toMatchObject({
      attachmentFetch: false,
      attachmentFetchMaxResources: 3,
      attachmentFetchMaxBytes: 1024,
      attachmentFetchTimeoutMs: 5_000,
    })
    expect(config.feishuTools.attachmentFetchMaxResources).toBe(3)
    expect(() => resolveConfig({ feishuTools: { attachmentFetchMaxResources: 0 } }))
      .toThrow(/invalid configuration/u)
    expect(() => resolveConfig({ feishuTools: { attachmentFetchTimeoutMs: 10 } }))
      .toThrow(/invalid configuration/u)
  })
})

// ---- Utility ----------------------------------------------------------

afterEach(() => {
  vi.useRealTimers()
})
