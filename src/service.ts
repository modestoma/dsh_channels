/**
 * The Feishu bridge service: inbound routing, workspace/session ownership,
 * topic creation, and streaming-card orchestration.
 *
 * Ownership model (one workspace per user × chat):
 *  - p2p:   one workspace per (bot, user), all of that user's sessions inside;
 *  - group: one workspace per (chat, user), sessions grouped per user.
 *
 * Routing model:
 *  - `thread_id` → bound session (no @ needed inside an owned topic);
 *  - degraded chat-scoped keys when Feishu refuses topic replies;
 *  - new topic + new session for an @-triggered message without a route.
 *
 * @module dsh-channels/service
 */

import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { ApprovalAnswerer } from './approvals.ts'
import type { ApprovalRoute } from './approvals.ts'
import { QuestionAnswerer } from './questions.ts'
import type {
  CommandInvocation,
  CommandResult,
  CredentialInfo,
  CredentialProvider,
  CordisFiber,
  HostContext,
  LlmService,
  Session,
  SessionId,
  SessionProjections,
  TokenMeter,
  Workspace,
} from './dsh-types.ts'
import { standaloneInfoCard } from './cards.ts'
import {
  armEffortCommand, armModelCommand, armRenewCommand, registerModelCommand, commandResultCardKind, parseSlashCommand,
  registerEffortCommand, registerRenewCommand, RouteOperationQueue, supportedCommandHelp, supportedCommandList,
} from './commands.ts'
import type { EffortCommandAction, ParsedSlashCommand } from './commands.ts'
import { commandSpec } from './commands/registry.ts'
import type { ChannelCommandSpec } from './commands/registry.ts'
import type { PermissionPresets, SessionQuery } from './dsh-types.ts'
import { feishuDomain } from './domain.ts'
import {
  applyWorkspaceCleanup, isPathInside, planWorkspaceCleanup, retentionMs,
} from './cleanup.ts'
import type { CleanupDeps, WorkspaceStats } from './cleanup.ts'
import type {
  ExpiredRouteRecord, FeishuDomainGlobal, FeishuDomainHandle, InflightSnapshot, ProcessedRecord, RawDomainHandle,
  RouteRecord,
} from './domain.ts'
import { RouteStore } from './session/routes.ts'
import { InflightRepair } from './session/repair.ts'
import { SessionManager } from './session/manager.ts'
import type { LiveAgent, RenewCommit } from './session/manager.ts'
import { CardDelivery } from './feishu/delivery.ts'
import { AttachmentIntake } from './feishu/inbound-attachments.ts'
import { InboundRouter } from './routing/inbound.ts'
import type { RequestPolicyController } from './session/request-policy.ts'
import type { ChannelFactory, FeishuChannel, NormalizedMessage } from './feishu-channel.ts'
import { buildHealthCard, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES } from './health.ts'
import type { HealthDependencyName, HealthSnapshot } from './health.ts'
import {
  buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard,
  compactFailureContext, resolveWorkDir, SESSION_HISTORY_DISPLAY_LIMIT,
} from './session-commands.ts'
import type { SessionHistoryAnnotation } from './session-commands.ts'
import { normalizeSessionHistory } from './domain.ts'
import { foldSessionStats, measureSessionContext, readProjectionViews } from './stats.ts'
import type { ContextMeasurement, ContextServices } from './stats.ts'
import { createLogicalSessionExport } from './session-export.ts'
import type { SessionExportBuilder } from './session-export.ts'
import { ACTIVITY_BUILD_MARKER, TurnStreamer } from './streamer.ts'
import type { ProjectedStats, StreamerHooks } from './streamer.ts'
import type { FeishuConfig } from './config.ts'
import type { OverlayStore } from './settings/overlay.ts'

/** Periodic route-GC sweep cadence (a long-running instance also accumulates
 *  dead records; TTL semantics make 6 h granularity more than sufficient). */
const GC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Dedup-record retention: Feishu redelivery windows are minutes-scale, so a
 *  day is 100×+ headroom while keeping the table bounded. */
const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000

/** Workspace-retention sweep cadence when automatic cleanup is enabled. */
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000


interface RenewAdmission {
  route: RouteRecord
  live: LiveAgent
  commit?: RenewCommit
}

interface EffortAdmission {
  live: LiveAgent
  controller: RequestPolicyController
}

interface ModelAdmission {
  live: LiveAgent
  controller: RequestPolicyController
}

/** Wrap the host's storage facility open behind a stable local type. */
async function openFeishuDomain(ctx: HostContext): Promise<FeishuDomainHandle> {
  const domain = await ctx.storageDomain.open(feishuDomain) as unknown as RawDomainHandle
  const table = domain.table('routes')
  const inflightRaw = domain.table('inflight')
  const processedRaw = domain.table('processed')
  const expiredRoutesRaw = domain.table('expired_routes')
  return {
    routes: {
      get: key => table.get(key) as RouteRecord | undefined,
      put: (key, value) => table.put(key, value),
      delete: key => table.delete(key),
      entries: () => table.entries() as IterableIterator<[string, RouteRecord]>,
    },
    inflight: {
      get: key => inflightRaw.get(key) as InflightSnapshot | undefined,
      put: (key, value) => inflightRaw.put(key, value),
      update: (key, fn) => inflightRaw.update(key, current => fn(current as InflightSnapshot)),
      delete: key => inflightRaw.delete(key),
      entries: () => inflightRaw.entries() as IterableIterator<[string, InflightSnapshot]>,
    },
    processed: {
      get: key => processedRaw.get(key) as ProcessedRecord | undefined,
      put: (key, value) => processedRaw.put(key, value),
      delete: key => processedRaw.delete(key),
      entries: () => processedRaw.entries() as IterableIterator<[string, ProcessedRecord]>,
    },
    expiredRoutes: {
      get: key => expiredRoutesRaw.get(key) as ExpiredRouteRecord | undefined,
      put: (key, value) => expiredRoutesRaw.put(key, value),
      entries: () => expiredRoutesRaw.entries() as IterableIterator<[string, ExpiredRouteRecord]>,
    },
    getGlobal: () => (domain.global.get() ?? {}) as FeishuDomainGlobal,
    setGlobal: value => domain.global.set(value),
    close: () => domain.close(),
  }
}

/**
 * Resolve one credential reference through the host credentials seam.
 *
 * Precedence is owned by the provider (env > `$DSH_HOME/.credentials.yaml`
 * > `.env` fallbacks). Without a mounted seam the process environment is the
 * whole credential plane.
 */
async function resolveCredentialRef(ctx: HostContext, ref: string): Promise<string> {
  const provider = ctx.get?.('credentials') as CredentialProvider | undefined
  if (provider !== undefined) {
    const hit = await provider.resolve(ref)
    if (hit !== undefined) return hit.value
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient !== '') return ambient
  }
  throw new Error(
    `dsh-channels: credential "${ref}" is not configured; add it to $DSH_HOME/.credentials.yaml `
    + `(e.g. "${ref}: <value>") or export it in the launching environment`,
  )
}

/** Best-effort human-readable error text for the settings panel. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Measure one workspace directory for the cleanup preview: total regular-file
 * bytes and file count. Symlinks are never followed; unreadable entries are
 * skipped so a permission problem cannot fail the whole pass.
 */
async function measureWorkspace(dir: string): Promise<WorkspaceStats | undefined> {
  let info
  try {
    info = await lstat(dir)
  } catch {
    return undefined
  }
  if (!info.isDirectory()) return undefined
  let bytes = 0
  let files = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await lstat(child)
        if (stat.isFile()) {
          bytes += stat.size
          files += 1
        }
      } catch {
        // The directory changed while walking it; the byte total is advisory.
      }
    }
  }
  return { mtimeMs: info.mtimeMs, bytes, files }
}

export class FeishuService {
  private readonly ctx: HostContext
  /** Live config object. Mutated in place — collaborators captured this reference. */
  private readonly config: FeishuConfig
  /** Loader/profile-provided config, the layer below the Web overlay. */
  private readonly baseConfig: FeishuConfig
  /** Web overlay store (`$DSH_HOME/dsh-channels/settings.json`), when mounted. */
  private readonly overlay: OverlayStore | undefined
  private readonly channelFactory: ChannelFactory
  private readonly sessionExportBuilder: SessionExportBuilder
  private channel: FeishuChannel | undefined
  private streamer: TurnStreamer | undefined
  private domain: FeishuDomainHandle | undefined
  /** Durable route store (cache + TTL retirement). */
  private readonly routes: RouteStore
  /** In-flight turn snapshots + startup repair. */
  private readonly repair: InflightRepair
  /** Outbound card delivery + reaction lifecycle. */
  private readonly delivery: CardDelivery
  /** Inbound attachment archival (Feishu resources → workspace files). */
  private readonly attachments: AttachmentIntake
  /** Inbound routing: dedup, admission, decision tree, session establishment. */
  private readonly inbound: InboundRouter
  /** Agent/session lifecycle: live registry, resume, presets, renew. */
  private readonly sessions: SessionManager
  /** FIFO admission for ordinary turns and commands targeting one route. */
  private readonly routeOperations = new RouteOperationQueue()
  /** Active Host command executions, aborted before shutdown tears peers down. */
  private readonly commandControllers = new Set<AbortController>()
  /** Whole command admissions, drained before channel/storage teardown. */
  private readonly commandOperations = new Set<Promise<void>>()
  /** `<provider>/<model>` → context window (lazy async fill; sync reads). */
  private readonly contextWindows = new Map<string, number>()
  private readonly windowRequests = new Set<string>()
  private started = false
  /** Epoch ms when `start()` completed (uptime for `/status`). */
  private startedAt: number | undefined
  /** Last failed `boot()` message, surfaced in the Web settings panel. */
  private lastStartError: string | undefined
  /** Effective config captured at the last successful connect (restart-pending diff). */
  private runningConfig: FeishuConfig | undefined
  /** Guards overlapping panel-triggered reconnects. */
  private restarting = false
  private unlisten: (() => void) | undefined
  /** Periodic route-GC timer (unref'd; only armed when `routeTtlMs > 0`). */
  private gcTimer: ReturnType<typeof setInterval> | undefined
  /** Periodic workspace-retention timer (only armed when auto cleanup is on). */
  private retentionTimer: ReturnType<typeof setInterval> | undefined
  /** Guards overlapping cleanup passes (panel button / daily timer). */
  private cleanupRunning = false
  /** HITL approval answerer (created in `start()`). */
  private approvalAnswerer: ApprovalAnswerer | undefined
  /** HITL structured-question answerer (`ask_user_question`). */
  private questionAnswerer: QuestionAnswerer | undefined
  /** Disposers for the host approval waterfall listener + card actions. */
  private unlistenApproval: (() => boolean) | undefined
  /** Disposer for the host user-questions waterfall listener. */
  private unlistenQuestions: (() => boolean) | undefined
  private unlistenCardAction: (() => void) | undefined

  constructor(
    ctx: HostContext,
    config: FeishuConfig,
    channelFactory: ChannelFactory,
    sessionExportBuilder: SessionExportBuilder = createLogicalSessionExport,
    overlay?: OverlayStore,
  ) {
    this.ctx = ctx
    this.config = config
    this.baseConfig = { ...config }
    this.overlay = overlay
    this.channelFactory = channelFactory
    this.sessionExportBuilder = sessionExportBuilder
    this.routes = new RouteStore({
      domain: () => this.domain,
      ttlMs: () => this.config.routeTtlMs,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.repair = new InflightRepair({
      domain: () => this.domain,
      channel: () => this.channel,
      ttlMs: () => this.config.routeTtlMs,
      info: (message, ...args) => this.ctx.logger?.info?.(message, ...args),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.sessions = new SessionManager({
      ctx: this.ctx,
      config: this.config,
      persistRoute: (key, record) => this.routes.put(key, record),
      started: () => this.started,
      detachStream: sessionId => this.streamer?.detach(sessionId),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.attachments = new AttachmentIntake({
      enabled: () => this.config.acceptAttachments,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.delivery = new CardDelivery({
      channel: () => this.channel,
      started: () => this.started,
      routeForSession: sessionId => this.routes.findBySession(sessionId),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.inbound = new InboundRouter({
      ctx: this.ctx,
      config: this.config,
      started: () => this.started,
      domain: () => this.domain,
      routes: this.routes,
      repair: this.repair,
      delivery: this.delivery,
      sessions: this.sessions,
      attachments: this.attachments,
      queue: this.routeOperations,
      streamer: () => this.streamer,
      questionAnswerer: () => this.questionAnswerer,
      commands: { handleSlash: (msg, line) => this.handleSlashMessage(msg, line) },
    })
  }

  // ---- lifecycle / Web settings panel ----------------------------------

  /**
   * Load the Web overlay, then open the channel. Startup errors are recorded
   * for the settings panel and the partial service is torn down before the
   * error is rethrown (the plugin fiber still fails the same way).
   */
  async boot(): Promise<void> {
    try {
      await this.loadOverlay()
      await this.start()
      this.lastStartError = undefined
      this.runningConfig = { ...this.config }
    } catch (error) {
      this.lastStartError = messageOf(error)
      try {
        await this.shutdown()
      } catch {
        // The original startup error is the useful one.
      }
      throw error
    }
  }

  /** Re-read the Web overlay over the profile config (no channel touch). */
  private async loadOverlay(): Promise<void> {
    const overlay = this.overlay === undefined ? {} : await this.overlay.load()
    this.replaceConfig({ ...this.baseConfig, ...overlay })
  }

  /**
   * Replace every own key of the live config object. `Object.assign` alone
   * would keep stale overlay-only keys (e.g. `provider`) when the next layer
   * no longer defines them; collaborators hold this object identity, so the
   * mutation must happen in place.
   */
  private replaceConfig(next: FeishuConfig): void {
    const live = this.config as unknown as Record<string, unknown>
    for (const key of Object.keys(live)) delete live[key]
    Object.assign(live, next)
  }

  /**
   * Apply an already-validated overlay over the profile config. Fields read
   * per event/turn take effect immediately; `RESTART_KEYS` need `restart()`.
   */
  applyOverlay(overlay: Partial<FeishuConfig>): void {
    this.replaceConfig({ ...this.baseConfig, ...overlay })
    this.refreshRetentionTimer()
  }

  /** Tear the connection down and bring it back with the latest config. */
  async restart(): Promise<void> {
    if (this.restarting) throw new Error('飞书连接正在重启，请稍候再试')
    this.restarting = true
    try {
      await this.shutdown()
      await this.loadOverlay()
      await this.start()
      this.lastStartError = undefined
      this.runningConfig = { ...this.config }
    } catch (error) {
      this.lastStartError = messageOf(error)
      // `start()` flips `started` before wiring; a failed reconnect must not
      // leave the panel claiming a live connection.
      try {
        await this.shutdown()
      } catch {
        // The restart error is the useful one.
      }
      throw error
    } finally {
      this.restarting = false
    }
  }

  isRunning(): boolean { return this.started }
  isRestarting(): boolean { return this.restarting }
  startedAtMs(): number | undefined { return this.startedAt }
  uptimeMs(): number | undefined {
    return this.startedAt === undefined || !this.started ? undefined : Math.max(0, Date.now() - this.startedAt)
  }
  startError(): string | undefined { return this.lastStartError }
  configSnapshot(): FeishuConfig { return { ...this.config } }
  baseConfigSnapshot(): FeishuConfig { return { ...this.baseConfig } }
  runningConfigSnapshot(): FeishuConfig | undefined {
    return this.runningConfig === undefined ? undefined : { ...this.runningConfig }
  }

  // ---- workspace retention cleanup -------------------------------------

  /**
   * Workspace-retention preview for the Web panel: how many plugin-created
   * workspaces exist, how many are past the configured window, and their
   * measured footprint. Never deletes anything.
   */
  async cleanupPreview(): Promise<{
    retention: string
    thresholdMs?: number
    auto: boolean
    workspaces: number
    candidates: number
    candidateBytes: number
    error?: string
  }> {
    const retention = this.config.workspaceRetention
    const window = retentionMs(retention)
    const base = {
      retention,
      ...(window === undefined ? {} : { thresholdMs: window }),
      auto: this.config.workspaceRetentionAuto,
    }
    try {
      const workspaces = this.ctx.workspaceRegistry.list().filter(workspace => this.isPluginWorkspace(workspace))
      const plan = await planWorkspaceCleanup(this.cleanupDeps())
      return {
        ...base,
        workspaces: workspaces.length,
        candidates: plan?.candidates.length ?? 0,
        candidateBytes: plan?.candidates.reduce((total, candidate) => total + candidate.bytes, 0) ?? 0,
      }
    } catch (error) {
      return { ...base, workspaces: 0, candidates: 0, candidateBytes: 0, error: messageOf(error) }
    }
  }

  /**
   * Delete every stale plugin workspace the configured retention allows.
   * Routes bound to a removed workspace are retired first (thread routes leave
   * a tombstone), so an old topic fails with the explicit expired card instead
   * of resuming into a missing directory. DSH Session logs are not touched.
   */
  async runWorkspaceCleanup(): Promise<{
    ok: boolean
    deletedWorkspaces: number
    retiredRoutes: number
    freedBytes: number
    failures: string[]
    error?: string
  }> {
    const empty = { ok: false, deletedWorkspaces: 0, retiredRoutes: 0, freedBytes: 0, failures: [] as string[] }
    if (retentionMs(this.config.workspaceRetention) === undefined) {
      return { ...empty, error: '未启用工作区清理阈值（workspaceRetention 为 off）' }
    }
    if (this.cleanupRunning) return { ...empty, error: '工作区清理正在进行中，请稍候' }
    this.cleanupRunning = true
    try {
      const deps = this.cleanupDeps()
      const plan = await planWorkspaceCleanup(deps)
      if (plan === undefined) return { ...empty, error: '工作区清理不可用：baseDir 配置无效' }
      const outcome = await applyWorkspaceCleanup(deps, plan)
      this.ctx.logger?.info?.(
        'dsh-channels: workspace cleanup removed %d workspace(s), retired %d route(s), freed %d bytes',
        outcome.deletedWorkspaces, outcome.retiredRoutes, outcome.freedBytes,
      )
      return {
        ok: true,
        deletedWorkspaces: outcome.deletedWorkspaces,
        retiredRoutes: outcome.retiredRoutes,
        freedBytes: outcome.freedBytes,
        failures: outcome.failures.map(failure => `${failure.path}: ${failure.message}`),
      }
    } catch (error) {
      return { ...empty, error: messageOf(error) }
    } finally {
      this.cleanupRunning = false
    }
  }

  /** Whether one registry workspace was created by this plugin inside `baseDir`. */
  private isPluginWorkspace(workspace: Workspace): boolean {
    const pluginTitle = workspace.title.startsWith('飞书私聊 ·') || workspace.title.startsWith('飞书群聊 ·')
    return pluginTitle && isPathInside(path.resolve(this.config.baseDir), workspace.path)
  }

  /** Effect seams for the cleanup policy module (all I/O stays here). */
  private cleanupDeps(): CleanupDeps {
    const baseDir = path.resolve(this.config.baseDir)
    return {
      baseDir,
      retention: this.config.workspaceRetention,
      listWorkspaces: () => this.ctx.workspaceRegistry.list(),
      activeRoutes: () => [...(this.domain?.routes.entries() ?? [])].map(([key, record]) => ({
        key,
        kind: record.kind,
        workspacePath: record.workspacePath,
        sessionId: record.sessionId,
        lastActivityAt: record.lastActivityAt,
      })),
      tombstones: () => [...(this.domain?.expiredRoutes.entries() ?? [])].map(([key, record]) => ({
        key,
        ...(record.workspacePath === undefined ? {} : { workspacePath: record.workspacePath }),
        expiredAt: record.expiredAt,
        ...(record.lastActivityAt === undefined ? {} : { lastActivityAt: record.lastActivityAt }),
      })),
      isLive: sessionId => this.sessions.get(sessionId) !== undefined
        || this.ctx.agents.get(sessionId as SessionId) !== undefined,
      statWorkspace: workspacePath => measureWorkspace(workspacePath),
      removeWorkspace: async workspace => {
        const target = path.resolve(workspace.path)
        if (!isPathInside(baseDir, target)) {
          throw new Error(`refusing to delete a path outside baseDir (${target})`)
        }
        // Re-verify the physical path: a symlinked ancestor inside baseDir
        // must not let the recursive delete escape it.
        try {
          const [physicalBase, physicalTarget] = await Promise.all([realpath(baseDir), realpath(target)])
          if (!isPathInside(physicalBase, physicalTarget)) {
            throw new Error(`refusing to delete a symlink escape outside baseDir (${physicalTarget})`)
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('refusing to delete a symlink escape')) throw error
          // A missing workspace is already effectively removed (rm is idempotent).
        }
        await rm(target, { recursive: true, force: true })
        try {
          await this.ctx.workspaceRegistry.delete(workspace.id)
        } catch (error) {
          this.ctx.logger?.warn?.(
            'dsh-channels: unregistering cleaned workspace %s failed: %s', workspace.path, String(error),
          )
        }
      },
      retireRoute: async route => {
        if (route.kind === 'thread') await this.routes.retire(route.key)
        else await this.routes.remove(route.key)
      },
      warn: message => this.ctx.logger?.warn?.(message),
    }
  }

  /**
   * (Re)arm the daily retention timer to match the live config. `runNow`
   * performs one pass immediately; it is only used at startup so saving any
   * unrelated setting can never trigger a surprise deletion pass.
   */
  private refreshRetentionTimer(runNow = false): void {
    if (this.retentionTimer !== undefined) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = undefined
    }
    if (!this.started
      || !this.config.workspaceRetentionAuto
      || retentionMs(this.config.workspaceRetention) === undefined) return
    const sweep = (): void => {
      void this.runWorkspaceCleanup().then(result => {
        if (!result.ok && result.error !== '工作区清理正在进行中，请稍候') {
          this.ctx.logger?.warn?.('dsh-channels: automatic workspace cleanup failed: %s', result.error)
        }
      })
    }
    if (runNow) sweep()
    const timer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS)
    timer.unref?.()
    this.retentionTimer = timer
  }

  /** Aggregate health used by `/health` and the Web settings panel. */
  health(): HealthSnapshot { return this.healthSnapshot() }

  /**
   * Credential facts for the two Feishu refs. Values are never returned:
   * `describe()` reports presence/source/writability only.
   */
  async credentialStates(): Promise<{ appId: CredentialInfo; appSecret: CredentialInfo }> {
    const provider = this.credentialProvider()
    const read = async (ref: string): Promise<CredentialInfo> => {
      try {
        if (provider?.describe !== undefined) {
          const info = await provider.describe(ref)
          return {
            configured: info?.configured === true,
            writable: info?.writable !== false && provider.set !== undefined,
            ...(info?.source === undefined ? {} : { source: info.source }),
          }
        }
        if (provider === undefined) {
          const ambient = process.env[ref]
          return { configured: ambient !== undefined && ambient !== '', writable: false }
        }
        return { configured: (await provider.resolve(ref)) !== undefined, writable: provider.set !== undefined }
      } catch {
        return { configured: false, writable: false }
      }
    }
    const [appId, appSecret] = await Promise.all([read(this.config.appId), read(this.config.appSecret)])
    return { appId, appSecret }
  }

  /** The host credentials seam, when mounted. */
  private credentialProvider(): CredentialProvider | undefined {
    return this.ctx.get?.('credentials') as CredentialProvider | undefined
  }

  /** Store one Feishu credential value through the host seam; the value is never logged. */
  async setCredential(field: 'appId' | 'appSecret', value: string): Promise<void> {
    const provider = this.credentialProvider()
    if (provider?.set === undefined) {
      throw new Error('主机的凭据服务不可写（未挂载 credentials.set，或当前提供方只读）')
    }
    const ref = this.credentialRef(field)
    try {
      await provider.set(ref, value)
    } catch (error) {
      throw new Error(`写入凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
  }

  /** Remove the stored value of one Feishu credential reference. */
  async clearCredential(field: 'appId' | 'appSecret'): Promise<void> {
    const provider = this.credentialProvider()
    if (provider?.unset === undefined) {
      throw new Error('主机的凭据服务不支持移除凭据')
    }
    const ref = this.credentialRef(field)
    try {
      await provider.unset(ref)
    } catch (error) {
      throw new Error(`移除凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
  }

  /** The overlay-independent ref name backing one editable credential slot. */
  private credentialRef(field: 'appId' | 'appSecret'): string {
    return field === 'appId' ? this.config.appId : this.config.appSecret
  }

  /** Wire events and open the long connection. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // 1. Resolve credentials through the host seam (env > .credentials.yaml > .env).
    const appId = await resolveCredentialRef(this.ctx, this.config.appId)
    const appSecret = await resolveCredentialRef(this.ctx, this.config.appSecret)

    // 2. Build the channel with the resolved secrets.
    const channel = this.channelFactory({
      appId,
      appSecret,
      loggerLevel: this.config.loggerLevel,
      requireMention: this.config.requireMention,
      dmMode: this.config.dmMode,
    })
    this.channel = channel
    const hooks: StreamerHooks = {
      measureContext: session => this.measureContext(session),
      projectStats: session => this.projectCardStats(session),
      sessionLabel: sessionId => sessionId,
      onError: (_key, error) => {
        this.ctx.logger?.warn?.('dsh-channels stream error: %s', String(error))
      },
      onTurnFinalized: (_sessionId, _turn, mainCardMessageId) => {
        // The turn settled (final patches fired, reaction swap requested):
        // retire its repair snapshot. Kept deliberately non-awaited — repair
        // state is a safety net, never a dependency of the turn lifecycle.
        void this.repair.clear(mainCardMessageId)
      },
      onSegmentDelivered: (mainCardMessageId, segmentIndex, messageId, mode) => {
        void this.repair.recordSegment(mainCardMessageId, segmentIndex, messageId, mode)
      },
      sendSegmentCard: (sessionId, segment, card, fallbackText) =>
        this.delivery.segmentCard(sessionId, segment, card, fallbackText),
    }
    this.streamer = new TurnStreamer(
      channel,
      this.config.refreshMs,
      hooks,
      this.config.statusRefreshMs,
    )

    this.domain = await openFeishuDomain(this.ctx)
    this.routes.load()

    // HITL: answer the host's approval/request waterfall for sessions this
    // channel routes. `prepend` claims such requests BEFORE the web gateway's
    // generic answerer (its panel would be invisible to a Feishu user), while
    // non-owned sessions delegate through `next()`.
    const answerer = new ApprovalAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels approval error (session %s): %s', sessionId, String(error))
      },
    }, this.config.approvalTimeoutMs)
    this.approvalAnswerer = answerer
    this.unlistenApproval = this.ctx.on('approval/request', (req, next) => answerer.onRequest(req, next), { prepend: true })
    // Structured questions (`ask_user_question`): the host's only shipped
    // answerer is the Web client, so a Feishu-only session would otherwise
    // fail every ask with NO_PROVIDER.
    const questions = new QuestionAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels question error (session %s): %s', sessionId, String(error))
      },
    }, this.config.questionTimeoutMs)
    this.questionAnswerer = questions
    this.unlistenQuestions = this.ctx.on(
      'user-questions/request',
      (request, next) => questions.onRequest(request, next),
      { prepend: true },
    )
    this.unlistenCardAction = channel.onCardAction(event => {
      answerer.onCardAction(event)
      questions.onCardAction(event)
    })

    this.ctx.on('session/event', (session, event) => {
      this.streamer?.onSessionEvent(session, event)
    })
    // DSH removed the durable `assistant/chunk` event (format v2 embeds the
    // stream in the settlement); the live deltas arrive here instead.
    this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.streamer?.onAssistantFrame(agent.session, frame)
    })
    this.unlisten = channel.onMessage(message => {
      void this.inbound.handle(message).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels inbound error: %s', String(error))
        // User-facing safety net: never leave the user without a reply.
        void channel
          .send(message.chatId, { text: `dsh-channels 处理失败：${String(error)}` }, { replyTo: message.messageId })
          .catch(() => {})
      })
    })
    await channel.connect()
    // Repair cards a previous instance left mid-flight (best-effort, background).
    void this.repair.repairAll().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: inflight repair failed: %s', String(error))
    })
    // Record GC: one sweep right after boot, then a slow periodic sweep.
    // Dedup records are pruned unconditionally (fixed retention); route
    // records of deleted topics (their thread id never reappears) are pruned
    // when `routeTtlMs` is enabled.
    void this.gcExpiredEntries().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: record GC failed: %s', String(error))
    })
    const timer = setInterval(() => {
      void this.gcExpiredEntries().catch(() => {})
    }, GC_SWEEP_INTERVAL_MS)
    timer.unref?.()
    this.gcTimer = timer
    // Workspace retention: opt-in automatic cleanup (default off).
    this.refreshRetentionTimer(true)
    this.ctx.logger?.info?.(
      'dsh-channels: feishu long connection established (bot open_id %s, %d route(s) loaded)',
      channel.botOpenId() ?? 'unknown',
      this.routes.size(),
    )
    console.info('[dsh-channels] feishu long connection established, bot open_id:', channel.botOpenId())
    console.info('[dsh-channels] activity build:', ACTIVITY_BUILD_MARKER)
    this.startedAt = Date.now()
    console.info('[dsh-channels] model request overrides:', {
      provider: this.config.provider ?? 'deployment-default',
      model: this.config.model ?? 'deployment-default',
      reasoningEffort: this.config.reasoningEffort ?? 'adapter-default',
    })
    const approvalMounted = this.ctx.get?.('approval') !== undefined
    console.info(
      approvalMounted
        ? `[dsh-channels] HITL 审批应答已就绪（决策卡片超时 ${this.config.approvalTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 approval 服务，HITL 审批应答关闭',
    )
    const questionsMounted = this.ctx.get?.('userQuestions') !== undefined
    console.info(
      questionsMounted
        ? `[dsh-channels] ask_user_question 应答已就绪（提问卡片超时 ${this.config.questionTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 userQuestions 服务，结构化提问应答关闭',
    )
  }

  /** Tear down: close the connection and dispose all live agents. */
  async shutdown(): Promise<void> {
    // Close admission first. In-flight Host commands receive cancellation
    // before their Agent/channel/storage dependencies are disposed, while
    // already queued route operations observe `started === false` and retire.
    this.started = false
    for (const controller of this.commandControllers) controller.abort()
    await Promise.allSettled([...this.commandOperations])
    this.commandControllers.clear()
    this.commandOperations.clear()
    this.unlisten?.()
    this.unlisten = undefined
    this.unlistenCardAction?.()
    this.unlistenCardAction = undefined
    this.unlistenApproval?.()
    this.unlistenApproval = undefined
    this.unlistenQuestions?.()
    this.unlistenQuestions = undefined
    // Withdraw in-flight approval questions (the host settles them cancelled).
    this.approvalAnswerer?.dispose()
    this.approvalAnswerer = undefined
    this.questionAnswerer?.dispose()
    this.questionAnswerer = undefined
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer)
      this.gcTimer = undefined
    }
    if (this.retentionTimer !== undefined) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = undefined
    }
    await this.sessions.disposeAll()
    this.routeOperations.clear()
    this.inbound.clear()
    this.routes.clear()
    try {
      await this.channel?.disconnect()
    } catch {
      // Already disconnected is fine.
    }
    this.channel = undefined
    this.streamer = undefined
    await this.domain?.close()
    this.domain = undefined
    this.runningConfig = undefined
  }

  // ---- inbound routing -------------------------------------------------

  
  /** Slash-command plane. Nothing in this method calls `agent.followup()`. */
  /**
   * Slash-command admission. The command vocabulary and its admission rules
   * come from the command registry; nothing here calls `agent.followup()`.
   */
  private async handleSlashMessage(msg: NormalizedMessage, line: string): Promise<void> {
    if (!this.started) return
    const parsed = parseSlashCommand(line)
    if (parsed === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'input-error',
        text: '命令名必须以小写字母开头，且只能包含小写字母、数字、下划线或连字符。',
        supported: supportedCommandList(),
      })
      return
    }
    const spec = commandSpec(parsed.name)
    if (spec === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unknown', command: parsed.name,
        text: `未找到命令 /${parsed.name}。`, supported: supportedCommandList(),
      })
      return
    }

    // Route-free commands answer without any Session work.
    if (spec.routeFree === true) {
      await this.runRouteFreeCommand(spec, msg, parsed)
      return
    }

    // A TTL-retired topic is permanently closed except for session-optional
    // diagnostics (`/health`).
    const expiredRoute = msg.threadId === undefined ? undefined : this.routes.expiredRoute(msg.threadId)
    if (expiredRoute !== undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.delivery.expiredRouteCard(msg, parsed.name)
      return
    }

    const route = await this.inbound.resolveRoute(msg)
    if (route === undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.delivery.commandCard(msg, {
        kind: 'unbound', command: parsed.name,
        text: '当前话题尚未绑定 Session。请先发送普通消息创建会话，或使用 /health 检查通道。',
      })
      return
    }

    if (msg.senderId !== route.senderOpenId) {
      await this.delivery.commandCard(msg, {
        kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
      })
      return
    }

    const operation = this.routeOperations.run(route.key, async () => {
      if (!this.started) return
      const current = this.routes.get(route.key) ?? route
      if (msg.senderId !== current.senderOpenId) {
        await this.delivery.commandCard(msg, {
          kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
        })
        return
      }
      await this.runRouteCommand(spec, msg, parsed, current)
    })
    this.commandOperations.add(operation)
    try {
      await operation
    } finally {
      this.commandOperations.delete(operation)
    }
  }

  /** Answer one command that needs no Session (help / userid / groupid / health). */
  private async runRouteFreeCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
  ): Promise<void> {
    const createThread = spec.directReply !== true
    if (parsed.rawInput.trim() !== '') {
      await this.delivery.commandCard(msg, {
        kind: 'input-error', command: spec.name, text: `用法错误：/${spec.name} 不接受参数。`,
      }, { createThread })
      return
    }
    if (spec.mentionGate === true
      && msg.chatType === 'group'
      && msg.threadId === undefined
      && this.config.requireMention
      && !msg.mentionedBot) {
      return
    }
    if (spec.chatType !== undefined && msg.chatType !== spec.chatType) {
      await this.delivery.commandCard(msg, {
        kind: 'context-error', command: spec.name,
        text: spec.chatType === 'p2p'
          ? `命令 /${spec.name} 仅支持在私聊中使用。`
          : `命令 /${spec.name} 仅支持在群聊中使用。`,
      }, { createThread })
      return
    }
    await this.delivery.withCommandReaction(msg, async () => {
      switch (spec.name) {
        case 'help':
          await this.delivery.commandCard(msg, { kind: 'help', text: supportedCommandHelp() }, { createThread })
          return
        case 'userid':
          await this.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前用户 ID：\`${msg.senderId}\``,
          }, { createThread })
          return
        case 'groupid':
          await this.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前群组 ID：\`${msg.chatId}\``,
          }, { createThread })
          return
        case 'health':
          await this.delivery.standaloneReply(msg, buildHealthCard(this.healthSnapshot()), { createThread })
          return
        default:
          await this.delivery.commandCard(msg, {
            kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
          }, { createThread })
      }
    })
  }

  /** Answer one route-bound command inside the per-route admission queue. */
  private async runRouteCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    await this.delivery.withCommandReaction(msg, async () => {
      try {
        if (spec.channelPlane === true) {
          await this.runChannelCommand(spec, msg, parsed, current)
          return
        }
        await this.runAgentCommand(spec, msg, parsed, current)
      } catch (error) {
        this.ctx.logger?.warn?.(
          'dsh-channels: command /%s failed for session %s: %s',
          spec.name, current.sessionId, String(error),
        )
        await this.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: '命令执行失败，请稍后重试；若持续发生，请查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
    })
  }

  /**
   * Commands the channel answers itself. `/stop` aborts the live turn
   * directly and deliberately never cold-resumes a Session just to cancel
   * nothing.
   */
  private async runChannelCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    if (spec.name === 'permissions') {
      await this.runPermissionsCommand(msg, parsed, current)
      return
    }
    if (spec.name === 'stop') {
      const agent = this.sessions.get(current.sessionId)?.agent
        ?? this.ctx.agents.get(current.sessionId as SessionId)
      const running = agent?.status === 'running'
      agent?.cancel?.({ kind: 'user' })
      await this.delivery.commandCard(msg, {
        kind: 'success', command: 'stop', sessionId: current.sessionId,
        text: running ? '已请求停止当前回合。' : '当前没有正在运行的回合。',
      })
      return
    }
    await this.delivery.commandCard(msg, {
      kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
      sessionId: current.sessionId,
    })
  }

  /**
   * `/permissions`: show this Session's effective sandbox+approval preset and
   * the selectable catalog; switch only when the deployment opted in.
   */
  private async runPermissionsCommand(
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    const presets = this.ctx.get?.('permissionPresets') as PermissionPresets | undefined
    if (presets === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
        text: '当前部署未挂载 permissionPresets 服务，无法查看权限预设。',
      })
      return
    }
    const live = await this.sessions.ensureLive(current)
    let active: string | undefined
    let catalogLine = ''
    try {
      active = presets.current(live.agent.session)
      const catalog = presets.catalog()
      catalogLine = catalog.options.map(option => `\`${option.value}\``).join('、')
    } catch {
      active = undefined
    }
    const requested = parsed.rawInput.trim()
    if (requested === '') {
      const lines = [
        `**当前权限预设**：${active === undefined ? '暂无数据' : `\`${active}\``}`,
        ...(catalogLine === '' ? [] : [`**可选预设**：${catalogLine}`]),
        ...(this.config.allowPermissionSwitch
          ? ['使用 `/permissions <name>` 切换；切换会同时调整沙箱与审批策略。']
          : ['当前部署未开启飞书侧切换（`allowPermissionSwitch: false`），仅支持查看。']),
      ]
      await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设**', lines))
      return
    }
    if (!this.config.allowPermissionSwitch) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
        text: '当前部署未开启飞书侧权限切换，仅支持 /permissions 查看。',
      })
      return
    }
    try {
      presets.set(live.agent.session, requested)
      await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设已切换**', [
        `**当前权限预设**：\`${requested}\``,
        '沙箱模式与审批策略已按该预设更新。',
      ]))
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: permission switch for session %s failed: %s', current.sessionId, String(error),
      )
      await this.delivery.commandCard(msg, {
        kind: 'input-error', command: 'permissions', sessionId: current.sessionId,
        text: `未知或不可用的权限预设：\`${requested}\`。可用：${catalogLine === '' ? '暂无数据' : catalogLine}`,
      })
    }
  }

  /**
   * Execute one command through the agent command plane: resolve the live
   * agent, mount borrowed channel commands when needed, arm the channel-scoped
   * `/renew` and `/effort` handlers, then render the settled result.
   */
  private async runAgentCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    // An alias (`/new`) resolves to this canonical spec; execute the canonical
    // line so the agent command plane finds the registered definition.
    const line = `/${spec.name}${parsed.rawInput}`
    const live = await this.sessions.ensureLive(current)
    let definition = this.ctx.commands.find(live.agent, spec.name)
    let unregisterBorrowedCommand: (() => void) | undefined
    if (definition === undefined && spec.name === 'renew') {
      unregisterBorrowedCommand = registerRenewCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined && spec.name === 'effort') {
      unregisterBorrowedCommand = registerEffortCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined && spec.name === 'model') {
      unregisterBorrowedCommand = registerModelCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined) {
      unregisterBorrowedCommand?.()
      const text = spec.name === 'compact'
        ? '当前部署未挂载 Harness 原生 /compact 命令。'
        : `当前 Session 未挂载 /${spec.name} 命令。`
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name, text, sessionId: current.sessionId,
      })
      return
    }
    const compactBefore = spec.name === 'compact'
      ? await this.measureCommandContext(live.agent.session)
      : undefined
    const controller = new AbortController()
    this.commandControllers.add(controller)
    const renewAdmission: RenewAdmission | undefined = spec.name === 'renew'
      ? { route: current, live }
      : undefined
    const effortAdmission: EffortAdmission | undefined = spec.name === 'effort'
      ? { live, controller: this.sessions.requestPolicy(live.agent) }
      : undefined
    const modelAdmission: ModelAdmission | undefined = spec.name === 'model'
      ? { live, controller: this.sessions.requestPolicy(live.agent) }
      : undefined
    const disarmRenew = renewAdmission === undefined
      ? undefined
      : armRenewCommand(controller.signal, invocation => this.runRenewCommand(invocation, renewAdmission))
    const disarmEffort = effortAdmission === undefined
      ? undefined
      : armEffortCommand(
          controller.signal,
          (invocation, action) => this.runEffortCommand(invocation, action, effortAdmission),
        )
    const disarmModel = modelAdmission === undefined
      ? undefined
      : armModelCommand(
          controller.signal,
          (invocation, rawInput) => this.runModelCommand(invocation, rawInput, modelAdmission),
        )
    let execution
    try {
      execution = await this.ctx.commands.execute(live.agent, line, [], controller.signal)
    } finally {
      this.commandControllers.delete(controller)
      disarmRenew?.()
      disarmEffort?.()
      disarmModel?.()
      unregisterBorrowedCommand?.()
      if (renewAdmission?.commit !== undefined) {
        await this.sessions.releaseRenewed(renewAdmission.commit)
      }
    }
    if (controller.signal.aborted || !this.started) return
    if (execution === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: `当前 Session 无法执行 /${spec.name}。`, sessionId: current.sessionId,
      })
      return
    }
    await this.renderCommandResult({
      spec, msg, current, live,
      result: execution.result,
      compactBefore,
      renewAdmission,
      effortAdmission,
      modelAdmission,
    })
  }

  /** Render one settled agent-plane command result. */
  private async renderCommandResult(input: {
    spec: ChannelCommandSpec
    msg: NormalizedMessage
    current: RouteRecord
    live: LiveAgent
    result: CommandResult
    compactBefore: ContextMeasurement | undefined
    renewAdmission: RenewAdmission | undefined
    effortAdmission: EffortAdmission | undefined
    modelAdmission: ModelAdmission | undefined
  }): Promise<void> {
    const { spec, msg, current, live, result, compactBefore, renewAdmission, effortAdmission, modelAdmission } = input
    if (spec.name === 'effort') effortAdmission?.controller.sync(live.agent.session.snapshotEvents())
    if (spec.name === 'model') modelAdmission?.controller.sync(live.agent.session.snapshotEvents())
    if (spec.name === 'renew' && result.kind === 'success' && renewAdmission?.commit !== undefined) {
      await this.delivery.standaloneReply(msg, buildRenewCard({
        previousSessionId: renewAdmission.commit.previous.sessionId,
        currentSessionId: renewAdmission.commit.current.sessionId,
        workspacePath: renewAdmission.commit.current.workspacePath,
      }))
      return
    }
    if (spec.name === 'health' && result.kind === 'success') {
      await this.delivery.standaloneReply(msg, buildHealthCard(this.healthSnapshot()))
      return
    }
    if (spec.name === 'status' && result.kind === 'success') {
      const session = live.agent.session
      const stats = foldSessionStats(session, this.projectionRegistry())
      const context = await measureSessionContext(
        session, this.commandContextServices(), stats.lastHeader,
      )
      await this.delivery.standaloneReply(msg, buildSessionStatusCard({
        sessionId: current.sessionId,
        stats,
        context,
        extras: {
          permissionPreset: this.permissionPresetOf(session),
          workspacePath: current.workspacePath,
          uptimeMs: this.startedAt === undefined ? undefined : Date.now() - this.startedAt,
          liveAgents: this.sessions.liveCount(),
          routeCount: this.routes.size(),
        },
      }))
      return
    }
    if (spec.name === 'workspace' && result.kind === 'success') {
      const resolved = resolveWorkDir(live.agent.session.header.cwd, current.workspacePath)
      if (resolved.kind === 'success') {
        await this.delivery.standaloneReply(msg, buildWorkDirCard(current.sessionId, resolved.path))
        return
      }
      if (resolved.kind === 'mismatch') {
        this.ctx.logger?.warn?.(
          'dsh-channels: workspace mismatch for session %s (paths redacted)', current.sessionId,
        )
      }
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: resolved.text, sessionId: current.sessionId,
      })
      return
    }
    if (spec.name === 'history' && result.kind === 'success') {
      await this.delivery.standaloneReply(msg, buildSessionHistoryCard(
        current, await this.sessionHistoryAnnotations(current),
      ))
      return
    }
    if (spec.name === 'export' && result.kind === 'success') {
      try {
        const file = await this.sessionExportBuilder(live.agent.session)
        await this.delivery.requireChannel().send(msg.chatId, { file }, {
          replyTo: msg.messageId,
          replyInThread: true,
        })
      } catch (error) {
        this.ctx.logger?.warn?.(
          'dsh-channels: logical export delivery failed for session %s: %s',
          current.sessionId, String(error),
        )
        await this.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: 'Session 逻辑日志导出失败，未交付文件；请稍后重试并查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
      return
    }
    if (spec.name === 'compact' && compactBefore !== undefined) {
      const compactAfter = await this.measureCommandContext(live.agent.session)
      if (result.kind === 'success') {
        await this.delivery.standaloneReply(msg, buildCompactComparisonCard({
          sessionId: current.sessionId,
          resultText: result.text ?? '命令已执行。',
          before: compactBefore,
          after: compactAfter,
        }))
        return
      }
      await this.delivery.commandCard(msg, {
        kind: commandResultCardKind(result), command: spec.name,
        text: `${result.text}\n\n${compactFailureContext(compactBefore, compactAfter)}`,
        sessionId: current.sessionId,
      })
      return
    }
    await this.delivery.commandCard(msg, {
      kind: commandResultCardKind(result), command: spec.name,
      text: result.text ?? '命令已执行。', sessionId: current.sessionId,
    })
  }

  /**
   * Annotate a route's session history with host-query facts: the latest
   * log-backed title per session and whether it is currently live. Both are
   * best-effort — a missing or failing `sessionQuery` only drops the titles.
   */
  private async sessionHistoryAnnotations(record: RouteRecord): Promise<Record<string, SessionHistoryAnnotation>> {
    const ids = normalizeSessionHistory(record)
      .slice(-SESSION_HISTORY_DISPLAY_LIMIT)
      .map(entry => entry.sessionId)
    const annotations: Record<string, SessionHistoryAnnotation> = {}
    for (const id of ids) {
      annotations[id] = { live: this.sessions.get(id) !== undefined || this.ctx.agents.get(id as SessionId) !== undefined }
    }
    const query = this.ctx.get?.('sessionQuery') as SessionQuery | undefined
    if (query === undefined) return annotations
    try {
      const results = await query.readTitleSnapshots(ids as SessionId[])
      for (const item of results) {
        if (item.status !== 'fulfilled' || item.value.title === undefined) continue
        annotations[item.sessionId] = { ...annotations[item.sessionId], title: item.value.title.title }
      }
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: session title lookup failed: %s', String(error))
    }
    return annotations
  }

  /** Effective permission preset of one Session, when the service is mounted. */
  private permissionPresetOf(session: Session): string | undefined {
    const presets = this.ctx.get?.('permissionPresets') as PermissionPresets | undefined
    try {
      return presets?.current(session)
    } catch {
      return undefined
    }
  }

  /** Optional diagnostic services resolved without topology-sensitive property access. */
  private commandContextServices(): ContextServices {
    return {
      tokenMeter: this.ctx.get?.('tokenMeter') as TokenMeter | undefined,
      llm: this.ctx.get?.('llm') as LlmService | undefined,
    }
  }

  /** Exact command-time measurement shared by `/status` and `/compact`. */
  private measureCommandContext(session: Session): Promise<ContextMeasurement> {
    return measureSessionContext(session, this.commandContextServices())
  }

  /** Capture aggregate health only; raw configuration and errors are excluded. */
  private healthSnapshot(): HealthSnapshot {
    const serviceKeys: Record<HealthDependencyName, string> = {
      agents: 'agents',
      commands: 'commands',
      workspace: 'workspaceRegistry',
      storage: 'storageDomain',
      credentials: 'credentials',
      llm: 'llm',
      'token-meter': 'tokenMeter',
    }
    const directServices: Record<HealthDependencyName, () => unknown> = {
      agents: () => this.ctx.agents,
      commands: () => this.ctx.commands,
      workspace: () => this.ctx.workspaceRegistry,
      storage: () => this.ctx.storageDomain,
      credentials: () => this.ctx.credentials,
      llm: () => this.ctx.llm,
      'token-meter': () => this.ctx.tokenMeter,
    }
    const dependencies = Object.fromEntries(HEALTH_DEPENDENCY_NAMES.map(name => {
      try {
        const service = this.ctx.get === undefined
          ? directServices[name]()
          : this.ctx.get(serviceKeys[name])
        return [name, service !== undefined]
      } catch {
        return [name, false]
      }
    })) as Record<HealthDependencyName, boolean>

    const fibers: CordisFiber[] = []
    try {
      for (const runtime of this.ctx.registry.values()) {
        for (const fiber of runtime.fibers) fibers.push(fiber)
      }
    } catch {
      // Registry inspection is diagnostic only. An empty fold is safer than
      // exposing or propagating an internal registry error to the user.
    }

    const inflightTurnCount = this.repair.count()

    let connection
    let botOpenId: string | undefined
    try { connection = this.channel?.getConnectionStatus() } catch {}
    try { botOpenId = this.channel?.botOpenId() } catch {}

    return foldHealthSnapshot({
      fibers,
      dependencies,
      connection,
      botOpenId,
      started: this.started,
      routeCount: this.routes.size(),
      liveAgentCount: this.sessions.liveCount(),
      inflightTurnCount,
    })
  }











  /**
   * GC pass over the routing domain. Two independent halves:
   *
   * 1. Dedup records (unconditional): `processed` records and in-process
   *    guard entries older than `PROCESSED_RETENTION_MS` are dropped —
   *    redelivery windows are minutes, so a day of retention is ample and
   *    keeps the table bounded regardless of the route TTL setting.
   * 2. Route/inflight GC (`routeTtlMs > 0`): thread routes idle past the TTL
   *    are retired into minimal persistent tombstones before their active
   *    records are deleted. A later message in that visible topic is then
   *    rejected instead of silently creating a context-free Session. Degraded
   *    chat-scoped routes have no topic boundary and are deleted normally.
   *    Stale in-flight snapshots are deleted without surprising the user with
   *    a repair of an ancient card. Sessions and workspaces remain host-owned.
   *
   * Per-key failures are logged and skipped; concurrent writes are safe
   * because `entries()` snapshots.
   */
  private async gcExpiredEntries(): Promise<void> {
    const now = Date.now()
    const processedCutoff = now - PROCESSED_RETENTION_MS
    let removedRoutes = 0
    let retiredThreadRoutes = 0
    let removedInflight = 0
    let removedProcessed = 0

    const processed = this.domain?.processed
    if (processed !== undefined) {
      for (const [key, record] of [...processed.entries()]) {
        if (record.processedAt >= processedCutoff) continue
        try {
          await processed.delete(key)
          removedProcessed++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of processed record %s failed: %s', key, String(error))
        }
      }
    }
    this.inbound.pruneAccepted(processedCutoff)

    const ttlMs = this.config.routeTtlMs
    if (ttlMs === 0) {
      if (removedProcessed > 0) {
        this.ctx.logger?.info?.('dsh-channels: record GC removed %d dedup record(s)', removedProcessed)
      }
      return
    }
    const cutoff = now - ttlMs

    const routes = this.domain?.routes
    if (routes !== undefined) {
      for (const [key, record] of [...routes.entries()]) {
        if (record.lastActivityAt >= cutoff) continue
        try {
          if (record.kind === 'thread') {
            await this.routes.expireThread(key, now)
            retiredThreadRoutes++
          } else {
            await this.routes.remove(key)
          }
          removedRoutes++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of route %s failed: %s', key, String(error))
        }
      }
    }

    const inflight = this.domain?.inflight
    if (inflight !== undefined) {
      for (const [key, snapshot] of [...inflight.entries()]) {
        if (snapshot.startedAt >= cutoff) continue
        try {
          await inflight.delete(key)
          removedInflight++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of inflight snapshot %s failed: %s', key, String(error))
        }
      }
    }

    if (removedRoutes > 0 || removedInflight > 0 || removedProcessed > 0) {
      this.ctx.logger?.info?.(
        'dsh-channels: record GC removed %d route(s) (%d thread tombstone(s)), %d stale snapshot(s), %d dedup record(s)',
        removedRoutes, retiredThreadRoutes, removedInflight, removedProcessed,
      )
    }
  }


  /**
   * HITL answerer hook: the Feishu placement of one session's approval cards,
   * or `undefined` when this channel does not route the session (the answerer
   * then delegates to other answerers).
   */
  private approvalRouteFor(sessionId: string): ApprovalRoute | undefined {
    const record = this.routes.findBySession(sessionId)
    if (record === undefined) return undefined
    return {
      chatId: record.chatId,
      cardMessageId: record.cardMessageId,
      inThread: record.kind === 'thread',
      senderOpenId: record.senderOpenId,
    }
  }

  /**
   * Send one body-segment continuation card into the session's topic (or, for
   * degraded chat-scoped routes, as a plain reply anchored to the main card).
   * When Feishu rejects the card (e.g. per-card table limit, error 11310) the
   * segment is re-delivered as a plain-text message so the content is never
   * lost — text messages carry no card constraints.
   */
  /** Authorized Session-level `/model` view/switch operation. */
  private async runModelCommand(
    invocation: CommandInvocation,
    rawInput: string,
    admission: ModelAdmission,
  ): Promise<CommandResult> {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/model 只能通过已授权的飞书话题执行。' }
    }
    const session = invocation.agent.session
    const state = admission.controller.state
    const header = session.requestHeader?.()?.config
    const currentProvider = state.effectiveModel?.provider
      ?? (typeof header?.provider === 'string' && header.provider !== '' ? header.provider : undefined)
    const currentModel = state.effectiveModel?.model
      ?? (typeof header?.model === 'string' && header.model !== '' ? header.model : undefined)
    const source = state.modelSource === 'session'
      ? 'Session 覆盖'
      : state.modelSource === 'config' ? '配置默认' : '部署默认'

    if (rawInput === '') {
      const lines = [
        `**当前模型**：${currentModel === undefined ? '尚无模型请求记录' : `\`${currentModel}\``}`
          + `${currentProvider === undefined ? '' : `（provider \`${currentProvider}\`）`} · ${source}`,
      ]
      const models = await this.listModels(currentProvider)
      if (models.length > 0) {
        lines.push(`**可选模型（${models.length}）**：${models.slice(0, 20).map(id => `\`${id}\``).join('、')}`
          + (models.length > 20 ? ' …' : ''))
      } else if (currentProvider === undefined) {
        lines.push('当前还没有模型请求记录；可先用 `/model <provider>/<model>` 指定，或先发一条普通消息。')
      }
      lines.push('用法：`/model <模型-id>`（沿用当前 provider）· `/model <provider>/<model>` · `/model reset`')
      return { kind: 'success', text: lines.join('\n') }
    }

    if (rawInput === 'reset') {
      return { kind: 'success', text: '已恢复部署默认模型（下一条消息生效）。' }
    }

    const slash = rawInput.indexOf('/')
    const provider = slash === -1 ? currentProvider : rawInput.slice(0, slash)
    const model = slash === -1 ? rawInput : rawInput.slice(slash + 1)
    if (model === '' || (slash !== -1 && (provider === undefined || provider === ''))) {
      return { kind: 'error', text: '用法错误：/model [模型-id|provider/model|reset]。' }
    }
    // Validate against the advertised catalog when the deployment exposes one;
    // an unsupported value would otherwise only fail at the next request.
    if (provider !== undefined) {
      const models = await this.listModels(provider)
      if (models.length > 0 && !models.includes(model)) {
        return {
          kind: 'error',
          text: `provider \`${provider}\` 未提供模型 \`${model}\`。可选：${models.slice(0, 20).map(id => `\`${id}\``).join('、')}`,
        }
      }
    }
    const label = provider === undefined ? model : `${provider}/${model}`
    return { kind: 'success', text: `当前 Session 模型已切换为 \`${label}\`（下一条消息生效）。` }
  }

  /** Model ids advertised for one provider route (empty when unavailable). */
  private async listModels(provider: string | undefined): Promise<string[]> {
    if (provider === undefined) return []
    try {
      const llm = this.ctx.get?.('llm') as LlmService | undefined
      const models = await llm?.listModels?.(provider)
      return (models ?? []).map(entry => entry.id ?? entry.name ?? '').filter(id => id !== '')
    } catch {
      return []
    }
  }

  /**
   * Agent-scoped `/renew` handler. Only the Feishu admission path arms its
   * AbortSignal, preventing another Host client from switching a Feishu route
   * by invoking the scoped command out of band.
   */
  private async runRenewCommand(
    invocation: CommandInvocation,
    admission: RenewAdmission,
  ): Promise<CommandResult> {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/renew 只能通过已授权的飞书话题执行。' }
    }
    const current = this.routes.get(admission.route.key)
    if (current === undefined || current.sessionId !== admission.route.sessionId) {
      return { kind: 'error', text: '当前话题绑定已变化，请重试 /renew。' }
    }
    try {
      admission.commit = await this.sessions.renew(current, admission.live)
      return { kind: 'success', text: '新 Session 已创建并绑定。' }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: renew transaction failed for session %s: %s',
        current.sessionId, String(error),
      )
      return { kind: 'error', text: 'Session 续建失败，原 Session 仍保持绑定；请稍后重试。' }
    }
  }

  /** Authorized Session-level `/effort` view/switch operation. */
  private runEffortCommand(
    invocation: CommandInvocation,
    action: EffortCommandAction,
    admission: EffortAdmission,
  ): CommandResult {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/effort 只能通过已授权的飞书话题执行。' }
    }
    const state = admission.controller.state
    if (action.kind === 'show') {
      if (state.effortSource === 'session') {
        return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（Session 覆盖）。` }
      }
      if (state.effortSource === 'config') {
        return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（配置默认）。` }
      }
      return { kind: 'success', text: '当前 Session 未设置推理强度覆盖，使用模型适配器/provider 默认。' }
    }
    if (action.kind === 'reset') {
      return state.configuredEffort === undefined
        ? { kind: 'success', text: '已恢复模型适配器/provider 默认推理强度。' }
        : { kind: 'success', text: `已恢复配置默认推理强度：\`${state.configuredEffort}\`。` }
    }
    return { kind: 'success', text: `当前 Session 推理强度已切换为：\`${action.value}\`。` }
  }

  // ---- outbound helpers ------------------------------------------------

  /** Context pressure for the card's second info line (synchronous reads only). */
  private measureContext(session: Session): { contextTokens?: number; contextWindow?: number } {
    let contextTokens: number | undefined
    try {
      // Optional peers are read through ctx.get (safe lookup); direct property
      // access on a cordis context throws for services the plugin did not inject.
      const meter = this.ctx.get?.('tokenMeter') as TokenMeter | undefined
      contextTokens = meter?.measure(session).totalTokens
    } catch {
      contextTokens = undefined
    }

    // The route-capacity window is published by the host's `contextPressure`
    // projection; the old request/header scan + resolveModelInfo call stays as
    // a fallback for deployments without the projection registry.
    let contextWindow = readProjectionViews(this.projectionRegistry(), session).contextPressure?.contextWindow
    if (contextWindow === undefined) {
      try {
        const header = session.requestHeader?.()?.config
        const provider = typeof header?.provider === 'string' ? header.provider : undefined
        const model = typeof header?.model === 'string' ? header.model : undefined
        if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
          const routeKey = `${provider}/${model}`
          contextWindow = this.contextWindows.get(routeKey)
          if (contextWindow === undefined && !this.windowRequests.has(routeKey)) {
            this.windowRequests.add(routeKey)
            const llm = this.ctx.get?.('llm') as LlmService | undefined
            void llm?.resolveModelInfo(provider, model)
              .then(info => {
                if (info?.context?.contextWindow !== undefined) {
                  this.contextWindows.set(routeKey, info.context.contextWindow)
                }
              })
              .catch(() => {})
          }
        }
      } catch {
        contextWindow = undefined
      }
    }

    return { contextTokens, contextWindow }
  }

  /** Host projection registry, when this deployment mounts one. */
  private projectionRegistry(): SessionProjections | undefined {
    return this.ctx.get?.('sessionProjections') as SessionProjections | undefined
  }

  /** Card figures from host projections (token totals / cache hit / window). */
  private projectCardStats(session: Session): ProjectedStats | undefined {
    const views = readProjectionViews(this.projectionRegistry(), session)
    const usage = views.tokenUsage
    const pressure = views.contextPressure
    if (usage === undefined && pressure === undefined) return undefined
    const last = usage?.last?.buckets
    const hit = last === undefined ? undefined : last.cacheReadTokens
    const uncached = last === undefined ? undefined : last.uncachedInputTokens
    const cacheHit = hit !== undefined && uncached !== undefined && hit + uncached > 0
      ? hit / (hit + uncached)
      : undefined
    return {
      ...(usage === undefined ? {} : {
        inputTokens: usage.totals.uncachedInputTokens,
        outputTokens: usage.totals.outputTokens,
      }),
      ...(cacheHit === undefined ? {} : { cacheHitPct: cacheHit }),
      ...(pressure?.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow }),
    }
  }
}
