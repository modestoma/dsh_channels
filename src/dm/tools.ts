/**
 * Model tools of a private-chat projects-mode main Session: open a topic,
 * list the person's topics, read a topic's recent replies, and forward a
 * message into a topic. They are mounted only in main Sessions, and every
 * call re-checks that the calling Session is still a main Session.
 *
 * @module dsh-channels/dm/tools
 */

import { z } from 'zod'
import type { RouteRecord } from '../domain.ts'
import type { AgentContext, ToolContentBlock, ToolDefinition } from '../host/index.ts'
import { AgentToolMount } from '../feishu/tool-mount.ts'
import type { DmTopicOpener } from './topic-opener.ts'
import { DM_TOPIC_REPLIES_KEPT, DM_TOPIC_STATUS_LABELS } from './topic-directory.ts'
import type { DmTopicDirectory, DmTopicStatus } from './topic-directory.ts'

/** Tool names, in the order they are registered. */
export const DM_TOPIC_OPEN_TOOL = 'feishu_topic_open'
export const DM_TOPIC_LIST_TOOL = 'feishu_topic_list'
export const DM_TOPIC_READ_TOOL = 'feishu_topic_read'
export const DM_TOPIC_SEND_TOOL = 'feishu_topic_send'

/** Every main-Session topic tool; the main-Session tool gate always allows them. */
export const DM_TOPIC_TOOL_NAMES: readonly string[] = [DM_TOPIC_OPEN_TOOL, DM_TOPIC_LIST_TOOL, DM_TOPIC_READ_TOOL, DM_TOPIC_SEND_TOOL]

/** Most topics one `feishu_topic_list` call shows. */
const LIST_LIMIT = 20

/** Longest brief accepted, in characters. */
const BRIEF_MAX_CHARS = 20_000

/** Longest forwarded message accepted, in characters. */
const MESSAGE_MAX_CHARS = 8_000

const openArgsSchema = z.object({
  title: z.string().trim().min(1).max(100),
  brief: z.string().trim().min(1).max(BRIEF_MAX_CHARS),
})

const listArgsSchema = z.object({
  status: z.enum(['all', 'running', 'waiting', 'idle', 'closed']).default('all'),
})

const readArgsSchema = z.object({
  topic_id: z.string().trim().min(1).max(200),
  last: z.number().int().min(1).max(DM_TOPIC_REPLIES_KEPT).default(1),
})

const sendArgsSchema = z.object({
  topic_id: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
})

/** Result of every topic tool: readable text, or a refusal. */
export type DmTopicToolValue =
  | { readonly ok: true; readonly text: string; readonly topic_id?: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    topic_id: { type: 'string' },
    code: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['ok'],
}

export interface DmTopicToolDeps {
  /** The route that names a Session, if any. */
  routeOfSession(sessionId: string): RouteRecord | undefined
  opener: DmTopicOpener
  directory: DmTopicDirectory
  warn(message: string, ...args: unknown[]): void
}

export class DmTopicToolRuntime {
  private readonly toolMount = new AgentToolMount({
    label: 'feishu_topic_*',
    enabled: () => true,
    definitions: sessionId => this.definitionsFor(sessionId),
    describeError: error => (error instanceof Error ? error.message : String(error)),
    warn: (message, ...args) => this.deps.warn(message, ...args),
  })

  constructor(private readonly deps: DmTopicToolDeps) {}

  /**
   * Register the topic tools inside a main Session's Agent scope.
   * @param agentCtx - the Agent scope.
   * @param sessionId - the main Session.
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    await this.toolMount.mount(agentCtx, sessionId)
  }

  private definitionsFor(sessionId: string): ToolDefinition[] {
    const tool = (
      name: string,
      description: string,
      parameters: Record<string, unknown>,
      run: (main: RouteRecord, args: Record<string, unknown>) => Promise<DmTopicToolValue> | DmTopicToolValue,
      concurrent: boolean,
    ): ToolDefinition => ({
      name,
      description,
      parameters,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      execute: async rawArgs => {
        const main = this.deps.routeOfSession(sessionId)
        if (main?.dmRole !== 'main') return refused('not-main', `${name} 只能在私聊主会话里使用`)
        return await run(main, rawArgs)
      },
      presentResult: (_args, value) => textOf(value),
      isConcurrencySafe: () => concurrent,
    })
    return [
      tool(DM_TOPIC_OPEN_TOOL, OPEN_DESCRIPTION, OPEN_PARAMETERS, async (main, raw) => {
        const args = parse(DM_TOPIC_OPEN_TOOL, openArgsSchema, raw)
        const result = await this.deps.opener.open(main, args.title, args.brief)
        if (!result.ok) return refused(result.code, result.message)
        return {
          ok: true,
          topic_id: result.topicId,
          text: result.replayed
            ? `同名话题「${result.title}」已在进行中（topic_id: ${result.topicId}），没有重复开。`
            : `已开话题「${result.title}」（topic_id: ${result.topicId}），交接说明作为第一轮在话题里后台运行。用一句话告诉用户你开了这个话题；进展会在用户下次发消息时以 <dm_topic_updates> 送来，不要等待它。`,
        }
      }, false),
      tool(DM_TOPIC_LIST_TOOL, LIST_DESCRIPTION, LIST_PARAMETERS, (main, raw) => {
        const args = parse(DM_TOPIC_LIST_TOOL, listArgsSchema, raw)
        return { ok: true, text: this.list(main, args.status) }
      }, true),
      tool(DM_TOPIC_READ_TOOL, READ_DESCRIPTION, READ_PARAMETERS, (main, raw) => {
        const args = parse(DM_TOPIC_READ_TOOL, readArgsSchema, raw)
        return this.read(main, args.topic_id, args.last)
      }, true),
      tool(DM_TOPIC_SEND_TOOL, SEND_DESCRIPTION, SEND_PARAMETERS, async (main, raw) => {
        const args = parse(DM_TOPIC_SEND_TOOL, sendArgsSchema, raw)
        const result = await this.deps.opener.send(main, args.topic_id, args.message)
        if (!result.ok) return refused(result.code, result.message)
        return {
          ok: true,
          topic_id: result.topicId,
          text: result.queued
            ? '消息已发到话题；话题正在跑上一轮，这条排在它后面。'
            : '消息已发到话题，话题开始处理。',
        }
      }, false),
    ]
  }

  private list(main: RouteRecord, filter: 'all' | DmTopicStatus): string {
    const directory = this.deps.directory
    const rows = directory.topicsOf(main.senderUserId ?? '')
      .map(record => ({ record, status: directory.statusOf(record) }))
      .filter(row => filter === 'all' || row.status === filter)
      .slice(0, LIST_LIMIT)
    if (rows.length === 0) return filter === 'all' ? '还没有话题。' : `没有${DM_TOPIC_STATUS_LABELS[filter]}的话题。`
    return rows.map(({ record, status }) => [
      `- 「${record.title}」 topic_id: ${record.key} · ${DM_TOPIC_STATUS_LABELS[status]} · ${record.openedBy === 'main' ? '主会话开的' : '用户开的'} · 更新于 ${new Date(record.updatedAt).toISOString()}`,
      ...(record.summary === undefined ? [] : record.summary.split('\n').map(line => `  ${line}`)),
    ].join('\n')).join('\n')
  }

  private read(main: RouteRecord, topicId: string, last: number): DmTopicToolValue {
    const record = this.deps.directory.get(topicId)
    if (record === undefined || record.userId !== main.senderUserId) {
      return refused('unknown-topic', `没有 topic_id 为 ${topicId} 的话题；先用 ${DM_TOPIC_LIST_TOOL} 查看`)
    }
    const status = DM_TOPIC_STATUS_LABELS[this.deps.directory.statusOf(record)]
    const replies = record.replies.slice(-last)
    if (replies.length === 0) {
      return { ok: true, topic_id: topicId, text: `话题「${record.title}」（${status}）还没有结束过的回合。${record.failedReason === undefined ? '' : `\n未能开始：${record.failedReason}`}` }
    }
    const body = replies.map((reply, index) => `### 第 ${replies.length - index} 近的回合（${new Date(reply.at).toISOString()}，${OUTCOME_LABELS[reply.outcome]}）\n${reply.text}`).join('\n\n')
    return { ok: true, topic_id: topicId, text: `话题「${record.title}」（${status}）\n\n${body}` }
  }
}

const OUTCOME_LABELS = { done: '已完成', stopped: '已停止', error: '出错' } as const

/** Parse tool arguments; invalid arguments throw a readable error (a failed tool call). */
function parse<T>(tool: string, schema: z.ZodType<T>, raw: Record<string, unknown>): T {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
  throw new Error(`${tool}: invalid ${where}: ${issue?.message ?? 'invalid arguments'}`)
}

function refused(code: string, reason: string): DmTopicToolValue {
  return { ok: false, code, reason }
}

function isValue(value: unknown): value is DmTopicToolValue {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/** The text a topic tool result shows. */
function textOf(value: unknown): string {
  if (!isValue(value)) return '结果不可用'
  return value.ok ? value.text : `未完成（${value.code}）：${value.reason}`
}

function renderValue(value: unknown): readonly ToolContentBlock[] {
  return [{ type: 'text', text: textOf(value) }]
}

const OPEN_DESCRIPTION = '在私聊里开一个话题，把一件需要完整工具（命令行、写文件、改代码、多步调查）或需要长时间专注讨论的事交给它。'
  + '话题是独立会话，工作目录是自己的子目录；交接说明 brief 是它的第一条消息，所以要写全：背景、目标、已知信息、约束、期望的产出，它看不到这个主会话的对话。'
  + '工具立即返回 topic_id，话题在后台运行，不要等待它；它的进展会在用户下次在主聊天发消息时以 <dm_topic_updates> 送来。'
  + '开完用一句话告诉用户你开了什么话题。同名且仍在进行中的话题不会重复开；主会话同时进行中的话题有上限。'

const OPEN_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 100, description: '话题标题，一句话说明这件事（超过 30 字会被截断）。' },
    brief: { type: 'string', minLength: 1, maxLength: BRIEF_MAX_CHARS, description: '交接说明：背景、目标、已知信息、约束、期望的产出。话题会话只看得到这段话。' },
  },
  required: ['title', 'brief'],
  additionalProperties: false,
}

const LIST_DESCRIPTION = '列出这个人私聊里的话题：标题、topic_id、状态（进行中 / 等你处理 / 空闲 / 未能开始 / 已过期）、谁开的、最近一次小结。最多 20 个，最近更新的在前。'

const LIST_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['all', 'running', 'waiting', 'idle', 'closed'],
      description: 'all（默认）全部；running 进行中；waiting 等用户处理（审批、提问，或小结里写了需要用户做的事）；idle 空闲；closed 已过期。',
    },
  },
  additionalProperties: false,
}

const READ_DESCRIPTION = '读取一个话题最近几轮的最终回复（每轮截断到 4000 字），用于回答用户关于话题进展的具体问题。小结不够用时再读。'

const READ_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    topic_id: { type: 'string', minLength: 1, description: 'feishu_topic_list 或 <dm_topic_updates> 里的 topic_id。' },
    last: { type: 'integer', minimum: 1, maximum: DM_TOPIC_REPLIES_KEPT, description: `读最近几轮，默认 1，最多 ${DM_TOPIC_REPLIES_KEPT}。` },
  },
  required: ['topic_id'],
  additionalProperties: false,
}

const SEND_DESCRIPTION = '把一条消息发到已有话题里，让它接着做（例如用户在主聊天里补充的要求）。消息会以「【主会话】」开头显示在话题里，并作为话题的下一轮；话题正在跑时排在当前回合后面。消息要自包含。'

const SEND_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    topic_id: { type: 'string', minLength: 1, description: '目标话题的 topic_id。' },
    message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS, description: '发给话题的消息，写清要它做什么。' },
  },
  required: ['topic_id', 'message'],
  additionalProperties: false,
}
