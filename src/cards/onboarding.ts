/**
 * One-time onboarding card: what the bot does, how workspaces are scoped, and
 * the command cheat sheet. Sent on the first private message of a chat.
 *
 * Static content, deliberately kept apart from the streaming reply card.
 *
 * @module dsh-channels/cards/onboarding
 */

import { card, markdown, note } from './primitives.ts'

/** First-contact onboarding card (private chats only, once per chat). */
export function buildOnboardingCard(): object {
  return card([
    markdown('**👋 欢迎使用飞书 DSH**'),
    markdown('直接发消息即可开始一个会话，我会在话题里流式回复；话题内继续发消息无需再 @ 我。'),
    markdown('**工作区**：私聊一人一个；群里每位成员各自一个，互不影响。'),
    markdown('**发文件**：只发文件我不会回复；请引用那条文件消息再提问，多个文件可合并转发后引用。'),
    markdown('**常用命令**：`/help` 命令列表 · `/status` 会话状态 · `/workspace` 工作目录\n'
      + '`/effort` 推理强度 · `/model` 模型 · `/permissions` 权限预设\n'
      + '`/new` 新建会话 · `/stop` 中断当前回合 · `/history` 历史 · `/export` 导出日志'),
    note('需要授权或补充信息时，我会发一张卡片，点按钮或直接回复即可。'),
  ])
}
