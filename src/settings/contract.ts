/**
 * Web 设置面板的线上契约：Host 半侧的路由/面板数据与 Browser 半侧的渲染共用。
 *
 * 本模块**没有运行时依赖**：Host 与 Client bundle 都直接内联它。因此这里只放
 * 常量、字段清单、可序列化的 wire 类型与无依赖的纯文案函数，不 import zod / node / DSH 内部包。
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
/** 访问与授权只读快照（GET/HEAD）：准入模式、管理员、群/用户/知识库白名单、待处理申请。 */
export const ACCESS_ROUTE = '/dsh-channels/access'
/** 群白名单增删（POST/DELETE，body `{ chatId, name? }` / `{ chatId }`）。 */
export const ACCESS_GROUPS_ROUTE = '/dsh-channels/access/groups'
/** 用户白名单增删（POST/DELETE，body `{ userId, name? }` / `{ userId }`）。 */
export const ACCESS_USERS_ROUTE = '/dsh-channels/access/users'
/** 知识库白名单增删（POST/DELETE，body `{ userId, name? }` / `{ userId }`）。 */
export const ACCESS_WIKI_USERS_ROUTE = '/dsh-channels/access/wiki-users'
/** 结算一条待处理授权申请（POST，body `{ token, decision }`）。 */
export const ACCESS_REQUESTS_ROUTE = '/dsh-channels/access/requests'
/**
 * 打开宿主机的系统目录选择框（POST，无请求体），返回绝对路径。
 *
 * 只有宿主挂载了 `directoryPicker` 的 native 后端（桌面/本地 GUI 会话）才
 * 会注册实际选择逻辑；远程/无头会话的 browse 后端不可用，面板不下发
 * [`EditableFieldWire.browse`]，保留手写输入。
 */
export const PICK_DIRECTORY_ROUTE = '/dsh-channels/pick-directory'
/** 会话的飞书来源（GET/HEAD，`?sessionId=`）：对话右侧栏「飞书来源」标签与会话头部入口使用。 */
export const SESSION_ORIGIN_ROUTE = '/dsh-channels/session-origin'

/** Where one Feishu-routed Session came from; names are resolved live and may be absent. */
export interface SessionOriginWire {
  sessionId: string
  /** `p2p` = 私聊，`group` = 群聊。 */
  chatType: 'p2p' | 'group'
  /** `thread` = 话题内会话，`chat` = 整个聊天一个会话（话题不可用时的降级）。 */
  kind: 'thread' | 'chat'
  chatId: string
  /** 群名（群聊且能读取群信息时）。 */
  chatName?: string
  /** 发起人 user_id（日志平台分析话题为请求人）。 */
  senderUserId: string
  /** 发起人姓名（通讯录或群成员列表能查到时）。 */
  senderName?: string
  /** 日志平台分析话题：群内成员都可以继续。 */
  shared: boolean
  /** Epoch ms when the Session was bound to its Feishu route. */
  createdAt: number
  /** Whether the Feishu route still points at this Session (false after `/renew`, `/new` or route expiry). */
  bound: boolean
  /** Epoch ms of the route's last activity, while bound. */
  lastActivityAt?: number
  /** 在飞书客户端打开该聊天的链接。 */
  chatLink: string
}

/** `GET SESSION_ORIGIN_ROUTE` response: `origin` is null for a Session not started from Feishu. */
export interface SessionOriginResponse {
  origin: SessionOriginWire | null
}

/**
 * 可由 Web 面板覆盖的配置项。顶层键对应 `src/config.ts` 的字段；`feishuTools.*`
 * 是嵌套字段（覆盖层里仍写成 `{ "feishuTools": { ... } }` 对象）。覆盖值写进
 * `$DSH_HOME/dsh-channels/settings.json`，优先级高于 profile 的
 * `cordis.patch.yml`（见 README「Web 设置面板」）。
 *
 * 刻意不包含 `appId` / `appSecret`：它们是**凭据引用名**，面板改为直接
 * 编辑引用背后的值（`PUT /dsh-channels/credentials`，经 DSH 凭据服务写入），
 * 因此不会落进覆盖层文件。
 *
 * `baseDir`（工作区根目录 = 模型/工具产生文件的落点）可覆盖，但面板只接受
 * **绝对路径**（`~` 会展开）；已有 Session / 目录不迁移，只影响之后新建的
 * 会话。校验与保存时建目录见 `src/workspaces.ts`。
 *
 * 数组顺序就是面板里同一分组内字段的显示顺序。
 */
export const EDITABLE_KEYS = [
  // 会话：触发
  'dmMode',
  'requireMention',
  'threadFallback',
  // 会话：工作区
  'baseDir',
  'topicIsolation',
  // 会话：话题与卡片
  'routeTtlMs',
  'approvalTimeoutMs',
  'questionTimeoutMs',
  'refreshMs',
  'statusRefreshMs',
  // 会话：飞书侧功能
  'welcomeOnboarding',
  'slashCommandPanel',
  'allowPermissionSwitch',
  // 模型
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'agentPreset',
  // 附件（v2 管线）
  'acceptAttachments',
  'attachmentStore',
  'prefetchImages',
  'historyBootstrapLimit',
  // 模型工具（`feishuTools.*` 是嵌套配置，覆盖层仍写成嵌套对象）
  'feishuTools.attachmentFetch',
  'feishuTools.topicMessages',
  'feishuTools.sendFile',
  // 限额与超时
  'prefetchTimeoutMs',
  'prefetchImageMaxBytes',
  'prefetchTotalMaxBytes',
  'feishuTools.attachmentFetchMaxResources',
  'feishuTools.attachmentFetchMaxBytes',
  'feishuTools.attachmentFetchTimeoutMs',
  'feishuTools.topicMessagesTimeoutMs',
  'promptContextTimeoutMs',
  // 准入与授权（白名单由「访问授权」tab 的列表管理）
  'accessMode',
  'adminUserId',
  'authRequestTtlDays',
  // 知识库（顶层 `wikiRoots` 字符串列表；为空时不挂载任何知识库工具）
  'feishuTools.wikiRead',
  'feishuTools.wikiWrite',
  'wikiRoots',
  // 日志平台分析接口（访问令牌是凭据引用 analyzeToken，值写在 DSH 凭据里）
  'analyzeListen',
  // 日志
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
  'slashCommandPanel',
  'analyzeListen',
  'refreshMs',
  'statusRefreshMs',
  'loggerLevel',
] as const satisfies readonly EditableKey[]

export type RestartKey = (typeof RESTART_KEYS)[number]

/**
 * Render kinds the generic panel form understands. `string-list` renders one
 * single-line input per entry with a remove button each and an add button
 * below; its value is a `readonly string[]`.
 */
export type FieldKind = 'boolean' | 'number' | 'text' | 'select' | 'string-list'

/**
 * Per-entry format of a `string-list` field. Host and Client both map the
 * format onto the same entry parser, so an invalid entry is marked before
 * saving and the Host re-validates it on save.
 *
 * - `wiki-root-link`: a Feishu wiki space link or wiki node link (`wikiRoots`).
 */
export type StringListItemFormat = 'wiki-root-link'

/**
 * Field groups partition the editable form. Each group is rendered inside one
 * panel tab (see {@link TAB_FIELD_GROUPS}); the Host is the source of truth for
 * which key belongs to which group.
 */
export type FieldGroup =
  | 'trigger'
  | 'workspace'
  | 'cards'
  | 'features'
  | 'model'
  | 'attachments'
  | 'tools'
  | 'limits'
  | 'access'
  | 'wiki'
  | 'analyze'
  | 'logging'

/** One selectable value rendered by the generic form. */
export interface FieldOptionWire {
  value: string
  label: string
}

/**
 * A two-value `select` rendered as a switch: `on` is the value stored while
 * the switch is on, `off` while it is off. Both are members of `options`.
 */
export interface FieldToggleWire {
  on: string
  off: string
}

/** One editable row, fully described by the Host so the client stays schema-free. */
export interface EditableFieldWire {
  key: EditableKey
  label: string
  kind: FieldKind
  group: FieldGroup
  /** One-line description always shown under the label. */
  summary?: string
  /** Longer explanation, collapsed behind the row's「详情」link. */
  help?: string
  options?: readonly FieldOptionWire[]
  /** `select` only: render the two options as a switch. */
  toggle?: FieldToggleWire
  /**
   * `number` only: display unit next to the input. With `scale`, the input
   * shows `stored / scale` and the panel submits `round(input * scale)`;
   * `min` / `max` / `step` stay in stored units.
   */
  unit?: string
  /** `number` only: stored units per displayed unit (e.g. 1000 for 秒 over ms). */
  scale?: number
  /** `number` only: an empty input clears the override instead of failing. */
  optional?: boolean
  /** Selector is not editable yet (e.g. pick the provider before the model). */
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  /** Input placeholder; for `string-list` it applies to every entry input. */
  placeholder?: string
  /** `string-list` only: most non-empty entries the Host accepts. */
  maxItems?: number
  /** `string-list` only: format every non-empty entry must satisfy. */
  itemFormat?: StringListItemFormat
  /** Render the control below the label across the row width (paths, lists). */
  wide?: boolean
  /**
   * `directory`：给这个 text 字段加一个「选择目录…」按钮，点击后由 Host
   * 打开宿主机系统目录选择框并把绝对路径写回草稿。仅当宿主提供 native
   * 目录选择器时下发；缺省（含 browse 后端）保持纯手写输入。
   */
  browse?: 'directory'
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

/**
 * Values the panel may submit. Empty strings for optional text fields clear the
 * override. A `string-list` field submits its entries as typed (untrimmed,
 * empty inputs included) so Host issue indexes match the rendered inputs; the
 * Host trims entries and drops empty ones before persisting.
 */
export type ConfigValue = string | number | boolean | readonly string[]
export type EditableValues = Partial<Record<EditableKey, ConfigValue>>

/** One credential reference plus its Host-side state (values never cross the wire). */
export interface CredentialRefWire {
  ref: string
  configured: boolean
  /** false when the mounted credentials provider cannot store values. */
  writable: boolean
  /** Where the configured value comes from (e.g. `file`), when the provider reports it. */
  source?: string
}

/**
 * The credential slots the panel may write: the Feishu application pair
 * (resolved on connect) and the analyze API token (resolved per request).
 */
export type CredentialField = 'appId' | 'appSecret' | 'analyzeToken'

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
  /** 连接后的权限自检结果；未连接或自检尚未完成时缺省。 */
  scopeCheck?: ScopeCheckWire
  /** 连接后飞书原生斜杠指令面板的同步结果；未连接或同步尚未完成时缺省。 */
  slashCommandSync?: SlashCommandSyncWire
}

/** One plugin need whose scopes are all missing. */
export interface MissingScopeWire {
  /** Scope names, preferred first; granting any one satisfies the need. */
  scopes: string[]
  /** `required` breaks a core path; `optional` only degrades a feature. */
  level: 'required' | 'optional'
  /** What the plugin loses without it. */
  purpose: string
  /** Developer-console permission page filtered to the preferred scope. */
  consoleUrl: string
}

/** Post-connect scope self-check outcome. */
export type ScopeCheckWire =
  /** Every applicable need is granted. */
  | { state: 'ok'; checkedAt: number }
  /** Some needs are missing; `consoleUrl` opens the console filtered to all of them. */
  | { state: 'missing'; checkedAt: number; missing: MissingScopeWire[]; consoleUrl: string }
  /** The grant list could not be read; `error` carries the Feishu reason. */
  | { state: 'error'; checkedAt: number; error: string }

/** Post-connect native slash-command panel sync outcome. */
export type SlashCommandSyncWire =
  /** The panel lists exactly the registry commands; counts are this sync's writes. */
  | { state: 'ok'; checkedAt: number; created: number; updated: number; removed: number; total: number }
  /** A Feishu call failed; `error` carries the Feishu reason. */
  | { state: 'error'; checkedAt: number; error: string }

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
  credentials: {
    appId: CredentialRefWire
    appSecret: CredentialRefWire
    analyzeToken: CredentialRefWire
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

/** One authorized user `user_id` (global across every authorized group). */
export interface AccessUserWire {
  userId: string
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
  /** `chat_id` for a group request, `user_id` for a user request. */
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
 * reference, the group, user, and wiki whitelists, and the still-pending
 * authorization requests.
 */
export interface AccessWire {
  mode: 'open' | 'guarded'
  admin: {
    /** The effective administrator: configured `adminUserId`, else the app owner. */
    userId?: string
    /** Where `userId` came from: explicit config or the app-owner fallback. */
    source?: 'config' | 'owner'
    /** false while guarded mode would refuse every conversation (fail closed). */
    configured: boolean
    /** Why the app-owner fallback is unavailable, when its lookup failed. */
    ownerLookupError?: string
  }
  /**
   * Whether the persisted whitelists were loaded. While the channel holds no
   * connection the plugin storage domain is closed, so the lists are unknown
   * (not empty) and the panel must not offer mutations.
   */
  loaded: boolean
  groups: AccessGroupWire[]
  users: AccessUserWire[]
  /** Wiki whitelist (`/auth wiki add`): topic owners allowed to use the wiki tools. */
  wikiUsers: AccessUserWire[]
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
  /** 访问与授权卡片的数据（准入模式、管理员、白名单、待处理申请）。 */
  access: AccessWire
}

/**
 * `POST /dsh-channels/pick-directory` response. `canceled` is a normal
 * outcome (the operator dismissed the OS dialog), not an error; `path` is an
 * absolute directory the Host's native chooser returned.
 */
export type PickDirectoryResponse =
  | { ok: true; path: string }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** `PUT /dsh-channels/config` body. */
export interface SaveConfigRequest {
  values: EditableValues
}

/** Per-field validation failure. */
export interface FieldIssueWire {
  key: string
  message: string
  /**
   * `string-list` only: zero-based position of the rejected entry in the
   * submitted array (empty inputs included). Absent for a whole-field issue.
   */
  index?: number
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
  analyzeToken?: string
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
 * - `not-needed`: removed while stopped, or only the analyze API token
 *   changed (it applies to the next request), nothing to reconnect.
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
  { id: 'sessions', label: '会话' },
  { id: 'model', label: '模型' },
  { id: 'attachments', label: '附件与工具' },
  { id: 'access', label: '访问授权' },
  { id: 'wiki', label: '知识库' },
  { id: 'advanced', label: '高级' },
] as const

export type PanelTabId = (typeof PANEL_TABS)[number]['id']

/** Which editable field groups each tab renders, in section order. */
export const TAB_FIELD_GROUPS: Readonly<Record<PanelTabId, readonly FieldGroup[]>> = {
  connection: [],
  sessions: ['trigger', 'workspace', 'cards', 'features'],
  model: ['model'],
  attachments: ['attachments', 'tools', 'limits'],
  access: ['access'],
  wiki: ['wiki'],
  advanced: ['analyze', 'logging'],
}

/** Section heading for one field group inside its tab. */
export const FIELD_GROUP_LABELS: Readonly<Record<FieldGroup, string>> = {
  trigger: '触发',
  workspace: '工作区',
  cards: '话题与卡片',
  features: '飞书侧功能',
  model: '模型',
  attachments: '入站附件',
  tools: '模型可用的飞书工具',
  limits: '限额与超时',
  access: '准入',
  wiki: '知识库工具',
  analyze: '日志分析接口',
  logging: '日志',
}

/** Groups rendered collapsed behind one summary row (rarely changed values). */
export const COLLAPSED_FIELD_GROUPS: readonly FieldGroup[] = ['limits']

/** `unit` of byte-count fields; the panel adds a MiB reading next to them. */
export const BYTES_UNIT = '字节'

/** Display labels for the panel header/cards (kept on the wire so the client owns no copy). */
export const PANEL_COPY = {
  title: '飞书渠道',
  // ---- lifecycle / status -------------------------------------------------
  phaseUnconfigured: '待配置',
  phaseIdle: '未连接',
  phaseConnecting: '连接中',
  phaseConnected: '已连接',
  phaseError: '连接失败',
  statusSummaryConnected: '机器人在线，可以收发消息',
  statusSummaryUnconfigured: '还没有填写飞书应用凭据，插件不会连接飞书',
  statusSummaryIdle: '凭据已就绪，还没有建立连接',
  statusSummaryConnecting: '正在连接飞书…',
  statusSummaryError: '连接飞书失败，请检查凭据与网络后重试',
  uptimePrefix: '运行',
  lastError: '最近一次连接失败',
  checksTitle: '自检',
  scopeCheckOk: '插件需要的飞书权限都已开通',
  scopeCheckMissing: '{n} 项权限未开通',
  scopeCheckMissingRequired: '{n} 项必需权限未开通，相关功能无法使用',
  scopeCheckMissingOptional: '不影响收发消息，只有相关功能不可用。开通后需在开发者后台发布新版本。',
  scopeCheckPublish: '开通后需在开发者后台发布新版本。',
  scopeCheckOpenAll: '全部开通',
  scopeCheckOpenOne: '去开通',
  scopeCheckRequired: '必需',
  scopeCheckError: '无法读取权限开通情况',
  slashCommandSyncTitle: '斜杠指令面板',
  slashCommandSyncOk: '已同步 {total} 条命令，飞书客户端约 5 分钟后刷新',
  slashCommandSyncError: '同步失败，直接输入命令不受影响',
  missingConfig: '缺少配置',
  routeCount: '话题路由',
  liveAgentCount: '活动会话',
  inflightTurnCount: '在途回复',
  botOpenId: 'Bot open_id',
  healthReasons: '健康判定',
  unknownValue: '—',
  connect: '连接飞书',
  connecting: '连接中…',
  // ---- onboarding ---------------------------------------------------------
  onboardingTitle: '开始使用飞书渠道',
  onboardingStep1Title: '创建飞书自建应用',
  onboardingStep1Text: '在 open.feishu.cn/app 创建企业自建应用，开启机器人能力；事件订阅选「长连接」，订阅 im.message.receive_v1。',
  onboardingStep2Title: '填写应用凭据',
  onboardingStep2Text: '把 App ID（cli_ 开头）和 App Secret 填到下方「应用凭据」。',
  onboardingStep3Title: '保存后自动连接',
  onboardingStep3Text: '两项都保存后插件会自动连接，状态变成「已连接」就能在飞书里私聊机器人。',
  // ---- credentials --------------------------------------------------------
  credentialsTitle: '应用凭据',
  credentialsHint: '值只存在本机凭据库，面板不回显。',
  appIdLabel: 'App ID',
  appSecretLabel: 'App Secret',
  credentialStore: '凭据库',
  saveCredentials: '保存凭据',
  savingCredentials: '保存中…',
  credentialSaved: '凭据已保存',
  credentialSavedReconnected: '凭据已保存，飞书已连接',
  credentialSavedPending: '凭据已保存，重启飞书连接后生效',
  credentialSavedUnconfigured: '凭据已保存；还缺少另一项凭据，补齐后会自动连接',
  credentialAutoConnectFailed: '凭据已保存，但自动连接失败',
  credentialRemoved: '已移除存储的凭据',
  credentialRemovedPending: '已移除存储的凭据，重启飞书连接后生效',
  replaceCredential: '更换',
  setCredential: '设置',
  cancel: '取消',
  removeCredential: '移除',
  removingCredential: '移除中…',
  credentialConfigured: '已配置',
  credentialMissing: '未配置',
  credentialReadOnly: '当前凭据存储不可写',
  appIdPlaceholder: '输入 App ID（cli_…）',
  appSecretPlaceholder: '输入 App Secret',
  credentialRemoveConfirm: '确定移除已存储的凭据值？移除后不会回显，需要时须重新填写。',
  // ---- forms --------------------------------------------------------------
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  dirtyCount: '{n} 项未保存',
  dirtyRestart: '，其中 {n} 项需要重连后生效',
  details: '详情',
  expand: '展开',
  collapse: '收起',
  collapsedCount: '{n} 项',
  collapsedClean: '一般不用改',
  collapsedChanged: '{n} 项已在面板修改',
  restartTag: '需重连',
  listAdd: '添加',
  listRemove: '移除',
  listEntry: '第 {n} 项',
  listTooMany: '最多 {max} 项（空输入框不计）',
  listNotArray: '必须是字符串列表',
  listEntryNotString: '必须是字符串',
  browseDirectory: '选择目录…',
  browsingDirectory: '选择中…',
  directoryPicked: '已选择目录',
  directoryPickFailed: '无法打开系统目录选择器',
  saved: '已保存',
  saveInvalid: '请先修正标红的配置项',
  numberInvalid: '请输入数字',
  numberMin: '不得小于 {n}',
  numberMax: '不得大于 {n}',
  modelFootnote: '对之后新建的会话生效。',
  catalogFailed: '模型目录加载失败，已退回手填。',
  catalogLoading: '正在读取宿主机选项…',
  catalogUnavailable: '宿主机未提供可选项，请手填。',
  // ---- restart ------------------------------------------------------------
  restartBanner: '以下配置要重启飞书连接后生效：',
  restartWarning: '重启会断开当前飞书连接并中断进行中的回复，确定现在重启？',
  reconnect: '重启连接',
  reconnecting: '重连中…',
  refresh: '刷新',
  retry: '重试',
  pollFailed: '状态刷新失败',
  connectDone: '已连接飞书',
  reconnectDone: '已重启飞书连接',
  loading: '加载中…',
  loadFailed: '设置面板加载失败',
  // ---- advanced -----------------------------------------------------------
  analyzeTokenLabel: '访问令牌',
  analyzeTokenSummary: '请求头 Authorization: Bearer 的值，保存后立即生效；未配置时接口拒绝所有请求',
  analyzeTokenPlaceholder: '填写新令牌（建议 32 位以上随机串）',
  analyzeTokenSaved: '令牌已保存，下一次请求生效',
  analyzeTokenRemoved: '令牌已移除，接口将拒绝所有请求',
  overlayTitle: 'Web 覆盖',
  overlayPath: '覆盖文件',
  overlayCount: '{n} 项配置由面板覆盖',
  noOverrides: '当前没有面板覆盖的配置',
  overlayPathHelp: '面板保存的配置写在这个 JSON 文件里，优先级高于 profile。可以直接编辑；面板保存会整体重写它。',
  clear: '恢复 profile 配置',
  clearing: '恢复中…',
  clearConfirm: '确定删除所有面板覆盖，恢复为 profile 配置？',
  cleared: '已恢复为 profile 配置',
  // ---- access -------------------------------------------------------------
  debugModeWarning: '调试模式已打开：应用可用范围内的任何人都能和机器人对话。用完请在「访问授权」关闭。',
  accessAdminMissingWarning: '没有可用的管理员，所有对话都会被拒绝。请在下方填写管理员 user_id（私聊机器人发送 /userid 获取）。',
  accessAdminOwnerSummary: '未单独设置，正在使用应用所有者 {id}',
  accessNotLoaded: '飞书连接建立后加载授权列表',
  accessRequestsTitle: '待处理申请',
  accessGroupsTitle: '已授权群',
  accessUsersTitle: '已授权用户',
  accessGroupsEmpty: '还没有授权任何群',
  accessUsersEmpty: '还没有授权任何用户',
  accessGroupChatIdPlaceholder: 'chat_id（oc_…，群里发 /groupid 获取）',
  accessGroupNamePlaceholder: '群名（可选）',
  accessUserIdPlaceholder: 'user_id（私聊机器人发 /userid 获取）',
  accessUserNamePlaceholder: '昵称（可选）',
  accessAddGroup: '添加群',
  accessAddUser: '添加用户',
  accessAdd: '添加',
  accessRemove: '移除',
  accessAllow: '授权',
  accessDeny: '忽略',
  accessWorking: '处理中…',
  accessSourceCommand: '对话命令',
  accessSourceCard: '授权卡',
  accessSourcePanel: '设置面板',
  accessRequestGroup: '申请授权群',
  accessRequestUser: '申请使用',
  accessRequestIn: '在「{group}」',
  accessRequestExpires: '{date} 前有效',
  accessGroupAdded: '已添加群授权',
  accessGroupRemoved: '已移除群授权',
  accessUserAdded: '已添加用户授权',
  accessUserRemoved: '已移除用户授权',
  accessRequestAllowed: '已授权',
  accessRequestDenied: '已忽略',
  // ---- wiki ---------------------------------------------------------------
  wikiUsersTitle: '可使用的人',
  wikiUsersAdminPlus: '管理员 + {n}',
  wikiUsersEmpty: '目前只有管理员发起的话题能用知识库工具',
  wikiUsersHint: '也可以在飞书发 /auth wiki add @用户',
  wikiUserAdded: '已加入知识库白名单',
  wikiUserRemoved: '已移出知识库白名单',
} as const

/**
 * Fill `{name}` placeholders of one `PANEL_COPY` template.
 *
 * @param template - Copy containing `{name}` placeholders.
 * @param values - Replacement per placeholder name.
 * @returns The filled string; unknown placeholders stay as written.
 */
export function fillCopy(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}
