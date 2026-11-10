/**
 * Types of the `feishuTopics` service: another DSH plugin starts a Feishu
 * group topic Session from an external trigger.
 *
 * One launch posts a root card into a group the bot is in, opens a topic below
 * it, creates the Session in the topic's own workspace under the group's
 * directory below the channel's `baseDir`, and streams the first turn (the
 * prompt, verbatim) in that topic. The root card's status tag follows the
 * first turn (进行中 → 已完成 / 已停止 / 失败) and turns 已中断 when DSH
 * restarts before it settles. The requester is a Feishu user or an external
 * requester without a Feishu account (see {@link TopicRequester}). Anyone
 * with chat access in the group may
 * continue the topic; the group's permission switches (set in the channel's
 * settings panel) gate its knowledge-base and code-write tools.
 *
 * This module has no runtime exports and is not part of the package exports:
 * a consumer declares the subset it calls in its own code, looks the service
 * up per call with `ctx.get('feishuTopics')` (absent while dsh-channels is not
 * loaded or reloading), and checks {@link FeishuTopicService.version} before
 * calling.
 *
 * @module dsh-channels/topics/contract
 */

/** Name the service is provided under (`ctx.get('feishuTopics')`). */
export type FeishuTopicsServiceName = 'feishuTopics'

/**
 * Version of this contract. It changes only when a change would make an older
 * consumer misbehave; a consumer refuses a provider whose version it does not
 * know. Version 2 removed `TopicLaunchSpec.workspace`: the topic's workspace
 * is derived from the group. Version 3 replaced `TopicLaunchSpec.requesterUserId`
 * with {@link TopicLaunchSpec.requester}.
 */
export type FeishuTopicsVersion = 3

/** One run of the root card's lead sentence. */
export interface TopicCardText {
  /** Plain text; Markdown characters are shown literally. */
  readonly text: string
  /** Shown in bold. */
  readonly bold?: boolean
}

/** One linked row of the root card's table. */
export interface TopicCardLink {
  /** Row label. */
  readonly name: string
  /** `http(s)` address opened by the row's link. */
  readonly url: string
}

/** What the root card shows besides its status. */
export interface TopicRootCard {
  /** Header title. */
  readonly title: string
  /**
   * Word naming the work in the status texts, e.g. `分析` gives the tag
   * `分析中` and the footer `分析已完成，结果见话题…`.
   */
  readonly taskName: string
  /** Lead sentence, shown after the requester (an @-mention, or the external requester's text). */
  readonly lead: readonly TopicCardText[]
  /** Optional table of links (at most 50 rows). */
  readonly links?: {
    /** Header of the label column. */
    readonly nameHeader: string
    /** Header of the link column. */
    readonly linkHeader: string
    readonly rows: readonly TopicCardLink[]
  }
}

/** Who a launch is for. */
export type TopicRequester =
  /**
   * A Feishu user (`user_id`): @-mentioned on the root card, the speaker of
   * the first turn (the prompt is submitted as them), and recorded as the
   * topic's initiator, which grants nothing on the topic (it belongs to the
   * group). They must be an administrator or a user whose `chat` switch is
   * on, unless the channel runs in `open` access mode.
   */
  | { readonly kind: 'feishu-user'; readonly userId: string }
  /**
   * A requester without a Feishu account, such as another system: `label`
   * (1–200 characters, one line, shown literally) replaces the @-mention on
   * the root card and in the records view. The first turn is submitted as the
   * group with no speaker, so it carries no speaker-bound attribution such as
   * a commit trailer. No Feishu access check applies: the caller is
   * responsible for authenticating whoever it launches for.
   */
  | { readonly kind: 'external'; readonly label: string }

/** One topic to start. */
export interface TopicLaunchSpec {
  /**
   * Idempotency key (1–200 visible ASCII characters). A launch whose key was
   * already accepted answers that launch's result instead of posting again.
   * Keys are shared by every caller; a caller that may collide with another
   * prefixes its keys.
   */
  readonly key: string
  /**
   * Caller-defined fingerprint of the request behind {@link key}, compared on
   * replay: the same key with another fingerprint is refused (`key-conflict`).
   */
  readonly fingerprint: string
  /** Target group chat (`oc_…`); the bot must be a member. */
  readonly chatId: string
  /** Who the launch is for. */
  readonly requester: TopicRequester
  readonly card: TopicRootCard
  /** First user message of the Session, sent verbatim (at most 100 000 characters). */
  readonly prompt: string
}

/**
 * Why a launch was refused. Nothing was posted for `invalid`,
 * `not-connected`, `forbidden-chat`, and `key-conflict`; `send-failed` means
 * the root card could not be posted.
 */
export type TopicLaunchFailureCode =
  /** The spec breaks a rule documented on {@link TopicLaunchSpec}. */
  | 'invalid'
  /** The Feishu connection is not established, or the channel is shutting down. */
  | 'not-connected'
  /**
   * The Feishu requester may not talk to the bot (not an administrator and
   * no `chat` switch). The code name predates the user table and is kept for
   * existing callers.
   */
  | 'forbidden-chat'
  /** The key was accepted before with another fingerprint. */
  | 'key-conflict'
  /** Feishu refused the root card (usually: the bot is not in the group). */
  | 'send-failed'

/** Outcome of {@link FeishuTopicService.launch}. */
export type TopicLaunchResult =
  | {
    readonly ok: true
    /** Whether this answers an earlier launch with the same key. */
    readonly replayed: boolean
    readonly chatId: string
    /** Root card message id; the topic hangs below it. */
    readonly messageId: string
  }
  | {
    readonly ok: false
    readonly code: TopicLaunchFailureCode
    /** Readable reason (Chinese). */
    readonly message: string
  }

/**
 * Root card status of a launch: `running` until the first turn settles, then
 * `done`, `stopped`, or `error` (the first turn failed); `failed` when the
 * topic or Session could not be started; `interrupted` when DSH restarted
 * before the first turn settled.
 */
export type TopicLaunchStatus = 'running' | 'done' | 'stopped' | 'error' | 'failed' | 'interrupted'

/** What one accepted launch has become. */
export interface TopicLaunchState {
  /** The launch's idempotency key. */
  readonly key: string
  readonly status: TopicLaunchStatus
  /** Why the topic could not be started; only with status `failed`. */
  readonly reason?: string
  /**
   * Session the topic's route currently names (`/renew` moves it to the new
   * Session). Absent before the route is published, after setup failed, and
   * after the route retired.
   */
  readonly sessionId?: string
  /**
   * Directory the topic's tools work in (its workspace directory); present
   * exactly when {@link sessionId} is.
   */
  readonly workDir?: string
}

/**
 * Cordis event emitted with `ctx.emit` after a launch's status is recorded
 * (first turn settled, setup failed, or marked interrupted at channel start).
 * Listeners receive the new {@link TopicLaunchState}; a listener that throws
 * is logged and does not affect the topic.
 */
export type FeishuTopicsStatusEvent = 'feishu-topics/status'

/**
 * The `feishuTopics` service. {@link FeishuTopicService.state} and
 * {@link FeishuTopicService.launchKeyOf} were added without a version change;
 * a consumer that must work with older providers checks that they exist.
 */
export interface FeishuTopicService {
  readonly version: FeishuTopicsVersion
  /**
   * Post the root card and start the topic. The promise settles once the
   * root card is posted and recorded; the topic, Session, and first turn start
   * in the background, and a failure there ends on the root card (失败, with
   * the reason) instead of rejecting.
   * @param spec - the topic to start.
   * @returns the root card, or why nothing was started.
   */
  launch(spec: TopicLaunchSpec): Promise<TopicLaunchResult>
  /**
   * Read what one launch has become.
   * @param key - the launch's idempotency key.
   * @returns the launch state, or undefined when no launch was accepted
   * under the key or the channel is not connected.
   */
  state(key: string): TopicLaunchState | undefined
  /**
   * Find the launch whose topic route currently names a Session.
   * @param sessionId - DSH session id.
   * @returns the launch's idempotency key, or undefined when the Session is
   * not the current Session of a launched topic.
   */
  launchKeyOf(sessionId: string): string | undefined
}
