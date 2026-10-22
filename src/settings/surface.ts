/**
 * Web 设置面板的 Host 视图模型：把 `FeishuService` 的运行时事实、覆盖层与
 * 字段描述组装成 wire 数据，并处理保存/清除/重连/清理四个动作。
 *
 * 这一层不碰 HTTP（见 `routes.ts`），也不碰 fs 细节（见 `overlay.ts`）；
 * 唯一的文件系统动作是保存 `baseDir` 时通过 `workspaces.ts` 创建并检查
 * 工作区根目录，这样不可用的路径在保存时就暴露，而不是等到飞书里提示
 * 「会话创建失败」。因此可以只用假 target 做单测。
 *
 * @module dsh-channels/settings/surface
 */

import { DSH_CHANNELS_VERSION } from '../session-export.ts'
import type { FeishuConfig } from '../config.ts'
import { FEISHU_USER_ID_PATTERN } from '../domain.ts'
import type { HealthSnapshot } from '../health.ts'
import { prepareWorkspaceBaseDir } from '../workspaces.ts'
import {
  EDITABLE_KEYS,
  PANEL_COPY,
  RESTART_KEYS,
} from './contract.ts'
import type {
  AccessMutationResponse,
  AccessWire,
  CatalogWire,
  ChannelPhaseWire,
  ChannelStatusWire,
  ClearConfigResponse,
  ClearCredentialResponse,
  ConfigValue,
  CredentialField,
  CredentialRefWire,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  FieldIssueWire,
  FieldOptionWire,
  PanelConfigWire,
  PanelWire,
  ReadOnlyFieldWire,
  ReconnectResponse,
  SaveConfigResponse,
  SaveCredentialsRequest,
  SaveCredentialsResponse,
  ScopeCheckWire,
  SlashCommandSyncWire,
} from './contract.ts'
import {
  configValueOf,
  deleteOverlayKey,
  mergeOverlay,
  mergeOverlayPatch,
  overlayValueOf,
  overlayValues,
  parseOverlay,
  pickEditable,
  setOverlayValue,
} from './overlay.ts'
import type { OverlayLogger, OverlayPatch, OverlayStore } from './overlay.ts'
import type { SettingsCatalog } from './catalog.ts'
import type { SettingsDirectoryPicker } from './directory-picker.ts'

/** The slice of `FeishuService` the panel needs (structural, easy to fake). */
export interface SettingsTarget {
  isRunning(): boolean
  isRestarting(): boolean
  /** True while an explicit connect action is in flight (panel button busy state). */
  isConnecting(): boolean
  health(): HealthSnapshot
  startedAtMs(): number | undefined
  uptimeMs(): number | undefined
  startError(): string | undefined
  /** Post-connect scope self-check for the open connection, once it finished. */
  scopeCheck(): ScopeCheckWire | undefined
  /** Post-connect native slash-command panel sync for the open connection, once it finished. */
  slashCommandSync(): SlashCommandSyncWire | undefined
  /**
   * Whether the Feishu application credentials resolve. A false value means the
   * plugin is loaded but deliberately holds no connection: the panel guides the
   * user through configuring credentials instead of reporting a failure.
   */
  isConfigured(): boolean
  /** Human-readable names of the missing configuration items (never values). */
  missingConfig(): readonly string[]
  /** Re-read credential presence (the credentials store is hot-reloaded on disk). */
  refreshReadiness(): Promise<void>
  /** Connect with the current config; throws when credentials are incomplete or the handshake fails. */
  connect(): Promise<void>
  configSnapshot(): FeishuConfig
  baseConfigSnapshot(): FeishuConfig
  runningConfigSnapshot(): FeishuConfig | undefined
  applyOverlay(overlay: OverlayPatch): void
  restart(): Promise<void>
  credentialStates(): Promise<{ appId: CredentialInfo; appSecret: CredentialInfo }>
  setCredential(field: CredentialField, value: string): Promise<void>
  clearCredential(field: CredentialField): Promise<void>
  /** Current admission snapshot: mode, administrator, whitelists, pending requests. */
  accessSnapshot(): AccessWire
  /** Authorize one group (panel entry); resolves with the refreshed snapshot. */
  addAccessGroup(chatId: string, name?: string): Promise<AccessMutationResponse>
  /** Revoke one group authorization (takes effect on the next message). */
  removeAccessGroup(chatId: string): Promise<AccessMutationResponse>
  /** Authorize one user `user_id` (global across authorized groups). */
  addAccessUser(userId: string, name?: string): Promise<AccessMutationResponse>
  /** Revoke one user authorization (takes effect on the next message). */
  removeAccessUser(userId: string): Promise<AccessMutationResponse>
  /** Settle one pending request (panel shares this path with the Feishu DM card). */
  resolveAccessRequest(token: string, decision: 'allow' | 'deny'): Promise<AccessMutationResponse>
}

/** Presence/source/writability facts returned by the credentials seam. */
export interface CredentialInfo {
  configured: boolean
  writable?: boolean
  source?: string
}

const RESTART_SET = new Set<string>(RESTART_KEYS)

/** Optional text fields: an empty string in the panel clears the override. */
const OPTIONAL_TEXT_KEYS = new Set<EditableKey>([
  'provider',
  'model',
  'reasoningEffort',
  'agentPreset',
  'adminUserId',
])

const BOOLEAN_KEYS = new Set<EditableKey>([
  'requireMention',
  'welcomeOnboarding',
  'slashCommandPanel',
  'allowPermissionSwitch',
  'acceptAttachments',
  'prefetchImages',
  'feishuTools.attachmentFetch',
  'feishuTools.topicMessages',
])

const SELECT_OPTIONS: Partial<Record<EditableKey, ReadonlyArray<{ value: string; label: string }>>> = {
  attachmentStore: [
    { value: 'native', label: 'DSH 原生附件库（默认）' },
    { value: 'archive', label: '工作区 attachments/（旧版）' },
  ],
  dmMode: [
    { value: 'open', label: '开放私聊' },
    { value: 'disabled', label: '禁用私聊' },
  ],
  threadFallback: [
    { value: 'degrade', label: '话题被拒时降级为会话级' },
    { value: 'strict', label: '话题被拒时直接失败' },
  ],
  loggerLevel: [
    { value: 'debug', label: 'debug' },
    { value: 'info', label: 'info' },
    { value: 'warn', label: 'warn' },
    { value: 'error', label: 'error' },
  ],
  accessMode: [
    { value: 'guarded', label: '守卫模式（仅管理员与白名单）' },
    { value: 'open', label: '开放（不安全，仅调试）' },
  ],
}

/** Panel copy per editable key: label, help, and (for numbers) bounds. */
const FIELD_META: Record<EditableKey, { label: string; help: string; min?: number; max?: number; step?: number; placeholder?: string; wide?: boolean }> = {
  baseDir: {
    label: '工作区根目录（文件落点）',
    help: '每个用户/群成员一个工作区：私聊 <baseDir>/p2p/<user_id>/，群聊 <baseDir>/groups/<chat_id>/<user_id>/；每个话题在其中拥有独立工作目录 <工作区>/topics/<话题>/（Git 仓库工作区可自动改用 worktree）。必须是绝对路径（~ 开头按家目录展开），保存时会创建该目录；只影响之后新建立的会话 —— 已有话题即使 /renew 也沿用原目录，旧文件不会迁移。',
    placeholder: '/Users/you/.dsh/dsh-channels/workspaces',
    wide: true,
  },
  dmMode: { label: '私聊模式', help: '禁用后私聊消息不再触发会话；群聊与已绑定话题不受影响。' },
  requireMention: { label: '普通群需 @ 机器人', help: '已绑定的主题内始终不需要 @；关闭后普通群的每条消息都会触发。' },
  threadFallback: { label: '话题被拒时的兜底', help: 'degrade 降级为会话级路由；strict 直接让回复失败。' },
  welcomeOnboarding: { label: '首次私聊引导卡', help: '每个私聊会话第一次触达时发送一张命令与用法引导卡，只发一次。' },
  slashCommandPanel: { label: '同步飞书原生斜杠指令面板', help: '连接时把插件命令同步到飞书输入 / 时弹出的面板；需开通 application:app_slash_command:read 与 write 权限，部分企业不允许应用添加斜杠指令。关闭时不读写面板，直接输入命令不受影响。' },
  allowPermissionSwitch: { label: '允许飞书侧切换权限预设', help: '安全敏感：开启后话题所有者可用 /permissions 切换沙箱与审批预设。' },
  adminUserId: {
    label: '管理员 user_id',
    help: '唯一管理员。私聊机器人发送 /userid 获取（不是 ou_ 开头的 open_id，也不是邮箱）；留空 = 清除 Web 覆盖。未配置时自动使用飞书应用所有者（需「获取应用信息」权限）；两者都没有时 guarded 模式会拒绝所有对话。',
    placeholder: 'user_id',
  },
  accessMode: {
    label: '准入模式',
    help: 'guarded（默认）：私聊仅管理员，群聊需群授权且发送者是管理员或已授权用户；open：应用可用范围内的任何人都能对话，不安全，仅调试。',
  },
  authRequestTtlDays: {
    label: '授权申请有效期（天）',
    help: '入群/用户授权申请卡的有效期，1–30 天；过期后卡片需重新触发申请（也可在本页下方「待处理申请」中处理）。',
    min: 1,
    max: 30,
    step: 1,
  },
  acceptAttachments: {
    label: '接收入站附件',
    help: '接收飞书图片、文件与合并转发记录。native（默认）下入站附件存入 DSH 原生附件库：触发消息的图片预取进首轮、文件保持懒取，纯附件消息不回复、不落地，需要时请引用该消息（多个文件可合并转发后引用）再提问；archive 下按旧版行为下载到工作区 attachments/。关闭后附件消息不保存、不触发模型、也不列入清单。',
  },
  attachmentStore: {
    label: '入站附件存储后端',
    help: 'native（默认）：图片与文件存入 DSH 原生附件库（不可变、内容寻址去重、读取校验、随 Session 回放；不自动清理）。archive：旧版下载到话题工作区 attachments/（可清理但会阻塞会话）。宿主未挂载附件服务时 native 自动降级 archive。',
  },
  prefetchImages: {
    label: '预取触发消息的图片',
    help: 'native 下把触发消息的图片预取为首轮 ImageBlock，会话/话题/卡片不等下载；失败、超限或超时的图片降级为清单中的懒取项。关闭后图片也需用 feishu_attachment_fetch 获取。',
  },
  prefetchTimeoutMs: {
    label: '图片预取整段超时（ms）',
    help: '一次触发消息图片预取的总超时（默认 10000 ms，100–120000）；到期后已取回的图片保留，其余降级为清单，不阻塞回合。',
    min: 100,
    max: 120_000,
    step: 100,
  },
  prefetchImageMaxBytes: {
    label: '单张预取图片上限（字节）',
    help: '单张图片超过该字节数即不入首轮图片、留在清单懒取（默认 20971520 = 20 MiB）。',
    min: 1,
    max: 200 * 1024 * 1024,
    step: 1,
  },
  prefetchTotalMaxBytes: {
    label: '单次预取总量上限（字节）',
    help: '一次触发消息图片预取的总字节预算（默认 52428800 = 50 MiB）；用尽后剩余图片降级为清单懒取。',
    min: 1,
    max: 1024 * 1024 * 1024,
    step: 1,
  },
  historyBootstrapLimit: {
    label: '首轮话题历史条数',
    help: '新 Session 首轮自动附带本话题最近 N 条消息摘要（0 = 关闭，上限 20）；被动读取使用短预算，缺权限/失败时静默省略。更早的消息用 feishu_topic_messages 工具翻页。',
    min: 0,
    max: 20,
    step: 1,
  },
  promptContextTimeoutMs: {
    label: '被动读取预算（ms）',
    help: '引用摘录与首轮话题历史这类被动 prompt 增强的整段预算（默认 3000 ms，100–10000）；超时即省略对应块、回合照跑。模型主动调用工具的读取超时另由 feishu_tools 超时控制。',
    min: 100,
    max: 10_000,
    step: 100,
  },
  'feishuTools.attachmentFetch': {
    label: '启用 feishu_attachment_fetch 工具',
    help: '让模型按 message_id/file_key 懒取已授权消息的图片/文件。关闭后文件无法懒取，插件整体回退 archive 后端（入站文件直接下载到工作区）。对新会话生效。',
  },
  'feishuTools.attachmentFetchMaxResources': {
    label: '单次取回资源数上限',
    help: '一次工具调用最多取回的附件数量（默认 10，1–50）；超出会返回可读原因，模型可按 file_key 拆分重试。',
    min: 1,
    max: 50,
    step: 1,
  },
  'feishuTools.attachmentFetchMaxBytes': {
    label: '单次取回字节预算（字节）',
    help: '一次工具调用的总下载字节预算（默认 104857600 = 100 MiB）；文件流式写入原生库，不整文件缓冲。',
    min: 1,
    max: 1024 * 1024 * 1024,
    step: 1,
  },
  'feishuTools.attachmentFetchTimeoutMs': {
    label: '单次取回超时（ms）',
    help: '一次 feishu_attachment_fetch 的整段超时（默认 120000 ms，1000–600000）；到期取消下载并逐项报告可读原因。',
    min: 1_000,
    max: 600_000,
    step: 1_000,
  },
  'feishuTools.topicMessages': {
    label: '启用 feishu_topic_messages 工具',
    help: '让模型按需读取引用消息与话题内更早的消息/附件。关闭只影响模型工具；被动的引用摘录与首轮历史仍由 historyBootstrapLimit 控制。',
  },
  'feishuTools.topicMessagesTimeoutMs': {
    label: '单次话题读取超时（ms）',
    help: '一次 feishu_topic_messages 的整段超时（默认 20000 ms，1000–120000）；被动摘录使用独立的短预算。',
    min: 1_000,
    max: 120_000,
    step: 1_000,
  },
  provider: { label: '模型服务商', help: '留空 = 使用部署默认；例如 deepseek-official。', placeholder: '留空 = 部署默认' },
  model: { label: '模型 id', help: '留空 = 使用部署默认；例如 deepseek-v4-flash。', placeholder: '留空 = 部署默认' },
  reasoningEffort: { label: '推理档位', help: '模型声明的精确档位 id（如 high / max）；留空 = 适配器默认。', placeholder: '留空 = 适配器默认' },
  agentPreset: { label: 'Agent 预设', help: '新会话使用的预设 id（如 standard）；留空 = roster 默认。', placeholder: '留空 = roster 默认' },
  refreshMs: { label: '流式刷新间隔（ms）', help: '流式卡片的 patch 节流间隔，200–10000；需重连生效。', min: 200, max: 10_000, step: 100 },
  statusRefreshMs: { label: '状态行保活间隔（ms）', help: '无文本输出时活动状态行的计时刷新间隔，1000–60000；需重连生效。', min: 1_000, max: 60_000, step: 500 },
  loggerLevel: { label: 'SDK 日志级别', help: '官方 SDK 的日志级别；需重连生效。' },
}

const GROUP_OF: Record<EditableKey, EditableFieldWire['group']> = {
  baseDir: 'workspace',
  dmMode: 'behavior',
  requireMention: 'behavior',
  threadFallback: 'behavior',
  welcomeOnboarding: 'behavior',
  slashCommandPanel: 'behavior',
  allowPermissionSwitch: 'behavior',
  adminUserId: 'access',
  accessMode: 'access',
  authRequestTtlDays: 'access',
  acceptAttachments: 'content',
  attachmentStore: 'content',
  prefetchImages: 'content',
  prefetchTimeoutMs: 'content',
  prefetchImageMaxBytes: 'content',
  prefetchTotalMaxBytes: 'content',
  historyBootstrapLimit: 'content',
  promptContextTimeoutMs: 'tools',
  'feishuTools.attachmentFetch': 'tools',
  'feishuTools.attachmentFetchMaxResources': 'tools',
  'feishuTools.attachmentFetchMaxBytes': 'tools',
  'feishuTools.attachmentFetchTimeoutMs': 'tools',
  'feishuTools.topicMessages': 'tools',
  'feishuTools.topicMessagesTimeoutMs': 'tools',
  provider: 'model',
  model: 'model',
  reasoningEffort: 'model',
  agentPreset: 'model',
  refreshMs: 'streaming',
  statusRefreshMs: 'streaming',
  loggerLevel: 'streaming',
}

/** One descriptor per editable key, in `EDITABLE_KEYS` order (Host-driven form). */
export const FIELD_DESCRIPTORS: readonly EditableFieldWire[] = EDITABLE_KEYS.map(key => {
  const meta = FIELD_META[key]
  const options = SELECT_OPTIONS[key]
  return {
    key,
    label: meta.label,
    kind: BOOLEAN_KEYS.has(key) ? 'boolean' : options !== undefined ? 'select' : meta.min !== undefined ? 'number' : 'text',
    group: GROUP_OF[key],
    help: meta.help,
    ...(options === undefined ? {} : { options }),
    ...(meta.min === undefined ? {} : { min: meta.min }),
    ...(meta.max === undefined ? {} : { max: meta.max }),
    ...(meta.step === undefined ? {} : { step: meta.step }),
    ...(meta.placeholder === undefined ? {} : { placeholder: meta.placeholder }),
    ...(meta.wide === undefined ? {} : { wide: meta.wide }),
    restartRequired: RESTART_SET.has(key),
  }
})

/** Keys whose options are resolved from the live host catalog at panel time. */
type CatalogKey = 'provider' | 'model' | 'reasoningEffort' | 'agentPreset'

const CATALOG_KEYS = new Set<EditableKey>(['provider', 'model', 'reasoningEffort', 'agentPreset'])

function isCatalogKey(key: EditableKey): key is CatalogKey {
  return CATALOG_KEYS.has(key)
}

/** Every group switched off: the form keeps its free-text controls. */
export function emptyCatalog(): CatalogWire {
  const none = { selectable: false, options: [] as FieldOptionWire[] }
  return {
    provider: { ...none },
    model: { ...none },
    reasoningEffort: { ...none },
    agentPreset: { ...none },
  }
}

/** Longest accepted catalog query value; anything longer is treated as absent. */
const MAX_CATALOG_QUERY_LENGTH = 200

/** Trim one provider/model query value, dropping empty, hostile, or oversized input. */
function cleanCatalogQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_CATALOG_QUERY_LENGTH) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  return trimmed
}

/**
 * Attach the live catalog to the four selector fields. A configured value the
 * host no longer advertises stays visible as an extra option so opening the
 * panel never silently rewrites the effective config.
 */
export function applyCatalog(
  fields: readonly EditableFieldWire[],
  catalog: CatalogWire,
  current: Partial<Record<CatalogKey, ConfigValue | undefined>>,
): EditableFieldWire[] {
  return fields.map((field) => {
    if (!isCatalogKey(field.key)) return field
    const selector = catalog[field.key]
    if (!selector.selectable) return field
    const value = current[field.key]
    const options = typeof value === 'string' && value !== ''
      && !selector.options.some(option => option.value === value)
      ? withCurrentOption(selector.options, value)
      : [...selector.options]
    const next: EditableFieldWire = {
      ...field,
      kind: 'select',
      options,
    }
    if (selector.disabled === true) next.disabled = true
    if (selector.help !== undefined) next.help = selector.help
    return next
  })
}

/** Keep the leading inherit option first, then surface the unlisted current value. */
function withCurrentOption(
  options: readonly FieldOptionWire[],
  value: string,
): FieldOptionWire[] {
  const [inherit, ...rest] = options
  const extra: FieldOptionWire = { value, label: `${value}（当前配置，不在宿主机列表中）` }
  return inherit === undefined ? [extra] : [inherit, extra, ...rest]
}

/**
 * Mark the workspace-root field as browsable when the host can open its native
 * directory chooser. Every other host (no `directoryPicker`, or the `browse`
 * backend of remote/headless sessions) keeps the plain text input.
 *
 * @param fields - Host field descriptors after the selector catalog is applied.
 * @param available - whether a native directory chooser can be opened.
 * @returns the descriptors with `browse: 'directory'` on `baseDir` when usable.
 */
export function withDirectoryBrowse(
  fields: readonly EditableFieldWire[],
  available: boolean,
): EditableFieldWire[] {
  if (!available) return [...fields]
  return fields.map(field => (field.key === 'baseDir' ? { ...field, browse: 'directory' } : field))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDays(ms: number): string {
  return ms === 0 ? '关闭（不过期）' : `${Math.round(ms / 86_400_000)} 天`
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1_000)} 秒`
}

function formatOptional(value: string | number | undefined, suffix = ''): string {
  return value === undefined ? '未设置' : `${value}${suffix}`
}

/** Credential values are opaque strings; trim, cap length, reject control chars. */
const MAX_CREDENTIAL_LENGTH = 512

export function normalizeCredentialValue(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: '必须是字符串' }
  const value = raw.trim()
  if (value === '') return { ok: false, message: '不能为空' }
  if (value.length > MAX_CREDENTIAL_LENGTH) return { ok: false, message: `长度不得超过 ${MAX_CREDENTIAL_LENGTH}` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: '包含非法控制字符' }
  return { ok: true, value }
}

/** Longest accepted whitelist identifier / display name. */
const MAX_ACCESS_VALUE_LENGTH = 128


/** Trim one whitelist identifier, rejecting empty, oversized, or hostile input. */
export function normalizeAccessId(
  raw: unknown,
  label: string,
  invalidFormat?: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: `${label}必须是字符串` }
  const value = raw.trim()
  if (value === '') return { ok: false, message: `${label}不能为空` }
  if (value.length > MAX_ACCESS_VALUE_LENGTH) {
    return { ok: false, message: `${label}长度不得超过 ${MAX_ACCESS_VALUE_LENGTH}` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: `${label}包含非法控制字符` }
  if (invalidFormat !== undefined && !FEISHU_USER_ID_PATTERN.test(value)) {
    return { ok: false, message: invalidFormat }
  }
  return { ok: true, value }
}

/** Optional display name: trimmed; empty means "unknown" and is dropped. */
export function normalizeAccessName(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, message: '名称必须是字符串' }
  const value = raw.trim()
  if (value === '') return { ok: true, value: undefined }
  if (value.length > MAX_ACCESS_VALUE_LENGTH) {
    return { ok: false, message: `名称长度不得超过 ${MAX_ACCESS_VALUE_LENGTH}` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: '名称包含非法控制字符' }
  return { ok: true, value }
}

/** Build the read-only advanced card from the effective config. */
export function readOnlyFields(config: FeishuConfig): ReadOnlyFieldWire[] {
  return [
    {
      key: 'topicIsolation',
      label: '话题目录隔离',
      value: config.topicIsolation === 'auto'
        ? '自动（Git 仓库用 worktree，否则普通子目录）'
        : config.topicIsolation === 'worktree' ? 'Git worktree（失败回退子目录）' : '普通子目录',
      help: '每个话题的独立工作目录形式；在 profile 配置里用 topicIsolation 设置（auto / subdir / worktree）。',
    },
    { key: 'routeTtlMs', label: '话题路由过期', value: formatDays(config.routeTtlMs), help: '超期话题的后续消息会被明确拒绝，而不是新建 Context-free Session。' },
    { key: 'approvalTimeoutMs', label: '审批卡片等待', value: formatSeconds(config.approvalTimeoutMs) },
    { key: 'questionTimeoutMs', label: '提问卡片等待', value: formatSeconds(config.questionTimeoutMs) },
    { key: 'maxTokens', label: '单次输出上限', value: formatOptional(config.maxTokens, ' tokens'), help: '留空/未设置时使用模型适配器默认值。' },
  ]
}

/**
 * Derive the panel phase from readiness + runtime facts. The order matters:
 * an incomplete configuration always wins (no connection is attempted), and a
 * failed attempt is only reported while the channel is stopped.
 */
function phaseOf(target: SettingsTarget): ChannelPhaseWire {
  // A connection attempt in flight is the honest label even though `start()`
  // flips `started` before the handshake finishes. A live connection outranks
  // missing credentials: removing a stored value does not drop the open socket,
  // so the panel keeps the connection actions available and flags the missing
  // credential separately (`configured: false`).
  if (target.isRestarting()) return 'connecting'
  if (target.isConnecting()) return target.isConfigured() ? 'connecting' : 'unconfigured'
  if (target.isRunning()) return 'connected'
  if (!target.isConfigured()) return 'unconfigured'
  if (target.startError() !== undefined) return 'error'
  return 'idle'
}

/** Assemble the status half of the panel payload. */
function buildStatus(target: SettingsTarget, overlayPath: string): ChannelStatusWire {
  const health = target.health()
  const connection = health.connection
  const scopeCheck = target.isRunning() ? target.scopeCheck() : undefined
  const slashCommandSync = target.isRunning() ? target.slashCommandSync() : undefined
  return {
    running: target.isRunning(),
    configured: target.isConfigured(),
    phase: phaseOf(target),
    missingConfig: [...target.missingConfig()],
    level: health.level,
    startedAt: target.startedAtMs(),
    uptimeMs: target.uptimeMs(),
    ...(connection === undefined ? {} : {
      connection: {
        state: connection.state,
        lastConnectTime: connection.lastConnectTime,
        nextConnectTime: connection.nextConnectTime,
        reconnectAttempts: connection.reconnectAttempts,
      },
    }),
    ...(health.botOpenIdTail === undefined ? {} : { botOpenIdTail: health.botOpenIdTail }),
    routeCount: health.routeCount,
    liveAgentCount: health.liveAgentCount,
    inflightTurnCount: health.inflightTurnCount,
    ...(target.startError() === undefined ? {} : { lastStartError: target.startError() }),
    reasons: health.reasons,
    version: DSH_CHANNELS_VERSION,
    overlayPath,
    busy: target.isRestarting() || target.isConnecting(),
    ...(scopeCheck === undefined ? {} : { scopeCheck }),
    ...(slashCommandSync === undefined ? {} : { slashCommandSync }),
  }
}

/**
 * Stateful panel facade over one service + one overlay file. All mutations are
 * validated here; the HTTP layer only parses the transport. The optional
 * [`SettingsCatalog`] turns the four model selectors into host-driven choice
 * lists; without it (headless tests, host without LLM services) they stay
 * free-text controls.
 */
export class SettingsSurface {
  constructor(
    private readonly target: SettingsTarget,
    private readonly store: OverlayStore,
    private readonly logger?: OverlayLogger,
    private readonly catalog?: SettingsCatalog,
    private readonly directoryPicker?: SettingsDirectoryPicker,
  ) {}

  /**
   * Re-read credential presence. The credentials store is hot-reloaded from
   * disk, so a value edited outside the panel becomes visible within one poll
   * instead of only after a restart/connect.
   */
  private async syncReadiness(): Promise<void> {
    try {
      await this.target.refreshReadiness()
    } catch (error) {
      this.logger?.warn?.('dsh-channels: 凭据状态刷新失败：%s', messageOf(error))
    }
  }

  /**
   * Reject panel writes while the connection lifecycle is in flight: saving an
   * overlay or credentials then would race `applyOverlay()`/`start()` and can
   * record a running-config snapshot that never took effect.
   */
  private writeBusy(): { ok: false; error: string } | undefined {
    if (!this.target.isRestarting() && !this.target.isConnecting()) return undefined
    return { ok: false, error: '飞书连接正在连接或重启，请稍候再试' }
  }

  /** Wire status only (used by the client's 5 s poll). */
  async status(): Promise<ChannelStatusWire> {
    await this.syncReadiness()
    return buildStatus(this.target, this.store.file)
  }

  /**
   * Resolve the selector catalog for one route (the client re-queries it when
   * the draft provider/model changes). A broken lookup degrades to the
   * free-text form instead of failing the panel.
   */
  async catalogFor(provider?: string, model?: string): Promise<CatalogWire> {
    if (this.catalog === undefined) return emptyCatalog()
    try {
      return await this.catalog.catalog(cleanCatalogQuery(provider), cleanCatalogQuery(model))
    } catch (error) {
      this.logger?.warn?.('dsh-channels: 选择目录加载失败：%s', messageOf(error))
      return emptyCatalog()
    }
  }

  /** Status + editable config with provenance + read-only facts. */
  async panel(): Promise<PanelWire> {
    await this.syncReadiness()
    const base = this.target.baseConfigSnapshot()
    const effective = this.target.configSnapshot()
    const overlay = await this.store.load()
    const running = this.target.runningConfigSnapshot()
    const overriddenKeys = EDITABLE_KEYS.filter(
      key => overlayValueOf(overlay as Record<string, unknown>, key) !== undefined,
    )
    const restartPendingKeys = this.target.isRunning() && running !== undefined
      ? RESTART_KEYS.filter(key => configValueOf(effective, key) !== configValueOf(running, key))
      : []
    const catalog = await this.catalogFor(effective.provider, effective.model)
    const fields = withDirectoryBrowse(
      applyCatalog(FIELD_DESCRIPTORS, catalog, {
        provider: effective.provider,
        model: effective.model,
        reasoningEffort: effective.reasoningEffort,
        agentPreset: effective.agentPreset,
      }),
      this.directoryPicker?.available === true,
    )

    let credentialStates: { appId: CredentialInfo; appSecret: CredentialInfo } = {
      appId: { configured: false, writable: false },
      appSecret: { configured: false, writable: false },
    }
    try {
      credentialStates = await this.target.credentialStates()
    } catch (error) {
      this.logger?.warn?.('dsh-channels: 凭据状态读取失败：%s', messageOf(error))
    }
    const toWire = (ref: string, state: CredentialInfo): CredentialRefWire => ({
      ref,
      configured: state.configured,
      writable: state.writable === true,
      ...(state.source === undefined ? {} : { source: state.source }),
    })
    const credentials: PanelConfigWire['credentials'] = {
      appId: toWire(effective.appId, credentialStates.appId),
      appSecret: toWire(effective.appSecret, credentialStates.appSecret),
    }

    // The access snapshot comes from in-memory maps, but a broken seam must
    // still not take the whole panel down: degrade to an empty, fail-closed
    // view (the whitelist mutations will report their own errors).
    let access: AccessWire
    try {
      access = this.target.accessSnapshot()
    } catch (error) {
      this.logger?.warn?.('dsh-channels: 访问授权快照读取失败：%s', messageOf(error))
      access = {
        mode: effective.accessMode,
        admin: { configured: false },
        loaded: false,
        groups: [],
        users: [],
        requests: [],
      }
    }

    return {
      status: buildStatus(this.target, this.store.file),
      config: {
        base: pickEditable(base) as Record<string, ConfigValue | undefined>,
        effective: pickEditable(effective) as Record<string, ConfigValue | undefined>,
        overlay: overlayValues(overlay),
        overriddenKeys,
        restartPendingKeys,
        fields,
        readOnly: readOnlyFields(effective),
        credentials,
      },
      access,
    }
  }

  /** Validate + persist a partial edit; live fields take effect immediately. */
  async save(values: EditableValues): Promise<SaveConfigResponse> {
    const busy = this.writeBusy()
    if (busy !== undefined) return busy
    const unknown = Object.keys(values).filter(key => !(EDITABLE_KEYS as readonly string[]).includes(key))
    if (unknown.length > 0) {
      return { ok: false, error: `未知配置项：${unknown.join(', ')}` }
    }

    const raw: Record<string, unknown> = {}
    const clearedKeys: EditableKey[] = []
    for (const key of EDITABLE_KEYS) {
      const value = values[key]
      if (value === undefined) continue
      if (typeof value === 'string' && value === '' && OPTIONAL_TEXT_KEYS.has(key)) {
        clearedKeys.push(key)
        continue
      }
      setOverlayValue(raw, key, value)
    }

    const parsed = parseOverlay(raw)
    if (!parsed.ok) {
      const issues: FieldIssueWire[] = parsed.issues.map(issue => ({
        key: issue.path,
        message: issue.message,
      }))
      return { ok: false, error: '配置校验失败', issues }
    }

    // A workspace root typed into the panel must be usable right now: create
    // and probe it before anything is persisted, so a typo (or a path that is
    // an existing file / unwritable) fails here rather than as a session
    // creation failure card inside Feishu.
    if (parsed.patch.baseDir !== undefined) {
      const problem = await prepareWorkspaceBaseDir(parsed.patch.baseDir)
      if (problem !== undefined) {
        return {
          ok: false,
          error: '工作区目录不可用',
          issues: [{ key: 'baseDir', message: problem }],
        }
      }
    }

    let merged: OverlayPatch
    try {
      merged = mergeOverlayPatch(await this.store.load(), parsed.patch)
      for (const key of clearedKeys) deleteOverlayKey(merged, key)
    } catch (error) {
      return { ok: false, error: `写入覆盖配置失败：${messageOf(error)}` }
    }

    // The host resolves a request route as a provider/model PAIR: a lone
    // provider (or lone model) leaves the session without a complete route,
    // so an edit to either side must end with both set or both cleared.
    if (values.provider !== undefined || values.model !== undefined) {
      const prospective = mergeOverlay(this.target.baseConfigSnapshot(), merged)
      const hasProvider = (prospective.provider ?? '') !== ''
      const hasModel = (prospective.model ?? '') !== ''
      if (hasProvider !== hasModel) {
        return {
          ok: false,
          error: '模型服务商与模型 id 必须同时配置，或都留空沿用部署默认',
          issues: [hasProvider
            ? { key: 'model', message: '已选择模型服务商，还需要选择模型 id（或把两者都留空）' }
            : { key: 'provider', message: '已选择模型 id，还需要选择模型服务商（或把两者都留空）' }],
        }
      }
    }

    try {
      await this.store.save(merged)
    } catch (error) {
      return { ok: false, error: `写入覆盖配置失败：${messageOf(error)}` }
    }
    this.target.applyOverlay(merged)
    return { ok: true, panel: await this.panel(), clearedKeys }
  }

  /** Drop every Web override and fall back to the profile config. */
  async clear(): Promise<ClearConfigResponse> {
    const busy = this.writeBusy()
    if (busy !== undefined) return busy
    try {
      await this.store.clear()
    } catch (error) {
      return { ok: false, error: `清除覆盖配置失败：${messageOf(error)}` }
    }
    this.target.applyOverlay({})
    return { ok: true, panel: await this.panel() }
  }

  /** Write provided credential values through the host seam (never echoed back). */
  async saveCredentials(values: SaveCredentialsRequest): Promise<SaveCredentialsResponse> {
    const busy = this.writeBusy()
    if (busy !== undefined) return busy
    const writes: Array<{ field: CredentialField; value: string }> = []
    const issues: FieldIssueWire[] = []
    for (const field of ['appId', 'appSecret'] as const) {
      const raw = values[field]
      if (raw === undefined) continue
      const normalized = normalizeCredentialValue(raw)
      if (!normalized.ok) {
        issues.push({ key: field, message: normalized.message })
        continue
      }
      writes.push({ field, value: normalized.value })
    }
    if (issues.length > 0) return { ok: false, error: '凭据校验失败', issues }
    if (writes.length === 0) return { ok: false, error: '请至少填写一项凭据（App ID 或 App Secret）' }

    try {
      for (const write of writes) await this.target.setCredential(write.field, write.value)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    return this.finishCredentialChange('save')
  }

  /** Remove the stored value behind one credential reference. */
  async clearCredential(field: CredentialField): Promise<ClearCredentialResponse> {
    const busy = this.writeBusy()
    if (busy !== undefined) return busy
    if (field !== 'appId' && field !== 'appSecret') {
      return { ok: false, error: '未知的凭据字段' }
    }
    try {
      await this.target.clearCredential(field)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    return this.finishCredentialChange('clear')
  }

  /**
   * Credential values are resolved on connect. Opening a connection is gated on
   * readiness: saving one half of the pair stores the value but keeps the
   * plugin idle until the other half exists. When the channel is stopped and
   * the pair is complete, connect immediately (nothing to interrupt); when it
   * is running, the user reconnects to pick the value up.
   */
  private async finishCredentialChange(kind: 'save' | 'clear'): Promise<SaveCredentialsResponse> {
    if (this.target.isRunning()) {
      return { ok: true, panel: await this.panel(), reconnect: 'pending' }
    }
    if (kind === 'clear' || !this.target.isConfigured()) {
      return { ok: true, panel: await this.panel(), reconnect: kind === 'clear' ? 'not-needed' : 'unconfigured' }
    }
    try {
      await this.target.connect()
      return { ok: true, panel: await this.panel(), reconnect: 'auto' }
    } catch (error) {
      // The value is stored, but the channel did not come up: report the
      // failure state instead of claiming a successful connection.
      return {
        ok: true,
        panel: await this.panel(),
        reconnect: 'failed',
        autoReconnectError: messageOf(error),
      }
    }
  }

  /**
   * The panel's single connect/reconnect action: reopen a running connection,
   * or open the first one when the channel is stopped. Credentials must be
   * complete — otherwise the panel points the user back at the credentials form
   * instead of surfacing a startup error.
   */
  async reconnect(): Promise<ReconnectResponse> {
    // Credentials may have been edited on disk since the last poll; re-check
    // presence before refusing the action.
    await this.syncReadiness()
    if (!this.target.isConfigured()) {
      return {
        ok: false,
        error: '飞书应用凭据尚未配置完整，请先填写 App ID 与 App Secret 并保存',
        unconfigured: true,
      }
    }
    const wasRunning = this.target.isRunning()
    try {
      if (wasRunning) await this.target.restart()
      else await this.target.connect()
    } catch (error) {
      return { ok: false, error: `${wasRunning ? '重连' : '连接'}失败：${messageOf(error)}` }
    }
    // `restart()` intentionally does not throw when the credentials vanished;
    // verify the connection actually exists before reporting success.
    if (!this.target.isRunning()) {
      return {
        ok: false,
        unconfigured: !this.target.isConfigured(),
        error: this.target.startError()
          ?? (this.target.isConfigured() ? '飞书连接未建立' : '飞书应用凭据尚未配置完整，请先填写并保存凭据'),
      }
    }
    return { ok: true, panel: await this.panel() }
  }

  /** Read the current admission snapshot (mode, administrator, whitelists, requests). */
  async access(): Promise<AccessWire> {
    return this.target.accessSnapshot()
  }

  /** Authorize one group from the panel. Validation happens before the write. */
  async saveAccessGroup(chatId: unknown, name?: unknown): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(chatId, '群 chat_id')
    if (!id.ok) return { ok: false, error: id.message }
    const label = normalizeAccessName(name)
    if (!label.ok) return { ok: false, error: label.message }
    return this.mutateAccess(() => this.target.addAccessGroup(id.value, label.value))
  }

  /** Revoke one group authorization (immediate: the next message re-evaluates). */
  async removeAccessGroup(chatId: unknown): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(chatId, '群 chat_id')
    if (!id.ok) return { ok: false, error: id.message }
    return this.mutateAccess(() => this.target.removeAccessGroup(id.value))
  }

  /** Authorize one user `user_id` (not an open_id or email). */
  async saveAccessUser(userId: unknown, name?: unknown): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(userId, '用户 user_id', '用户 user_id 只能包含字母、数字、_ 和 -（不是 ou_ 开头的 open_id，也不是邮箱）')
    if (!id.ok) return { ok: false, error: id.message }
    const label = normalizeAccessName(name)
    if (!label.ok) return { ok: false, error: label.message }
    return this.mutateAccess(() => this.target.addAccessUser(id.value, label.value))
  }

  /** Revoke one user authorization (immediate: the next message re-evaluates). */
  async removeAccessUser(userId: unknown): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(userId, '用户 user_id', '用户 user_id 只能包含字母、数字、_ 和 -（不是 ou_ 开头的 open_id，也不是邮箱）')
    if (!id.ok) return { ok: false, error: id.message }
    return this.mutateAccess(() => this.target.removeAccessUser(id.value))
  }

  /**
   * Settle one pending request. Shares the target-side resolver with the DM
   * card, so the panel and the card can never disagree on the outcome.
   */
  async resolveAccessRequest(token: unknown, decision: unknown): Promise<AccessMutationResponse> {
    const normalized = normalizeAccessId(token, '申请 token')
    if (!normalized.ok) return { ok: false, error: normalized.message }
    if (decision !== 'allow' && decision !== 'deny') {
      return { ok: false, error: 'decision 必须是 allow 或 deny' }
    }
    return this.mutateAccess(() => this.target.resolveAccessRequest(normalized.value, decision))
  }

  /** Run one whitelist mutation, folding thrown seam errors into the wire type. */
  private async mutateAccess(
    mutation: () => Promise<AccessMutationResponse>,
  ): Promise<AccessMutationResponse> {
    try {
      return await mutation()
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * Open the host's native directory chooser (the panel's「选择目录…」button).
   *
   * @param signal - caller lifetime; abort closes the OS dialog.
   * @returns the chosen absolute path, or `null` when the operator cancels.
   * @throws when the host provides no native directory chooser.
   */
  async pickDirectory(signal: AbortSignal): Promise<string | null> {
    if (this.directoryPicker === undefined) throw new Error(PANEL_COPY.directoryPickFailed)
    return await this.directoryPicker.pick(signal)
  }
}

export { PANEL_COPY }
