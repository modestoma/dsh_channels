/**
 * Web settings panel: overlay persistence, Host view-model (surface), HTTP
 * routes, and FeishuService config hot-apply / reconnect integration.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { AgentPreset, HostContext, LlmModelInfo, LlmService } from '../src/dsh-types.ts'
import { FeishuService } from '../src/service.ts'
import { HEALTH_DEPENDENCY_NAMES } from '../src/health.ts'
import type { HealthSnapshot } from '../src/health.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import {
  ACCESS_GROUPS_ROUTE,
  ACCESS_REQUESTS_ROUTE,
  ACCESS_ROUTE,
  ACCESS_USERS_ROUTE,
  CATALOG_ROUTE,
  CONFIG_ROUTE,
  CREDENTIALS_ROUTE,
  EDITABLE_KEYS,
  FIELD_GROUP_LABELS,
  PANEL_COPY,
  PANEL_ROUTE,
  PICK_DIRECTORY_ROUTE,
  PANEL_TABS,
  TAB_FIELD_GROUPS,
  RECONNECT_ROUTE,
  RESTART_KEYS,
  STATUS_ROUTE,
} from '../src/settings/contract.ts'
import type {
  AccessMutationResponse,
  AccessWire,
  CatalogWire,
  EditableValues,
  ScopeCheckWire,
} from '../src/settings/contract.ts'
import {
  OverlayStore,
  configValueOf,
  defaultOverlayPath,
  deleteOverlayKey,
  mergeOverlay,
  mergeOverlayPatch,
  normalizeOverlay,
  overlayValues,
  parseOverlay,
  pickEditable,
  resolveDshHome,
} from '../src/settings/overlay.ts'
import type { OverlayPatch } from '../src/settings/overlay.ts'
import {
  FIELD_DESCRIPTORS,
  SettingsSurface,
  emptyCatalog,
  readOnlyFields,
} from '../src/settings/surface.ts'
import type { SettingsTarget } from '../src/settings/surface.ts'
import { createHostCatalog } from '../src/settings/catalog.ts'
import type { SettingsCatalog } from '../src/settings/catalog.ts'
import type { SettingsDirectoryPicker } from '../src/settings/directory-picker.ts'
import { isSameOriginRequest, registerSettingsRoutes } from '../src/settings/routes.ts'
import type { HostWebServer } from '../src/settings/routes.ts'
import { normalizeWorkspaceBaseDir, prepareWorkspaceBaseDir } from '../src/workspaces.ts'
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
    inactiveFibers: [],
    inactiveTotal: 0,
    reasons: [],
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
  credentialInfo: {
    appId: { configured: boolean; writable: boolean; source?: string }
    appSecret: { configured: boolean; writable: boolean; source?: string }
  } = {
    appId: { configured: true, writable: true, source: 'file' },
    appSecret: { configured: true, writable: true, source: 'file' },
  }
  credentialCalls: Array<{ field: string; value?: string }> = []
  applied: OverlayPatch | undefined
  restartCalls = 0
  connectCalls = 0
  connecting = false
  failRestart: string | undefined
  failConnect: string | undefined
  healthState = healthySnapshot()
  scopeCheckState: ScopeCheckWire | undefined
  /** Admission snapshot handed to the panel (the real service keeps it in memory). */
  accessState: AccessWire = {
    mode: 'guarded',
    admin: { configured: false },
    loaded: true,
    groups: [],
    users: [],
    requests: [],
  }
  /** Every whitelist mutation the surface forwarded (asserted by the tests). */
  accessCalls: Array<Record<string, unknown>> = []
  /** Return one failed wire result instead of mutating (storage error path). */
  failAccess: string | undefined
  /** Thrown instead of returning, to exercise the surface's error folding. */
  throwAccess: string | undefined

  constructor(config: FeishuConfig) {
    this.base = { ...config }
    this.config = { ...config }
    this.running = { ...config }
  }

  isRunning(): boolean { return this.runningFlag }
  isRestarting(): boolean { return this.restarting }
  isConnecting(): boolean { return this.connecting }
  /** The fake credentials never change behind the panel's back. */
  async refreshReadiness(): Promise<void> {}
  /** Readiness mirrors the credential states, like the real service's cache. */
  isConfigured(): boolean {
    return this.credentialInfo.appId.configured && this.credentialInfo.appSecret.configured
  }
  missingConfig(): readonly string[] {
    const missing: string[] = []
    if (!this.credentialInfo.appId.configured) missing.push('FEISHU_APP_ID（飞书 App ID）')
    if (!this.credentialInfo.appSecret.configured) missing.push('FEISHU_APP_SECRET（飞书 App Secret）')
    return missing
  }
  health(): HealthSnapshot { return this.healthState }
  startedAtMs(): number | undefined { return 1_000 }
  uptimeMs(): number | undefined { return this.runningFlag ? 60_000 : undefined }
  startError(): string | undefined { return this.startErrorText }
  scopeCheck(): ScopeCheckWire | undefined { return this.scopeCheckState }
  configSnapshot(): FeishuConfig { return { ...this.config } }
  baseConfigSnapshot(): FeishuConfig { return { ...this.base } }
  runningConfigSnapshot(): FeishuConfig | undefined {
    return this.running === undefined ? undefined : { ...this.running }
  }

  applyOverlay(overlay: OverlayPatch): void {
    this.applied = overlay
    this.config = mergeOverlay(this.base, overlay)
  }

  async restart(): Promise<void> {
    this.restartCalls++
    if (this.failRestart !== undefined) throw new Error(this.failRestart)
    this.running = { ...this.config }
  }

  async connect(): Promise<void> {
    this.connectCalls++
    if (this.failConnect !== undefined) throw new Error(this.failConnect)
    if (!this.isConfigured()) throw new Error('飞书应用凭据尚未配置完整')
    this.runningFlag = true
    this.running = { ...this.config }
    this.startErrorText = undefined
  }

  async credentialStates(): Promise<{
    appId: { configured: boolean; writable: boolean; source?: string }
    appSecret: { configured: boolean; writable: boolean; source?: string }
  }> {
    return this.credentialInfo
  }

  async setCredential(field: 'appId' | 'appSecret', value: string): Promise<void> {
    this.credentialCalls.push({ field, value })
    this.credentialInfo[field] = { configured: true, writable: true, source: 'file' }
  }

  async clearCredential(field: 'appId' | 'appSecret'): Promise<void> {
    this.credentialCalls.push({ field })
    this.credentialInfo[field] = { configured: false, writable: true }
  }

  accessSnapshot(): AccessWire {
    return structuredClone(this.accessState)
  }

  async addAccessGroup(chatId: string, name?: string): Promise<AccessMutationResponse> {
    this.accessCalls.push({ op: 'add-group', chatId, name })
    const failed = this.accessFailure()
    if (failed !== undefined) return failed
    if (!this.accessState.groups.some(group => group.chatId === chatId)) {
      this.accessState.groups.push({
        chatId,
        ...(name === undefined ? {} : { name }),
        source: 'panel',
        addedAt: 1_700_000_000_000,
      })
    }
    return { ok: true, access: this.accessSnapshot() }
  }

  async removeAccessGroup(chatId: string): Promise<AccessMutationResponse> {
    this.accessCalls.push({ op: 'remove-group', chatId })
    const failed = this.accessFailure()
    if (failed !== undefined) return failed
    this.accessState.groups = this.accessState.groups.filter(group => group.chatId !== chatId)
    return { ok: true, access: this.accessSnapshot() }
  }

  async addAccessUser(userId: string, name?: string): Promise<AccessMutationResponse> {
    this.accessCalls.push({ op: 'add-user', userId, name })
    const failed = this.accessFailure()
    if (failed !== undefined) return failed
    if (!this.accessState.users.some(user => user.userId === userId)) {
      this.accessState.users.push({
        userId,
        ...(name === undefined ? {} : { name }),
        source: 'panel',
        addedAt: 1_700_000_000_000,
      })
    }
    return { ok: true, access: this.accessSnapshot() }
  }

  async removeAccessUser(userId: string): Promise<AccessMutationResponse> {
    this.accessCalls.push({ op: 'remove-user', userId })
    const failed = this.accessFailure()
    if (failed !== undefined) return failed
    this.accessState.users = this.accessState.users.filter(user => user.userId !== userId)
    return { ok: true, access: this.accessSnapshot() }
  }

  async resolveAccessRequest(token: string, decision: 'allow' | 'deny'): Promise<AccessMutationResponse> {
    this.accessCalls.push({ op: 'resolve', token, decision })
    const failed = this.accessFailure()
    if (failed !== undefined) return failed
    const request = this.accessState.requests.find(item => item.token === token)
    if (request === undefined) return { ok: false, error: '申请不存在或已结算' }
    this.accessState.requests = this.accessState.requests.filter(item => item.token !== token)
    if (decision === 'allow') {
      if (request.kind === 'group') {
        this.accessState.groups.push({
          chatId: request.targetId,
          ...(request.name === undefined ? {} : { name: request.name }),
          source: 'card',
          addedAt: 1_700_000_000_000,
        })
      } else {
        this.accessState.users.push({
          userId: request.targetId,
          ...(request.name === undefined ? {} : { name: request.name }),
          source: 'card',
          addedAt: 1_700_000_000_000,
        })
      }
    }
    return { ok: true, access: this.accessSnapshot() }
  }

  private accessFailure(): { ok: false; error: string } | undefined {
    if (this.throwAccess !== undefined) throw new Error(this.throwAccess)
    if (this.failAccess !== undefined) return { ok: false, error: this.failAccess }
    return undefined
  }
}

function makeSurface(
  partial: Partial<FeishuConfig> = {},
  catalog?: SettingsCatalog,
  directoryPicker?: SettingsDirectoryPicker,
): {
  surface: SettingsSurface
  target: FakeTarget
  store: OverlayStore
  file: string
} {
  const file = tempOverlayFile()
  const target = new FakeTarget(makeConfig(partial))
  const store = new OverlayStore(file)
  return {
    surface: new SettingsSurface(target, store, undefined, catalog, directoryPicker),
    target,
    store,
    file,
  }
}

/** Stub native directory picker whose outcome is decided per test. */
function stubPicker(outcome: () => Promise<string | null>): SettingsDirectoryPicker {
  return { available: true, pick: outcome }
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

  it('accepts only absolute workspace roots and expands ~ for the panel', () => {
    const absolute = parseOverlay({ baseDir: '/tmp/dsh-channels-ws/' })
    expect(absolute.ok).toBe(true)
    if (!absolute.ok) return
    expect(absolute.patch.baseDir).toBe('/tmp/dsh-channels-ws')

    const home = parseOverlay({ baseDir: '~/channels-data' })
    expect(home.ok).toBe(true)
    if (!home.ok) return
    expect(home.patch.baseDir).toBe(path.join(homedir(), 'channels-data'))

    for (const raw of ['./channels-data', 'channels-data', '   ', '/', 42]) {
      const parsed = parseOverlay({ baseDir: raw })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.issues.map(issue => issue.path)).toContain('baseDir')
    }
  })

  it('normalizes workspace roots with a pinned home directory and rejects hostile values', () => {
    expect(normalizeWorkspaceBaseDir('/data/ws/', '/home/tester')).toEqual({ ok: true, value: '/data/ws' })
    expect(normalizeWorkspaceBaseDir('~', '/home/tester')).toEqual({ ok: true, value: '/home/tester' })
    expect(normalizeWorkspaceBaseDir('~/ws', '/home/tester'))
      .toEqual({ ok: true, value: path.join('/home/tester', 'ws') })
    expect(normalizeWorkspaceBaseDir('ws', '/home/tester').ok).toBe(false)
    expect(normalizeWorkspaceBaseDir('/', '/home/tester').ok).toBe(false)
    expect(normalizeWorkspaceBaseDir(' /ws/\u0000 ', '/home/tester').ok).toBe(false)
    expect(normalizeWorkspaceBaseDir(42, '/home/tester').ok).toBe(false)
  })

  it('creates the workspace root on save and refuses an unusable directory', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-channels-prepare-'))
    const nested = path.join(root, 'nested', 'workspaces')
    await expect(prepareWorkspaceBaseDir(nested)).resolves.toBeUndefined()
    expect(statSync(nested).isDirectory()).toBe(true)

    const occupied = path.join(root, 'not-a-dir')
    writeFileSync(occupied, 'x')
    await expect(prepareWorkspaceBaseDir(occupied)).resolves.toMatch(/不是目录|无法创建工作区目录/)
  })

  it('merges over the profile config and keeps empty optional text out of the overlay', () => {
    const base = makeConfig({ provider: 'deepseek-official' })
    const merged = mergeOverlay(base, normalizeOverlay({ provider: '', dmMode: 'disabled' }))
    expect(merged.provider).toBe('deepseek-official')
    expect(merged.dmMode).toBe('disabled')
    expect(pickEditable(merged).dmMode).toBe('disabled')
  })

  it('validates nested feishuTools keys and stores only the edited sub-fields', () => {
    const ok = parseOverlay({
      dmMode: 'disabled',
      feishuTools: { attachmentFetch: false, attachmentFetchTimeoutMs: 60_000 },
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.patch).toEqual({
      dmMode: 'disabled',
      feishuTools: { attachmentFetch: false, attachmentFetchTimeoutMs: 60_000 },
    })

    // Canonical schema defaults must not leak into the overlay.
    const single = parseOverlay({ feishuTools: { topicMessages: false } })
    expect(single.ok).toBe(true)
    if (!single.ok) return
    expect(single.patch).toEqual({ feishuTools: { topicMessages: false } })

    const invalid = parseOverlay({
      feishuTools: { topicMessagesTimeoutMs: 10, attachmentFetchMaxResources: 0 },
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'feishuTools.topicMessagesTimeoutMs',
      'feishuTools.attachmentFetchMaxResources',
    ]))

    const notObject = parseOverlay({ feishuTools: 'yes' })
    expect(notObject.ok).toBe(false)
    if (notObject.ok) return
    expect(notObject.issues.map(issue => issue.path)).toContain('feishuTools')
  })

  it('merges nested feishuTools over the profile config without dropping sibling keys', () => {
    const base = makeConfig({ attachmentStore: 'native' })
    const merged = mergeOverlay(base, { feishuTools: { attachmentFetch: false } })
    expect(merged.feishuTools.attachmentFetch).toBe(false)
    expect(merged.feishuTools.topicMessages).toBe(true)
    expect(merged.feishuTools.attachmentFetchMaxBytes).toBe(base.feishuTools.attachmentFetchMaxBytes)
    expect(configValueOf(merged, 'feishuTools.attachmentFetch')).toBe(false)
    expect(configValueOf(merged, 'attachmentStore')).toBe('native')

    // A pre-v2 overlay (flat keys only) still validates, keys of removed
    // settings (workspace retention) are dropped, and every new key falls back
    // to the profile/default layer.
    const old = normalizeOverlay({ requireMention: false, workspaceRetention: '30d', workspaceRetentionAuto: true })
    expect(old).toEqual({ requireMention: false })
    const migrated = mergeOverlay(base, old)
    expect(migrated.requireMention).toBe(false)
    expect(migrated.attachmentStore).toBe('native')
    expect(migrated.prefetchImages).toBe(true)
    expect(migrated.feishuTools.attachmentFetch).toBe(true)
  })

  it('deep-merges and clears nested overlay keys', () => {
    const first = normalizeOverlay({ feishuTools: { attachmentFetch: false, topicMessages: false } })
    const second = normalizeOverlay({ feishuTools: { attachmentFetch: true } })
    const merged = mergeOverlayPatch(first, second)
    expect(merged.feishuTools).toEqual({ attachmentFetch: true, topicMessages: false })
    deleteOverlayKey(merged, 'feishuTools.topicMessages')
    expect(merged.feishuTools).toEqual({ attachmentFetch: true })
    deleteOverlayKey(merged, 'feishuTools.attachmentFetch')
    expect(merged.feishuTools).toBeUndefined()
    // Wire projection uses the flat dotted key space the form renders.
    expect(overlayValues(first)).toEqual({
      'feishuTools.attachmentFetch': false,
      'feishuTools.topicMessages': false,
    })
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

  it('round-trips nested feishuTools overrides in the hand-editable nested shape', async () => {
    const file = tempOverlayFile()
    const store = new OverlayStore(file)
    await store.save({ feishuTools: { attachmentFetch: false, attachmentFetchMaxBytes: 2048 } })
    await expect(store.load()).resolves.toEqual({
      feishuTools: { attachmentFetch: false, attachmentFetchMaxBytes: 2048 },
    })
    // The file mirrors the profile config shape, so an operator can edit it by hand.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      feishuTools: { attachmentFetch: false, attachmentFetchMaxBytes: 2048 },
    })
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
    expect(byKey.has('baseDir')).toBe(false)
  })

  it('exposes the workspace root as an editable full-width path field', () => {
    const baseDir = FIELD_DESCRIPTORS.find(field => field.key === 'baseDir')
    expect(baseDir).toMatchObject({
      kind: 'text',
      group: 'workspace',
      restartRequired: false,
      wide: true,
    })
    expect(baseDir?.label).toContain('工作区')
    expect(baseDir?.help).toContain('绝对路径')
  })

  it('maps every editable field group onto exactly one panel tab', () => {
    const rendered = new Set<string>()
    for (const tab of PANEL_TABS) {
      for (const group of TAB_FIELD_GROUPS[tab.id]) {
        expect(rendered.has(group), `group ${group} rendered twice`).toBe(false)
        rendered.add(group)
      }
    }
    const groups = new Set(FIELD_DESCRIPTORS.map(field => field.group))
    for (const group of groups) {
      expect(rendered.has(group), `group ${group} has no tab`).toBe(true)
      expect(FIELD_GROUP_LABELS[group].length).toBeGreaterThan(0)
    }
    // The connection tab owns credentials instead of a field group.
    expect(TAB_FIELD_GROUPS.connection).toEqual([])
  })

  it('describes the access-control fields without restarting the channel', () => {
    const byKey = new Map(FIELD_DESCRIPTORS.map(field => [field.key, field]))
    for (const key of ['adminUserId', 'accessMode', 'authRequestTtlDays'] as const) {
      expect(EDITABLE_KEYS).toContain(key)
      expect(byKey.get(key)).toMatchObject({ group: 'access', restartRequired: false })
    }

    const admin = byKey.get('adminUserId')
    expect(admin).toMatchObject({ kind: 'text' })
    expect(admin?.label).toContain('管理员')
    expect(admin?.help).toContain('/userid')
    expect(admin?.help).toContain('u_')

    const mode = byKey.get('accessMode')
    expect(mode).toMatchObject({ kind: 'select' })
    expect(mode?.options?.map(option => option.value)).toEqual(['guarded', 'open'])
    expect(mode?.options?.find(option => option.value === 'guarded')?.label).toContain('守卫')
    expect(mode?.options?.find(option => option.value === 'open')?.label).toContain('不安全')

    const ttl = byKey.get('authRequestTtlDays')
    expect(ttl).toMatchObject({ kind: 'number', min: 1, max: 30, step: 1 })
    expect(ttl?.label).toContain('有效期')
    expect(ttl?.help).toContain('过期')
  })

  it('describes the attachment toggle instead of the old image and retention keys', () => {
    const keys = EDITABLE_KEYS as readonly string[]
    expect(keys).not.toContain('acceptImages')
    expect(keys).not.toContain('maxImagesPerMessage')
    expect(keys).not.toContain('workspaceRetention')
    expect(keys).not.toContain('workspaceRetentionAuto')

    const byKey = new Map(FIELD_DESCRIPTORS.map(field => [field.key, field]))
    expect(byKey.get('acceptAttachments')).toMatchObject({
      kind: 'boolean',
      group: 'content',
      restartRequired: false,
    })
  })

  it('describes the v2 attachment pipeline and model-tool fields with bounds', () => {
    const byKey = new Map(FIELD_DESCRIPTORS.map(field => [field.key, field]))
    const store = byKey.get('attachmentStore')
    expect(store).toMatchObject({ kind: 'select', group: 'content', restartRequired: false })
    expect(store?.options?.map(option => option.value)).toEqual(['native', 'archive'])
    expect(store?.options?.find(option => option.value === 'native')?.label).toContain('原生')
    expect(store?.help).toContain('不可变')

    expect(byKey.get('prefetchImages')).toMatchObject({ kind: 'boolean', group: 'content' })
    expect(byKey.get('prefetchTimeoutMs')).toMatchObject({
      kind: 'number', group: 'content', min: 100, max: 120_000,
    })
    expect(byKey.get('prefetchImageMaxBytes')).toMatchObject({ kind: 'number', min: 1 })
    expect(byKey.get('prefetchTotalMaxBytes')).toMatchObject({ kind: 'number', min: 1 })
    expect(byKey.get('historyBootstrapLimit')).toMatchObject({ kind: 'number', min: 0, max: 20 })
    expect(byKey.get('promptContextTimeoutMs')).toMatchObject({ kind: 'number', group: 'tools' })
    expect(byKey.get('feishuTools.attachmentFetch')).toMatchObject({
      kind: 'boolean', group: 'tools', restartRequired: false,
    })
    expect(byKey.get('feishuTools.attachmentFetchMaxResources')).toMatchObject({
      kind: 'number', min: 1, max: 50,
    })
    expect(byKey.get('feishuTools.attachmentFetchMaxBytes')).toMatchObject({ kind: 'number', min: 1 })
    expect(byKey.get('feishuTools.attachmentFetchTimeoutMs')).toMatchObject({
      kind: 'number', min: 1_000, max: 600_000,
    })
    expect(byKey.get('feishuTools.topicMessages')).toMatchObject({ kind: 'boolean', group: 'tools' })
    expect(byKey.get('feishuTools.topicMessagesTimeoutMs')).toMatchObject({
      kind: 'number', min: 1_000, max: 120_000,
    })
    // Every new descriptor renders under the「会话与行为」tab.
    const toolOrContent = new Set([
      'attachmentStore', 'prefetchImages', 'prefetchTimeoutMs',
      'historyBootstrapLimit', 'feishuTools.attachmentFetch', 'feishuTools.topicMessages',
    ])
    for (const field of FIELD_DESCRIPTORS) {
      if (!toolOrContent.has(field.key)) continue
      expect(TAB_FIELD_GROUPS.sessions).toContain(field.group)
    }
  })

  it('describes where attachments live and that directories are never deleted automatically', () => {
    expect(PANEL_COPY.workspaceTabHelp).toContain('原生附件库')
    expect(PANEL_COPY.workspaceTabHelp).toContain('不会自动删除')

    const byKey = new Map(FIELD_DESCRIPTORS.map(field => [field.key, field]))
    expect(byKey.get('acceptAttachments')?.help).toContain('原生附件库')
  })
})

/** A complete catalog as the Host would resolve it for one configured route. */
const SAMPLE_CATALOG: CatalogWire = {
  provider: {
    selectable: true,
    options: [
      { value: '', label: '留空 = 部署默认（deepseek-account）' },
      { value: 'deepseek-account', label: 'DeepSeek（deepseek-account）' },
    ],
  },
  model: {
    selectable: true,
    options: [
      { value: '', label: '留空 = 部署默认（deepseek-flash）' },
      { value: 'deepseek-flash', label: 'deepseek-flash' },
      { value: 'deepseek-pro', label: 'deepseek-pro' },
    ],
  },
  reasoningEffort: {
    selectable: true,
    options: [
      { value: '', label: '留空 = 适配器默认（max）' },
      { value: 'low', label: 'low' },
      { value: 'max', label: 'max' },
    ],
  },
  agentPreset: {
    selectable: true,
    options: [
      { value: '', label: '留空 = roster 默认（standard）' },
      { value: 'standard', label: '标准（standard）' },
    ],
  },
  deploymentDefault: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  defaultPresetId: 'standard',
}

function makeCatalog(wire: CatalogWire = SAMPLE_CATALOG): {
  catalog: SettingsCatalog
  calls: Array<{ provider?: string; model?: string }>
} {
  const calls: Array<{ provider?: string; model?: string }> = []
  return {
    calls,
    catalog: {
      async catalog(provider?: string, model?: string): Promise<CatalogWire> {
        calls.push({ provider, model })
        return structuredClone(wire)
      },
    },
  }
}

interface CatalogHostOptions {
  providers?: readonly { id: string; name: string }[]
  models?: readonly LlmModelInfo[]
  modelInfo?: LlmModelInfo | Error
  presets?: readonly AgentPreset[] | Error
  defaultPresetId?: string
  deployment?: { provider: string; model: string; reasoningEffort?: string }
}

/** Minimal host context carrying only what createHostCatalog reads. */
function makeCatalogHost(options: CatalogHostOptions = {}): HostContext {
  const llm: LlmService = {
    async resolveModelInfo(): Promise<LlmModelInfo> {
      const info = options.modelInfo
      if (info instanceof Error) throw info
      return info ?? {
        provider: 'deepseek-account',
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        context: { contextWindow: 128_000 },
      }
    },
    ...(options.providers === undefined ? {} : { listProviders: () => options.providers! }),
    listModels: async () => options.models ?? [],
  }
  const services: Record<string, unknown> = {}
  const presetRows = options.presets
  if (presetRows !== undefined) {
    services.agentPresets = {
      defaultId: options.defaultPresetId,
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      mount: async () => ({ id: 'standard' }),
      list: async () => {
        if (presetRows instanceof Error) throw presetRows
        return presetRows
      },
    }
  }
  if (options.deployment !== undefined) {
    services.agentDefaultModel = { currentSelection: () => options.deployment }
  }
  return {
    llm,
    get: (name: string) => services[name],
  } as unknown as HostContext
}

describe('host selector catalog', () => {
  it('maps live providers, models, efforts, presets, and deployment defaults', async () => {
    const warnings: string[] = []
    const ctx = makeCatalogHost({
      providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
      models: [
        { provider: 'deepseek-account', id: 'deepseek-flash', name: 'deepseek-flash' },
        { provider: 'deepseek-account', id: 'deepseek-pro', name: 'Pro' },
      ],
      modelInfo: {
        provider: 'deepseek-account',
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }],
          defaultEffort: 'max',
        },
      },
      presets: [
        { id: 'standard', name: '标准' },
        { id: 'minimal' },
        { id: 'broken', broken: '缺少插件' },
      ],
      defaultPresetId: 'standard',
      deployment: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    })
    const wire = await createHostCatalog(ctx, message => { warnings.push(message) })
      .catalog('deepseek-account', 'deepseek-flash')

    expect(wire.provider.selectable).toBe(true)
    expect(wire.provider.options.map(option => option.value)).toEqual(['', 'deepseek-account'])
    expect(wire.provider.options[1]?.label).toBe('DeepSeek（deepseek-account）')
    expect(wire.provider.options[0]?.label).toContain('deepseek-account')

    expect(wire.model.selectable).toBe(true)
    expect(wire.model.options.map(option => option.value)).toEqual(['', 'deepseek-flash', 'deepseek-pro'])
    expect(wire.model.options[2]?.label).toBe('Pro（deepseek-pro）')

    expect(wire.reasoningEffort.selectable).toBe(true)
    expect(wire.reasoningEffort.options.map(option => option.value)).toEqual(['', 'low', 'max'])
    expect(wire.reasoningEffort.options[0]?.label).toContain('max')

    expect(wire.agentPreset.selectable).toBe(true)
    expect(wire.agentPreset.options.map(option => option.value)).toEqual(['', 'standard', 'minimal', 'broken'])
    expect(wire.agentPreset.options[0]?.label).toContain('standard')
    expect(wire.agentPreset.options.find(option => option.value === 'broken')?.label).toContain('不可用')

    expect(wire.deploymentDefault).toEqual({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    expect(wire.defaultPresetId).toBe('standard')
    expect(warnings).toEqual([])
  })

  it('shows the model selector disabled until a provider is chosen', async () => {
    const ctx = makeCatalogHost({
      providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
      models: [{ provider: 'deepseek-account', id: 'deepseek-flash', name: 'deepseek-flash' }],
      deployment: { provider: 'deepseek-account', model: 'deepseek-flash' },
    })
    const wire = await createHostCatalog(ctx).catalog()
    expect(wire.provider.selectable).toBe(true)
    expect(wire.model.selectable).toBe(true)
    expect(wire.model.disabled).toBe(true)
    expect(wire.model.options.map(option => option.value)).toEqual([''])
    expect(wire.model.options[0]?.label).toContain('deepseek-flash')
    expect(wire.reasoningEffort.disabled).toBe(true)
  })

  it('disables reasoning effort when the model declares no levels', async () => {
    const ctx = makeCatalogHost({
      providers: [{ id: 'p', name: 'P' }],
      models: [{ provider: 'p', id: 'm', name: 'm' }],
      modelInfo: { provider: 'p', id: 'm', name: 'm' },
    })
    const wire = await createHostCatalog(ctx).catalog('p', 'm')
    expect(wire.reasoningEffort.selectable).toBe(true)
    expect(wire.reasoningEffort.disabled).toBe(true)
    expect(wire.reasoningEffort.options).toHaveLength(1)
    expect(wire.reasoningEffort.help).toContain('推理档位')
  })

  it('keeps provider/model selects degraded independently and warns on failed lookups', async () => {
    const warnings: string[] = []
    const ctx = makeCatalogHost({
      models: [{ provider: 'p', id: 'm', name: 'm' }],
      modelInfo: new Error('adapter down'),
      presets: new Error('roster down'),
    })
    const wire = await createHostCatalog(ctx, (message, ...args) => { warnings.push([message, ...args].join(' ')) })
      .catalog('p', 'm')
    expect(wire.provider.selectable).toBe(false)
    expect(wire.model.selectable).toBe(true)
    expect(wire.reasoningEffort.selectable).toBe(false)
    expect(wire.agentPreset.selectable).toBe(false)
    expect(warnings.some(message => message.includes('model-info'))).toBe(true)
    expect(warnings.some(message => message.includes('presets'))).toBe(true)
  })

  it('labels the inherit choices plainly without a deployment default', async () => {
    const ctx = makeCatalogHost({
      providers: [{ id: 'p', name: 'P' }],
      models: [{ provider: 'p', id: 'm', name: 'm' }],
    })
    const wire = await createHostCatalog(ctx).catalog('p', 'm')
    expect(wire.provider.options[0]?.label).toBe('留空 = 部署默认')
    expect(wire.deploymentDefault).toBeUndefined()
    expect(wire.agentPreset.selectable).toBe(false)
  })
})

describe('settings panel selector catalog', () => {
  it('renders the four model fields as host-driven selects', async () => {
    const fake = makeCatalog()
    const { surface } = makeSurface({ provider: 'deepseek-account', model: 'deepseek-flash' }, fake.catalog)
    const panel = await surface.panel()
    const byKey = new Map(panel.config.fields.map(field => [field.key, field]))
    for (const key of ['provider', 'model', 'reasoningEffort', 'agentPreset'] as const) {
      expect(byKey.get(key)?.kind).toBe('select')
      expect(byKey.get(key)?.options?.[0]?.value).toBe('')
    }
    expect(fake.calls).toEqual([{ provider: 'deepseek-account', model: 'deepseek-flash' }])
  })

  it('keeps an unlisted configured value visible as an extra option', async () => {
    const fake = makeCatalog()
    const { surface } = makeSurface({
      provider: 'legacy-provider',
      model: 'legacy-model',
      reasoningEffort: 'high',
      agentPreset: 'legacy-preset',
    }, fake.catalog)
    const panel = await surface.panel()
    const byKey = new Map(panel.config.fields.map(field => [field.key, field]))
    expect(byKey.get('provider')?.options?.map(option => option.value))
      .toEqual(['', 'legacy-provider', 'deepseek-account'])
    expect(byKey.get('provider')?.options?.[1]?.label).toContain('当前配置')
    expect(byKey.get('model')?.options?.map(option => option.value))
      .toEqual(['', 'legacy-model', 'deepseek-flash', 'deepseek-pro'])
    expect(byKey.get('reasoningEffort')?.options?.map(option => option.value))
      .toEqual(['', 'high', 'low', 'max'])
    expect(byKey.get('agentPreset')?.options?.map(option => option.value))
      .toEqual(['', 'legacy-preset', 'standard'])
  })

  it('keeps the free-text controls when the host exposes no catalog', async () => {
    const { surface } = makeSurface()
    const panel = await surface.panel()
    const byKey = new Map(panel.config.fields.map(field => [field.key, field]))
    for (const key of ['provider', 'model', 'reasoningEffort', 'agentPreset'] as const) {
      expect(byKey.get(key)?.kind).toBe('text')
    }
  })

  it('sanitizes catalog queries and degrades a failing lookup', async () => {
    const calls: Array<{ provider?: string; model?: string }> = []
    const ok = makeSurface({}, {
      async catalog(provider?: string, model?: string): Promise<CatalogWire> {
        calls.push({ provider, model })
        return SAMPLE_CATALOG
      },
    })
    await ok.surface.catalogFor('   ', 'x'.repeat(500))
    expect(calls[0]).toEqual({ provider: undefined, model: undefined })
    await ok.surface.catalogFor('provider\u0001', 'model')
    expect(calls[1]).toEqual({ provider: undefined, model: 'model' })

    const broken = makeSurface({}, {
      async catalog(): Promise<CatalogWire> {
        throw new Error('catalog down')
      },
    })
    await expect(broken.surface.catalogFor('p', 'm')).resolves.toEqual(emptyCatalog())
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
    expect(panel.status.phase).toBe('connected')
    expect(panel.status.configured).toBe(true)
    expect(panel.status.missingConfig).toEqual([])
    expect(panel.status.connection?.state).toBe('connected')
    expect(panel.status.version.length).toBeGreaterThan(0)
    expect(panel.status.overlayPath).toBe(file)
    expect(panel.config.overriddenKeys).toEqual(['dmMode'])
    expect(panel.config.overlay).toEqual({ dmMode: 'disabled' })
    expect(panel.config.effective.dmMode).toBe('disabled')
    expect(panel.config.base.dmMode).toBe('open')
    expect(panel.config.credentials.appId).toEqual({ ref: 'FEISHU_APP_ID', configured: true, writable: true, source: 'file' })
    expect(panel.config.fields).toHaveLength(EDITABLE_KEYS.length)
    expect(panel.config.restartPendingKeys).toEqual([])
    expect(panel.status.reasons).toEqual([])
  })

  it('marks the workspace root as browsable only when a native chooser is mounted', async () => {
    const withPicker = makeSurface({}, undefined, stubPicker(async () => '/tmp/ws'))
    const panelWith = await withPicker.surface.panel()
    const base = panelWith.config.fields.find(field => field.key === 'baseDir')
    expect(base).toMatchObject({ kind: 'text', browse: 'directory' })
    expect(panelWith.config.fields.filter(field => field.browse !== undefined).map(field => field.key))
      .toEqual(['baseDir'])

    const withoutPicker = await makeSurface().surface.panel()
    expect(withoutPicker.config.fields.some(field => field.browse !== undefined)).toBe(false)
  })

  it('derives the connecting / unconfigured phases honestly', async () => {
    const connecting = makeSurface()
    connecting.target.connecting = true
    expect((await connecting.surface.status()).phase).toBe('connecting')

    const restarting = makeSurface()
    restarting.target.restarting = true
    expect((await restarting.surface.status()).phase).toBe('connecting')

    // Booting without credentials: in flight, but there is nothing to connect.
    const bootingUnconfigured = makeSurface()
    bootingUnconfigured.target.connecting = true
    bootingUnconfigured.target.credentialInfo.appSecret = { configured: false, writable: true }
    expect((await bootingUnconfigured.surface.status()).phase).toBe('unconfigured')

    // A live socket outranks a missing credential: removing a stored value does
    // not disconnect, so the panel keeps the connection actions available.
    const runningWithoutCredentials = makeSurface()
    runningWithoutCredentials.target.credentialInfo.appSecret = { configured: false, writable: true }
    const status = await runningWithoutCredentials.surface.status()
    expect(status.phase).toBe('connected')
    expect(status.configured).toBe(false)
    expect(status.missingConfig).toEqual(['FEISHU_APP_SECRET（飞书 App Secret）'])
  })

  it('carries the scope self-check only while the channel runs', async () => {
    const { surface, target } = makeSurface()
    expect((await surface.status()).scopeCheck).toBeUndefined()
    target.scopeCheckState = { state: 'ok', checkedAt: 5 }
    expect((await surface.status()).scopeCheck).toEqual({ state: 'ok', checkedAt: 5 })
    target.runningFlag = false
    expect((await surface.status()).scopeCheck).toBeUndefined()
  })

  it('surfaces the health reasons that explain a degraded level', async () => {
    const { surface, target } = makeSurface()
    target.healthState = healthySnapshot({
      level: 'degraded',
      reasons: ['宿主其它插件仍有 2 个入口在等待依赖或加载/卸载（与飞书通道无关）：a、b'],
    })
    const panel = await surface.panel()
    expect(panel.status.level).toBe('degraded')
    expect(panel.status.reasons).toEqual([
      '宿主其它插件仍有 2 个入口在等待依赖或加载/卸载（与飞书通道无关）：a、b',
    ])
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
    const result = await surface.save({ requireMention: false, acceptAttachments: false, provider: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.clearedKeys).toEqual(['provider'])
    await expect(store.load()).resolves.toEqual({ requireMention: false, acceptAttachments: false })
    expect(target.applied).toEqual({ requireMention: false, acceptAttachments: false })
    expect(result.panel.config.overriddenKeys).toEqual(['requireMention', 'acceptAttachments'])
  })

  it('saves the attachment toggle', async () => {
    const { surface, target, store } = makeSurface()
    const result = await surface.save({ acceptAttachments: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const saved = { acceptAttachments: false }
    await expect(store.load()).resolves.toEqual(saved)
    expect(target.applied).toEqual(saved)
    expect(result.panel.config.overriddenKeys).toEqual(['acceptAttachments'])
  })

  it('saves the v2 attachment pipeline fields, including nested feishuTools keys', async () => {
    const { surface, target, store } = makeSurface()
    const result = await surface.save({
      attachmentStore: 'archive',
      prefetchImages: false,
      prefetchTimeoutMs: 5_000,
      prefetchImageMaxBytes: 1024,
      prefetchTotalMaxBytes: 4096,
      historyBootstrapLimit: 3,
      promptContextTimeoutMs: 1_500,
      'feishuTools.attachmentFetch': false,
      'feishuTools.attachmentFetchMaxResources': 4,
      'feishuTools.attachmentFetchMaxBytes': 2048,
      'feishuTools.attachmentFetchTimeoutMs': 30_000,
      'feishuTools.topicMessages': false,
      'feishuTools.topicMessagesTimeoutMs': 15_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The overlay file keeps the nested profile shape; untouched siblings stay out.
    await expect(store.load()).resolves.toEqual({
      attachmentStore: 'archive',
      prefetchImages: false,
      prefetchTimeoutMs: 5_000,
      prefetchImageMaxBytes: 1024,
      prefetchTotalMaxBytes: 4096,
      historyBootstrapLimit: 3,
      promptContextTimeoutMs: 1_500,
      feishuTools: {
        attachmentFetch: false,
        attachmentFetchMaxResources: 4,
        attachmentFetchMaxBytes: 2048,
        attachmentFetchTimeoutMs: 30_000,
        topicMessages: false,
        topicMessagesTimeoutMs: 15_000,
      },
    })
    expect(result.panel.config.effective.attachmentStore).toBe('archive')
    expect(result.panel.config.effective['feishuTools.attachmentFetch']).toBe(false)
    expect(target.applied?.feishuTools?.attachmentFetch).toBe(false)
    expect(result.panel.config.overriddenKeys).toContain('feishuTools.attachmentFetch')
    // The wire projection uses the same dotted keys as the form.
    expect(result.panel.config.overlay['feishuTools.topicMessages']).toBe(false)

    // A later partial edit deep-merges instead of replacing the tools object.
    const later = await surface.save({ 'feishuTools.topicMessages': true })
    expect(later.ok).toBe(true)
    const overlay = await store.load()
    expect(overlay.feishuTools).toMatchObject({
      attachmentFetch: false,
      topicMessages: true,
      attachmentFetchTimeoutMs: 30_000,
    })
  })

  it('rejects the removed image keys as unknown configuration', async () => {
    const { surface, store } = makeSurface()
    for (const legacy of [{ acceptImages: true }, { maxImagesPerMessage: 2 }]) {
      const result = await surface.save(legacy as unknown as EditableValues)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('未知配置项')
    }
    await expect(store.load()).resolves.toEqual({})
  })

  it('refuses a half-configured model override', async () => {
    const { surface, store } = makeSurface()
    const providerOnly = await surface.save({ provider: 'deepseek-account' })
    expect(providerOnly.ok).toBe(false)
    if (providerOnly.ok) return
    expect(providerOnly.issues?.map(issue => issue.key)).toEqual(['model'])

    const modelOnly = await surface.save({ model: 'deepseek-flash' })
    expect(modelOnly.ok).toBe(false)
    if (modelOnly.ok) return
    expect(modelOnly.issues?.map(issue => issue.key)).toEqual(['provider'])

    await expect(store.load()).resolves.toEqual({})

    const pair = await surface.save({ provider: 'deepseek-account', model: 'deepseek-flash' })
    expect(pair.ok).toBe(true)
    await expect(store.load()).resolves.toEqual({ provider: 'deepseek-account', model: 'deepseek-flash' })

    const cleared = await surface.save({ provider: '', model: '' })
    expect(cleared.ok).toBe(true)
    await expect(store.load()).resolves.toEqual({})
  })

  it('saves the access-control config and clears the administrator override', async () => {
    const { surface, store } = makeSurface()
    const saved = await surface.save({ adminUserId: 'u_admin', accessMode: 'open', authRequestTtlDays: 14 })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    await expect(store.load()).resolves.toEqual({
      adminUserId: 'u_admin',
      accessMode: 'open',
      authRequestTtlDays: 14,
    })
    expect(saved.panel.config.effective.adminUserId).toBe('u_admin')
    expect(saved.panel.config.effective.accessMode).toBe('open')
    expect(saved.panel.config.effective.authRequestTtlDays).toBe(14)
    expect(saved.panel.config.restartPendingKeys).toEqual([])

    const invalid = await surface.save({ adminUserId: 'ou_alice', authRequestTtlDays: 0 })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues?.map(issue => issue.key))
      .toEqual(expect.arrayContaining(['adminUserId', 'authRequestTtlDays']))

    const cleared = await surface.save({ adminUserId: '' })
    expect(cleared.ok).toBe(true)
    const overlay = await store.load()
    expect(overlay.adminUserId).toBeUndefined()
    expect(overlay.accessMode).toBe('open')
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

  it('saves an absolute baseDir, applies it live, and needs no reconnect', async () => {
    const { surface, target, store } = makeSurface()
    const next = mkdtempSync(path.join(tmpdir(), 'dsh-channels-ws-next-'))
    const result = await surface.save({ baseDir: next })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.panel.config.effective.baseDir).toBe(next)
    expect(result.panel.config.overriddenKeys).toEqual(['baseDir'])
    expect(result.panel.config.restartPendingKeys).toEqual([])
    expect(target.applied).toEqual({ baseDir: next })
    await expect(store.load()).resolves.toEqual({ baseDir: next })
  })

  it('rejects an unusable baseDir without persisting anything', async () => {
    const { surface, store } = makeSurface()
    const relative = await surface.save({ baseDir: './channels-data' })
    expect(relative.ok).toBe(false)
    if (relative.ok) return
    expect(relative.issues?.map(issue => issue.key)).toEqual(['baseDir'])

    const occupied = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-channels-ws-file-')), 'file')
    writeFileSync(occupied, 'x')
    const existingFile = await surface.save({ baseDir: occupied })
    expect(existingFile.ok).toBe(false)
    if (existingFile.ok) return
    expect(existingFile.issues?.[0]?.message).toMatch(/不是目录|无法创建工作区目录/)

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

  it('opens the first connection when stopped and refuses while unconfigured', async () => {
    const stopped = makeSurface()
    stopped.target.runningFlag = false
    const connected = await stopped.surface.reconnect()
    expect(connected.ok).toBe(true)
    expect(stopped.target.connectCalls).toBe(1)
    expect(stopped.target.restartCalls).toBe(0)

    const unconfigured = makeSurface()
    unconfigured.target.runningFlag = false
    unconfigured.target.credentialInfo.appId = { configured: false, writable: true }
    const refused = await unconfigured.surface.reconnect()
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.unconfigured).toBe(true)
    expect(unconfigured.target.connectCalls).toBe(0)
    expect(unconfigured.target.restartCalls).toBe(0)
  })
})

describe('SettingsSurface access control', () => {
  const SAMPLE_ACCESS: AccessWire = {
    mode: 'guarded',
    admin: { userId: 'u_admin', configured: true },
    loaded: true,
    groups: [{ chatId: 'oc_team', name: '研发群', source: 'card', addedAt: 1_700_000_000_000 }],
    users: [{ userId: 'u_alice', name: 'Alice', source: 'command', addedAt: 1_700_000_100_000 }],
    requests: [{
      token: 'tok_1',
      kind: 'group',
      targetId: 'oc_new',
      name: '新群',
      chatId: 'oc_new',
      createdAt: 1_700_000_200_000,
      expiresAt: 1_700_000_800_000,
    }],
  }

  it('carries the access snapshot into the panel', async () => {
    const { surface, target } = makeSurface()
    target.accessState = structuredClone(SAMPLE_ACCESS)
    const panel = await surface.panel()
    expect(panel.access).toEqual(SAMPLE_ACCESS)
    await expect(surface.access()).resolves.toEqual(SAMPLE_ACCESS)
  })

  it('degrades a broken access snapshot instead of failing the panel', async () => {
    const { surface, target } = makeSurface({ accessMode: 'open' })
    target.accessSnapshot = () => { throw new Error('access store down') }
    const panel = await surface.panel()
    expect(panel.access).toEqual({
      mode: 'open',
      admin: { configured: false },
      loaded: false,
      groups: [],
      users: [],
      requests: [],
    })
    await expect(surface.access()).rejects.toThrow('access store down')
  })

  it('validates and saves group and user authorizations', async () => {
    const { surface, target } = makeSurface()
    const group = await surface.saveAccessGroup(' oc_team ', ' 研发群 ')
    expect(group.ok).toBe(true)
    if (!group.ok) return
    expect(group.access.groups).toEqual([{
      chatId: 'oc_team',
      name: '研发群',
      source: 'panel',
      addedAt: 1_700_000_000_000,
    }])

    const user = await surface.saveAccessUser(' u_alice ', ' Alice ')
    expect(user.ok).toBe(true)
    if (!user.ok) return
    expect(user.access.users).toEqual([{
      userId: 'u_alice',
      name: 'Alice',
      source: 'panel',
      addedAt: 1_700_000_000_000,
    }])
    expect(target.accessCalls).toEqual([
      { op: 'add-group', chatId: 'oc_team', name: '研发群' },
      { op: 'add-user', userId: 'u_alice', name: 'Alice' },
    ])
  })

  it('rejects invalid identifiers before writing anything', async () => {
    const { surface, target } = makeSurface()
    for (const chatId of ['', '   ', 'x'.repeat(129), 'oc_\u0001bad', 42]) {
      const result = await surface.saveAccessGroup(chatId)
      expect(result.ok).toBe(false)
    }
    for (const userId of ['ou_alice', 'on_alice', 'user@example.com', 'bad id']) {
      const result = await surface.saveAccessUser(userId)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('ou_')
    }
    const badName = await surface.saveAccessUser('u_bob', 'x'.repeat(129))
    expect(badName.ok).toBe(false)
    expect(target.accessCalls).toEqual([])
  })

  it('removes authorizations and resolves pending requests', async () => {
    const { surface, target } = makeSurface()
    target.accessState = structuredClone(SAMPLE_ACCESS)

    const removedGroup = await surface.removeAccessGroup('oc_team')
    expect(removedGroup.ok).toBe(true)
    const removedUser = await surface.removeAccessUser('u_alice')
    expect(removedUser.ok).toBe(true)
    const allowed = await surface.resolveAccessRequest('tok_1', 'allow')
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.access.requests).toEqual([])
    expect(allowed.access.groups.map(group => group.chatId)).toEqual(['oc_new'])
    expect(target.accessCalls).toEqual([
      { op: 'remove-group', chatId: 'oc_team' },
      { op: 'remove-user', userId: 'u_alice' },
      { op: 'resolve', token: 'tok_1', decision: 'allow' },
    ])
  })

  it('folds target failures, thrown errors, and invalid decisions into the wire', async () => {
    const { surface, target } = makeSurface()
    target.failAccess = 'store unavailable'
    await expect(surface.saveAccessGroup('oc_x')).resolves.toEqual({ ok: false, error: 'store unavailable' })

    target.failAccess = undefined
    target.throwAccess = 'domain not open'
    await expect(surface.removeAccessUser('u_bob')).resolves.toEqual({ ok: false, error: 'domain not open' })

    target.throwAccess = undefined
    target.accessState = structuredClone(SAMPLE_ACCESS)
    const badDecision = await surface.resolveAccessRequest('tok_1', 'maybe')
    expect(badDecision.ok).toBe(false)
    const badToken = await surface.resolveAccessRequest('   ', 'allow')
    expect(badToken.ok).toBe(false)
    const unknownToken = await surface.resolveAccessRequest('missing', 'deny')
    expect(unknownToken.ok).toBe(false)
  })
})

describe('SettingsSurface credentials', () => {
  it('writes provided values through the seam and asks for reconnect while running', async () => {
    const { surface, target } = makeSurface()
    const result = await surface.saveCredentials({ appId: ' cli_new ', appSecret: 'secret_new' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reconnect).toBe('pending')
    expect(target.credentialCalls).toEqual([
      { field: 'appId', value: 'cli_new' },
      { field: 'appSecret', value: 'secret_new' },
    ])
    expect(result.panel.config.credentials.appId.configured).toBe(true)
    expect(target.restartCalls).toBe(0)
  })

  it('rejects empty, non-string, and oversized values with per-field issues', async () => {
    const { surface, target } = makeSurface()
    const none = await surface.saveCredentials({})
    expect(none.ok).toBe(false)

    const invalid = await surface.saveCredentials({
      appId: '   ',
      appSecret: 42 as unknown as string,
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues?.map(issue => issue.key)).toEqual(expect.arrayContaining(['appId', 'appSecret']))

    const oversized = await surface.saveCredentials({ appId: 'x'.repeat(600) })
    expect(oversized.ok).toBe(false)
    expect(target.credentialCalls).toEqual([])
  })

  it('connects when stopped once both credentials are complete', async () => {
    const stopped = makeSurface()
    stopped.target.runningFlag = false
    const result = await stopped.surface.saveCredentials({ appId: 'cli_new', appSecret: 'secret_new' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reconnect).toBe('auto')
    expect(result.autoReconnectError).toBeUndefined()
    expect(stopped.target.connectCalls).toBe(1)
    expect(stopped.target.restartCalls).toBe(0)

    const failing = makeSurface()
    failing.target.runningFlag = false
    failing.target.failConnect = 'handshake refused'
    const failed = await failing.surface.saveCredentials({ appId: 'cli_new', appSecret: 'secret_new' })
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.autoReconnectError).toContain('handshake refused')
  })

  it('stores one half of the pair without connecting until the other half exists', async () => {
    const stopped = makeSurface()
    stopped.target.runningFlag = false
    stopped.target.credentialInfo.appSecret = { configured: false, writable: true }
    const result = await stopped.surface.saveCredentials({ appId: 'cli_new' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reconnect).toBe('unconfigured')
    expect(stopped.target.connectCalls).toBe(0)
    expect(result.panel.status.phase).toBe('unconfigured')
    expect(result.panel.status.configured).toBe(false)
    expect(result.panel.status.missingConfig).toEqual(['FEISHU_APP_SECRET（飞书 App Secret）'])
  })

  it('clears a stored credential and reports pending / not-needed', async () => {
    const running = makeSurface()
    const pending = await running.surface.clearCredential('appSecret')
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    expect(pending.reconnect).toBe('pending')
    expect(running.target.credentialCalls).toEqual([{ field: 'appSecret' }])
    expect(pending.panel.config.credentials.appSecret.configured).toBe(false)

    const stopped = makeSurface()
    stopped.target.runningFlag = false
    const notNeeded = await stopped.surface.clearCredential('appId')
    expect(notNeeded.ok).toBe(true)
    if (!notNeeded.ok) return
    expect(notNeeded.reconnect).toBe('not-needed')
    expect(stopped.target.restartCalls).toBe(0)
  })

  it('refuses unknown credential fields', async () => {
    const result = await makeSurface().surface.clearCredential('nope' as 'appId')
    expect(result.ok).toBe(false)
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
  const listeners = new Map<string, Array<() => void>>()
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      res.headersSent = true
      return res
    },
    setHeader() {},
    on(event: string, listener: () => void) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return res
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener()
      return res
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) captured.body += String(chunk)
      res.writableEnded = true
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

  it('serves the selector catalog over GET and rejects writes', async () => {
    const fake = makeCatalog()
    const { surface } = makeSurface({ provider: 'deepseek-account', model: 'deepseek-flash' }, fake.catalog)
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const catalog = await call(routes, CATALOG_ROUTE, makeRequest({
      url: `${CATALOG_ROUTE}?provider=deepseek-account&model=deepseek-flash`,
    }))
    expect(catalog.status).toBe(200)
    const body = JSON.parse(catalog.body) as CatalogWire
    expect(body.provider.selectable).toBe(true)
    expect(fake.calls).toEqual([{ provider: 'deepseek-account', model: 'deepseek-flash' }])

    const head = await call(routes, CATALOG_ROUTE, makeRequest({ method: 'HEAD', url: CATALOG_ROUTE }))
    expect(head.status).toBe(200)
    expect(head.body).toBe('')

    const post = await call(routes, CATALOG_ROUTE, makeRequest({ method: 'POST', url: CATALOG_ROUTE }))
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
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

  it('rejects a connect request with 400 while the credentials are incomplete', async () => {
    const { surface, target } = makeSurface()
    target.runningFlag = false
    target.credentialInfo.appSecret = { configured: false, writable: true }
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const response = await call(routes, RECONNECT_ROUTE, makeRequest({ method: 'POST', headers: { host: 'h' } }))
    expect(response.status).toBe(400)
    const body = JSON.parse(response.body) as { ok: boolean; unconfigured?: boolean }
    expect(body.ok).toBe(false)
    expect(body.unconfigured).toBe(true)
    expect(target.connectCalls).toBe(0)
  })

  it('opens the native directory chooser and returns the picked path', async () => {
    const { surface } = makeSurface({}, undefined, stubPicker(async () => '/Users/me/workspaces'))
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const crossSite = await call(routes, PICK_DIRECTORY_ROUTE, makeRequest({
      method: 'POST',
      headers: { origin: 'https://evil.example', host: '127.0.0.1:52555' },
    }))
    expect(crossSite.status).toBe(403)

    const notAllowed = await call(routes, PICK_DIRECTORY_ROUTE, makeRequest({ method: 'GET' }))
    expect(notAllowed.status).toBe(405)
    expect(notAllowed.headers.allow).toBe('POST')

    const picked = await call(routes, PICK_DIRECTORY_ROUTE, makeRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:52555' },
    }))
    expect(picked.status).toBe(200)
    expect(JSON.parse(picked.body)).toEqual({ ok: true, path: '/Users/me/workspaces' })
  })

  it('reports a canceled chooser as a normal outcome, and failures as JSON errors', async () => {
    let outcome: () => Promise<string | null> = async () => null
    const { surface } = makeSurface({}, undefined, { available: true, pick: () => outcome() })
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const canceled = await call(routes, PICK_DIRECTORY_ROUTE, makeRequest({
      method: 'POST',
      headers: { host: 'h' },
    }))
    expect(canceled.status).toBe(200)
    expect(JSON.parse(canceled.body)).toEqual({ ok: true, canceled: true })

    outcome = async () => { throw new Error('dialog failed') }
    const failed = await call(routes, PICK_DIRECTORY_ROUTE, makeRequest({
      method: 'POST',
      headers: { host: 'h' },
    }))
    expect(failed.status).toBe(500)
    const body = JSON.parse(failed.body) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('dialog failed')

    // No picker seam (remote/headless host): the route still exists but refuses.
    const headless = makeSurface()
    const headlessServer = makeWebServer()
    registerSettingsRoutes(headlessServer.server, headless.surface)
    const unavailable = await call(headlessServer.routes, PICK_DIRECTORY_ROUTE, makeRequest({
      method: 'POST',
      headers: { host: 'h' },
    }))
    expect(unavailable.status).toBe(500)
    expect(JSON.parse(unavailable.body).error).toContain(PANEL_COPY.directoryPickFailed)
  })

  it('serves the access snapshot and guards every whitelist write', async () => {
    const { surface, target } = makeSurface()
    target.accessState = {
      mode: 'guarded',
      admin: { userId: 'u_admin', configured: true },
      loaded: true,
      groups: [{ chatId: 'oc_team', name: '研发群', source: 'card', addedAt: 1_700_000_000_000 }],
      users: [],
      requests: [{
        token: 'tok_1',
        kind: 'group',
        targetId: 'oc_new',
        chatId: 'oc_new',
        createdAt: 1_700_000_200_000,
        expiresAt: 1_700_000_800_000,
      }],
    }
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const read = await call(routes, ACCESS_ROUTE, makeRequest())
    expect(read.status).toBe(200)
    const snapshot = JSON.parse(read.body) as AccessWire
    expect(snapshot.admin).toEqual({ userId: 'u_admin', configured: true })
    expect(snapshot.groups).toEqual(target.accessState.groups)

    const head = await call(routes, ACCESS_ROUTE, makeRequest({ method: 'HEAD', url: ACCESS_ROUTE }))
    expect(head.status).toBe(200)
    expect(head.body).toBe('')

    const writes: Array<{ route: string; method: string; body: Record<string, unknown> }> = [
      { route: ACCESS_GROUPS_ROUTE, method: 'POST', body: { chatId: 'oc_team' } },
      { route: ACCESS_GROUPS_ROUTE, method: 'DELETE', body: { chatId: 'oc_team' } },
      { route: ACCESS_USERS_ROUTE, method: 'POST', body: { userId: 'u_alice' } },
      { route: ACCESS_USERS_ROUTE, method: 'DELETE', body: { userId: 'u_alice' } },
      { route: ACCESS_REQUESTS_ROUTE, method: 'POST', body: { token: 'tok_1', decision: 'allow' } },
    ]
    for (const write of writes) {
      const crossSite = await call(routes, write.route, makeRequest({
        method: write.method,
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:52555' },
        body: JSON.stringify(write.body),
      }))
      expect(crossSite.status).toBe(403)
    }
    expect(target.accessCalls).toEqual([])

    const addedGroup = await call(routes, ACCESS_GROUPS_ROUTE, makeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ chatId: 'oc_team', name: '研发群' }),
    }))
    expect(addedGroup.status).toBe(200)
    expect(JSON.parse(addedGroup.body).ok).toBe(true)
    expect(JSON.parse(addedGroup.body).access.groups.map((group: { chatId: string }) => group.chatId))
      .toContain('oc_team')

    const invalidUser = await call(routes, ACCESS_USERS_ROUTE, makeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ userId: 'ou_alice' }),
    }))
    expect(invalidUser.status).toBe(400)
    expect(JSON.parse(invalidUser.body).error).toContain('ou_')

    const removed = await call(routes, ACCESS_GROUPS_ROUTE, makeRequest({
      method: 'DELETE',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ chatId: 'oc_team' }),
    }))
    expect(removed.status).toBe(200)

    const resolved = await call(routes, ACCESS_REQUESTS_ROUTE, makeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ token: 'tok_1', decision: 'allow' }),
    }))
    expect(resolved.status).toBe(200)
    expect(JSON.parse(resolved.body).access.requests).toEqual([])

    const missing = await call(routes, ACCESS_GROUPS_ROUTE, makeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({}),
    }))
    expect(missing.status).toBe(400)

    const notAllowed = await call(routes, ACCESS_GROUPS_ROUTE, makeRequest({ method: 'GET' }))
    expect(notAllowed.status).toBe(405)
    expect(notAllowed.headers.allow).toBe('POST, DELETE')
  })
})

  it('writes and removes credentials via PUT / DELETE with the same guards', async () => {
    const { surface } = makeSurface()
    const { server, routes } = makeWebServer()
    registerSettingsRoutes(server, surface)

    const crossSite = await call(routes, CREDENTIALS_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:52555' },
      body: JSON.stringify({ appId: 'cli_x' }),
    }))
    expect(crossSite.status).toBe(403)

    const saved = await call(routes, CREDENTIALS_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:52555' },
      body: JSON.stringify({ appId: 'cli_x' }),
    }))
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.body).ok).toBe(true)

    const invalid = await call(routes, CREDENTIALS_ROUTE, makeRequest({
      method: 'PUT',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ appId: '   ' }),
    }))
    expect(invalid.status).toBe(400)

    const badField = await call(routes, CREDENTIALS_ROUTE, makeRequest({
      method: 'DELETE',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ field: 'nope' }),
    }))
    expect(badField.status).toBe(400)

    const removed = await call(routes, CREDENTIALS_ROUTE, makeRequest({
      method: 'DELETE',
      headers: { 'content-type': 'application/json', host: 'h' },
      body: JSON.stringify({ field: 'appSecret' }),
    }))
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.body).ok).toBe(true)

    const notAllowed = await call(routes, CREDENTIALS_ROUTE, makeRequest({ method: 'GET' }))
    expect(notAllowed.status).toBe(405)
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
    const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-channels-home-'))
    vi.stubEnv('DSH_HOME', dshHome)
    apply(ctx, {
      appId: 'FEISHU_APP_ID',
      appSecret: 'FEISHU_APP_SECRET',
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-apply-')),
      channelFactory: () => channel,
    })

    expect(routes.has(PANEL_ROUTE)).toBe(true)
    expect(routes.has(STATUS_ROUTE)).toBe(true)
    expect(routes.has(CATALOG_ROUTE)).toBe(true)
    expect(routes.has(CONFIG_ROUTE)).toBe(true)
    expect(routes.has(CREDENTIALS_ROUTE)).toBe(true)
    expect(routes.has(RECONNECT_ROUTE)).toBe(true)
    expect(routes.has(ACCESS_ROUTE)).toBe(true)
    expect(routes.has(ACCESS_GROUPS_ROUTE)).toBe(true)
    expect(routes.has(ACCESS_USERS_ROUTE)).toBe(true)
    expect(routes.has(ACCESS_REQUESTS_ROUTE)).toBe(true)

    const panel = await call(routes, PANEL_ROUTE, makeRequest())
    expect(panel.status).toBe(200)
    const panelBody = JSON.parse(panel.body)
    expect(panelBody.config.fields).toHaveLength(EDITABLE_KEYS.length)
    // The live host catalog turns the provider field into a select (the fake
    // host context advertises one provider); model stays free text until a
    // provider is configured.
    const providerField = panelBody.config.fields.find((field: { key: string }) => field.key === 'provider')
    expect(providerField.kind).toBe('select')

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
    expect(JSON.parse(readFileSync(path.join(dshHome, 'dsh-channels', 'settings.json'), 'utf8')))
      .toMatchObject({ requireMention: false })

    for (const cleanup of cleanups.reverse()) await cleanup()
    vi.unstubAllEnvs()
  })
})

describe('FeishuService settings integration', () => {
  function harness(
    overlay: Record<string, unknown> = {},
    credentialValues?: Record<string, string>,
  ): {
    ctx: HostContext
    credentials: ReturnType<typeof makeHostContext>['credentials']
    channel: FeishuChannel
    config: FeishuConfig
    store: OverlayStore
    file: string
  } {
    const file = tempOverlayFile()
    if (Object.keys(overlay).length > 0) writeFileSync(file, JSON.stringify(overlay))
    const hostState = makeHostContext(credentialValues)
    return {
      ctx: hostState.ctx,
      credentials: hostState.credentials,
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

    expect(await service.credentialStates()).toMatchObject({ appId: { configured: true }, appSecret: { configured: true } })
    await service.shutdown()
  })

  it('deep-merges a nested feishuTools overlay over the profile config', async () => {
    const h = harness({ feishuTools: { attachmentFetch: false } })
    const service = new FeishuService(h.ctx, h.config, () => h.channel, undefined, h.store)
    await service.boot()
    const config = service.configSnapshot()
    expect(config.feishuTools.attachmentFetch).toBe(false)
    // Sibling tool settings keep their profile/default values.
    expect(config.feishuTools.topicMessages).toBe(true)
    expect(config.feishuTools.attachmentFetchMaxBytes).toBe(h.config.feishuTools.attachmentFetchMaxBytes)
    expect(service.runningConfigSnapshot()?.feishuTools.attachmentFetch).toBe(false)

    // A live panel write starts from the profile base (not from the previous
    // overlay) and applies only the sub-fields it carries.
    service.applyOverlay({ feishuTools: { topicMessages: false } })
    expect(service.configSnapshot().feishuTools.topicMessages).toBe(false)
    expect(service.configSnapshot().feishuTools.attachmentFetch).toBe(true)
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

  it('records a failed connection attempt without failing the plugin boot', async () => {
    const h = harness()
    const failing = Object.assign(makeChannel(), {
      connect: vi.fn(async () => { throw new Error('ws handshake failed') }),
    })
    const service = new FeishuService(h.ctx, h.config, () => failing, undefined, h.store)
    // A connection problem must not reject `boot()`: the plugin stays loaded so
    // the settings panel can show the error and offer a retry.
    await service.boot()
    expect(service.isRunning()).toBe(false)
    expect(service.isConfigured()).toBe(true)
    expect(service.startError()).toContain('ws handshake failed')
    expect(service.missingConfig()).toEqual([])

    const panel = await new SettingsSurface(service, h.store).panel()
    expect(panel.status.running).toBe(false)
    expect(panel.status.phase).toBe('error')
    expect(panel.status.lastStartError).toContain('ws handshake failed')
  })

  it('stays loaded and unconnected while the credentials are incomplete', async () => {
    // Only the App ID exists: the plugin must load, expose the panel, and hold
    // no connection until the pair is complete.
    const h = harness({}, { FEISHU_APP_ID: 'cli_test_app' })
    const calls: Array<Record<string, unknown>> = []
    const service = new FeishuService(h.ctx, h.config, options => {
      calls.push(options as unknown as Record<string, unknown>)
      return h.channel
    }, undefined, h.store)

    await service.boot()
    expect(calls).toHaveLength(0)
    expect(service.isRunning()).toBe(false)
    expect(service.isConfigured()).toBe(false)
    expect(service.missingConfig()).toEqual(['FEISHU_APP_SECRET（飞书 App Secret）'])
    expect(service.startError()).toBeUndefined()

    const surface = new SettingsSurface(service, h.store)
    const panel = await surface.panel()
    expect(panel.status.phase).toBe('unconfigured')
    expect(panel.status.configured).toBe(false)
    expect(panel.status.missingConfig).toEqual(['FEISHU_APP_SECRET（飞书 App Secret）'])
    expect(panel.status.lastStartError).toBeUndefined()
    expect(panel.status.running).toBe(false)
    // Unconnected the storage domain is closed: the whitelists are unknown
    // rather than empty.
    expect(panel.access.loaded).toBe(false)

    // Saving the missing secret from the panel connects immediately.
    const saved = await surface.saveCredentials({ appSecret: 'secret' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.reconnect).toBe('auto')
    expect(service.isRunning()).toBe(true)
    expect(service.isConfigured()).toBe(true)
    expect(saved.panel.status.phase).toBe('connected')
    await service.shutdown()
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

  it('hot-applies a panel baseDir for sessions created afterwards without a reconnect', async () => {
    const h = harness()
    const service = new FeishuService(h.ctx, h.config, () => h.channel, undefined, h.store)
    await service.boot()
    const surface = new SettingsSurface(service, h.store)
    const original = h.config.baseDir
    const next = mkdtempSync(path.join(tmpdir(), 'dsh-channels-ws-hot-'))
    const saved = await surface.save({ baseDir: next })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.panel.config.effective.baseDir).toBe(next)
    expect(saved.panel.config.restartPendingKeys).toEqual([])
    expect(service.configSnapshot().baseDir).toBe(next)
    // The connection-scoped snapshot keeps the old value; that must not count
    // as restart-pending because baseDir is read per session establishment.
    expect(service.runningConfigSnapshot()?.baseDir).toBe(original)
    await service.shutdown()
  })

  it('credential writes enable a channel that booted without credentials', async () => {
    const h = harness({}, {})
    const service = new FeishuService(h.ctx, h.config, () => h.channel, undefined, h.store)
    const surface = new SettingsSurface(service, h.store)
    // No credentials: boot succeeds (the plugin is loaded for the settings
    // panel) but deliberately opens no connection.
    await service.boot()
    expect(service.isRunning()).toBe(false)
    expect(service.isConfigured()).toBe(false)
    expect(service.startError()).toBeUndefined()

    const saved = await surface.saveCredentials({ appId: 'cli_new', appSecret: 'secret_new' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.reconnect).toBe('auto')
    expect(saved.panel.status.running).toBe(true)
    expect(saved.panel.config.credentials.appId.configured).toBe(true)
    expect(h.credentials.values.FEISHU_APP_ID).toBe('cli_new')
    expect(h.credentials.values.FEISHU_APP_SECRET).toBe('secret_new')

    const cleared = await surface.clearCredential('appSecret')
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.reconnect).toBe('pending')
    expect(h.credentials.values.FEISHU_APP_SECRET).toBeUndefined()
    await service.shutdown()
  })

  it('keeps a partially configured pair unconnected through the real service', async () => {
    const h = harness({}, { FEISHU_APP_ID: 'cli_test_app' })
    const calls: Array<Record<string, unknown>> = []
    const service = new FeishuService(h.ctx, h.config, options => {
      calls.push(options as unknown as Record<string, unknown>)
      return h.channel
    }, undefined, h.store)
    const surface = new SettingsSurface(service, h.store)
    await service.boot()
    expect(service.isRunning()).toBe(false)

    // Re-saving the half that already exists leaves the pair incomplete: the
    // value is stored, the channel stays down.
    const saved = await surface.saveCredentials({ appId: 'cli_new' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.reconnect).toBe('unconfigured')
    expect(calls).toHaveLength(0)
    expect(service.isRunning()).toBe(false)
    expect(saved.panel.status.phase).toBe('unconfigured')
    expect(service.isConfigured()).toBe(false)
  })

  it('releases host listeners on teardown so restarts never double-wire events', async () => {
    const h = harness()
    const originalOn = h.ctx.on
    const disposers: Array<() => unknown> = []
    let disposed = 0
    const trackingOn = ((name: string, listener: unknown, options?: unknown) => {
      const dispose = (originalOn as unknown as (n: string, l: unknown, o?: unknown) => () => unknown)(
        name, listener, options,
      )
      disposers.push(dispose)
      return () => {
        disposed += 1
        return dispose()
      }
    }) as unknown as typeof h.ctx.on
    h.ctx.on = trackingOn

    const service = new FeishuService(h.ctx, h.config, () => h.channel, undefined, h.store)
    await service.boot()
    const afterBoot = disposers.length
    expect(afterBoot).toBeGreaterThanOrEqual(2)

    await service.restart()
    expect(disposers.length).toBeGreaterThan(afterBoot)
    // The first generation of listeners was disposed by the restart teardown.
    expect(disposed).toBeGreaterThanOrEqual(afterBoot)

    const beforeShutdown = disposers.length
    await service.shutdown()
    expect(disposed).toBeGreaterThanOrEqual(beforeShutdown)
  })

  it('serializes concurrent connect actions', async () => {
    const h = harness()
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = Object.assign(makeChannel(), {
      connect: vi.fn(async () => { await gate }),
    })
    // First factory call serves the boot; later calls return the gated channel.
    const service = new FeishuService(h.ctx, h.config, () => {
      calls += 1
      return calls === 1 ? h.channel : slow
    }, undefined, h.store)
    await service.boot()
    await service.shutdown()

    const first = service.connect()
    // The lifecycle lock is acquired synchronously, before the first await.
    const second = service.connect()
    await expect(second).rejects.toThrow(/连接|重启/)
    expect(vi.mocked(slow.connect)).toHaveBeenCalledTimes(0)

    release?.()
    await expect(first).resolves.toBeUndefined()
    expect(vi.mocked(slow.connect)).toHaveBeenCalledTimes(1)
    await service.shutdown()
  })

  it('reports a read-only credentials provider instead of silently dropping writes', async () => {
    const h = harness()
    const readOnly = { ...h.credentials, set: undefined, unset: undefined }
    const ctx = {
      ...h.ctx,
      get: (name: string) => (name === 'credentials' ? readOnly : h.ctx.get?.(name)),
    } as unknown as HostContext
    const service = new FeishuService(ctx, h.config, () => h.channel, undefined, h.store)
    await expect(service.setCredential('appId', 'cli_x')).rejects.toThrow(/不可写/)
    await expect(service.clearCredential('appSecret')).rejects.toThrow(/不支持移除/)
  })
})
