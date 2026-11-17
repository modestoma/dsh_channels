/**
 * Root card of a topic a private-chat projects-mode main Session opened
 * (`feishu_topic_open`): the topic title, the start of the main Session's
 * hand-over, and a status tag (进行中 → 已完成 / 已停止 / 失败 / 未能开始).
 * The card sits in the chat timeline; the topic below it streams the work.
 *
 * @module dsh-channels/cards/dm-topic
 */

import { CARD_CONFIG, CARD_SCHEMA, markdown, note } from './primitives.ts'

/** Root card status: the last settled turn, `running` while one is in flight, or `failed` when the topic never started. */
export type DmTopicCardStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error' }
  | { readonly kind: 'failed'; readonly reason: string }

/** Longest hand-over excerpt shown on the card, in characters. */
const BRIEF_EXCERPT_CHARS = 300

/** Escape markdown emphasis characters in model-supplied text. */
function plain(text: string): string {
  return text.replace(/([*_~`[\]\\<>])/gu, '\\$1')
}

/** Header tag text, tag color, and header template of each status. */
function statusLook(status: DmTopicCardStatus): { tag: string; color: string; template: string } {
  switch (status.kind) {
    case 'running': return { tag: '进行中', color: 'blue', template: 'blue' }
    case 'done': return { tag: '已完成', color: 'green', template: 'green' }
    case 'stopped': return { tag: '已停止', color: 'neutral', template: 'grey' }
    case 'error': return { tag: '失败', color: 'red', template: 'red' }
    case 'failed': return { tag: '未能开始', color: 'red', template: 'red' }
  }
}

/** Footer line of each status. */
function statusNote(status: DmTopicCardStatus): string {
  switch (status.kind) {
    case 'running': return '主会话开了这个话题，过程在下面的话题里实时输出；你可以在话题里直接回复。'
    case 'done': return '这一轮已完成，结果见话题；在话题里回复即可继续。'
    case 'stopped': return '这一轮已停止；在话题里回复即可继续。'
    case 'error': return '这一轮出错结束，原因见话题；在话题里回复即可重试。'
    case 'failed': return `话题未能开始：${plain(status.reason)}`
  }
}

/**
 * The root card of a main-Session topic.
 * @param title - the topic title.
 * @param brief - the main Session's hand-over; the card shows its start.
 * @param status - the status the card shows.
 * @returns card JSON.
 */
export function buildDmTopicRootCard(title: string, brief: string, status: DmTopicCardStatus): object {
  const look = statusLook(status)
  const chars = [...brief.trim()]
  const excerpt = chars.length <= BRIEF_EXCERPT_CHARS ? chars.join('') : `${chars.slice(0, BRIEF_EXCERPT_CHARS - 1).join('')}…`
  return {
    schema: CARD_SCHEMA,
    config: CARD_CONFIG,
    header: {
      title: { tag: 'plain_text', content: title },
      template: look.template,
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: look.tag }, color: look.color }],
    },
    body: { elements: [markdown(plain(excerpt)), note(statusNote(status))] },
  }
}
