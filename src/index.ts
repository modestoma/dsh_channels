/**
 * dsh-channels — DeepSeek Harness 飞书渠道插件。
 *
 * 一个 dsh 实例对应一个飞书机器人；用户通过私聊、群聊 @、话题群 @ 三种方式
 * 发起会话。每条触发消息：立即加 “Typing” 表情 → 以话题形式回复（创建话题）
 * → 绑定 DSH session → 卡片 2.0 流式回复（推理折叠面板 + 富文本正文 + 两行
 * session 信息，默认 500ms 刷新）→ 流式结束移除 Typing，成功更新为
 * “DONE”，失败显示结构化错误并更新为 “No”。
 *
 * 工作区归属：私聊一人一工作区；群聊中每个用户在该群拥有独立工作区
 * （目录即工作区，会话以 cwd 落盘）。
 *
 * @module dsh-channels
 */

import type { HostContext } from './dsh-types.ts'
import { FeishuService } from './service.ts'
import { configSchema, resolveConfig } from './config.ts'
import type { FeishuConfig } from './config.ts'
import { defaultChannelFactory } from './feishu-channel.ts'
import type { ChannelFactory } from './feishu-channel.ts'
import { OverlayStore, defaultOverlayPath } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { SettingsSurface } from './settings/surface.ts'

export type * from './config.ts'
export type * from './cards.ts'
export type * from './domain.ts'
export type * from './feishu-channel.ts'
export type * from './approvals.ts'
export type * from './commands.ts'
export type * from './health.ts'
export type * from './session-commands.ts'
export type * from './session-export.ts'
export type * from './stats.ts'
export type * from './questions.ts'
export type * from './settings/contract.ts'
export { CONFIG_ROUTE, CREDENTIALS_ROUTE, EDITABLE_KEYS, PANEL_COPY, PANEL_ROUTE, RECONNECT_ROUTE, RESTART_KEYS, STATUS_ROUTE } from './settings/contract.ts'
export { defaultOverlayPath, mergeOverlay, normalizeOverlay, OverlayStore, parseOverlay, pickEditable, resolveDshHome } from './settings/overlay.ts'
export { FIELD_DESCRIPTORS, normalizeCredentialValue, readOnlyFields, SettingsSurface } from './settings/surface.ts'
export type { SettingsTarget } from './settings/surface.ts'
export { isSameOriginRequest, mountSettingsRoutes, registerSettingsRoutes } from './settings/routes.ts'
export type { HostWebServer } from './settings/routes.ts'
export type { ApprovalOutcome, ApprovalRequest, ApprovalAnswererListener, AssistantStreamFrame, AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequestEvent, UserQuestionAnswererListener, AgentCancelCause, SessionStatsView, TokenUsageView, ContextPressureView, SessionProjections } from './dsh-types.ts'
export { buildCard, buildInterruptionCard, cardJsonBytes, CARD_MAX_BYTES, CARD_TARGET_BYTES, CARD_PANEL_RESERVE_BYTES, REASONING_MAX_BYTES, INTERRUPTION_NOTICE, MAX_TABLES_PER_CARD, PANEL_TITLES, PANEL_CHEVRON_TOKEN, segmentCardContent, splitBodyForCard, stripTables, tableBlocks, TRUNCATION_SUFFIX, buildApprovalCard, buildApprovalSettledCard, buildQuestionCard, buildQuestionSettledCard, MAX_QUESTION_OPTIONS } from './cards.ts'
export { ApprovalAnswerer } from './approvals.ts'
export { QuestionAnswerer } from './questions.ts'
export { armModelCommand, buildCommandResultCard, CHANNEL_COMMAND_NAMES, commandResultCardKind, isSupportedCommand, parseSlashCommand, registerChannelCommands, registerModelCommand, RouteOperationQueue, SUPPORTED_COMMAND_NAMES, supportedCommandHelp, supportedCommandList } from './commands.ts'
export { buildHealthCard, countFiberStates, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES, maskOpenIdTail } from './health.ts'
export { buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard, compactFailureContext, querySessionHistory, resolveWorkDir, SESSION_HISTORY_DISPLAY_LIMIT } from './session-commands.ts'
export { createLogicalSessionExport, DSH_CHANNELS_VERSION, LOGICAL_EXPORT_FORMAT, LOGICAL_EXPORT_FORMAT_VERSION, serializeLogicalSession } from './session-export.ts'
export { addUsage, applyProjectionViews, averageDecodeTokensPerSecond, averageTtftMs, cacheHitPct, EMPTY_TOTALS, foldAll, foldEvent, foldSessionStats, measureSessionContext, readProjectionViews, usageFromBuckets } from './stats.ts'
export { FeishuService } from './service.ts'
export { TurnStreamer } from './streamer.ts'
export { ensureWorkspace, workspacePathFor, workspaceTitleFor } from './workspaces.ts'
export { appendSessionHistory, chatRouteKey, expiredRouteRecordSchema, feishuDomain, normalizeRouteRecord, normalizeSessionHistory, routeRecordSchema, sessionHistoryEntrySchema, inflightSnapshotSchema, processedRecordSchema } from './domain.ts'

/** Cordis function-plugin name. */
export const name = 'channels'

/** Host services this plugin consumes (all resolved through ctx).
 *
 * `credentials` is listed even though the plugin could fall back to the
 * process environment: at boot the credentials provider may not be visible
 * yet (a race observed in real profiles), and inject makes the loader wait
 * for it. `llm` / `tokenMeter` feed the card's context line and ship with
 * every dsh-base profile.
 */
export const inject = ['agents', 'commands', 'workspaceRegistry', 'storageDomain', 'credentials', 'llm', 'tokenMeter'] as const

/**
 * Cordis Standard Schema declaration for the plugin config.
 *
 * The loader validates (and default-fills) the raw composition config through
 * `Config['~standard'].validate()` *before* `apply()` runs, so a malformed
 * `cordis.patch.yml` entry fails at load time with a cordis `ValidationError`
 * instead of surfacing from inside the async service start. `apply()` keeps
 * its `resolveConfig()` fallback for direct invocation (unit tests, embedded
 * hosts) where config has not been pre-validated.
 */
export const Config = configSchema

export interface FeishuPluginOptions extends FeishuConfig {
  /** Test seam: substitute a channel implementation. */
  channelFactory?: ChannelFactory
}

/**
 * Install the bridge. Credentials stay references here — the actual secrets
 * resolve through `ctx.credentials` (env > `$DSH_HOME/.credentials.yaml`
 * > `.env`) when `FeishuService.start()` builds the channel.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const resolved = resolveConfig(config)
  const factory: ChannelFactory = (config as FeishuPluginOptions | undefined)?.channelFactory
    ?? defaultChannelFactory
  // Web settings overlay (optional file; degrades to "no overrides").
  const overlay = new OverlayStore(
    resolved.settingsFile ?? defaultOverlayPath(),
    { warn: (message, ...args) => ctx.logger?.warn?.(message, ...args) },
  )
  const service = new FeishuService(ctx, resolved, factory, undefined, overlay)
  // Settings routes ride the host's web server when this deployment has one.
  mountSettingsRoutes(ctx, new SettingsSurface(service, overlay, {
    warn: (message, ...args) => ctx.logger?.warn?.(message, ...args),
  }))
  ctx.effect(() => {
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('dsh-channels failed to start: %s', String(error))
      // Critical lifecycle line duplicated to the console: cordis logger
      // messages emitted before a web exporter attaches are buffered and may
      // never reach stdout, which makes real-device debugging guesswork.
      console.error('[dsh-channels] failed to start:', error)
    })
    return () => service.shutdown()
  }, 'dsh-channels')
}
