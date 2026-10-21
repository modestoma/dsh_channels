/**
 * Shared fakes: a stub Feishu channel and a fake host context surface.
 *
 * @module tests/helpers
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type {
  Agent, AgentContext, AgentHandle, AgentOptions, AgentRegistry, AgentRequestConfig, AgentRequestListener, ApprovalAnswererListener,
  AssistantStreamPayload, AttachmentStore, CommandDefinition, CommandInvocation, CommandRuntime, EncodedImageAttachment,
  FileAttachmentRef, HostContext, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType, PermissionPresets, PromptSection,
  Session, SessionEvent, SessionId, SessionProjections, StorageDomainFacility, ToolDefinition, ToolRuntime,
  UserQuestionAnswererListener, Workspace, WorkspaceRegistry,
} from '../src/dsh-types.ts'
import type {
  CreatedWorktree, WorkingDirectoryService, WorktreeService,
} from '../src/session/isolation.ts'
import type {
  BotAddedEvent, CardActionEvent, ChatInfo, FeishuChannel, FeishuConnectionStatus, NormalizedMessage, SendResult,
} from '../src/feishu-channel.ts'
import type { RawDomainHandle } from '../src/domain.ts'

export function makeSession(
  id = `session-${Math.random().toString(36).slice(2, 10)}`,
  cwd?: string,
  agentPreset?: string,
): Session {
  // Test sessions keep the raw log locally (so tests can append/inspect) and
  // expose it only through the DSH 0.2.0 range reader the plugin consumes.
  const log: SessionEvent[] = []
  const session = {
    id: id as SessionId,
    header: {
      version: 0,
      id: id as SessionId,
      createdAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    events: log,
    firstLiveSeq: 0,
    snapshotEvents: (fromSeq = 0, toSeqExclusive = log.length) => log.slice(fromSeq, toSeqExclusive),
    requestHeader: () => {
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const event = log[index]
        if (event?.type === 'request/header') return event.data.header
      }
      return undefined
    },
  }
  return session as unknown as Session
}

/**
 * Test-only raw log view of a fake Session. Production code reads the log
 * through `snapshotEvents()`; tests keep direct array access for assertions
 * and synthetic appends.
 */
export function sessionEvents(session: Session): SessionEvent[] {
  return (session as unknown as { events: SessionEvent[] }).events
}

export function makeCommandRuntime(): CommandRuntime & { definitions: Map<string, CommandDefinition> } {
  const definitions = new Map<string, CommandDefinition>()
  let commandSeq = 0
  const runtime: CommandRuntime & { definitions: Map<string, CommandDefinition> } = {
    definitions,
    register: vi.fn((definition: CommandDefinition) => {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    }),
    list: vi.fn((agent: Agent) => {
      const effective = new Map(definitions)
      if (agent.ctx.commands !== runtime) {
        for (const entry of agent.ctx.commands.list(agent)) {
          const definition = agent.ctx.commands.find(agent, entry.name)
          if (definition !== undefined) effective.set(entry.name, definition)
        }
      }
      return [...effective.values()].map(({ handler: _handler, recordInput: _recordInput, ...entry }) => entry)
    }),
    find: vi.fn((agent: Agent, name: string) => {
      if (agent.ctx.commands !== runtime) {
        const scoped = agent.ctx.commands.find(agent, name)
        if (scoped !== undefined) return scoped
      }
      return definitions.get(name)
    }),
    execute: vi.fn(async (
      agent: Agent,
      line: string,
      _images: readonly EncodedImageAttachment[],
      signal: AbortSignal,
    ) => {
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
      const name = match?.[1]
      if (name === undefined || match === null) return undefined
      const definition = runtime.find(agent, name)
      if (definition === undefined) return undefined
      const commandId = `cmd-test-${++commandSeq}` as CommandInvocation['commandId']
      const events = sessionEvents(agent.session) as unknown as Array<{ seq: number; type: string; data: Record<string, unknown> }>
      events.push({
        seq: events.length,
        type: 'command/run',
        data: {
          commandId,
          name,
          ...(definition.recordInput === false ? {} : { args: line.slice(match[0].length) }),
          source: { kind: 'user' },
        },
      })
      const result = await definition.handler({
        commandId,
        agent,
        rawInput: line.slice(match[0].length),
        signal,
      })
      events.push({
        seq: events.length,
        type: 'command/done',
        data: { commandId, kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) },
      })
      return { commandId, result }
    }),
  }
  return runtime
}

const agentRequestListeners = new WeakMap<AgentContext, AgentRequestListener[]>()

const agentPromptSections = new WeakMap<AgentContext, PromptSection[]>()

/** Prompt sections registered through one fake Agent context. */
export function promptSectionsOf(ctx: AgentContext): readonly PromptSection[] {
  return agentPromptSections.get(ctx) ?? []
}

/** Optional host services exposed inside a fake Agent scope. */
export interface FakeAgentServices {
  tools?: ToolRuntime
  attachments?: AttachmentStore
}

export function makeAgentContext(
  commands = makeCommandRuntime(),
  services: FakeAgentServices = {},
): AgentContext {
  const listeners: AgentRequestListener[] = []
  const sections: PromptSection[] = []
  const ctx: AgentContext = {
    commands,
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index !== -1) sections.splice(index, 1)
        }
      },
    },
    ...(services.tools === undefined ? {} : { tools: services.tools }),
    ...(services.attachments === undefined ? {} : { attachments: services.attachments }),
    on(_event, listener, options) {
      const prepend = options === true || (typeof options === 'object' && options.prepend === true)
      if (prepend) listeners.unshift(listener)
      else listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index === -1) return false
        listeners.splice(index, 1)
        return true
      }
    },
    async inject(_dependencies, callback) {
      callback(ctx)
    },
  }
  agentRequestListeners.set(ctx, listeners)
  agentPromptSections.set(ctx, sections)
  return ctx
}

/** Run the fake Agent-scoped request waterfall in registration order. */
export async function dispatchAgentRequest(
  ctx: AgentContext,
  config: AgentRequestConfig,
): Promise<AgentRequestConfig> {
  const listeners = agentRequestListeners.get(ctx) ?? []
  const payload = { turn: 1, step: 0, signal: new AbortController().signal }
  const run = (index: number): Promise<AgentRequestConfig> => {
    const listener = listeners[index]
    return listener === undefined ? Promise.resolve(config) : listener(payload, () => run(index + 1))
  }
  return run(0)
}

/** Fake Agent-scoped tool registry recording every registered definition. */
export function makeToolsRuntime(): ToolRuntime & {
  definitions: Map<string, ToolDefinition>
  register: ReturnType<typeof vi.fn>
} {
  const definitions = new Map<string, ToolDefinition>()
  return {
    definitions,
    register: vi.fn((definition: ToolDefinition) => {
      definitions.set(definition.name, definition)
      return () => {
        definitions.delete(definition.name)
      }
    }),
  }
}

const DEFAULT_FAKE_IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64 * 1024 * 1024,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

export interface FakeAttachmentStoreOptions {
  imageLimits?: Partial<ImageAttachmentLimits>
  /** Throw from `saveImage` (fixed error or per-call decision). */
  failImage?: Error | ((input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }) => Error | undefined)
  /** Throw from `saveFileStream` (fixed error or per-call decision). */
  failFile?: Error | ((input: { name?: string }) => Error | undefined)
}

/** One image committed by the fake native attachment library. */
export interface FakeSavedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

/** One file committed by the fake native attachment library. */
export interface FakeSavedFile {
  readonly data: Uint8Array
  readonly name: string
}

/**
 * Fake host `ctx.attachments`: content-addressed-ish refs, image limits, and
 * per-call recording so tests can assert both the prefetch and the lazy fetch
 * paths without touching the real attachment library.
 */
export function makeAttachmentStore(options: FakeAttachmentStoreOptions = {}): AttachmentStore & {
  savedImages: FakeSavedImage[]
  savedFiles: FakeSavedFile[]
} {
  const savedImages: FakeSavedImage[] = []
  const savedFiles: FakeSavedFile[] = []
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
  const imageRefOf = (data: Uint8Array, mediaType: ImageMediaType, name?: string): ImageAttachmentRef => ({
    attachmentId: `sha256:${digest(data)}`,
    mediaType,
    bytes: data.byteLength,
    width: 2,
    height: 2,
    ...(name === undefined ? {} : { name }),
  })
  const store = {
    savedImages,
    savedFiles,
    imageLimits: { ...DEFAULT_FAKE_IMAGE_LIMITS, ...options.imageLimits },
    saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }) => {
      const failure = typeof options.failImage === 'function' ? options.failImage(input) : options.failImage
      if (failure !== undefined) throw failure
      const ref = imageRefOf(input.data, input.mediaType, input.name)
      savedImages.push({
        data: input.data,
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      return ref
    }),
    saveFileStream: vi.fn(async (input: { data: AsyncIterable<Uint8Array>; name?: string }) => {
      const failure = typeof options.failFile === 'function' ? options.failFile(input) : options.failFile
      if (failure !== undefined) throw failure
      const chunks: Uint8Array[] = []
      for await (const chunk of input.data) chunks.push(chunk)
      const data = new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
      const name = input.name ?? 'file.bin'
      savedFiles.push({ data, name })
      return { attachmentId: `sha256:${digest(data)}`, name, bytes: data.byteLength } satisfies FileAttachmentRef
    }),
    fileHostPath: vi.fn((ref: FileAttachmentRef) =>
      path.join(tmpdir(), 'dsh-channels-fake-attachments', ref.name)),
    imageHostPath: vi.fn((ref: ImageAttachmentRef) =>
      path.join(tmpdir(), 'dsh-channels-fake-attachments', `${ref.attachmentId.slice(-16)}.png`)),
    admitPromptContent: vi.fn(async (content: readonly unknown[]) => content),
    isAttachmentError: vi.fn(() => false),
  }
  return store as unknown as AttachmentStore & { savedImages: FakeSavedImage[]; savedFiles: FakeSavedFile[] }
}

/** Snapshot every followup prompt handed to a fake agent. */
export function followupMessagesOf(agent: Agent): Array<{ content: Array<{ type: string; text?: string; attachment?: unknown }> }> {
  return mockCallsOf(agent.followup).map(call => call[0] as { content: Array<{ type: string; text?: string; attachment?: unknown }> })
}

function mockCallsOf(fn: unknown): unknown[][] {
  return (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls
}


export function makeAgent(session: Session, options: AgentOptions = {}, ctx?: AgentContext): Agent {
  return {
    id: session.id,
    options,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: ctx ?? makeAgentContext(),
    followup: vi.fn(),
  }
}

export interface FakeAgentsOptions {
  failCreate?: Error
  /** When set, `resume()` rejects with this error (before registering anything). */
  failResume?: Error
  /** Runs immediately before a failing `resume()` rejects (race seam: lets a
   *  test register the "winner" agent the way a concurrent cold resume would). */
  onFailResume?: (options: Parameters<AgentRegistry['resume']>[0]) => void
  /** Optional durable Session snapshot returned by the next fake resume. */
  resumeSession?: Session
  /** Host services exposed inside every fake Agent scope (tools/attachments). */
  agentExtras?: FakeAgentServices
}

export function makeAgentRegistry(fail: FakeAgentsOptions = {}): {
  registry: AgentRegistry
  created: Array<{ options: Parameters<AgentRegistry['create']>[0]; handle: AgentHandle; setupCtx: AgentContext }>
  resumed: Array<{ options: Parameters<AgentRegistry['resume']>[0]; handle: AgentHandle; setupCtx: AgentContext }>
  /** Live agents the registry answers to `get()`, mirroring the host's
   *  published-agent registry (create/resume register, dispose unregisters). */
  liveAgents: Map<string, AgentHandle>
} {
  const created: Array<{ options: Parameters<AgentRegistry['create']>[0]; handle: AgentHandle; setupCtx: AgentContext }> = []
  const resumed: Array<{ options: Parameters<AgentRegistry['resume']>[0]; handle: AgentHandle; setupCtx: AgentContext }> = []
  const liveAgents = new Map<string, AgentHandle>()
  const registry: AgentRegistry = {
    async create(options) {
      if (fail.failCreate !== undefined) throw fail.failCreate
      // Mirror the host factory: setup composes the unpublished scope and is
      // awaited BEFORE the session/agent become visible; a rejection rolls the
      // creation back.
      const setupCtx = makeAgentContext(undefined, fail.agentExtras ?? {})
      await options.setup?.(setupCtx)
      const session = makeSession(options.sessionId, options.meta?.cwd, options.meta?.agentPreset)
      const agent = makeAgent(session, options.agentOptions, setupCtx)
      const handle: AgentHandle = { agent, dispose: vi.fn(async () => { liveAgents.delete(options.sessionId) }) }
      liveAgents.set(options.sessionId, handle)
      created.push({ options, handle, setupCtx })
      return handle
    },
    async resume(options) {
      if (fail.failResume !== undefined) {
        fail.onFailResume?.(options)
        throw fail.failResume
      }
      const setupCtx = makeAgentContext(undefined, fail.agentExtras ?? {})
      await options.setup?.(setupCtx)
      const session = fail.resumeSession ?? makeSession(options.resumeSessionId)
      const agent = makeAgent(session, options.agentOptions, setupCtx)
      const handle: AgentHandle = { agent, dispose: vi.fn(async () => { liveAgents.delete(options.resumeSessionId) }) }
      liveAgents.set(options.resumeSessionId, handle)
      resumed.push({ options, handle, setupCtx })
      return handle
    },
    get(id: SessionId) {
      return liveAgents.get(id)?.agent
    },
  }
  return { registry, created, resumed, liveAgents }
}

export function makeWorkspaceRegistry(): { registry: WorkspaceRegistry; workspaces: Map<string, Workspace> } {
  const workspaces = new Map<string, Workspace>()
  const registry: WorkspaceRegistry = {
    async create(dir: string, title?: string) {
      const existing = workspaces.get(dir)
      if (existing !== undefined) return existing
      const workspace: Workspace = {
        id: `ws-${dir}`,
        path: dir,
        title: title ?? path.basename(dir),
        attachSession: vi.fn(),
        detachSession: vi.fn(),
      }
      workspaces.set(dir, workspace)
      return workspace
    },
    list() {
      return [...workspaces.values()]
    },
    async delete(id: string) {
      for (const [path, workspace] of workspaces) {
        if (workspace.id !== id) continue
        workspaces.delete(path)
        return true
      }
      return false
    },
  }
  return { registry, workspaces }
}

interface FakeTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<unknown>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  entries(): IterableIterator<[string, unknown]>
}

export function makeDomain(): { facility: StorageDomainFacility; raw: RawDomainHandle } {
  /** One record map per table name (mirrors the host's per-table layout). */
  const tableData = new Map<string, Map<string, unknown>>()
  const tableHandles = new Map<string, FakeTable>()
  let globalValue: unknown = {}

  const tableFor = (name: string): FakeTable => {
    const existing = tableHandles.get(name)
    if (existing !== undefined) return existing
    let data = tableData.get(name)
    if (data === undefined) {
      data = new Map<string, unknown>()
      tableData.set(name, data)
    }
    const records = data
    const handle: FakeTable = {
      get: (key: string) => records.get(key),
      put: vi.fn(async (key: string, value: unknown) => {
        records.set(key, value)
        return true
      }),
      update: vi.fn(async (key: string, fn: (current: unknown) => unknown) => {
        if (!records.has(key)) throw new Error('missing-key')
        const next = fn(records.get(key))
        records.set(key, next)
        return next
      }),
      delete: vi.fn(async (key: string) => records.delete(key)),
      entries: () => records.entries(),
    }
    tableHandles.set(name, handle)
    return handle
  }

  const raw: RawDomainHandle = {
    table: tableFor,
    global: {
      get: () => globalValue,
      set: vi.fn(async (value: unknown) => {
        globalValue = value
      }),
    },
    close: vi.fn(async () => {}),
  }

  const facility: StorageDomainFacility = {
    open: vi.fn(async () => raw),
  }
  return { facility, raw }
}

/** One fake preset roster entry (`resolve`/`mount`/`list` vi.fn's + call log). */
export interface FakeAgentPresets {
  resolve: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  defaultId: string
  mounts: Array<{ agentCtx: AgentContext; id?: string }>
}

export interface FakeAgentPresetsOptions {
  /** Preset id the roster resolves for any request (default 'standard'). */
  defaultId?: string
  /** Rows `list()` returns (default: one entry for the default preset). */
  roster?: ReadonlyArray<{ id: string; name?: string; description?: string; broken?: string }>
  /** Optional request default installed while the preset mounts. */
  reasoningEffort?: string
  /** When set, `resolve()` rejects with this error. */
  failResolve?: Error
}

/**
 * Fake host roster: `resolve(id)` answers `{ id: id ?? defaultId, path }`,
 * `mount` records `(agentCtx, id)` calls, and `list` reports the roster rows,
 * mirroring the real service's contract closely enough for the plugin's
 * composition and settings-catalog flows.
 */
export function makeAgentPresets(options: FakeAgentPresetsOptions = {}): FakeAgentPresets {
  const mounts: Array<{ agentCtx: AgentContext; id?: string }> = []
  const defaultId = options.defaultId ?? 'standard'
  const presetFor = (id: string | undefined) => ({
    id: id ?? defaultId,
    path: `/presets/${id ?? defaultId}`,
  })
  return {
    resolve: vi.fn(async (id?: string) => {
      if (options.failResolve !== undefined) throw options.failResolve
      return presetFor(id)
    }),
    mount: vi.fn(async (agentCtx: AgentContext, id?: string) => {
      mounts.push({ agentCtx, id })
      if (options.reasoningEffort !== undefined) {
        agentCtx.on('agent/request', async (_payload, next) => ({
          ...(await next()),
          reasoningEffort: options.reasoningEffort,
        }))
      }
      return presetFor(id)
    }),
    list: vi.fn(async () => options.roster ?? [{ id: defaultId }]),
    defaultId,
    mounts,
  }
}

/**
 * Fake effective-directory service mirroring `ctx.workingDirectory`: the
 * Session's directory defaults to its header cwd, and `set` records a durable
 * `working-directory/change` event on the fake log.
 */
export interface FakeWorkingDirectory {
  service: WorkingDirectoryService
  /** Session id → effective directory (only for sessions that moved). */
  dirs: Map<string, string>
  /** Every successful `set` call, in order. */
  sets: Array<{ sessionId: string; path: string }>
  /** Directly move one agent (also records the event and the `sets` entry). */
  apply(agent: Agent, directory: string): void
}

export function makeWorkingDirectory(): FakeWorkingDirectory {
  const dirs = new Map<string, string>()
  const sets: Array<{ sessionId: string; path: string }> = []
  const apply = (agent: Agent, directory: string): void => {
    dirs.set(agent.session.id, directory)
    sets.push({ sessionId: agent.session.id, path: directory })
  }
  const service: WorkingDirectoryService = {
    get(session) {
      return dirs.get(session.id) ?? session.header.cwd ?? ''
    },
    async set(agent, directory) {
      apply(agent, directory)
      return directory
    },
  }
  return { service, dirs, sets, apply }
}

/** Fake Git-worktree service mirroring `ctx.worktrees.create`. */
export interface FakeWorktrees {
  service: WorktreeService
  created: Array<{ sessionId: string; name: string; path: string; branch: string }>
  /** When set, every `create` rejects with this error (fallback-path tests). */
  failWith?: Error
}

export function makeWorktrees(workingDirectory: FakeWorkingDirectory): FakeWorktrees {
  const fake: FakeWorktrees = {
    created: [],
    service: {
      create: vi.fn(async (agent, request = {}): Promise<CreatedWorktree> => {
        if (fake.failWith !== undefined) throw fake.failWith
        const name = request.name ?? `worktree-${fake.created.length}`
        const root = workingDirectory.service.get(agent.session)
        const directory = path.join(root, '.agents', 'worktrees', name)
        mkdirSync(directory, { recursive: true })
        workingDirectory.apply(agent, directory)
        fake.created.push({ sessionId: agent.session.id, name, path: directory, branch: name })
        return { path: directory, branch: name, baseCommit: 'deadbeef', repositoryRoot: root }
      }),
    },
  } as FakeWorktrees
  return fake
}

export function makeHostContext(
  credentialValues?: Record<string, string>,
  agentPresets?: FakeAgentPresets,
  agentsOptions: FakeAgentsOptions = {},
  projections?: SessionProjections,
  extraServices: Record<string, unknown> = {},
): {
  ctx: HostContext
  agents: ReturnType<typeof makeAgentRegistry>
  workspaces: ReturnType<typeof makeWorkspaceRegistry>
  domain: ReturnType<typeof makeDomain>
  workingDirectory: FakeWorkingDirectory
  worktrees: FakeWorktrees
  credentials: {
    resolve: ReturnType<typeof vi.fn>
    describe: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    unset: ReturnType<typeof vi.fn>
    values: Record<string, string>
  }
  sessionListeners: Array<(session: Session, event: SessionEvent) => void>
  assistantStreamListeners: Array<(payload: AssistantStreamPayload) => void>
  approvalListeners: Array<{ listener: ApprovalAnswererListener; options: { prepend?: boolean } | undefined }>
  questionListeners: Array<{ listener: UserQuestionAnswererListener; options: { prepend?: boolean } | undefined }>
  permissions: PermissionPresets & { set: ReturnType<typeof vi.fn>; preset: string }
  sessionQuery: { readTitleSnapshots: ReturnType<typeof vi.fn> }
} {
  const agents = makeAgentRegistry(agentsOptions)
  const workspaces = makeWorkspaceRegistry()
  const domain = makeDomain()
  const workingDirectory = makeWorkingDirectory()
  const worktrees = makeWorktrees(workingDirectory)
  const sessionListeners: Array<(session: Session, event: SessionEvent) => void> = []
  const assistantStreamListeners: Array<(payload: AssistantStreamPayload) => void> = []
  const approvalListeners: Array<{ listener: ApprovalAnswererListener; options: { prepend?: boolean } | undefined }> = []
  const questionListeners: Array<{ listener: UserQuestionAnswererListener; options: { prepend?: boolean } | undefined }> = []
  const tokenMeter = { measure: () => ({ totalTokens: 1234 }) }
  const permissions = {
    preset: 'standard',
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'standard', name: 'Standard' },
      ],
      defaultOptions: [{ value: 'standard', name: 'Standard' }],
      defaultPreset: 'standard',
    }),
    current: () => permissions.preset,
    optionOf: (name: string) => ({ value: name, name }),
    set: vi.fn((_session: Session, name: string) => { permissions.preset = name }),
  }
  const llm = {
    resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 128000 } })),
    listProviders: vi.fn(() => [{ id: 'deepseek-official', name: 'DeepSeek' }]),
    listModels: vi.fn(async () => [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'Flash' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'Pro' },
    ]),
  }
  const commands = makeCommandRuntime()
  const credentials = {
    values: {
      ...(credentialValues === undefined
        ? { FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test_secret' }
        : credentialValues),
    } as Record<string, string>,
    resolve: vi.fn(async (ref: string) => {
      const value = credentials.values[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    }),
    describe: vi.fn(async (ref: string) => ({
      configured: credentials.values[ref] !== undefined,
      writable: true,
      source: credentials.values[ref] === undefined ? undefined : 'file',
    })),
    set: vi.fn(async (ref: string, value: string) => {
      credentials.values[ref] = value
    }),
    unset: vi.fn(async (ref: string) => {
      delete credentials.values[ref]
    }),
  }
  const sessionQuery = {
    readTitleSnapshots: vi.fn(async (ids: readonly string[]) => ids.map(sessionId => ({
      sessionId,
      status: 'fulfilled' as const,
      value: { title: { title: '测试标题', updatedAt: 1 } },
    }))),
  }
  const services: Record<string, unknown> = {
    agents: agents.registry,
    sessionQuery,
    commands,
    workspaceRegistry: workspaces.registry,
    storageDomain: domain.facility,
    tokenMeter,
    llm,
    credentials,
    userQuestions: {},
    permissionPresets: permissions,
    workingDirectory: workingDirectory.service,
    worktrees: worktrees.service,
    ...(agentPresets === undefined ? {} : { agentPresets }),
    ...(projections === undefined ? {} : { sessionProjections: projections }),
    ...extraServices,
  }
  const ctx: HostContext = {
    agents: agents.registry,
    commands,
    workspaceRegistry: workspaces.registry,
    storageDomain: domain.facility,
    credentials,
    tokenMeter,
    llm,
    registry: { size: 0, values: () => new Map().values() },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    get: (name: string) => services[name],
    on: vi.fn((name: unknown, listener?: unknown, options?: unknown) => {
      if (name === 'session/event') {
        const wrapped = listener as (session: Session, event: SessionEvent) => void
        sessionListeners.push(wrapped)
      } else if (name === 'agent/assistant-stream') {
        assistantStreamListeners.push(listener as (payload: AssistantStreamPayload) => void)
      } else if (name === 'approval/request') {
        approvalListeners.push({
          listener: listener as ApprovalAnswererListener,
          options: options as { prepend?: boolean } | undefined,
        })
      } else if (name === 'user-questions/request') {
        questionListeners.push({
          listener: listener as UserQuestionAnswererListener,
          options: options as { prepend?: boolean } | undefined,
        })
      }
      return () => true
    }),
    effect: vi.fn(),
  }
  return {
    ctx, agents, workspaces, domain, credentials, sessionListeners,
    assistantStreamListeners, approvalListeners, questionListeners, permissions, sessionQuery,
    workingDirectory, worktrees,
  }
}

export interface FakeChannelOptions {
  threadIdOfMessage?: (messageId: string) => Promise<string | undefined>
  /** Resource chunks returned by `downloadResource` (one message's payload). */
  downloadResource?: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ) => Uint8Array[] | Promise<Uint8Array[]>
  failFirstSend?: boolean
  failReplyInThread?: boolean
  /** Reject every card send (used to exercise the plain-text fallback). */
  failCardSends?: boolean
  /** Reject Buffer-backed file messages while leaving error-card delivery available. */
  failFileSends?: boolean
  /** Official SDK WebSocket lifecycle snapshot returned by the stub. */
  connectionStatus?: FeishuConnectionStatus
  /** Chat info returned by the `getChatInfo` stub (defaults to a group shell). */
  chatInfo?: (chatId: string) => ChatInfo | Promise<ChatInfo>
}

export function makeChannel(options: FakeChannelOptions = {}): FeishuChannel & {
  sent: Array<{ chatId: string; input: object; options?: { replyTo?: string; replyInThread?: boolean } }>
  updated: Array<{ messageId: string; card: object }>
  reactions: Array<{ messageId: string; emojiType: string }>
  removedReactions: Array<{ messageId: string; reactionId: string }>
  cardActionHandlers: Array<(event: CardActionEvent) => void | Promise<void>>
  /** Dispatch one card action through every registered handler. */
  fireCardAction: (event: CardActionEvent) => Promise<void>
  botAddedHandlers: Array<(event: BotAddedEvent) => void | Promise<void>>
  /** Dispatch one bot-added event through every registered handler. */
  fireBotAdded: (event: BotAddedEvent) => Promise<void>
} {
  const sent: Array<{ chatId: string; input: object; options?: { replyTo?: string; replyInThread?: boolean } }> = []
  const updated: Array<{ messageId: string; card: object }> = []
  const reactions: Array<{ messageId: string; emojiType: string }> = []
  const removedReactions: Array<{ messageId: string; reactionId: string }> = []
  const cardActionHandlers: Array<(event: CardActionEvent) => void | Promise<void>> = []
  const botAddedHandlers: Array<(event: BotAddedEvent) => void | Promise<void>> = []
  let serial = 0

  const channel: FeishuChannel = {
    onMessage: vi.fn(() => () => {}),
    onCardAction: vi.fn((handler: (event: CardActionEvent) => void | Promise<void>) => {
      cardActionHandlers.push(handler)
      return () => {}
    }),
    onBotAdded: vi.fn((handler: (event: BotAddedEvent) => void | Promise<void>) => {
      botAddedHandlers.push(handler)
      return () => {}
    }),
    getChatInfo: vi.fn(async (chatId: string): Promise<ChatInfo> => {
      if (options.chatInfo !== undefined) return options.chatInfo(chatId)
      return { chatId, chatType: 'group' }
    }),
    botOpenId: () => 'bot-open-id',
    getConnectionStatus: vi.fn(() => options.connectionStatus),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (chatId, input, sendOptions) => {
      if (options.failFirstSend) throw new Error('send failed')
      if (options.failCardSends && 'card' in input) throw new Error('card rejected (230099)')
      if (options.failFileSends && 'file' in input) throw new Error('file upload failed')
      if (sendOptions?.replyInThread === true && options.failReplyInThread === true) {
        throw new Error('topic unsupported')
      }
      const messageId = `om_${++serial}`
      sent.push({ chatId, input, options: sendOptions })
      const result: SendResult = { messageId }
      return result
    }),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card })
    }),
    addReaction: vi.fn(async (messageId: string, emojiType: string) => {
      reactions.push({ messageId, emojiType })
      return `react-${reactions.length}`
    }),
    removeReaction: vi.fn(async (messageId: string, reactionId: string) => {
      removedReactions.push({ messageId, reactionId })
    }),
    threadIdOfMessage: options.threadIdOfMessage ?? (async () => `omt_${serial}`),
    downloadResource: vi.fn(async (messageId: string, fileKey: string, type: 'image' | 'file') => {
      const chunks = options.downloadResource === undefined
        ? [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])]
        : await options.downloadResource(messageId, fileKey, type)
      return (async function* (): AsyncGenerator<Uint8Array> {
        for (const chunk of chunks) yield chunk
      })()
    }),
  }
  return Object.assign(channel, {
    sent, updated, reactions, removedReactions, cardActionHandlers, botAddedHandlers,
    fireCardAction: async (event: CardActionEvent) => {
      for (const handler of cardActionHandlers) await handler(event)
    },
    fireBotAdded: async (event: BotAddedEvent) => {
      for (const handler of botAddedHandlers) await handler(event)
    },
  })
}

export function makeMessage(partial: Partial<Omit<NormalizedMessage, 'content'>> & { content: string }): NormalizedMessage {
  return {
    messageId: `om_msg_${Math.random().toString(36).slice(2, 10)}`,
    chatId: 'oc_test_chat',
    chatType: 'group',
    senderId: 'ou_test_user',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    ...partial,
  } as NormalizedMessage
}

export function makeTempBaseDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-channels-test-'))
}
