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
export const RECONNECT_ROUTE = '/dsh-channels/reconnect'

/**
 * 可由 Web 面板覆盖的配置项。全部是 `src/config.ts` 里已存在的字段；
 * 覆盖值写进 `$DSH_HOME/dsh-channels/settings.json`，优先级高于 profile
 * 的 `cordis.patch.yml`（见 README「Web 设置面板」）。
 *
 * 刻意不包含 `appId` / `appSecret`（凭据引用，改动语义是重连/重新解析凭据，
 * 留在 profile 文件里编辑）与 `baseDir`（已有工作区路径不可迁移）。
 */
export const EDITABLE_KEYS = [
  // 行为
  'dmMode',
  'requireMention',
  'threadFallback',
  'welcomeOnboarding',
  'allowPermissionSwitch',
  // 内容
  'acceptImages',
  'maxImagesPerMessage',
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
export type FieldGroup = 'behavior' | 'content' | 'model' | 'streaming'

/** One editable row, fully described by the Host so the client stays schema-free. */
export interface EditableFieldWire {
  key: EditableKey
  label: string
  kind: FieldKind
  group: FieldGroup
  help?: string
  options?: ReadonlyArray<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** 保存后需重连飞书通道才生效。 */
  restartRequired: boolean
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

/** One credential reference plus whether the Host can currently resolve it. */
export interface CredentialRefWire {
  ref: string
  configured: boolean
}

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
}

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

/** Display labels for the panel header/cards (kept on the wire so the client owns no copy). */
export const PANEL_COPY = {
  title: '飞书渠道',
  description: '飞书长连接状态与常用配置。改动保存后写入本机覆盖文件；标注「需重连」的项需重启飞书连接生效。',
  statusCard: '连接状态',
  configCard: '常用配置',
  advancedCard: '只读与高级信息',
  save: '保存配置',
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
  cleared: '已清除 Web 覆盖，恢复为 profile 配置',
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
} as const
