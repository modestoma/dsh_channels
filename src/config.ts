/**
 * Plugin configuration: schema, defaults, and credential-reference validation.
 *
 * `appId` / `appSecret` are NOT secrets themselves — they are credential
 * *references* (POSIX shell identifiers such as `FEISHU_APP_ID`), resolved at
 * startup through the host's `ctx.credentials` seam, which layers
 * `$DSH_HOME/.credentials.yaml` (the managed, writable store) between the
 * process environment and `.env` fallbacks — the same seam the DeepSeek
 * adapter uses for `DEEPSEEK_API_KEY`. Secrets therefore never sit in the
 * composition file.
 *
 * @module dsh-channels/config
 */

import { z } from 'zod'
import { WORKSPACE_RETENTION_VALUES } from './cleanup.ts'

export const FEISHU_LOGGER_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type FeishuLoggerLevel = (typeof FEISHU_LOGGER_LEVELS)[number]

/** Same shape as the host credentials seam's `CredentialRef` (shell identifier). */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Conventional credential-reference names used when the loader passes no config. */
export const DEFAULT_APP_ID_REF = 'FEISHU_APP_ID'
export const DEFAULT_APP_SECRET_REF = 'FEISHU_APP_SECRET'

/** Default route-table GC threshold: 30 days without activity. */
export const DEFAULT_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Default HITL approval decision window: 5 minutes per question. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** Default structured-question window: 5 minutes per `ask_user_question` call. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000

/** A credential reference: `FEISHU_APP_ID`-style name resolved through ctx.credentials. */
const credentialRefSchema = z.string().regex(
  CREDENTIAL_REF_PATTERN,
  'must be a credential reference name such as FEISHU_APP_ID (resolved through the dsh credentials seam, e.g. $DSH_HOME/.credentials.yaml) — plaintext secrets are not accepted',
)

export const configSchema = z.object({
  /** Feishu app id credential reference (defaults to `FEISHU_APP_ID`). */
  appId: credentialRefSchema.default(DEFAULT_APP_ID_REF),
  /** Feishu app secret credential reference (defaults to `FEISHU_APP_SECRET`). */
  appSecret: credentialRefSchema.default(DEFAULT_APP_SECRET_REF),
  /**
   * Root directory for per-(user, chat) workspace directories — the filesystem
   * root where files produced by channel sessions land. Read per session
   * establishment, so editing it only affects sessions created afterwards
   * (existing workspaces are never migrated). The Web settings panel may
   * override it, but only with an absolute path (`~` expanded) — the relative
   * default below is kept for profile-level compatibility and resolves
   * against the host process cwd.
   */
  baseDir: z.string().min(1).default('./channels-data'),
  /**
   * Optional path of the Web settings overlay (default
   * `$DSH_HOME/dsh-channels/settings.json`). The Web panel writes only
   * editable fields there; this path is for embedded hosts, tests, or users
   * who want multiple instances with different overlays.
   */
  settingsFile: z.string().min(1).optional(),
  /** LLM provider route for sessions this plugin creates (optional → deployment default). */
  provider: z.string().optional(),
  /** Model id for sessions this plugin creates (optional → deployment default). */
  model: z.string().optional(),
  /** Exact model-advertised reasoning-effort id (optional → adapter/provider default). */
  reasoningEffort: z.string().min(1).optional(),
  /** Output-token cap per model request (optional → adapter default). */
  maxTokens: z.number().int().positive().optional(),
  /**
   * Agent preset id sessions this plugin creates are composed from
   * (optional → the roster default, e.g. `standard`). In web-profile
   * deployments the model-facing tools exist only inside agent presets, so
   * leaving this unset mounts the default; name a leaner preset (e.g. one
   * with only bash/fs) to restrict what the bot can do.
   */
  agentPreset: z.string().optional(),
  /** Streaming card refresh interval in milliseconds. */
  refreshMs: z.number().int().min(200).max(10_000).default(500),
  /**
   * Keep-alive interval for the card's activity status line (tool calls,
   * subagent / workflow progress). While a turn produces no text deltas, the
   * line's elapsed counter is re-rendered at this cadence so the card never
   * sits silently. Min 1 s keeps Feishu card-update traffic modest.
   */
  statusRefreshMs: z.number().int().min(1_000).max(60_000).default(5_000),
  /** Accept p2p (private) chats. */
  dmMode: z.enum(['open', 'disabled']).default('open'),
  /**
   * In normal (non-topic) groups, require an @-mention of the bot to start a
   * session. Messages inside a topic the bot already owns never require a
   * mention. Disable to answer every group message.
   */
  requireMention: z.boolean().default(true),
  /** SDK logger level. */
  loggerLevel: z.enum(FEISHU_LOGGER_LEVELS).default('info'),
  /**
   * Reply-in-thread fallbacks. `degrade` (default) falls back to a chat-scoped
   * conversation when Feishu refuses a topic (p2p / topic-less groups);
   * `strict` fails the reply instead.
   */
  threadFallback: z.enum(['degrade', 'strict']).default('degrade'),
  /**
   * Route-table GC threshold. Route records (and stale in-flight repair
   * snapshots) whose last activity is older than this many milliseconds are
   * retired at startup and on every periodic sweep. Real thread routes leave a
   * minimal persistent tombstone, so a later message in the visibly old topic
   * is rejected instead of silently creating a context-free Session. Degraded
   * chat-scoped routes are deleted normally. The DSH session and workspace
   * stay untouched. `0` disables route retirement entirely.
   */
  routeTtlMs: z.number().int().min(0).default(DEFAULT_ROUTE_TTL_MS),
  /**
   * HITL approval decision window: how long one approval decision card waits
   * for an 允许/拒绝 click before failing closed (`rejected`; the card is
   * patched to 已超时). The pending turn is blocked while the question is
   * open, so the window trades user think-time against agent stall time.
   */
  approvalTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(DEFAULT_APPROVAL_TIMEOUT_MS),
  /**
   * Accept inbound Feishu images, files, and merged-forward chat records and
   * save them below `<workspace>/attachments/`. Nothing is forwarded to the
   * model automatically: the Agent reads whichever attachment the
   * conversation needs with its ordinary filesystem tools. Disabled keeps
   * attachment messages inert (no save, no turn).
   */
  acceptAttachments: z.boolean().default(true),
  /**
   * Delete the workspace directories of stale conversations. `off` (default)
   * never deletes; `7d`/`30d`/`90d`/`180d` remove plugin-created workspaces
   * whose last activity is older than the threshold. The managed Web panel
   * exposes this as a select, previews the candidates, and can run one
   * cleanup manually. DSH Session logs are never deleted.
   */
  workspaceRetention: z.enum(WORKSPACE_RETENTION_VALUES).default('off'),
  /**
   * Run the workspace-retention cleanup at startup and once per day. Off by
   * default: deletion is irreversible, so it stays an explicit opt-in even
   * when a retention threshold is configured.
   */
  workspaceRetentionAuto: z.boolean().default(false),
  /**
   * Send a one-time onboarding card on the first private message of a chat
   * (facts + command cheat sheet). Persisted per chat; never repeats.
   */
  welcomeOnboarding: z.boolean().default(true),
  /**
   * Allow `/permissions <name>` to switch this Session's sandbox + approval
   * preset from Feishu. Read-only `/permissions` always works; switching is
   * security-sensitive (it can widen the sandbox), so it is off by default.
   */
  allowPermissionSwitch: z.boolean().default(false),
  /**
   * Admission policy for inbound Feishu traffic.
   *
   * - `guarded` (default): only the configured administrator can talk in
   *   private chats, and a group conversation additionally requires the group
   *   to be authorized and the sender to be the administrator or an explicitly
   *   authorized user.
   * - `open`: legacy behavior — any user inside the app's availability scope
   *   can start a conversation. Debug/compatibility only; unsafe.
   */
  accessMode: z.enum(['open', 'guarded']).default('guarded'),
  /**
   * The unique administrator's Feishu open_id (`ou_...`). Set it in the Web
   * settings panel (or the profile config). Get it by sending `/userid` to the
   * bot in a private chat. While `accessMode` is `guarded` and this is unset,
   * every conversation is refused (fail closed); `/userid` and a fixed notice
   * stay available so the deployment can be bootstrapped.
   */
  adminOpenId: z.string().regex(
    /^ou_[A-Za-z0-9_-]+$/,
    'must be a Feishu open_id such as ou_xxx (send /userid to the bot in a private chat to see it)',
  ).optional(),
  /**
   * Lifetime of one pending authorization request and of the DM card that asks
   * the administrator to approve a group or a user. Expired requests stay in
   * the store as an audit trail but can no longer be decided.
   */
  authRequestTtlDays: z.number().int().min(1).max(30).default(7),
  /**
   * Structured-question decision window for the model's `ask_user_question`
   * tool (`user-questions/request`). A blocking ask that gets no answer in
   * this window fails closed with an explicit error; a host *timed* wait owns
   * its own deadline and is left to the host signal instead.
   */
  questionTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(DEFAULT_QUESTION_TIMEOUT_MS),
})

export type FeishuConfig = z.infer<typeof configSchema>

/**
 * DSH loader-facing schema. The bundle patch inserts this plugin without a
 * `config` object; the loader validates that row with `undefined` before the
 * user's patch layer supplies values. Accept that absence and fill the same
 * defaults as {@link resolveConfig}, so enabling the plugin from the Web UI
 * cannot fail with "expected object, received undefined".
 */
export const pluginConfigSchema = configSchema.prefault({})

/**
 * Validate the raw loader config. Values stay credential *references*; the
 * secrets themselves resolve through `ctx.credentials` at startup.
 * @param raw - the config object the cordis loader passed (may be undefined).
 * @returns the validated config.
 */
export function resolveConfig(raw: unknown): FeishuConfig {
  const parsed = configSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`dsh-channels: invalid configuration:\n${details}`)
  }
  return parsed.data
}
