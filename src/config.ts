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

export const FEISHU_LOGGER_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type FeishuLoggerLevel = (typeof FEISHU_LOGGER_LEVELS)[number]

/** Same shape as the host credentials seam's `CredentialRef` (shell identifier). */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Default route-table GC threshold: 30 days without activity. */
export const DEFAULT_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** A credential reference: `FEISHU_APP_ID`-style name resolved through ctx.credentials. */
const credentialRefSchema = z.string().regex(
  CREDENTIAL_REF_PATTERN,
  'must be a credential reference name such as FEISHU_APP_ID (resolved through the dsh credentials seam, e.g. $DSH_HOME/.credentials.yaml) — plaintext secrets are not accepted',
)

export const configSchema = z.object({
  /** Feishu app id credential reference (e.g. `FEISHU_APP_ID`). */
  appId: credentialRefSchema,
  /** Feishu app secret credential reference (e.g. `FEISHU_APP_SECRET`). */
  appSecret: credentialRefSchema,
  /** Root directory for per-(user, chat) workspace directories. */
  baseDir: z.string().default('./channels-data'),
  /** LLM provider route for sessions this plugin creates (optional → deployment default). */
  provider: z.string().optional(),
  /** Model id for sessions this plugin creates (optional → deployment default). */
  model: z.string().optional(),
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
   * deleted at startup and on every periodic sweep — a deleted topic's
   * `thread_id` never reappears, so its record is dead weight forever
   * otherwise. Only the plugin's routing entry is removed: the DSH session
   * and workspace stay untouched. `0` disables GC entirely.
   */
  routeTtlMs: z.number().int().min(0).default(DEFAULT_ROUTE_TTL_MS),
})

export type FeishuConfig = z.infer<typeof configSchema>

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
