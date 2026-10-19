/**
 * Web 设置面板的线上契约：Host 半侧的路由/面板数据与 Browser 半侧的渲染共用。
 *
 * 本模块**没有运行时依赖**：Host 与 Client bundle 都直接内联它。因此这里只放
 * 常量、字段清单与可序列化的 wire 类型，不 import zod / node / DSH 内部包。
 *
 * @module dsh-channels/settings/contract
 */

/** Same-origin routes the settings panel talks to. */
export const STATUS_ROUTE = '/dsh-channels/status'
export const PANEL_ROUTE = '/dsh-channels/panel'
export const CONFIG_ROUTE = '/dsh-channels/config'
export const CREDENTIALS_ROUTE = '/dsh-channels/credentials'
/**
 * Connection lifecycle action (POST). While the channel runs it restarts the
 * long connection; while it is stopped it opens one — so the panel has exactly
 * one "connect / reconnect" button. Credentials are resolved again either way.
 */
export const RECONNECT_ROUTE = '/dsh-channels/reconnect'
/** 模型/推理档位/预设选择器的宿主目录（provider → model → effort 级联刷新）。 */
export const CATALOG_ROUTE = '/dsh-channels/catalog'
/** 手动执行一次过期工作区清理（POST，无请求体）。 */
export const CLEANUP_ROUTE = '/dsh-channels/cleanup'
/** 访问与授权只读快照（GET/HEAD）：准入模式、管理员、群/用户白名单、待处理申请。 */
export const ACCESS_ROUTE = '/dsh-channels/access'
/** 群白名单增删（POST/DELETE，body `{ chatId, name? }` / `{ chatId }`）。 */
export const ACCESS_GROUPS_ROUTE = '/dsh-channels/access/groups'
/** 用户白名单增删（POST/DELETE，body `{ openId, name? }` / `{ openId }`）。 */
export const ACCESS_USERS_ROUTE = '/dsh-channels/access/users'
/** 结算一条待处理授权申请（POST，body `{ token, decision }`）。 */
export const ACCESS_REQUESTS_ROUTE = '/dsh-channels/access/requests'

/**
 * 可由 Web 面板覆盖的配置项。全部是 `src/config.ts` 里已存在的字段；
 * 覆盖值写进 `$DSH_HOME/dsh-channels/settings.json`，优先级高于 profile
 * 的 `cordis.patch.yml`（见 README「Web 设置面板」）。
 *
 * 刻意不包含 `appId` / `appSecret`：它们是**凭据引用名**，面板改为直接
 * 编辑引用背后的值（`PUT /dsh-channels/credentials`，经 DSH 凭据服务写入），
 * 因此不会落进覆盖层文件。
 *
 * `baseDir`（工作区根目录 = 模型/工具产生文件的落点）可覆盖，但面板只接受
 * **绝对路径**（`~` 会展开）；已有 Session / 工作区不迁移，只影响之后新建的
 * 会话。校验与保存时建目录见 `src/workspaces.ts`。
 */
export const EDITABLE_KEYS = [
  // 工作区
  'baseDir',
  'workspaceRetention',
  'workspaceRetentionAuto',
  // 行为
  'dmMode',
  'requireMention',
  'threadFallback',
  'welcomeOnboarding',
  'allowPermissionSwitch',
  // 准入与授权（管理员/准入模式/申请有效期；白名单由「访问与授权」卡片管理）
  'adminOpenId',
  'accessMode',
  'authRequestTtlDays',
  // 内容
  'acceptAttachments',
  // 模型
  'provider',
  'model',
  'reasoningEffort',
  'agentPreset',
  // 流式卡片
  'refreshMs',
  'statusRefreshMs',
  'loggerLevel',
] as const

export type EditableKey = (typeof EDITABLE_KEYS)[number]

/**
 * 只有重连飞书长连接后才生效的字段：它们在 `FeishuService.start()` 建连时
 * 被交给官方 SDK 或流式器，运行中修改不会影响已建立的连接。
 */
export const RESTART_KEYS = [
  'dmMode',
  'requireMention',
  'refreshMs',
  'statusRefreshMs',
  'loggerLevel',
] as const satisfies readonly EditableKey[]

export type RestartKey = (typeof RESTART_KEYS)[number]

/** Render kinds the generic panel form understands. */
export type FieldKind = 'boolean' | 'number' | 'text' | 'select'

/**
 * Field groups partition the editable form. Each group is rendered inside one
 * panel tab (see {@link TAB_FIELD_GROUPS}); the Host is the source of truth for
 * which key belongs to which group.
 */
export type FieldGroup = 'workspace' | 'behavior' | 'content' | 'model' | 'streaming' | 'access'

/** One selectable value rendered by the generic form. */
export interface FieldOptionWire {
  value: string
  label: string
}

/** One editable row, fully described by the Host so the client stays schema-free. */
export interface EditableFieldWire {
  key: EditableKey
  label: string
  kind: FieldKind
  group: FieldGroup
  help?: string
  options?: readonly FieldOptionWire[]
  /** Selector is not editable yet (e.g. pick the provider before the model). */
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** Render across the whole form width (long paths). */
  wide?: boolean
  /** 保存后需重连飞书通道才生效。 */
  restartRequired: boolean
}

/**
 * One selector group resolved from live host services. `selectable: false`
 * means the host could not enumerate values (service absent / lookup failed),
 * so the field falls back to the free-text control with the same key.
 */
export interface SelectCatalogWire {
  selectable: boolean
  /** Rendered in order; the leading `''` entry is the inherit/clear choice. */
  options: FieldOptionWire[]
  disabled?: boolean
  /** Host-side explanation shown instead of the static field help. */
  help?: string
}

/** `GET /dsh-channels/catalog` payload: the model-facing selector catalog. */
export interface CatalogWire {
  provider: SelectCatalogWire
  model: SelectCatalogWire
  reasoningEffort: SelectCatalogWire
  agentPreset: SelectCatalogWire
  /** Deployment default selection, when the host exposes `agentDefaultModel`. */
  deploymentDefault?: {
    provider?: string
    model?: string
    reasoningEffort?: string
  }
  /** Roster default preset id, when the host exposes the preset roster. */
  defaultPresetId?: string
}

/** Values the panel may submit. Empty strings for optional text fields clear the override. */
export type ConfigValue = string | number | boolean
export type EditableValues = Partial<Record<EditableKey, ConfigValue>>

/** Read-only facts shown in the advanced card. */
export interface ReadOnlyFieldWire {
  key: string
  label: string
  value: string
  help?: string
}

/** One credential reference plus its Host-side state (values never cross the wire). */
export interface CredentialRefWire {
  ref: string
  configured: boolean
  /** false when the mounted credentials provider cannot store values. */
  writable: boolean
  /** Where the configured value comes from (e.g. `file`), when the provider reports it. */
  source?: string
}

/** The two credential slots the panel may write. */
export type CredentialField = 'appId' | 'appSecret'

/** Official-SDK WebSocket lifecycle snapshot (structural copy, no SDK import on the wire). */
export interface ConnectionWire {
  state: string
  lastConnectTime?: number
  nextConnectTime?: number
  reconnectAttempts: number
}

/**
 * The panel-facing lifecycle phase, derived by the Host from configuration
 * readiness and runtime state. Enabling the plugin starts in `unconfigured`
 * (or `idle` when credentials already resolve) and never forces a connection
 * before the Feishu application credentials are complete.
 */
export type ChannelPhaseWire =
  /** Credentials are incomplete: the plugin is loaded but deliberately not connected. */
  | 'unconfigured'
  /** Credentials are complete, no connection is open yet. */
  | 'idle'
  /** A connection attempt / reconnect is in flight. */
  | 'connecting'
  /** The Feishu long connection is open. */
  | 'connected'
  /** The last connection attempt failed; the reason is in `lastStartError`. */
  | 'error'

/** Runtime connection/liveness facts. */
export interface ChannelStatusWire {
  running: boolean
  /**
   * Whether the Feishu application credentials are complete. When false the
   * plugin stays loaded (settings panel usable) but opens no long connection.
   */
  configured: boolean
  /** Display phase derived from `configured` / `running` / `lastStartError`. */
  phase: ChannelPhaseWire
  /** Human-readable config items that are still missing (names only, never values). */
  missingConfig: string[]
  level: 'healthy' | 'degraded' | 'unhealthy'
  startedAt?: number
  uptimeMs?: number
  connection?: ConnectionWire
  botOpenIdTail?: string
  routeCount: number
  liveAgentCount: number
  inflightTurnCount: number
  /** 最近一次连接失败的原因（成功后清空）。 */
  lastStartError?: string
  /** 健康判定的原因说明（空数组 = 健康）；由 Host 的 health 折叠给出。 */
  reasons: string[]
  /** 面板显示的所有键值对来源版本。 */
  version: string
  /** Web 覆盖文件绝对路径（用户可直接编辑）。 */
  overlayPath: string
  /** 正在连接或重连时为 true，此时面板的写操作按钮禁用。 */
  busy: boolean
}

/** The whole editable configuration surface, with provenance. */
export interface PanelConfigWire {
  /** profile `cordis.patch.yml` 提供的值（覆盖层之下）。 */
  base: Record<string, ConfigValue | undefined>
  /** 合并后的生效值。 */
  effective: Record<string, ConfigValue | undefined>
  /** 已写入 Web 覆盖层的值。 */
  overlay: EditableValues
  overriddenKeys: EditableKey[]
  /** 与当前运行中连接不一致、需重连才生效的字段。 */
  restartPendingKeys: EditableKey[]
  fields: EditableFieldWire[]
  readOnly: ReadOnlyFieldWire[]
  credentials: {
    appId: CredentialRefWire
    appSecret: CredentialRefWire
  }
}

/** One authorized group (the first of the two admission gates). */
export interface AccessGroupWire {
  chatId: string
  /** Human-readable group name captured at authorization time. */
  name?: string
  /** Which authorization entry produced the grant. */
  source: 'command' | 'card' | 'panel'
  /** Epoch ms when it was authorized. */
  addedAt: number
}

/** One authorized user `open_id` (global across every authorized group). */
export interface AccessUserWire {
  openId: string
  /** Display name captured at authorization time. */
  name?: string
  /** Which authorization entry produced the grant. */
  source: 'command' | 'card' | 'panel'
  /** Epoch ms when it was authorized. */
  addedAt: number
}

/** One pending authorization request the panel may settle (same path as the DM card). */
export interface AccessRequestWire {
  /** Opaque token; never derived from the target id. */
  token: string
  kind: 'group' | 'user'
  /** `chat_id` for a group request, `open_id` for a user request. */
  targetId: string
  /** Display name of the requested target (group name / user name), when known. */
  name?: string
  /** Chat the request originated from, when applicable. */
  chatId?: string
  /** Group name captured for the card. */
  groupName?: string
  /** Open_id of the user who triggered a user request. */
  requester?: string
  /** Epoch ms when the request was created. */
  createdAt: number
  /** Epoch ms after which the request can no longer be decided. */
  expiresAt: number
}

/**
 * `GET /dsh-channels/access` payload: admission mode, the administrator
 * reference, both whitelists, and the still-pending authorization requests.
 */
export interface AccessWire {
  mode: 'open' | 'guarded'
  admin: {
    openId?: string
    /** false while guarded mode would refuse every conversation (fail closed). */
    configured: boolean
  }
  /**
   * Whether the persisted whitelists were loaded. While the channel holds no
   * connection the plugin storage domain is closed, so the lists are unknown
   * (not empty) and the panel must not offer mutations.
   */
  loaded: boolean
  groups: AccessGroupWire[]
  users: AccessUserWire[]
  requests: AccessRequestWire[]
}

/** Write responses for every `/dsh-channels/access*` mutation. */
export type AccessMutationResponse =
  | { ok: true; access: AccessWire }
  | { ok: false; error: string }

/** `GET /dsh-channels/panel` payload. */
export interface PanelWire {
  status: ChannelStatusWire
  config: PanelConfigWire
  cleanup: CleanupPreviewWire
  /** 访问与授权卡片的数据（准入模式、管理员、白名单、待处理申请）。 */
  access: AccessWire
}

/**
 * What the workspace-retention cleanup would delete right now. Counts are
 * zero and `error` is set when the Host cannot compute the preview (for
 * example the cleanup seam is unavailable); the panel stays usable.
 */
export interface CleanupPreviewWire {
  /** Effective `workspaceRetention` value (`off` / `7d` / `30d` / `90d` / `180d`). */
  retention: string
  /** Retention threshold in milliseconds; absent when `retention` is `off`. */
  thresholdMs?: number
  /** Periodic cleanup runs at startup and once per day. */
  auto: boolean
  /** Plugin-created workspaces under the current baseDir. */
  workspaces: number
  /** Workspaces older than the threshold (the deletable set). */
  candidates: number
  /** Total bytes currently occupied by the candidates. */
  candidateBytes: number
  /** Why the preview could not be computed (counts are zero then). */
  error?: string
}

/** Outcome of one manual cleanup run (partial failures do not abort the run). */
export interface CleanupRunWire {
  ok: boolean
  deletedWorkspaces: number
  retiredRoutes: number
  freedBytes: number
  /** One `path: message` line per workspace that could not be deleted. */
  failures: string[]
  error?: string
}

/** `POST /dsh-channels/cleanup` response. */
export type CleanupResponse =
  | { ok: true; panel: PanelWire; result: CleanupRunWire }
  | { ok: false; error: string }

/** `PUT /dsh-channels/config` body. */
export interface SaveConfigRequest {
  values: EditableValues
}

/** Per-field validation failure. */
export interface FieldIssueWire {
  key: string
  message: string
}

/** `PUT /dsh-channels/config` response. */
export type SaveConfigResponse =
  | { ok: true; panel: PanelWire; clearedKeys: EditableKey[] }
  | { ok: false; error: string; issues?: FieldIssueWire[] }

/** `POST /dsh-channels/reconnect` response. */
export type ReconnectResponse =
  | { ok: true; panel: PanelWire }
  /** `unconfigured` tells the panel to route the user to the credentials form. */
  | { ok: false; error: string; unconfigured?: boolean }

/** `DELETE /dsh-channels/config` response. */
export type ClearConfigResponse =
  | { ok: true; panel: PanelWire }
  | { ok: false; error: string }

/** `PUT /dsh-channels/credentials` body: only provided, non-empty values are written. */
export interface SaveCredentialsRequest {
  appId?: string
  appSecret?: string
}

/** `DELETE /dsh-channels/credentials` body. */
export interface ClearCredentialRequest {
  field: CredentialField
}

/**
 * How a saved credential reached the running channel.
 *
 * - `auto`: the channel was stopped and connected immediately after the save.
 * - `pending`: the channel is running; reconnect for the value to take effect.
 * - `not-needed`: removed while stopped, nothing to reconnect.
 * - `unconfigured`: saved, but the other credential of the pair is still
 *   missing — the plugin keeps waiting (no connection attempt) until it is
 *   configured.
 * - `failed`: the pair is complete and a connection was attempted, but it
 *   failed; the value is stored and `autoReconnectError` explains why.
 */
export type CredentialReconnectState = 'auto' | 'pending' | 'not-needed' | 'unconfigured' | 'failed'

export interface CredentialsSavedPayload {
  panel: PanelWire
  reconnect: CredentialReconnectState
  /** Set when the automatic reconnect after a save failed (the value is still saved). */
  autoReconnectError?: string
}

/** Credential write/remove responses (values never appear in either direction). */
export type SaveCredentialsResponse =
  | ({ ok: true } & CredentialsSavedPayload)
  | { ok: false; error: string; issues?: FieldIssueWire[] }

export type ClearCredentialResponse =
  | ({ ok: true } & CredentialsSavedPayload)
  | { ok: false; error: string; issues?: FieldIssueWire[] }

/**
 * Top-level panel tabs, in render order. The panel shows the connection state
 * header above every tab, so switching tabs never hides whether the bridge is
 * connected.
 */
export const PANEL_TABS = [
  { id: 'connection', label: '连接' },
  { id: 'sessions', label: '会话与行为' },
  { id: 'model', label: '模型' },
  { id: 'workspace', label: '工作区' },
  { id: 'access', label: '访问授权' },
  { id: 'advanced', label: '高级' },
] as const

export type PanelTabId = (typeof PANEL_TABS)[number]['id']

/** Which editable field groups each tab renders (the tabs own one or two). */
export const TAB_FIELD_GROUPS: Readonly<Record<PanelTabId, readonly FieldGroup[]>> = {
  connection: [],
  sessions: ['behavior', 'content'],
  model: ['model'],
  workspace: ['workspace'],
  access: ['access'],
  advanced: ['streaming'],
}

/** Section heading for one field group inside its tab. */
export const FIELD_GROUP_LABELS: Readonly<Record<FieldGroup, string>> = {
  workspace: '工作区与文件',
  behavior: '行为',
  content: '内容与附件',
  model: '模型与推理',
  streaming: '流式卡片与日志',
  access: '准入与授权',
}

/** Display labels for the panel header/cards (kept on the wire so the client owns no copy). */
export const PANEL_COPY = {
  title: '飞书渠道',
  description: '飞书长连接、应用凭据与渠道配置。凭据只写入 DSH 凭据库且不回显；标注「需重连」的项在连接建立时读取。',
  // ---- lifecycle / status -------------------------------------------------
  statusCard: '连接状态',
  phaseUnconfigured: '待配置',
  phaseIdle: '未连接',
  phaseConnecting: '连接中',
  phaseConnected: '已连接',
  phaseError: '连接失败',
  configuredBadge: '凭据已配置',
  unconfiguredBadge: '凭据未配置',
  statusSummaryConnected: '飞书长连接已建立，机器人可以收发消息。',
  statusSummaryUnconfigured: '尚未配置飞书应用凭据：插件已加载，但不会连接飞书。填写凭据并保存后会自动连接。',
  statusSummaryIdle: '飞书应用凭据已就绪，但当前没有建立长连接。',
  statusSummaryConnecting: '正在连接飞书长连接…',
  statusSummaryError: '最近一次连接飞书失败，请检查凭据与网络后重试。',
  lastError: '最近一次连接失败',
  missingConfig: '缺少配置',
  statusHintUnconfigured: '配置完成后插件会自动连接；也可以稍后在本页手动连接。',
  connectionInfo: '连接信息',
  connectionStateLabel: '飞书长连接',
  botOpenId: 'Bot open_id',
  uptime: '运行时长',
  routeCount: '话题路由',
  liveAgentCount: '活动会话',
  inflightTurnCount: '在途回复',
  healthReasons: '健康判定',
  unknownValue: '—',
  connect: '连接飞书',
  connecting: '连接中…',
  // ---- onboarding ---------------------------------------------------------
  onboardingTitle: '开始使用飞书渠道',
  onboardingIntro: '只需三步：在飞书开放平台创建自建应用，把 App ID / App Secret 填入本页，保存后自动连接。',
  onboardingStep1Title: '创建飞书自建应用',
  onboardingStep1Text: '在飞书开放平台创建企业自建应用，开启机器人能力；事件订阅选择「长连接」，订阅 im.message.receive_v1（接收消息）。',
  onboardingStep2Title: '填写应用凭据',
  onboardingStep2Text: '把应用的 App ID（cli_ 开头）与 App Secret 填入下方「飞书应用凭据」，值会写入 DSH 凭据库。',
  onboardingStep3Title: '保存并等待连接',
  onboardingStep3Text: '两项凭据都保存后插件会自动连接；状态变为「已连接」即可在飞书里私聊机器人。',
  onboardingDocsHint: '开放平台地址：open.feishu.cn/app；应用需要开通 im:message、im:message:send_as_bot 等消息权限。',
  // ---- credentials --------------------------------------------------------
  credentialsCard: '飞书应用凭据',
  credentialsCardHelp: '凭据值经 DSH 凭据服务写入本机凭据库；面板只显示「已配置 / 未配置」，永不回显已存值。两项都配置后才会连接飞书。',
  appIdLabel: '飞书 App ID',
  appSecretLabel: '飞书 App Secret',
  credentialsRef: '凭据引用',
  saveCredentials: '保存凭据',
  savingCredentials: '保存中…',
  credentialSaved: '凭据已保存',
  credentialSavedReconnected: '凭据已保存，飞书已连接',
  credentialSavedPending: '凭据已保存，重启飞书连接后生效',
  credentialSavedUnconfigured: '凭据已保存；还缺少另一项凭据，补齐后会自动连接',
  credentialAutoConnectFailed: '凭据已保存，但自动连接失败',
  credentialRemoved: '已移除存储的凭据',
  credentialRemovedPending: '已移除存储的凭据，重启飞书连接后生效',
  removeCredential: '移除已存值',
  removingCredential: '移除中…',
  credentialConfigured: '已配置',
  credentialMissing: '未配置',
  credentialReadOnly: '当前凭据存储不可写',
  appIdPlaceholder: '输入 App ID（cli_…）',
  appSecretPlaceholder: '输入 App Secret',
  credentialsPendingHint: '填写后点「保存凭据」；两项齐全时插件会自动连接飞书。',
  // ---- tabs / forms -------------------------------------------------------
  connectionTabHelp: '连接状态与飞书应用凭据。凭据不完整时不会连接飞书。',
  sessionsTabHelp: '私聊、群聊触发方式与入站内容；「需重连」项在下次连接时读取。',
  modelTabHelp: '飞书会话使用的模型服务商、模型、推理档位与 Agent 预设；下拉选项来自宿主机实时目录，保存后对新会话生效。',
  workspaceTabHelp: '每个飞书话题一个独立工作区（模型/工具产生文件的落点）；只影响之后新建的话题。',
  accessTabHelp: '准入采用 fail-closed：管理员不受白名单限制，非管理员私聊会被拒绝，群聊需要「群已授权 + 用户在白名单」两层同时命中。',
  advancedTabHelp: '流式刷新等低层参数、Web 覆盖文件与只读信息。',
  save: '保存更改',
  saving: '保存中…',
  saveHintDirty: '只保存改动过的字段；标注「需重连」的项在下次连接时生效。',
  discardTab: '放弃本页更改',
  saveHintClean: '没有未保存的更改。',
  dirtyCount: '未保存项',
  saved: '已保存',
  cleared: '已清除 Web 覆盖，恢复为 profile 配置',
  clear: '清除 Web 覆盖',
  clearing: '清除中…',
  noOverrides: '当前没有 Web 覆盖',
  overridden: 'Web 覆盖',
  inherited: '继承 profile',
  restartTag: '需重连',
  restartBanner: '以下配置需重启飞书连接后生效：',
  restartWarning: '重启会断开当前飞书长连接并中断进行中的回复，请确认空闲时操作。',
  reconnect: '重启飞书连接',
  reconnecting: '重连中…',
  refresh: '刷新状态',
  retry: '重试',
  pollFailed: '状态刷新失败',
  connectDone: '已连接飞书',
  reconnectDone: '已重启飞书连接',
  saveInvalid: '请先修正标红的配置项',
  enabled: '已启用',
  disabled: '已关闭',
  credentialRemoveConfirm: '确定移除已存储的凭据值？移除后不会回显，需要时须重新填写。',
  accessNotLoaded: '飞书连接建立后加载授权列表',
  loading: '加载中…',
  loadFailed: '设置面板加载失败',
  catalogFailed: '模型目录加载失败，已退回手填。',
  catalogLoading: '正在读取宿主机选项…',
  catalogUnavailable: '宿主机未提供可选项，请手填。',
  version: '插件版本',
  overlayPath: '覆盖文件',
  overlayPathHelp: '可以直接编辑该 JSON 文件；面板保存会整体重写它，「清除 Web 覆盖」会删除它并回落到 profile 配置。',
  advancedCard: '只读与高级信息',
  advancedHelp: '这些值来自 profile 配置，不能在面板里编辑。',
  readOnlyCard: '部署级参数',
  // ---- model --------------------------------------------------------------
  // ---- cleanup ------------------------------------------------------------
  cleanupCard: '工作区清理',
  cleanupCardHelp: '删除超过保留期且不再活跃的飞书工作区目录；只会删除本插件在「工作区根目录」下创建的目录，DSH 会话日志不删除。删除不可恢复：相关旧话题会失效并提示已过期，工作区列表记录同步移除。',
  cleanupRetention: '保留期',
  cleanupAutoLabel: '自动清理',
  cleanupCandidates: '可清理工作区',
  cleanupCandidateBytes: '预计释放空间',
  cleanupRetentionOff: '关闭（不删除）',
  cleanupAutoOn: '已开启（启动时 + 每天一次）',
  cleanupAutoOff: '已关闭（仅手动执行）',
  cleanupAutoInactive: '未执行（保留期为关闭）',
  cleanupNow: '立即清理',
  cleanupRunning: '清理中…',
  cleanupConfirm: '确定清理过期工作区吗？该操作不可恢复，会删除这些工作区内的全部文件（包括 attachments/ 附件）。',
  cleanupConfirmHint: '删除前会再次确认；保留期为「关闭」或没有过期工作区时按钮不可用。',
  cleanupDisabledOff: '保留策略为「关闭」：请先在上方「过期工作区保留期」中选择保留天数。',
  cleanupDisabledEmpty: '没有超过保留期的过期工作区。',
  cleanupPreviewFailed: '无法读取清理预览',
  cleanupDone: '清理完成',
  cleanupFailed: '清理失败',
  cleanupDeleted: '已删除工作区',
  cleanupRetired: '已清理话题路由',
  cleanupFreed: '释放空间',
  cleanupFailures: '以下工作区未能删除：',
  // ---- access -------------------------------------------------------------
  accessCard: '访问与授权',
  accessCardHelp: '准入采用 fail-closed：管理员不受白名单限制（私聊、任意群聊都可直接对话）；非管理员私聊会被拒绝，群聊需要「群已授权 + 用户在白名单」两层同时命中。管理员与准入模式在上方「准入与授权」中编辑；私聊机器人发送 /userid 获取自己的 open_id。',
  accessModeOpenWarning: '当前准入模式为开放（open）：应用可用范围内的任何人都能开启对话。该模式不安全，仅建议调试时使用。',
  accessAdminMissingWarning: '当前准入=guarded 但未配置管理员，所有对话都会被拒绝。请在上方「准入与授权」填写管理员 open_id。',
  accessGroupsTitle: '已授权群',
  accessGroupsEmpty: '尚未授权任何群。机器人被拉进群后，管理员会收到带 chat_id 的群信息卡；也可在群内发送 /groupid 获取。',
  accessUsersTitle: '已授权用户',
  accessUsersEmpty: '尚未授权任何用户。已授权用户可在所有已授权群里与机器人对话（私聊仍只开给管理员）。',
  accessRequestsTitle: '待处理申请',
  accessRequestsEmpty: '没有待处理的授权申请。',
  accessGroupChatIdPlaceholder: '群 chat_id（oc_…）',
  accessGroupNamePlaceholder: '群名（可选）',
  accessUserOpenIdPlaceholder: '用户 open_id（ou_…）',
  accessUserNamePlaceholder: '昵称（可选）',
  accessAddGroup: '添加群',
  accessAddUser: '添加用户',
  accessRemove: '移除',
  accessAllow: '授权',
  accessDeny: '忽略',
  accessWorking: '处理中…',
  accessSourceCommand: '对话命令',
  accessSourceCard: '授权卡',
  accessSourcePanel: '设置面板',
  accessRequestGroup: '群申请',
  accessRequestUser: '用户申请',
  accessRequestRequester: '申请人',
  accessRequestExpires: '有效期至',
  accessGroupAdded: '已添加群授权',
  accessGroupRemoved: '已移除群授权',
  accessUserAdded: '已添加用户授权',
  accessUserRemoved: '已移除用户授权',
  accessRequestAllowed: '已授权',
  accessRequestDenied: '已忽略',
  accessHints: '三种授权入口：群内 /auth 命令、入群与用户授权卡、本面板。撤销立即生效；白名单只约束非管理员（管理员在任何私聊/群聊都直接放行），非管理员需要群和用户两层同时命中。',
  accessChatIdHint: 'chat_id 可从入群群信息卡或群内 /groupid 获取；open_id 可私聊机器人发送 /userid 获取。',
} as const
