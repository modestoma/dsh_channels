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
import { MAX_TIMER_DELAY_MS } from '../config.ts'
import { FEISHU_USER_ID_PATTERN } from '../domain.ts'
import { parseWikiRootLink, WIKI_ROOT_LINK_ERRORS } from '../feishu/wiki/links.ts'
import type { HealthSnapshot } from '../health.ts'
import { prepareWorkspaceBaseDir } from '../workspaces.ts'
import {
  BYTES_UNIT,
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
  FeishuProfilesWire,
  FieldIssueWire,
  FieldGroup,
  FieldOptionWire,
  FieldToggleWire,
  PanelConfigWire,
  PanelWire,
  ReconnectResponse,
  SaveConfigResponse,
  SaveCredentialsRequest,
  SaveCredentialsResponse,
  ScopeCheckWire,
  SessionOriginResponse,
  SessionOriginWire,
  SlashCommandSyncWire,
  StringListItemFormat,
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
  credentialStates(): Promise<Record<CredentialField, CredentialInfo>>
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
  /** Add one user `user_id` to the wiki whitelist. */
  addWikiUser(userId: string, name?: string): Promise<AccessMutationResponse>
  /** Remove one user from the wiki whitelist (takes effect on the next wiki tool call). */
  removeWikiUser(userId: string): Promise<AccessMutationResponse>
  /** Settle one pending request (panel shares this path with the Feishu DM card). */
  resolveAccessRequest(token: string, decision: 'allow' | 'deny'): Promise<AccessMutationResponse>
  /** Feishu origin of one Session, or null when Feishu never routed it. */
  sessionOrigin(sessionId: string): Promise<SessionOriginWire | null>
  /** Live Feishu names and avatars of the given users and chats. */
  feishuProfiles(userIds: readonly string[], chatIds: readonly string[]): Promise<FeishuProfilesWire>
}

/** Presence/source/writability facts returned by the credentials seam. */
export interface CredentialInfo {
  configured: boolean
  writable?: boolean
  source?: string
}

const RESTART_SET = new Set<string>(RESTART_KEYS)

/** Every credential slot the panel writes, in form order. */
const CREDENTIAL_FIELDS: readonly CredentialField[] = ['appId', 'appSecret', 'analyzeToken']

/** Optional fields: an empty string in the panel clears the override. */
const OPTIONAL_TEXT_KEYS = new Set<EditableKey>([
  'provider',
  'model',
  'reasoningEffort',
  'agentPreset',
  'maxTokens',
  'adminUserId',
])

const BOOLEAN_KEYS = new Set<EditableKey>([
  'requireMention',
  'welcomeOnboarding',
  'slashCommandPanel',
  'allowPermissionSwitch',
  'dmAllowWhitelist',
  'acceptAttachments',
  'prefetchImages',
  'feishuTools.attachmentFetch',
  'feishuTools.topicMessages',
  'feishuTools.sendFile',
  'feishuTools.wikiRead',
  'feishuTools.wikiWrite',
  'analyzeEnabled',
])

/** Bounds and entry format of one `string-list` field. */
interface StringListSpec {
  /** Most non-empty entries accepted (mirrors the config schema bound). */
  maxItems: number
  itemFormat?: StringListItemFormat
}

/** Editable keys rendered as `string-list` (one input per entry). */
const STRING_LIST_FIELDS: Partial<Record<EditableKey, StringListSpec>> = {
  wikiRoots: { maxItems: 20, itemFormat: 'wiki-root-link' },
}

/** Entry checks per item format: the readable reason, or `undefined` when valid. */
const ITEM_FORMAT_CHECKS: Readonly<Record<StringListItemFormat, (entry: string) => string | undefined>> = {
  'wiki-root-link': (entry) => {
    const parsed = parseWikiRootLink(entry)
    return parsed.ok ? undefined : WIKI_ROOT_LINK_ERRORS[parsed.error]
  },
}

/** `第 N 项「entry」：reason`, shared wording with the Client check. */
function listEntryMessage(index: number, entry: string | undefined, reason: string): string {
  const position = PANEL_COPY.listEntry.replace('{n}', String(index + 1))
  return entry === undefined ? `${position}${reason}` : `${position}「${entry}」：${reason}`
}

/**
 * Normalize one submitted `string-list` value: entries are trimmed, empty
 * entries dropped, the count bounded by `maxItems`, and every remaining entry
 * checked against `itemFormat`. Issue indexes refer to the submitted array
 * (empty inputs included), so the panel can mark the exact input.
 *
 * @param key - The editable key the issues are reported under.
 * @param raw - The untrusted submitted value.
 * @param spec - The field's bounds and entry format.
 * @returns The cleaned entries, or every per-entry / whole-field issue.
 */
export function normalizeStringList(
  key: EditableKey,
  raw: unknown,
  spec: StringListSpec,
): { ok: true; value: string[] } | { ok: false; issues: FieldIssueWire[] } {
  if (!Array.isArray(raw)) return { ok: false, issues: [{ key, message: PANEL_COPY.listNotArray }] }
  const issues: FieldIssueWire[] = []
  const value: string[] = []
  const check = spec.itemFormat === undefined ? undefined : ITEM_FORMAT_CHECKS[spec.itemFormat]
  raw.forEach((item: unknown, index) => {
    if (typeof item !== 'string') {
      issues.push({ key, index, message: listEntryMessage(index, undefined, PANEL_COPY.listEntryNotString) })
      return
    }
    const entry = item.trim()
    if (entry === '') return
    const reason = check?.(entry)
    if (reason !== undefined) {
      issues.push({ key, index, message: listEntryMessage(index, entry, reason) })
      return
    }
    value.push(entry)
  })
  const count = raw.filter(item => typeof item !== 'string' || item.trim() !== '').length
  if (count > spec.maxItems) {
    issues.push({ key, message: PANEL_COPY.listTooMany.replace('{max}', String(spec.maxItems)) })
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value }
}

const SELECT_OPTIONS: Partial<Record<EditableKey, ReadonlyArray<{ value: string; label: string }>>> = {
  dmMode: [
    { value: 'open', label: '开启' },
    { value: 'disabled', label: '关闭' },
  ],
  threadFallback: [
    { value: 'degrade', label: '降级为会话级' },
    { value: 'strict', label: '直接失败' },
  ],
  topicIsolation: [
    { value: 'auto', label: '自动（推荐）' },
    { value: 'subdir', label: '普通子目录' },
    { value: 'worktree', label: 'Git worktree' },
  ],
  attachmentStore: [
    { value: 'native', label: 'DSH 原生附件库' },
    { value: 'archive', label: '话题目录 attachments/' },
  ],
  accessMode: [
    { value: 'guarded', label: '关闭（管理员与白名单）' },
    { value: 'open', label: '打开（所有人可聊）' },
  ],
  loggerLevel: [
    { value: 'debug', label: 'debug' },
    { value: 'info', label: 'info' },
    { value: 'warn', label: 'warn' },
    { value: 'error', label: 'error' },
  ],
}

/** Two-value selects rendered as switches: the stored value while on / off. */
const TOGGLES: Partial<Record<EditableKey, FieldToggleWire>> = {
  dmMode: { on: 'open', off: 'disabled' },
  threadFallback: { on: 'degrade', off: 'strict' },
  attachmentStore: { on: 'native', off: 'archive' },
  accessMode: { on: 'open', off: 'guarded' },
}

const DAY_MS = 86_400_000

/** Panel copy and bounds per editable key; numeric bounds stay in stored units. */
interface FieldMeta {
  label: string
  group: FieldGroup
  summary?: string
  help?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  scale?: number
  optional?: boolean
  placeholder?: string
  wide?: boolean
}

const FIELD_META: Record<EditableKey, FieldMeta> = {
  dmMode: { label: '私聊', group: 'trigger', summary: '关闭后私聊不再触发会话', help: '群聊和已绑定的话题不受影响。' },
  requireMention: { label: '普通群需要 @ 机器人', group: 'trigger', summary: '话题内始终不需要 @', help: '关闭后普通群里的每条消息都会触发会话。' },
  threadFallback: { label: '话题被拒时降级为会话级', group: 'trigger', summary: '飞书不允许建话题时改在会话里回复，关闭则直接报错' },
  baseDir: {
    label: '工作区根目录',
    group: 'workspace',
    summary: '模型和工具生成文件的位置',
    help: '每个用户一个工作区：私聊 <根目录>/p2p/<user_id>/，群聊 <根目录>/groups/<chat_id>/<user_id>/，每个话题在里面有独立目录。必须是绝对路径（~ 按家目录展开），保存时会创建该目录。只影响之后新建的话题，旧文件不迁移。',
    placeholder: '/Users/you/.dsh/dsh-channels/workspaces',
    wide: true,
  },
  topicIsolation: {
    label: '话题工作目录',
    group: 'workspace',
    summary: '每个话题在工作区里怎么隔离',
    help: '自动：工作区是 Git 仓库时给每个话题建一个 worktree，否则用普通子目录。选 Git worktree 但宿主不支持时退回普通子目录。只影响之后新建的话题，已有话题保持原来的目录。',
  },
  routeTtlMs: {
    label: '话题过期',
    group: 'cards',
    summary: '闲置超过这么久的话题不再续聊，0 为永不过期',
    help: '过期话题里的新消息会被明确拒绝并提示新开话题，而不是悄悄开一个没有上下文的会话；Session 和工作区文件都保留。调小后，下一次清理（启动时和定期）就会让更多旧话题过期。',
    min: 0,
    step: DAY_MS,
    unit: '天',
    scale: DAY_MS,
  },
  approvalTimeoutMs: {
    label: '审批卡片等待',
    group: 'cards',
    summary: '超时自动拒绝，等待期间回复暂停',
    min: 10_000,
    max: 3_600_000,
    step: 1_000,
    unit: '秒',
    scale: 1_000,
  },
  questionTimeoutMs: {
    label: '提问卡片等待',
    group: 'cards',
    summary: '模型向用户提问时最多等多久',
    min: 10_000,
    max: 3_600_000,
    step: 1_000,
    unit: '秒',
    scale: 1_000,
  },
  refreshMs: { label: '流式刷新间隔', group: 'cards', summary: '回复卡片多久更新一次', min: 200, max: 10_000, step: 100, unit: 'ms' },
  statusRefreshMs: { label: '状态行保活间隔', group: 'cards', summary: '没有文字输出时，计时多久刷新一次', min: 1_000, max: 60_000, step: 500, unit: 'ms' },
  welcomeOnboarding: { label: '首次私聊发引导卡', group: 'features', summary: '每个私聊只发一次' },
  slashCommandPanel: {
    label: '同步斜杠指令面板',
    group: 'features',
    summary: '在飞书输入 / 时列出插件命令',
    help: '需要 application:app_slash_command:read 和 application:app_slash_command:write 权限。部分企业不允许应用添加斜杠指令；关闭时不读写面板，直接输入命令不受影响。',
  },
  allowPermissionSwitch: { label: '允许在飞书里切换权限预设', group: 'features', summary: '话题所有者可以用 /permissions 改沙箱和审批' },
  provider: { label: '服务商', group: 'model', summary: '留空使用部署默认', placeholder: '留空 = 部署默认' },
  model: { label: '模型', group: 'model', summary: '留空使用部署默认', placeholder: '留空 = 部署默认' },
  reasoningEffort: { label: '推理档位', group: 'model', summary: '模型声明的档位 id，留空使用适配器默认', placeholder: '留空 = 适配器默认' },
  maxTokens: { label: '单次输出上限', group: 'model', summary: '留空使用模型默认', min: 1, step: 1, unit: 'tokens', optional: true, placeholder: '模型默认' },
  agentPreset: { label: 'Agent 预设', group: 'model', summary: '留空使用 roster 默认', placeholder: '留空 = roster 默认' },
  acceptAttachments: {
    label: '接收图片和文件',
    group: 'attachments',
    summary: '关闭后附件消息不保存、不触发模型',
    help: '纯附件消息不回复；需要时引用该消息再提问，多个文件可以合并转发后引用。也接收合并转发的聊天记录。',
  },
  attachmentStore: {
    label: '使用 DSH 原生附件库',
    group: 'attachments',
    summary: '推荐开启；关闭则下载到话题目录 attachments/',
    help: '原生附件库：不可变、内容寻址去重、随 Session 回放，不自动清理。话题目录：旧版行为，可以手动清理，但下载会阻塞会话。宿主没有附件服务时自动退回话题目录。',
  },
  prefetchImages: { label: '预取触发消息里的图片', group: 'attachments', summary: '首轮直接带图，失败的留给模型按需取' },
  historyBootstrapLimit: {
    label: '首轮带上话题历史',
    group: 'attachments',
    summary: '新会话自动附带最近几条消息，0 为关闭',
    help: '更早的消息由模型用 feishu_topic_messages 工具翻页读取。缺权限或读取失败时静默省略。',
    min: 0,
    max: 20,
    step: 1,
    unit: '条',
  },
  'feishuTools.attachmentFetch': {
    label: '读取附件',
    group: 'tools',
    summary: '按需下载已授权消息里的图片和文件',
    help: '工具名 feishu_attachment_fetch。关闭后文件无法按需读取，入站文件直接下载到话题目录。对新会话生效。',
  },
  'feishuTools.topicMessages': {
    label: '读取话题消息',
    group: 'tools',
    summary: '翻看引用消息和话题里更早的内容',
    help: '工具名 feishu_topic_messages。只影响模型主动读取；引用摘录和首轮历史不受影响。',
  },
  'feishuTools.sendFile': {
    label: '发送文件',
    group: 'tools',
    summary: '把生成的图片或文件发回会话，需 im:resource 权限',
    help: '工具名 feishu_send_file。图片不超过 10 MB，文件不超过 30 MB。对新会话生效。',
  },
  prefetchTimeoutMs: { label: '图片预取超时', group: 'limits', min: 100, max: 120_000, step: 100, unit: 'ms' },
  prefetchImageMaxBytes: { label: '单张预取图片上限', group: 'limits', min: 1, max: 200 * 1024 * 1024, step: 1, unit: BYTES_UNIT },
  prefetchTotalMaxBytes: { label: '单次预取总量', group: 'limits', min: 1, max: 1024 * 1024 * 1024, step: 1, unit: BYTES_UNIT },
  'feishuTools.attachmentFetchMaxResources': { label: '读取附件：数量上限', group: 'limits', min: 1, max: 50, step: 1, unit: '个' },
  'feishuTools.attachmentFetchMaxBytes': { label: '读取附件：总字节', group: 'limits', min: 1, step: 1, unit: BYTES_UNIT },
  'feishuTools.attachmentFetchTimeoutMs': { label: '读取附件：超时', group: 'limits', min: 1_000, max: MAX_TIMER_DELAY_MS, step: 1_000, unit: 'ms' },
  'feishuTools.topicMessagesTimeoutMs': { label: '读取话题消息：超时', group: 'limits', min: 1_000, max: 120_000, step: 1_000, unit: 'ms' },
  promptContextTimeoutMs: { label: '引用摘录与历史：超时', group: 'limits', min: 100, max: 10_000, step: 100, unit: 'ms' },
  accessMode: {
    label: '调试模式',
    group: 'access',
    summary: '打开后所有人都能聊，不安全，只在调试时用',
    help: '关闭时（默认）：管理员随时可用；非管理员私聊会被拒绝（打开「白名单用户可私聊」后白名单用户也可以）；群聊要同时满足群已授权、发言人在用户白名单里。授权入口有三个：群里 /auth 命令、授权卡、本页。撤销立即生效。',
  },
  dmAllowWhitelist: {
    label: '白名单用户可私聊',
    group: 'access',
    summary: '关闭时私聊仅管理员可用',
    help: '打开后「已授权用户」里的人也可以私聊机器人，各自使用独立的私聊工作区，能力与群聊相同；不在白名单的人仍收到固定提示。撤销用户立即生效。',
  },
  adminUserId: {
    label: '管理员 user_id',
    group: 'access',
    summary: '私聊机器人发送 /userid 获取；留空使用应用所有者',
    help: '不是 ou_ 开头的 open_id，也不是邮箱。私聊关闭时 /userid 不可用，可以在飞书管理后台的成员详情里查看。自动使用应用所有者需要可选的「获取应用信息」权限。',
    placeholder: 'user_id',
  },
  authRequestTtlDays: { label: '申请有效期', group: 'access', summary: '授权申请卡多久内可以处理', min: 1, max: 30, step: 1, unit: '天' },
  'feishuTools.wikiRead': {
    label: '读取知识库',
    group: 'wiki',
    summary: '浏览节点，读取文档、电子表格、多维表格',
    help: '以应用身份访问，工具 feishu_wiki_list / feishu_wiki_read / feishu_wiki_sheet_read / feishu_wiki_base_read。打开文档前在授权卡上征得话题发起人同意，每个话题一次。只有管理员或下方「可使用的人」发起的话题能用（/auth wiki add @成员）。需要权限 wiki:wiki、docx:document（或只读）、sheets:spreadsheet:read、base:table:read、base:field:read、base:record:read；旧版 sheets:spreadsheet、bitable:app 不生效。对新会话生效。',
  },
  'feishuTools.wikiWrite': {
    label: '编辑知识库',
    group: 'wiki',
    summary: '新建和修改文档、表格，每次都需审批',
    help: '工具 feishu_wiki_create / feishu_wiki_edit / feishu_wiki_sheet_edit / feishu_wiki_base_edit。只能编辑本应用拥有的文档和表格；其他多维表格只能新增记录。需要读取工具的权限，以及 sheets:spreadsheet:write_only、base:record:create、base:record:update、base:record:delete。对新会话生效。',
  },
  wikiRoots: {
    label: '可访问范围',
    group: 'wiki',
    summary: '每行一个知识空间或节点链接，为空时不挂载知识库工具',
    help: '整个知识空间 https://<租户>.feishu.cn/wiki/space/<space_id>，或节点 https://<租户>.feishu.cn/wiki/<node_token>（含其下所有节点）。最多 20 项，空行保存时忽略。对新会话生效。',
    placeholder: 'https://<租户>.feishu.cn/wiki/space/<space_id>',
    wide: true,
  },
  analyzeEnabled: {
    label: '日志分析接口',
    group: 'analyze',
    summary: '关闭时接口返回 404',
    help: '接口挂在 DSH Web 端口上：POST /open-api/logalyze/analyze，请求需带 Authorization: Bearer <访问令牌>。只有带 Web 的 profile 才有这个接口。改后立即生效，不需要重连。',
  },
  loggerLevel: { label: 'SDK 日志级别', group: 'logging' },
}

/** One descriptor per editable key, in `EDITABLE_KEYS` order (Host-driven form). */
export const FIELD_DESCRIPTORS: readonly EditableFieldWire[] = EDITABLE_KEYS.map(key => {
  const meta = FIELD_META[key]
  const options = SELECT_OPTIONS[key]
  const toggle = TOGGLES[key]
  const list = STRING_LIST_FIELDS[key]
  return {
    key,
    label: meta.label,
    kind: list !== undefined
      ? 'string-list'
      : BOOLEAN_KEYS.has(key) ? 'boolean' : options !== undefined ? 'select' : meta.min !== undefined ? 'number' : 'text',
    group: meta.group,
    ...(meta.summary === undefined ? {} : { summary: meta.summary }),
    ...(meta.help === undefined ? {} : { help: meta.help }),
    ...(options === undefined ? {} : { options }),
    ...(toggle === undefined ? {} : { toggle }),
    ...(meta.min === undefined ? {} : { min: meta.min }),
    ...(meta.max === undefined ? {} : { max: meta.max }),
    ...(meta.step === undefined ? {} : { step: meta.step }),
    ...(meta.unit === undefined ? {} : { unit: meta.unit }),
    ...(meta.scale === undefined ? {} : { scale: meta.scale }),
    ...(meta.optional === undefined ? {} : { optional: meta.optional }),
    ...(meta.placeholder === undefined ? {} : { placeholder: meta.placeholder }),
    ...(list === undefined ? {} : { maxItems: list.maxItems }),
    ...(list?.itemFormat === undefined ? {} : { itemFormat: list.itemFormat }),
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


/** Format reason for a rejected user `user_id` (shared by the user and wiki whitelists). */
const USER_ID_FORMAT = '用户 user_id 只能包含字母、数字、_ 和 -（不是 ou_ 开头的 open_id，也不是邮箱）'

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
  /** Feishu origin of one Session for the conversation sidebar. */
  async sessionOrigin(sessionId: string): Promise<SessionOriginResponse> {
    return { origin: await this.target.sessionOrigin(sessionId) }
  }

  /**
   * Live Feishu names and avatars for the panel's users and chats.
   * @param userIds - user `user_id`s.
   * @param chatIds - chat `chat_id`s.
   * @returns the profiles Feishu resolved.
   */
  async feishuProfiles(userIds: readonly string[], chatIds: readonly string[]): Promise<FeishuProfilesWire> {
    return this.target.feishuProfiles(userIds, chatIds)
  }

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

    let credentialStates: Record<CredentialField, CredentialInfo> = {
      appId: { configured: false, writable: false },
      appSecret: { configured: false, writable: false },
      analyzeToken: { configured: false, writable: false },
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
      analyzeToken: toWire(effective.analyzeToken, credentialStates.analyzeToken),
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
        wikiUsers: [],
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
    const listIssues: FieldIssueWire[] = []
    for (const key of EDITABLE_KEYS) {
      const value = values[key]
      if (value === undefined) continue
      if (typeof value === 'string' && value === '' && OPTIONAL_TEXT_KEYS.has(key)) {
        clearedKeys.push(key)
        continue
      }
      const list = STRING_LIST_FIELDS[key]
      if (list !== undefined) {
        const normalized = normalizeStringList(key, value, list)
        if (normalized.ok) setOverlayValue(raw, key, normalized.value)
        else listIssues.push(...normalized.issues)
        continue
      }
      setOverlayValue(raw, key, value)
    }

    const parsed = parseOverlay(raw)
    if (!parsed.ok || listIssues.length > 0) {
      const issues: FieldIssueWire[] = [
        ...listIssues,
        ...(parsed.ok ? [] : parsed.issues.map(issue => ({ key: issue.path, message: issue.message }))),
      ]
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
    for (const field of CREDENTIAL_FIELDS) {
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
    if (writes.length === 0) return { ok: false, error: '请至少填写一项凭据' }

    try {
      for (const write of writes) await this.target.setCredential(write.field, write.value)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (writes.every(write => write.field === 'analyzeToken')) {
      return { ok: true, panel: await this.panel(), reconnect: 'not-needed' }
    }
    return this.finishCredentialChange('save')
  }

  /** Remove the stored value behind one credential reference. */
  async clearCredential(field: CredentialField): Promise<ClearCredentialResponse> {
    const busy = this.writeBusy()
    if (busy !== undefined) return busy
    if (!CREDENTIAL_FIELDS.includes(field)) {
      return { ok: false, error: '未知的凭据字段' }
    }
    try {
      await this.target.clearCredential(field)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (field === 'analyzeToken') return { ok: true, panel: await this.panel(), reconnect: 'not-needed' }
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
    return this.saveUser(userId, name, (id, label) => this.target.addAccessUser(id, label))
  }

  /** Revoke one user authorization (immediate: the next message re-evaluates). */
  async removeAccessUser(userId: unknown): Promise<AccessMutationResponse> {
    return this.removeUser(userId, id => this.target.removeAccessUser(id))
  }

  /** Add one user `user_id` to the wiki whitelist. */
  async saveWikiUser(userId: unknown, name?: unknown): Promise<AccessMutationResponse> {
    return this.saveUser(userId, name, (id, label) => this.target.addWikiUser(id, label))
  }

  /** Remove one user from the wiki whitelist (immediate: the next wiki tool call re-evaluates). */
  async removeWikiUser(userId: unknown): Promise<AccessMutationResponse> {
    return this.removeUser(userId, id => this.target.removeWikiUser(id))
  }

  private async saveUser(
    userId: unknown,
    name: unknown,
    add: (id: string, label: string | undefined) => Promise<AccessMutationResponse>,
  ): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(userId, '用户 user_id', USER_ID_FORMAT)
    if (!id.ok) return { ok: false, error: id.message }
    const label = normalizeAccessName(name)
    if (!label.ok) return { ok: false, error: label.message }
    return this.mutateAccess(() => add(id.value, label.value))
  }

  private async removeUser(
    userId: unknown,
    remove: (id: string) => Promise<AccessMutationResponse>,
  ): Promise<AccessMutationResponse> {
    const id = normalizeAccessId(userId, '用户 user_id', USER_ID_FORMAT)
    if (!id.ok) return { ok: false, error: id.message }
    return this.mutateAccess(() => remove(id.value))
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
