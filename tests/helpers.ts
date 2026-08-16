/**
 * Shared fakes: a stub Feishu channel and a fake host context surface.
 *
 * @module tests/helpers
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type {
  Agent, AgentHandle, AgentRegistry, HostContext, Session, SessionEvent,
  SessionId, StorageDomainFacility, Workspace, WorkspaceRegistry,
} from '../src/dsh-types.ts'
import type { FeishuChannel, NormalizedMessage, SendResult } from '../src/feishu-channel.ts'
import type { RawDomainHandle } from '../src/domain.ts'

export function makeSession(id = `session-${Math.random().toString(36).slice(2, 10)}`): Session {
  return {
    id: id as SessionId,
    header: { version: 0, id: id as SessionId, createdAt: Date.now() },
    events: [],
    firstLiveSeq: 0,
  }
}

export function makeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
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
}

export function makeAgentRegistry(fail: FakeAgentsOptions = {}): {
  registry: AgentRegistry
  created: Array<{ options: Parameters<AgentRegistry['create']>[0]; handle: AgentHandle; setupCtx: unknown }>
  resumed: Array<{ options: Parameters<AgentRegistry['resume']>[0]; handle: AgentHandle; setupCtx: unknown }>
  /** Live agents the registry answers to `get()`, mirroring the host's
   *  published-agent registry (create/resume register, dispose unregisters). */
  liveAgents: Map<string, AgentHandle>
} {
  const created: Array<{ options: Parameters<AgentRegistry['create']>[0]; handle: AgentHandle; setupCtx: unknown }> = []
  const resumed: Array<{ options: Parameters<AgentRegistry['resume']>[0]; handle: AgentHandle; setupCtx: unknown }> = []
  const liveAgents = new Map<string, AgentHandle>()
  const registry: AgentRegistry = {
    async create(options) {
      if (fail.failCreate !== undefined) throw fail.failCreate
      // Mirror the host factory: setup composes the unpublished scope and is
      // awaited BEFORE the session/agent become visible; a rejection rolls the
      // creation back.
      const setupCtx = {}
      await options.setup?.(setupCtx)
      const session = makeSession(options.sessionId)
      const agent = makeAgent(session)
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
      const setupCtx = {}
      await options.setup?.(setupCtx)
      const session = makeSession(options.resumeSessionId)
      const agent = makeAgent(session)
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
      }
      workspaces.set(dir, workspace)
      return workspace
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

/** One fake preset roster entry (`resolve`/`mount` vi.fn's + call log). */
export interface FakeAgentPresets {
  resolve: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  mounts: Array<{ agentCtx: unknown; id?: string }>
}

export interface FakeAgentPresetsOptions {
  /** Preset id the roster resolves for any request (default 'standard'). */
  defaultId?: string
  /** When set, `resolve()` rejects with this error. */
  failResolve?: Error
}

/**
 * Fake host roster: `resolve(id)` answers `{ id: id ?? defaultId, path }` and
 * `mount` records `(agentCtx, id)` calls, mirroring the real service's
 * contract closely enough for the plugin's composition flow.
 */
export function makeAgentPresets(options: FakeAgentPresetsOptions = {}): FakeAgentPresets {
  const mounts: Array<{ agentCtx: unknown; id?: string }> = []
  const presetFor = (id: string | undefined) => ({
    id: id ?? options.defaultId ?? 'standard',
    path: `/presets/${id ?? options.defaultId ?? 'standard'}`,
  })
  return {
    resolve: vi.fn(async (id?: string) => {
      if (options.failResolve !== undefined) throw options.failResolve
      return presetFor(id)
    }),
    mount: vi.fn(async (agentCtx: unknown, id?: string) => {
      mounts.push({ agentCtx, id })
      return presetFor(id)
    }),
    mounts,
  }
}

export function makeHostContext(
  credentialValues?: Record<string, string>,
  agentPresets?: FakeAgentPresets,
  agentsOptions: FakeAgentsOptions = {},
): {
  ctx: HostContext
  agents: ReturnType<typeof makeAgentRegistry>
  workspaces: ReturnType<typeof makeWorkspaceRegistry>
  domain: ReturnType<typeof makeDomain>
  credentials: { resolve: ReturnType<typeof vi.fn>; values: Record<string, string> }
  sessionListeners: Array<(session: Session, event: SessionEvent) => void>
} {
  const agents = makeAgentRegistry(agentsOptions)
  const workspaces = makeWorkspaceRegistry()
  const domain = makeDomain()
  const sessionListeners: Array<(session: Session, event: SessionEvent) => void> = []
  const tokenMeter = { measure: () => ({ totalTokens: 1234 }) }
  const llm = { resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 128000 } })) }
  const credentials = {
    values: {
      ...(credentialValues === undefined
        ? { FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test_secret' }
        : credentialValues),
    },
    resolve: vi.fn(async (ref: string) => {
      const value = credentials.values[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    }),
  }
  const services: Record<string, unknown> = {
    tokenMeter,
    llm,
    credentials,
    ...(agentPresets === undefined ? {} : { agentPresets }),
  }
  const ctx: HostContext = {
    agents: agents.registry,
    workspaceRegistry: workspaces.registry,
    storageDomain: domain.facility,
    credentials,
    tokenMeter,
    llm,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    get: (name: string) => services[name],
    on: vi.fn((name, listener) => {
      if (name === 'session/event') {
        const wrapped = listener as (session: Session, event: SessionEvent) => void
        sessionListeners.push(wrapped)
      }
      return () => true
    }),
    effect: vi.fn(),
  }
  return { ctx, agents, workspaces, domain, credentials, sessionListeners }
}

export interface FakeChannelOptions {
  threadIdOfMessage?: (messageId: string) => Promise<string | undefined>
  failFirstSend?: boolean
  failReplyInThread?: boolean
  /** Reject every card send (used to exercise the plain-text fallback). */
  failCardSends?: boolean
}

export function makeChannel(options: FakeChannelOptions = {}): FeishuChannel & {
  sent: Array<{ chatId: string; input: object; options?: { replyTo?: string; replyInThread?: boolean } }>
  updated: Array<{ messageId: string; card: object }>
  reactions: Array<{ messageId: string; emojiType: string }>
  removedReactions: Array<{ messageId: string; reactionId: string }>
} {
  const sent: Array<{ chatId: string; input: object; options?: { replyTo?: string; replyInThread?: boolean } }> = []
  const updated: Array<{ messageId: string; card: object }> = []
  const reactions: Array<{ messageId: string; emojiType: string }> = []
  const removedReactions: Array<{ messageId: string; reactionId: string }> = []
  let serial = 0

  const channel: FeishuChannel = {
    onMessage: vi.fn(() => () => {}),
    botOpenId: () => 'bot-open-id',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    async send(chatId, input, sendOptions) {
      if (options.failFirstSend) throw new Error('send failed')
      if (options.failCardSends && 'card' in input) throw new Error('card rejected (230099)')
      if (sendOptions?.replyInThread === true && options.failReplyInThread === true) {
        throw new Error('topic unsupported')
      }
      const messageId = `om_${++serial}`
      sent.push({ chatId, input, options: sendOptions })
      const result: SendResult = { messageId }
      return result
    },
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
  }
  return Object.assign(channel, { sent, updated, reactions, removedReactions })
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
