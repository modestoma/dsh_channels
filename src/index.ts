/**
 * dsh-channels — DeepSeek Harness 飞书渠道插件。
 *
 * 一个 dsh 实例对应一个飞书机器人；用户通过私聊、群聊 @、话题群 @ 三种方式
 * 发起会话。每条触发消息：立即加 “Typing” 表情 → 以话题形式回复（创建话题）
 * → 绑定 DSH session → 卡片 2.0 流式回复（推理折叠面板 + 富文本正文 + 两行
 * session 信息，默认 500ms 刷新）→ 流式结束移除 Typing、更新为 “DONE”。
 *
 * 工作区归属：私聊一人一工作区；群聊中每个用户在该群拥有独立工作区
 * （目录即工作区，会话以 cwd 落盘）。
 *
 * @module dsh-channels
 */

import type { HostContext } from './dsh-types.ts'
import { FeishuService } from './service.ts'
import { resolveConfig } from './config.ts'
import type { FeishuConfig } from './config.ts'
import { defaultChannelFactory } from './feishu-channel.ts'
import type { ChannelFactory } from './feishu-channel.ts'

export type * from './config.ts'
export type * from './cards.ts'
export type * from './domain.ts'
export type * from './feishu-channel.ts'
export type * from './approvals.ts'
export type { ApprovalOutcome, ApprovalRequest, ApprovalAnswererListener } from './dsh-types.ts'
export { buildCard, buildInterruptionCard, cardJsonBytes, CARD_MAX_BYTES, CARD_TARGET_BYTES, INTERRUPTION_NOTICE, MAX_TABLES_PER_CARD, PANEL_TITLES, PANEL_CHEVRON_TOKEN, segmentCardContent, splitBodyForCard, stripTables, tableBlocks, TRUNCATION_SUFFIX, buildApprovalCard, buildApprovalSettledCard } from './cards.ts'
export { ApprovalAnswerer } from './approvals.ts'
export { FeishuService } from './service.ts'
export { TurnStreamer } from './streamer.ts'
export { ensureWorkspace, workspacePathFor, workspaceTitleFor } from './workspaces.ts'
export { chatRouteKey, feishuDomain, routeRecordSchema, inflightSnapshotSchema, processedRecordSchema } from './domain.ts'

/** Cordis function-plugin name. */
export const name = 'channels'

/** Host services this plugin consumes (all resolved through ctx).
 *
 * `credentials` is listed even though the plugin could fall back to the
 * process environment: at boot the credentials provider may not be visible
 * yet (a race observed in real profiles), and inject makes the loader wait
 * for it. `llm` / `tokenMeter` feed the card's context line and ship with
 * every dsh-base profile.
 */
export const inject = ['agents', 'workspaceRegistry', 'storageDomain', 'credentials', 'llm', 'tokenMeter'] as const

export interface FeishuPluginOptions extends FeishuConfig {
  /** Test seam: substitute a channel implementation. */
  channelFactory?: ChannelFactory
}

/**
 * Install the bridge. Credentials stay references here — the actual secrets
 * resolve through `ctx.credentials` (env > `$DSH_HOME/.credentials.yaml`
 * > `.env`) when `FeishuService.start()` builds the channel.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const resolved = resolveConfig(config)
  const factory: ChannelFactory = (config as FeishuPluginOptions | undefined)?.channelFactory
    ?? defaultChannelFactory
  const service = new FeishuService(ctx, resolved, factory)
  ctx.effect(() => {
    void service.start().catch((error: unknown) => {
      ctx.logger?.error?.('dsh-channels failed to start: %s', String(error))
      // Critical lifecycle line duplicated to the console: cordis logger
      // messages emitted before a web exporter attaches are buffered and may
      // never reach stdout, which makes real-device debugging guesswork.
      console.error('[dsh-channels] failed to start:', error)
    })
    return () => service.shutdown()
  })
}

