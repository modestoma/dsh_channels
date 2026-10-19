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
export const RECONNECT_ROUTE = '/dsh-channels/reconnect'
/** 模型/推理档位/预设选择器的宿主目录（provider → model → effort 级联刷新）。 */
export const CATALOG_ROUTE = '/dsh-channels/catalog'
/** 手动执行一次过期工作区清理（POST，无请求体）。 */
export const CLEANUP_ROUTE = '/dsh-channels/cleanup'

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

/** Field groups map one-to-one onto panel cards. */
export type FieldGroup = 'workspace' | 'behavior' | 'content' | 'model' | 'streaming'

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

/** Runtime connection/liveness facts. */
export interface ChannelStatusWire {
  running: boolean
  level: 'healthy' | 'degraded' | 'unhealthy'
  startedAt?: number
  uptimeMs?: number
  connection?: ConnectionWire
  botOpenIdTail?: string
  routeCount: number
  liveAgentCount: number
  inflightTurnCount: number
  /** 最近一次启动失败的原因（成功后清空）。 */
  lastStartError?: string
  /** 健康判定的原因说明（空数组 = 健康）；由 Host 的 health 折叠给出。 */
  reasons: string[]
  /** 面板显示的所有键值对来源版本。 */
  version: string
  /** Web 覆盖文件绝对路径（用户可直接编辑）。 */
  overlayPath: string
  /** 正在重连时为 true，此时面板按钮禁用。 */
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

/** `GET /dsh-channels/panel` payload. */
export interface PanelWire {
  status: ChannelStatusWire
  config: PanelConfigWire
  cleanup: CleanupPreviewWire
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
  | { ok: false; error: string }

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

/** How a saved credential reached the running channel. */
export type CredentialReconnectState = 'auto' | 'pending' | 'not-needed'

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

/** Display labels for the panel header/cards (kept on the wire so the client owns no copy). */
export const PANEL_COPY = {
  title: '飞书渠道',
  description: '飞书长连接状态、应用凭据与常用配置。凭据写入 DSH 凭据库且不回显；标注「需重连」的项需重启飞书连接生效。',
  statusCard: '连接状态',
  credentialsCard: '飞书应用凭据',
  modelCard: '模型与推理',
  modelCardHelp: '模型服务商、模型 id、推理档位与新会话的 Agent 预设。下拉选项来自宿主机实时目录；保存后对新会话生效。',
  configCard: '常用配置',
  advancedCard: '只读与高级信息',
  appIdLabel: '飞书 App ID',
  appSecretLabel: '飞书 App Secret',
  credentialsHelp: '值通过 DSH 凭据服务写入本机凭据库；面板只显示是否已配置，永不回显已存值。留空表示保持当前值。',
  credentialsRef: '凭据引用',
  saveCredentials: '保存凭据',
  savingCredentials: '保存中…',
  credentialSaved: '凭据已保存',
  credentialSavedReconnected: '凭据已保存，已自动重连飞书通道',
  credentialSavedPending: '凭据已保存，重启飞书连接后生效',
  credentialRemoved: '已移除存储的凭据',
  credentialRemovedPending: '已移除存储的凭据，重启飞书连接后生效',
  removeCredential: '移除已存值',
  removingCredential: '移除中…',
  credentialConfigured: '已配置',
  credentialMissing: '未配置',
  credentialReadOnly: '当前凭据存储不可写',
  appIdPlaceholder: '输入 App ID（cli_…）',
  appSecretPlaceholder: '输入 App Secret',
  save: '保存配置',
  saveAll: '保存全部配置',
  saveModel: '保存模型配置',
  modelActionsHint: '只保存模型与推理字段',
  saving: '保存中…',
  clear: '清除 Web 覆盖',
  clearing: '清除中…',
  reconnect: '重启飞书连接',
  reconnecting: '重连中…',
  refresh: '刷新状态',
  retry: '重试',
  loading: '加载中…',
  loadFailed: '设置面板加载失败',
  saved: '已保存',
  savedModel: '模型配置已保存',
  cleared: '已清除 Web 覆盖，恢复为 profile 配置',
  catalogFailed: '模型目录加载失败，已退回手填。',
  catalogLoading: '正在读取宿主机选项…',
  catalogUnavailable: '宿主机未提供可选项，请手填。',
  noOverrides: '当前没有 Web 覆盖',
  overridden: 'Web 覆盖',
  inherited: '继承 profile',
  restartTag: '需重连',
  restartBanner: '以下配置需重启飞书连接后生效：',
  restartWarning: '重启会断开当前飞书长连接并中断进行中的回复，请确认空闲时操作。',
  lastError: '最近一次启动失败',
  notRunning: '未运行',
  version: '插件版本',
  overlayPath: '覆盖文件',
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
  cleanupDisabledOff: '保留策略为「关闭」：请先在「常用配置 → 工作区与文件」中选择保留天数。',
  cleanupDisabledEmpty: '没有超过保留期的过期工作区。',
  cleanupPreviewFailed: '无法读取清理预览',
  cleanupDone: '清理完成',
  cleanupFailed: '清理失败',
  cleanupDeleted: '已删除工作区',
  cleanupRetired: '已清理话题路由',
  cleanupFreed: '释放空间',
  cleanupFailures: '以下工作区未能删除：',
} as const
