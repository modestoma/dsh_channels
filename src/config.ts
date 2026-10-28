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
import { FEISHU_USER_ID_PATTERN } from './domain.ts'
import { parseWikiRootLink, WIKI_ROOT_LINK_ERRORS } from './feishu/wiki/links.ts'

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

/** Backends for inbound attachment storage, selected by `attachmentStore`. */
export const ATTACHMENT_STORE_MODES = ['native', 'archive'] as const
export type AttachmentStoreMode = (typeof ATTACHMENT_STORE_MODES)[number]

/** Default per-call attachment count of `feishu_attachment_fetch`. */
export const DEFAULT_ATTACHMENT_FETCH_MAX_RESOURCES = 10

/** Default per-call total download budget of `feishu_attachment_fetch` (100 MiB). */
export const DEFAULT_ATTACHMENT_FETCH_MAX_BYTES = 100 * 1024 * 1024

/** Default whole-call timeout of `feishu_attachment_fetch` (120 s). */
export const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 120_000

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms, about 24.8 days); longer delays fire at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Default per-image byte cap for trigger-message prefetch (20 MiB). */
export const DEFAULT_PREFETCH_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** Default total byte budget for one trigger-message image prefetch (50 MiB). */
export const DEFAULT_PREFETCH_TOTAL_MAX_BYTES = 50 * 1024 * 1024

/** Default short timeout for one trigger-message image prefetch (10 s). */
export const DEFAULT_PREFETCH_TIMEOUT_MS = 10_000

/**
 * Default number of recent topic messages attached to a new Session's first
 * turn (0 disables the history bootstrap). Mirrors
 * `HISTORY_BOOTSTRAP_DEFAULT` in `feishu/message-read.ts`.
 */
export const DEFAULT_HISTORY_BOOTSTRAP_LIMIT = 10

/** Hard cap of the first-turn history bootstrap. */
export const MAX_HISTORY_BOOTSTRAP_LIMIT = 20

/** Default whole-call timeout of `feishu_topic_messages` (20 s). */
export const DEFAULT_TOPIC_MESSAGES_TIMEOUT_MS = 20_000

/**
 * Default budget of one passive prompt-enrichment message read (quoted excerpt
 * / first-turn topic history). Kept short: the turn must not wait long for an
 * optional context block.
 */
export const DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS = 3_000

/** Conventional credential reference holding the log-platform analyze API bearer token. */
export const DEFAULT_ANALYZE_TOKEN_REF = 'DSH_CHANNELS_ANALYZE_TOKEN'

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
   * Per-topic working-directory isolation inside one user workspace.
   *
   * - `auto` (default): use a Git worktree per topic when the user workspace
   *   is a Git repository (the workspace directory contains `.git`), otherwise
   *   a plain subdirectory.
   * - `subdir`: always a plain subdirectory (no Git requirement, no duplicated
   *   checkouts).
   * - `worktree`: always try a Git worktree; when the workspace is not a Git
   *   repository, the `worktrees` service is unavailable, or creation is
   *   denied, log a warning and fall back to a subdirectory.
   *
   * The workspace itself stays the Session header cwd either way, so Sessions
   * remain grouped under the user's project; only the effective working
   * directory changes. See `docs/workspace-isolation-design.md`.
   */
  topicIsolation: z.enum(['auto', 'subdir', 'worktree']).default('auto'),
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
   * Accept inbound Feishu images, files, and merged-forward chat records.
   *
   * With the native backend (default) images of the triggering message are
   * prefetched into the DSH native attachment library and files stay lazy
   * behind a prompt manifest; with the archive backend the resources are saved
   * below `<workspace>/attachments/` before the turn, exactly like the legacy
   * pipeline. Disabled keeps attachment messages inert (no save, no turn, no
   * manifest rows).
   */
  acceptAttachments: z.boolean().default(true),
  /**
   * Backend for inbound Feishu images and files.
   *
   * - `native` (default): store into the DSH native attachment library
   *   (`ctx.attachments`) as durable `ImageBlock`/`FileBlock` references; if
   *   the host does not mount that service, the storage layer falls back to
   *   `archive` for that deployment.
   * - `archive`: legacy behavior — write the resources into the topic
   *   workspace `attachments/` directory through the existing intake.
   *
   * Admission consumes this switch through the backend-selecting inbound
   * store: an explicit `archive` always uses the legacy download path, and a
   * `native` deployment without the mounted host service degrades to the same
   * legacy path (see `effectiveAttachmentMode`).
   */
  attachmentStore: z.enum(ATTACHMENT_STORE_MODES).default('native'),
  /**
   * Prefetch images attached to the triggering message into the first model
   * turn (native attachment backend only). The session, topic, and streaming
   * card are already visible before the prefetch starts; the turn only waits
   * for the (short, bounded) image download, never for file bytes. Failed,
   * oversized, or timed-out images degrade to a manifest row that the model
   * can fetch with `feishu_attachment_fetch`. Set `false` to keep every
   * attachment lazy (images then need the tool as well).
   */
  prefetchImages: z.boolean().default(true),
  /**
   * Largest single image the trigger-message prefetch buffers in memory before
   * refusing it (default 20 MiB). A refused image stays in the manifest and
   * is fetched on demand.
   */
  prefetchImageMaxBytes: z.number().int().min(1).max(200 * 1024 * 1024)
    .default(DEFAULT_PREFETCH_IMAGE_MAX_BYTES),
  /**
   * Total byte budget of one trigger-message image prefetch (default 50 MiB).
   * Once exhausted, the remaining images degrade to the manifest.
   */
  prefetchTotalMaxBytes: z.number().int().min(1).max(1024 * 1024 * 1024)
    .default(DEFAULT_PREFETCH_TOTAL_MAX_BYTES),
  /**
   * Short whole-prefetch timeout (default 10 s). On expiry the already-loaded
   * images stay in the prompt and the rest degrade to the manifest, so a slow
   * image download never blocks the turn for long.
   */
  prefetchTimeoutMs: z.number().int().min(100).max(120_000).default(DEFAULT_PREFETCH_TIMEOUT_MS),
  /**
   * Number of recent messages of the current topic automatically attached to
   * the FIRST turn of a new Session (decision D1: the model should see the
   * discussion before @ without asking). The `<feishu_history>` block is
   * bounded and truncated with an explicit marker and each line carries the
   * message_id needed to fetch a named attachment; older messages remain
   * reachable through the `feishu_topic_messages` tool. `0` disables the
   * bootstrap entirely. Reads use a short (~3 s) prompt-enrichment budget and a
   * failure (missing scope, p2p history unavailable, channel down) degrades
   * silently: the turn still runs.
   */
  historyBootstrapLimit: z.number().int().min(0).max(MAX_HISTORY_BOOTSTRAP_LIMIT)
    .default(DEFAULT_HISTORY_BOOTSTRAP_LIMIT),
  /**
   * Whole-read budget (milliseconds) of the passive prompt enrichment: the
   * quoted-message excerpt and the first-turn topic history. Deliberately short
   * (default 3 s) and independent from `feishuTools.topicMessagesTimeoutMs`:
   * on expiry the block is omitted and the turn runs. Model-initiated reads
   * through `feishu_topic_messages` use the tool timeout instead.
   */
  promptContextTimeoutMs: z.number().int().min(100).max(10_000)
    .default(DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS),
  /**
   * Model-facing Feishu tools.
   *
   * - `attachmentFetch` (default on): register `feishu_attachment_fetch` in
   *   channel sessions so the model can fetch images/files of a known message
   *   on demand. Registration is skipped (with one warning) on deployments
   *   without the host `tools` / `attachments` services. Turning it off also
   *   keeps inbound attachments on the archive backend: lazy native files
   *   would be unreachable without the tool, so admission downloads them to
   *   the workspace instead (see `effectiveAttachmentMode`).
   * - `attachmentFetchMaxResources`: maximum attachments one tool call may
   *   fetch (1–50). A message with more attachments is refused with a readable
   *   reason so the model can retry per `file_key`.
   * - `attachmentFetchMaxBytes`: total download budget of one tool call
   *   (default 100 MiB, no upper bound). Files stream to the native attachment
   *   library, so the limit is enforced while streaming rather than buffered
   *   first, and multi-GiB files need only disk space.
   * - `attachmentFetchTimeoutMs`: whole-call timeout (default 120 s, at most
   *   {@link MAX_TIMER_DELAY_MS}). On expiry the in-flight download is
   *   cancelled and reported per attachment.
   * - `topicMessages` (default on): register `feishu_topic_messages` in
   *   channel sessions so the model can read the quoted message / earlier
   *   topic messages on demand and authorize their attachments for fetch.
   *   Reads require the Feishu message-read scopes; a missing scope degrades to
   *   a readable tool failure and never fails the turn. This switch only
   *   controls the model-facing tool: the passive `<feishu_quote>` /
   *   `<feishu_history>` prompt excerpts stay enabled (they are bounded and
   *   degrade silently) and are configured by `historyBootstrapLimit`. On the
   *   archive backend the tool is still mounted for history text, while its
   *   description states that `feishu_attachment_fetch` is unavailable.
   * - `topicMessagesTimeoutMs`: whole-call timeout of one model-initiated
   *   topic read (default 20 s). Passive prompt excerpts use a separate short
   *   (~3 s) budget and never wait this long.
   * - `sendFile` (default on): register `feishu_send_file` in channel sessions
   *   so the model can send an image or file from the topic's working
   *   directory back to the current conversation. Needs the Feishu
   *   `im:resource` (or `im:resource:upload`) scope; without it a call returns
   *   a readable failure and the turn continues.
   *
   * - `wikiRead` (default off): register `feishu_wiki_list`,
   *   `feishu_wiki_read`, `feishu_wiki_sheet_read`, and
   *   `feishu_wiki_base_read` so the model can browse the wiki nodes under
   *   `wikiRoots` and read docx documents, spreadsheets, and Bases there.
   *   Needs `wiki:wiki` (or `wiki:wiki:readonly`), `docx:document` (or
   *   `docx:document:readonly`), `sheets:spreadsheet:read`, and
   *   `base:table:read` + `base:field:read` + `base:record:read` (the
   *   classic `sheets:spreadsheet` / `bitable:app` grants do not apply).
   * - `wikiWrite` (default off): register `feishu_wiki_create`,
   *   `feishu_wiki_edit`, `feishu_wiki_sheet_edit`, and
   *   `feishu_wiki_base_edit` so the model can create docx documents,
   *   spreadsheets, and Bases under `wikiRoots`, edit documents and
   *   spreadsheets this app owns, and change records of Bases this app owns
   *   (other Bases accept new records only). Needs `wiki:wiki`,
   *   `docx:document`, `sheets:spreadsheet:write_only`, and
   *   `base:record:create` / `base:record:update` / `base:record:delete`,
   *   plus the read scopes above.
   *
   * The wiki tools act with the app identity and are mounted only while
   * `wikiRoots` is non-empty. Each call is limited to topics whose owner is
   * the administrator or on the wiki whitelist (`/auth wiki add`); opening a
   * document, creating one, and editing one each need the topic owner's
   * consent on an authorization card (a read consent lasts for the topic).
   *
   * The Web panel/metrics ship with `panel_docs_release`.
   */
  feishuTools: z.object({
    attachmentFetch: z.boolean().default(true),
    attachmentFetchMaxResources: z.number().int().min(1).max(50)
      .default(DEFAULT_ATTACHMENT_FETCH_MAX_RESOURCES),
    attachmentFetchMaxBytes: z.number().int().min(1)
      .default(DEFAULT_ATTACHMENT_FETCH_MAX_BYTES),
    attachmentFetchTimeoutMs: z.number().int().min(1_000).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS),
    topicMessages: z.boolean().default(true),
    topicMessagesTimeoutMs: z.number().int().min(1_000).max(120_000)
      .default(DEFAULT_TOPIC_MESSAGES_TIMEOUT_MS),
    sendFile: z.boolean().default(true),
    wikiRead: z.boolean().default(false),
    wikiWrite: z.boolean().default(false),
  }).default({
    attachmentFetch: true,
    attachmentFetchMaxResources: DEFAULT_ATTACHMENT_FETCH_MAX_RESOURCES,
    attachmentFetchMaxBytes: DEFAULT_ATTACHMENT_FETCH_MAX_BYTES,
    attachmentFetchTimeoutMs: DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS,
    topicMessages: true,
    topicMessagesTimeoutMs: DEFAULT_TOPIC_MESSAGES_TIMEOUT_MS,
    sendFile: true,
    wikiRead: false,
    wikiWrite: false,
  }),
  /**
   * Wiki (知识库) locations the wiki tools may touch: whole spaces
   * (`https://<tenant>.feishu.cn/wiki/space/<space_id>`) or single nodes with
   * everything below them (`https://<tenant>.feishu.cn/wiki/<node_token>`).
   * Browsing, reading, creating, and editing outside these roots fail. Empty
   * (default) mounts no wiki tool even when `feishuTools.wikiRead`/`wikiWrite`
   * is on.
   */
  wikiRoots: z.array(z.string().trim().superRefine((link, issue) => {
    const parsed = parseWikiRootLink(link)
    if (!parsed.ok) issue.addIssue({ code: 'custom', message: WIKI_ROOT_LINK_ERRORS[parsed.error] })
  })).max(20).default([]),
  /**
   * Send a one-time onboarding card on the first private message of a chat
   * (facts + command cheat sheet). Persisted per chat; never repeats.
   */
  welcomeOnboarding: z.boolean().default(true),
  /**
   * Sync the command registry to Feishu's native `/` panel on every connect
   * (needs the `application:app_slash_command:read`/`write` scopes). Off by
   * default: some tenants forbid apps from adding slash commands. When off,
   * the plugin neither reads nor writes the panel.
   */
  slashCommandPanel: z.boolean().default(false),
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
   *   private chats (plus whitelisted users when `dmAllowWhitelist` is on),
   *   and a group conversation additionally requires the group to be
   *   authorized and the sender to be the administrator or an explicitly
   *   authorized user.
   * - `open`: legacy behavior — any user inside the app's availability scope
   *   can start a conversation. Debug/compatibility only; unsafe.
   */
  accessMode: z.enum(['open', 'guarded']).default('guarded'),
  /**
   * In `guarded` mode, also admit users on the global user whitelist
   * (`/auth user`) in private chats. Off by default: private chats stay
   * administrator-only. Each private-chat user already has an own workspace.
   */
  dmAllowWhitelist: z.boolean().default(false),
  /**
   * The unique administrator's Feishu `user_id`. Set it in the Web
   * settings panel (or the profile config). Get it by sending `/userid` to the
   * bot in a private chat. When unset, the Feishu app owner (looked up via
   * `application.v6.application.get` at connect; needs an app-info read scope)
   * is the administrator. While `accessMode` is `guarded` and neither is
   * available, every conversation is refused (fail closed); `/userid` and a
   * fixed notice stay available so the deployment can be bootstrapped.
   */
  adminUserId: z.string().regex(
    FEISHU_USER_ID_PATTERN,
    'must be a Feishu user_id, not an open_id (send /userid to the bot in a private chat to see it)',
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
  /**
   * Switch for the log-platform analyze API (`POST /api/dsh-channels.logalyze`
   * on the DSH Web server). Off (default) answers 404; read per request, so
   * toggling it needs no reconnect. Needs a host with a Web server.
   */
  analyzeEnabled: z.boolean().default(false),
  /**
   * Credential reference holding the analyze API bearer token (defaults to
   * `DSH_CHANNELS_ANALYZE_TOKEN`). Resolved per request, so rotating the value
   * applies to the next request; an unresolvable token refuses every request.
   */
  analyzeToken: credentialRefSchema.default(DEFAULT_ANALYZE_TOKEN_REF),
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
