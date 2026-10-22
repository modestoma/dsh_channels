/**
 * Post-connect scope self-check: compares the tenant scopes the Feishu app has
 * been granted (`application.v6.scope.list`) against what the plugin uses, and
 * builds developer-console deep links for the missing ones.
 *
 * Pure module: no I/O. The service fetches the grants and the app-owner
 * lookup outcome, then calls {@link checkScopes}.
 *
 * @module dsh-channels/feishu/scopes
 */

/** One scope row reported by `application.v6.scope.list`. */
export interface ScopeGrant {
  /** Scope name, e.g. `im:message`. */
  readonly name: string
  /** Whether the tenant granted it (`grant_status === 1`). */
  readonly granted: boolean
  /** Identity the scope applies to; absent when Feishu omitted it. */
  readonly type?: 'tenant' | 'user'
}

/** One plugin need, satisfied by any of its scopes. */
export interface ScopeRequirement {
  /** Scope names, preferred first; any granted one satisfies the need. */
  readonly anyOf: readonly string[]
  /** `required` breaks a core path; `optional` only degrades a feature. */
  readonly level: 'required' | 'optional'
  /** What the plugin loses without it (shown in the panel and log). */
  readonly purpose: string
}

/** Facts that decide which requirements apply to the running connection. */
export interface ScopeCheckContext {
  /** Direct messages are accepted (`dmMode: 'open'`). */
  readonly dmEnabled: boolean
  /** Ordinary group messages need an @ mention (`requireMention`). */
  readonly requireMention: boolean
  /**
   * The app-owner lookup failed while it backs the administrator (guarded
   * mode without `adminUserId`).
   */
  readonly ownerLookupFailed: boolean
  /** The native slash-command panel sync is enabled (`slashCommandPanel`). */
  readonly slashCommandPanel: boolean
}

/** A requirement none of whose scopes is granted. */
export interface MissingScope {
  readonly anyOf: readonly string[]
  readonly level: 'required' | 'optional'
  readonly purpose: string
  /** Console permission page filtered to the preferred scope. */
  readonly consoleUrl: string
}

/** Result of one self-check. */
export interface ScopeCheckResult {
  /** Required needs first, then optional ones, each in table order. */
  readonly missing: readonly MissingScope[]
  /** Console permission page filtered to every missing preferred scope. */
  readonly consoleUrl?: string
}

/** `grant_status` value Feishu uses for a granted scope. */
export const SCOPE_GRANTED_STATUS = 1

/** Messaging scopes that need no runtime context to apply. */
const BASE_REQUIREMENTS: readonly ScopeRequirement[] = [
  { anyOf: ['im:message', 'im:message:send_as_bot'], level: 'required', purpose: '以机器人身份发送消息、下载消息附件' },
  { anyOf: ['contact:user.employee_id:readonly'], level: 'required', purpose: '获取用户 user_id；缺失时所有用户消息都会被丢弃' },
  { anyOf: ['im:message:update', 'im:message'], level: 'required', purpose: '流式更新回复卡片' },
  { anyOf: ['im:message.reactions:write_only', 'im:message'], level: 'optional', purpose: '给消息添加/移除处理中表情' },
  { anyOf: ['im:message:readonly', 'im:message'], level: 'optional', purpose: '读取引用消息、话题历史与 feishu_topic_messages' },
  { anyOf: ['im:chat:readonly', 'im:chat'], level: 'optional', purpose: '机器人入群后读取群信息、发送群信息卡' },
]

/** Panel sync needs, applicable while `slashCommandPanel` is on. */
const SLASH_COMMAND_REQUIREMENTS: readonly ScopeRequirement[] = [
  { anyOf: ['application:app_slash_command:read'], level: 'optional', purpose: '读取飞书原生斜杠指令面板，连接后同步插件命令' },
  { anyOf: ['application:app_slash_command:write'], level: 'optional', purpose: '写入飞书原生斜杠指令面板（输入 / 时列出插件命令）' },
]

/** Group receive needs while ordinary group messages require an @ mention. */
const MENTION_GROUP_REQUIREMENTS: readonly ScopeRequirement[] = [
  { anyOf: ['im:message.group_at_msg:readonly', 'im:message.group_msg'], level: 'required', purpose: '接收群聊中 @ 机器人的消息' },
  { anyOf: ['im:message.group_msg'], level: 'optional', purpose: '读取群/话题中未 @ 机器人的历史消息（敏感权限，需管理员审批）' },
]

/** Group receive need while unmentioned group messages are answered (`requireMention: false`). */
const ALL_GROUP_REQUIREMENT: ScopeRequirement = {
  anyOf: ['im:message.group_msg'], level: 'required', purpose: '接收群聊中所有消息（requireMention 已关闭；敏感权限，需管理员审批）',
}

/** Direct-message receive scope, applicable while DMs are accepted. */
const DM_REQUIREMENT: ScopeRequirement = {
  anyOf: ['im:message.p2p_msg:readonly'], level: 'required', purpose: '接收用户发给机器人的私聊消息',
}

/**
 * App-info scope for the owner-as-administrator fallback. Optional: a
 * configured `adminUserId` replaces it. Its exact console name is not
 * documented, so the lookup outcome is authoritative; the names only feed
 * the deep link.
 */
const APP_INFO_REQUIREMENT: ScopeRequirement = {
  anyOf: ['admin:app.info:readonly', 'application:application:self_manage'],
  level: 'optional',
  purpose: '自动把应用所有者设为管理员；不开通时在「访问授权」手动填写管理员 user_id 即可',
}

/**
 * Developer-console permission page for `appId`, searched for `scopes`.
 *
 * @param appId Resolved Feishu app id (`cli_...`).
 * @param scopes Scope names to prefill in the console search box.
 * @returns The `open.feishu.cn` permission-management URL.
 */
export function scopeConsoleUrl(appId: string, scopes: readonly string[]): string {
  const query = new URLSearchParams({ q: scopes.join(','), op_from: 'openapi', token_type: 'tenant' })
  return `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth?${query.toString()}`
}

/**
 * The requirements that apply under `context`, in display order.
 *
 * @param context Runtime facts (DM mode, mention requirement, panel sync, owner-fallback need).
 * @returns Requirement table for this connection.
 */
export function scopeRequirements(context: ScopeCheckContext): readonly ScopeRequirement[] {
  return [
    ...(context.dmEnabled ? [DM_REQUIREMENT] : []),
    ...(context.requireMention ? MENTION_GROUP_REQUIREMENTS : [ALL_GROUP_REQUIREMENT]),
    ...BASE_REQUIREMENTS,
    ...(context.slashCommandPanel ? SLASH_COMMAND_REQUIREMENTS : []),
  ]
}

/**
 * Compare `grants` with the applicable requirements. Only tenant (or untyped)
 * grants count: the plugin always calls with the app identity.
 *
 * @param grants Rows from `application.v6.scope.list`.
 * @param appId Resolved Feishu app id, for the deep links.
 * @param context Runtime facts deciding which requirements apply.
 * @returns Missing needs (required first) and an aggregate console link.
 */
export function checkScopes(grants: readonly ScopeGrant[], appId: string, context: ScopeCheckContext): ScopeCheckResult {
  const granted = new Set(grants.filter(grant => grant.granted && grant.type !== 'user').map(grant => grant.name))
  const unmet = scopeRequirements(context).filter(requirement => !requirement.anyOf.some(scope => granted.has(scope)))
  if (context.ownerLookupFailed) unmet.push(APP_INFO_REQUIREMENT)
  const ordered = [
    ...unmet.filter(requirement => requirement.level === 'required'),
    ...unmet.filter(requirement => requirement.level === 'optional'),
  ]
  const missing = ordered.map((requirement): MissingScope => ({
    anyOf: requirement.anyOf,
    level: requirement.level,
    purpose: requirement.purpose,
    consoleUrl: scopeConsoleUrl(appId, [requirement.anyOf[0]!]),
  }))
  if (missing.length === 0) return { missing }
  return { missing, consoleUrl: scopeConsoleUrl(appId, missing.map(item => item.anyOf[0]!)) }
}
