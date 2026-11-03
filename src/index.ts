/**
 * dsh-channels — DeepSeek Harness 飞书渠道插件。
 *
 * 一个 dsh 实例对应一个飞书机器人；用户通过私聊、群聊 @、话题群 @ 三种方式
 * 发起会话。每条触发消息：立即加 “Typing” 表情 → 以话题形式回复（创建话题）
 * → 绑定 DSH session → 卡片 2.0 流式回复（推理折叠面板 + 临时活动行 +
 * 富文本正文 + 结算页脚，默认 500ms 刷新）→ 流式结束移除 Typing，成功更新为
 * “DONE”，失败显示结构化错误并更新为 “No”。
 *
 * 工作区归属：一个话题一个工作区（私聊 `p2p/<user_id>/<话题>/`，群聊
 * `groups/<chat_id>/<话题>/`）。话题目录就是会话 header cwd，同时是 GUI 归属
 * 与沙箱边界，因此话题之间的文件互不干扰，也不需要切换工作目录。
 *
 * @module dsh-channels
 */

import type { HostContext } from './dsh-types.ts'
import { FeishuService } from './service.ts'
import { pluginConfigSchema, resolveConfig } from './config.ts'
import type { FeishuConfig } from './config.ts'
import { defaultChannelFactory } from './feishu-channel.ts'
import type { ChannelFactory } from './feishu-channel.ts'
import { OverlayStore, defaultOverlayPath } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { FEISHU_TOPICS_SERVICE } from './topics/launcher.ts'
import { SettingsSurface } from './settings/surface.ts'
import { createHostCatalog } from './settings/catalog.ts'
import { createSettingsDirectoryPicker } from './settings/directory-picker.ts'

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
export type * from './topics/contract.ts'
export * from './access/index.ts'
export type { AccessPermission, AccessRequestRecord, AccessSwitch, AccessUserRecord, GroupPermission, GroupPermissionRecord } from './domain.ts'
export { CATALOG_ROUTE, CLEAR_CONFIG_ROUTE, CLEAR_CREDENTIAL_ROUTE, EDITABLE_KEYS, PANEL_COPY, PANEL_ROUTE, PICK_DIRECTORY_ROUTE, RECONNECT_ROUTE, REMOVE_ACCESS_GROUP_ROUTE, RESTART_KEYS, SAVE_CONFIG_ROUTE, SAVE_CREDENTIALS_ROUTE, SET_GROUP_PERMISSION_ROUTE, STATUS_ROUTE } from './settings/contract.ts'
export type { PickDirectoryResponse } from './settings/contract.ts'
export { defaultOverlayPath, mergeOverlay, normalizeOverlay, OverlayStore, parseOverlay, pickEditable, resolveDshHome } from './settings/overlay.ts'
export { applyCatalog, emptyCatalog, FIELD_DESCRIPTORS, normalizeCredentialValue, SettingsSurface, withDirectoryBrowse } from './settings/surface.ts'
export type { SettingsTarget } from './settings/surface.ts'
export { createHostCatalog } from './settings/catalog.ts'
export type { CatalogWarn, SettingsCatalog } from './settings/catalog.ts'
export { createSettingsDirectoryPicker } from './settings/directory-picker.ts'
export type { HostDirectoryPickerService, SettingsDirectoryPicker } from './settings/directory-picker.ts'
export { mountSettingsRoutes, registerSettingsRoutes } from './settings/routes.ts'
export type { HostConnection, HostFetchRoute } from './settings/routes.ts'
export type { ApprovalOutcome, ApprovalRequest, ApprovalAnswererListener, AssistantStreamFrame, AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequestEvent, UserQuestionAnswererListener, AgentCancelCause, SessionStatsView, TokenUsageView, ContextPressureView, SessionProjections } from './dsh-types.ts'
export { buildCard, buildInterruptionCard, cardJsonBytes, CARD_MAX_BYTES, CARD_TARGET_BYTES, REASONING_MAX_BYTES, INTERRUPTION_NOTICE, MAX_TABLES_PER_CARD, TURN_HEADLINES, REASONING_PANEL_TITLE, PANEL_CHEVRON_TOKEN, segmentCardContent, splitBodyForCard, stripTables, tableBlocks, TRUNCATION_SUFFIX, buildApprovalCard, buildApprovalSettledCard, buildQuestionCard, buildQuestionSettledCard, buildTopicRootCard, MAX_QUESTION_OPTIONS } from './cards.ts'
export { ApprovalAnswerer } from './approvals.ts'
export { QuestionAnswerer } from './questions.ts'
export { buildCommandResultCard, CHANNEL_COMMAND_NAMES, commandResultCardKind, isSupportedCommand, parseSlashCommand, registerChannelCommands, RouteOperationQueue, SUPPORTED_COMMAND_NAMES, supportedCommandHelp, supportedCommandList } from './commands.ts'
export { buildHealthCard, countFiberStates, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES, maskOpenIdTail } from './health.ts'
export { buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard, compactFailureContext, querySessionHistory, resolveWorkDir, SESSION_HISTORY_DISPLAY_LIMIT } from './session-commands.ts'
export { createLogicalSessionExport, DSH_CHANNELS_VERSION, LOGICAL_EXPORT_FORMAT, LOGICAL_EXPORT_FORMAT_VERSION, serializeLogicalSession } from './session-export.ts'
export { addUsage, applyProjectionViews, averageDecodeTokensPerSecond, averageTtftMs, cacheHitPct, EMPTY_TOTALS, foldAll, foldEvent, foldSessionStats, measureSessionContext, readProjectionViews, usageFromBuckets } from './stats.ts'
export { FeishuService } from './service.ts'
export { FEISHU_TOPICS_SERVICE, FEISHU_TOPICS_VERSION, TopicLauncher } from './topics/launcher.ts'
export type { TopicLauncherDeps } from './topics/launcher.ts'
export { TurnStreamer } from './streamer.ts'
export { ensureTopicWorkspace, topicTitleOf, topicTokenFor, topicWorkspacePathFor, workspaceTitleFor } from './workspaces.ts'
export type { TopicLocationPort } from './workspaces.ts'
export { ACCESS_PERMISSIONS, accessRequestRecordSchema, accessUserRecordSchema, appendSessionHistory, chatRouteKey, expiredRouteRecordSchema, feishuDomain, GROUP_PERMISSIONS, groupPermissionRecordSchema, isGroupRoute, normalizeRouteRecord, normalizeSessionHistory, routeRecordSchema, sessionDirOf, sessionHistoryEntrySchema, inflightSnapshotSchema, processedRecordSchema } from './domain.ts'

/** Cordis function-plugin name. */
export const name = 'channels'

/** Host services this plugin consumes (all resolved through ctx).
 *
 * `credentials` is listed even though the plugin could fall back to the
 * process environment: at boot the credentials provider may not be visible
 * yet (a race observed in real profiles), and inject makes the loader wait
 * for it. `llm` / `tokenMeter` feed the card's context line and ship with
 * every dsh-base profile. `attachments` is the DSH native attachment library
 * (`@deepseek-ai/dsh-attachment-local`, mounted by the shipped base
 * composition): it is the only storage for inbound Feishu images and files.
 * `connection`, `typertGateway`, `remoteAccess` and `fileUploads` come from
 * the DSH Web composition (web-app bundle) and submit every Feishu prompt
 * through `session/prompt` as the sender's Peer; they are listed so the
 * loader waits for them instead of booting the channel before they exist
 * (`boot()` does not retry a failed start). `requireRemoteServices` still
 * fails loud for direct invocation without them.
 */
export const inject = ['agents', 'commands', 'workspaceRegistry', 'storageDomain', 'credentials', 'llm', 'tokenMeter', 'attachments', 'connection', 'typertGateway', 'remoteAccess', 'fileUploads'] as const

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
export const Config = pluginConfigSchema

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
  // Web settings overlay at `$DSH_HOME/dsh-channels/settings.json` (optional
  // file; degrades to "no overrides").
  const overlay = new OverlayStore(
    defaultOverlayPath(),
    { warn: (message, ...args) => ctx.logger?.warn?.(message, ...args) },
  )
  const service = new FeishuService(ctx, resolved, factory, undefined, overlay)
  // Settings routes ride DSH's authenticated `/api` channel when this deployment has one.
  // The catalog resolves the panel's model selectors from live host services;
  // the optional native directory picker backs the workspace-root「选择目录…」
  // button (absent in headless/remote compositions → plain text input).
  const warn = (message: string, ...args: unknown[]): void => { ctx.logger?.warn?.(message, ...args) }
  mountSettingsRoutes(ctx, new SettingsSurface(
    service,
    overlay,
    { warn },
    createHostCatalog(ctx, warn),
    createSettingsDirectoryPicker(ctx),
  ))
  // Other plugins start group-shared topics through this
  // service; it answers `not-connected` until the Feishu connection is up.
  ctx.provide?.(FEISHU_TOPICS_SERVICE, service.topics())
  ctx.effect(() => {
    // Boot loads the Web overlay and connects only when the Feishu application
    // credentials are complete; an incomplete configuration or a failed
    // connection is a panel-visible state, not a plugin failure. Only an
    // unexpected boot error (e.g. unreadable overlay) reaches this catch.
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('dsh-channels failed to boot: %s', String(error))
      // Critical lifecycle line duplicated to the console: cordis logger
      // messages emitted before a web exporter attaches are buffered and may
      // never reach stdout, which makes real-device debugging guesswork.
      console.error('[dsh-channels] failed to boot:', error)
    })
    return () => service.shutdown()
  }, 'dsh-channels')
}
