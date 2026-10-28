/**
 * Types of the `feishuTopics` service: another DSH plugin starts a
 * group-shared Feishu topic Session from an external trigger (for example
 * 观象's log-platform analyze API).
 *
 * One launch posts a root card into an authorized group, opens a topic below
 * it, creates the Session in a workspace below the channel's `baseDir`, and
 * streams the first turn (the prompt, verbatim) in that topic. The root card's
 * status tag follows the first turn (进行中 → 已完成 / 已停止 / 失败) and turns
 * 已中断 when DSH restarts before it settles. Every member admitted in the
 * group may continue the topic.
 *
 * This module has no runtime exports, and the package subpath
 * `@modesto_ma/dsh-channels/topics` exposes only its types. A consumer imports
 * them with `import type`, looks the service up per call with
 * `ctx.get('feishuTopics')` (absent while dsh-channels is not loaded or
 * reloading), and checks {@link FeishuTopicService.version} before calling.
 *
 * @module dsh-channels/topics/contract
 */

/** Name the service is provided under (`ctx.get('feishuTopics')`). */
export type FeishuTopicsServiceName = 'feishuTopics'

/**
 * Version of this contract. It changes only when a change would make an older
 * consumer misbehave; a consumer refuses a provider whose version it does not
 * know.
 */
export type FeishuTopicsVersion = 1

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
  /** Lead sentence, shown after an @-mention of the requester. */
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
  /** Target group chat (`oc_…`). It must be an authorized group, or the channel must run in `open` access mode. */
  readonly chatId: string
  /** Feishu `user_id` of the person the launch is for: @-mentioned on the root card and recorded as the route's requester. */
  readonly requesterUserId: string
  readonly card: TopicRootCard
  /**
   * Workspace of the Session: directory segments below the channel's
   * `baseDir` (1–8 segments of `A-Z a-z 0-9 . _ -`, the first not one of the
   * channel's own `p2p`, `groups`, `topics`, `_staging`), and its title in
   * the DSH workspace list. Launches with the same segments share the
   * workspace, each in its own topic directory.
   */
  readonly workspace: {
    readonly segments: readonly string[]
    readonly title: string
  }
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
  /** The target group is not authorized. */
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

/** The `feishuTopics` service. */
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
}
