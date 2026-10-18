/**
 * Web 设置面板的 Host 视图模型：把 `FeishuService` 的运行时事实、覆盖层与
 * 字段描述组装成 wire 数据，并处理保存/清除/重连三个动作。
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
import type { HealthSnapshot } from '../health.ts'
import { prepareWorkspaceBaseDir } from '../workspaces.ts'
import {
  EDITABLE_KEYS,
  PANEL_COPY,
  RESTART_KEYS,
} from './contract.ts'
import type {
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
  PanelConfigWire,
  PanelWire,
  ReadOnlyFieldWire,
  ReconnectResponse,
  SaveConfigResponse,
  SaveCredentialsRequest,
  SaveCredentialsResponse,
} from './contract.ts'
import {
  parseOverlay,
  pickEditable,
} from './overlay.ts'
import type { OverlayLogger, OverlayPatch, OverlayStore } from './overlay.ts'

/** The slice of `FeishuService` the panel needs (structural, easy to fake). */
export interface SettingsTarget {
  isRunning(): boolean
  isRestarting(): boolean
  health(): HealthSnapshot
  startedAtMs(): number | undefined
  uptimeMs(): number | undefined
  startError(): string | undefined
  configSnapshot(): FeishuConfig
  baseConfigSnapshot(): FeishuConfig
  runningConfigSnapshot(): FeishuConfig | undefined
  applyOverlay(overlay: Partial<FeishuConfig>): void
  restart(): Promise<void>
  credentialStates(): Promise<{ appId: CredentialInfo; appSecret: CredentialInfo }>
  setCredential(field: CredentialField, value: string): Promise<void>
  clearCredential(field: CredentialField): Promise<void>
}

/** Presence/source/writability facts returned by the credentials seam. */
export interface CredentialInfo {
  configured: boolean
  writable?: boolean
  source?: string
}

const RESTART_SET = new Set<string>(RESTART_KEYS)

/** Optional text fields: an empty string in the panel clears the override. */
const OPTIONAL_TEXT_KEYS = new Set<EditableKey>(['provider', 'model', 'reasoningEffort', 'agentPreset'])

const BOOLEAN_KEYS = new Set<EditableKey>([
  'requireMention',
  'welcomeOnboarding',
  'allowPermissionSwitch',
  'acceptImages',
])

const SELECT_OPTIONS: Partial<Record<EditableKey, ReadonlyArray<{ value: string; label: string }>>> = {
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
}

/** Panel copy per editable key: label, help, and (for numbers) bounds. */
const FIELD_META: Record<EditableKey, { label: string; help: string; min?: number; max?: number; step?: number; placeholder?: string; wide?: boolean }> = {
  baseDir: {
    label: '工作区根目录（文件落点）',
    help: '模型/工具产生的文件默认写在每个（用户 × 聊天）的工作区里：私聊 <baseDir>/p2p/<open_id>/，群聊 <baseDir>/groups/<chat_id>/<open_id>/。必须是绝对路径（~ 开头按家目录展开），保存时会创建该目录；只影响之后新建立的工作区 —— 已有话题即使 /renew 也沿用原工作区，旧文件不会迁移。',
    placeholder: '/Users/you/.dsh/dsh-channels/workspaces',
    wide: true,
  },
  dmMode: { label: '私聊模式', help: '禁用后私聊消息不再触发会话；群聊与已绑定话题不受影响。' },
  requireMention: { label: '普通群需 @ 机器人', help: '已绑定的主题内始终不需要 @；关闭后普通群的每条消息都会触发。' },
  threadFallback: { label: '话题被拒时的兜底', help: 'degrade 降级为会话级路由；strict 直接让回复失败。' },
  welcomeOnboarding: { label: '首次私聊引导卡', help: '每个私聊会话第一次触达时发送一张命令与用法引导卡，只发一次。' },
  allowPermissionSwitch: { label: '允许飞书侧切换权限预设', help: '安全敏感：开启后话题所有者可用 /permissions 切换沙箱与审批预设。' },
  acceptImages: { label: '接收并转发图片', help: '把飞书图片作为 ImageBlock 转发给模型；需要主机 attachments 服务。' },
  maxImagesPerMessage: { label: '单条消息图片上限', help: '多出的图片忽略；0 表示不转发任何图片。', min: 0, max: 8, step: 1 },
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
  allowPermissionSwitch: 'behavior',
  acceptImages: 'content',
  maxImagesPerMessage: 'content',
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

/** Build the read-only advanced card from the effective config. */
export function readOnlyFields(config: FeishuConfig): ReadOnlyFieldWire[] {
  return [
    { key: 'routeTtlMs', label: '话题路由过期', value: formatDays(config.routeTtlMs), help: '超期话题的后续消息会被明确拒绝，而不是新建 Context-free Session。' },
    { key: 'approvalTimeoutMs', label: '审批卡片等待', value: formatSeconds(config.approvalTimeoutMs) },
    { key: 'questionTimeoutMs', label: '提问卡片等待', value: formatSeconds(config.questionTimeoutMs) },
    { key: 'maxTokens', label: '单次输出上限', value: formatOptional(config.maxTokens, ' tokens'), help: '留空/未设置时使用模型适配器默认值。' },
  ]
}

/** Assemble the status half of the panel payload. */
function buildStatus(target: SettingsTarget, overlayPath: string): ChannelStatusWire {
  const health = target.health()
  const connection = health.connection
  return {
    running: target.isRunning(),
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
    busy: target.isRestarting(),
  }
}

/**
 * Stateful panel facade over one service + one overlay file. All mutations are
 * validated here; the HTTP layer only parses the transport.
 */
export class SettingsSurface {
  constructor(
    private readonly target: SettingsTarget,
    private readonly store: OverlayStore,
    private readonly logger?: OverlayLogger,
  ) {}

  /** Wire status only (used by the client's 5 s poll). */
  async status(): Promise<ChannelStatusWire> {
    return buildStatus(this.target, this.store.file)
  }

  /** Status + editable config with provenance + read-only facts. */
  async panel(): Promise<PanelWire> {
    const base = this.target.baseConfigSnapshot()
    const effective = this.target.configSnapshot()
    const overlay = await this.store.load()
    const running = this.target.runningConfigSnapshot()
    const overriddenKeys = EDITABLE_KEYS.filter(key => overlay[key] !== undefined)
    const restartPendingKeys = this.target.isRunning() && running !== undefined
      ? RESTART_KEYS.filter(key => effective[key] !== running[key])
      : []

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

    return {
      status: buildStatus(this.target, this.store.file),
      config: {
        base: pickEditable(base) as Record<string, ConfigValue | undefined>,
        effective: pickEditable(effective) as Record<string, ConfigValue | undefined>,
        overlay: overlay as EditableValues,
        overriddenKeys,
        restartPendingKeys,
        fields: [...FIELD_DESCRIPTORS],
        readOnly: readOnlyFields(effective),
        credentials,
      },
    }
  }

  /** Validate + persist a partial edit; live fields take effect immediately. */
  async save(values: EditableValues): Promise<SaveConfigResponse> {
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
      raw[key] = value
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
      merged = { ...await this.store.load() }
      for (const key of clearedKeys) delete merged[key]
      Object.assign(merged, parsed.patch)
      await this.store.save(merged)
    } catch (error) {
      return { ok: false, error: `写入覆盖配置失败：${messageOf(error)}` }
    }
    this.target.applyOverlay(merged)
    return { ok: true, panel: await this.panel(), clearedKeys }
  }

  /** Drop every Web override and fall back to the profile config. */
  async clear(): Promise<ClearConfigResponse> {
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
   * Credential values are resolved on connect. When the channel is stopped,
   * retry immediately (nothing to interrupt); when it is running, ask the user
   * to reconnect. A failed retry still reports the save as successful.
   */
  private async finishCredentialChange(kind: 'save' | 'clear'): Promise<SaveCredentialsResponse> {
    if (this.target.isRunning()) {
      return { ok: true, panel: await this.panel(), reconnect: 'pending' }
    }
    if (kind === 'clear') {
      return { ok: true, panel: await this.panel(), reconnect: 'not-needed' }
    }
    try {
      await this.target.restart()
      return { ok: true, panel: await this.panel(), reconnect: 'auto' }
    } catch (error) {
      return {
        ok: true,
        panel: await this.panel(),
        reconnect: 'auto',
        autoReconnectError: messageOf(error),
      }
    }
  }

  /** Close and reopen the Feishu long connection with the latest config. */
  async reconnect(): Promise<ReconnectResponse> {
    try {
      await this.target.restart()
    } catch (error) {
      return { ok: false, error: `重连失败：${messageOf(error)}` }
    }
    return { ok: true, panel: await this.panel() }
  }
}

export { PANEL_COPY }
