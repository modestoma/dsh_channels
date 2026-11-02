/**
 * Root card of a topic started through the `feishuTopics` service: the
 * caller's title, an @-mention of the requester followed by the caller's lead
 * sentence, an optional link table, and a status tag (进行中 → 已完成 /
 * 已停止 / 失败 / 已中断) whose wording uses the caller's task name. The work
 * itself streams in the topic below the card through the ordinary streaming
 * card.
 *
 * @module dsh-channels/cards/topic
 */

import type { TopicRootCard } from '../topics/contract.ts'
import { CARD_CONFIG, CARD_SCHEMA, markdown, note } from './primitives.ts'

/**
 * Root card status: `running` until the first turn settles (`done`,
 * `stopped`, `error`), `failed` when the topic could not start, or
 * `interrupted` when DSH restarted before the first turn settled.
 */
export type TopicStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'interrupted' }

/** Rows per table page (Feishu caps `page_size` at 10). */
const TABLE_PAGE_SIZE = 10

/** Escape markdown emphasis characters in caller-supplied text. */
function plain(text: string): string {
  return text.replace(/([*_~`[\]\\])/gu, '\\$1')
}

/** Percent-encode the characters that would end a markdown link target early. */
function linkTarget(url: string): string {
  return url.replace(/[()\s]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** Header tag text, tag color, and header template of each status. */
function statusLook(status: TopicStatus, task: string): { tag: string; color: string; template: string } {
  switch (status.kind) {
    case 'running': return { tag: `${task}中`, color: 'blue', template: 'blue' }
    case 'done': return { tag: '已完成', color: 'green', template: 'green' }
    case 'stopped': return { tag: '已停止', color: 'neutral', template: 'grey' }
    case 'error':
    case 'failed': return { tag: '失败', color: 'red', template: 'red' }
    case 'interrupted': return { tag: '已中断', color: 'orange', template: 'orange' }
  }
}

/** Footer line of each status. */
function statusNote(status: TopicStatus, task: string): string {
  switch (status.kind) {
    case 'running': return `${task}过程在本卡片下的话题内实时输出；群内已授权的成员可以在话题内直接回复追问。`
    case 'done': return `${task}已完成，结果见话题；在话题内回复即可继续追问。`
    case 'stopped': return `${task}已停止；在话题内回复即可继续。`
    case 'error': return `${task}回合失败，原因见话题；在话题内回复即可重试或追问。`
    case 'failed': return `${task}未能开始：${plain(status.reason)}`
    case 'interrupted': return `DSH 重启导致${task}中断；在话题内回复即可继续。`
  }
}

/**
 * The topic root card.
 * @param requesterUserId - `user_id` @-mentioned before the lead sentence.
 * @param card - what the caller asked the card to show.
 * @param status - the status the card shows.
 * @returns card JSON.
 */
export function buildTopicRootCard(requesterUserId: string, card: TopicRootCard, status: TopicStatus): object {
  const task = plain(card.taskName)
  const look = statusLook(status, card.taskName)
  const lead = card.lead.map(run => (run.bold === true ? `**${plain(run.text)}**` : plain(run.text))).join('')
  const elements: object[] = [markdown(`<at id=${requesterUserId}></at> ${lead}`)]
  if (card.links !== undefined && card.links.rows.length > 0) {
    elements.push({
      tag: 'table',
      page_size: TABLE_PAGE_SIZE,
      row_height: 'low',
      header_style: { background_style: 'grey', bold: true, lines: 1 },
      columns: [
        { name: 'name', display_name: card.links.nameHeader, data_type: 'text', width: 'auto' },
        { name: 'link', display_name: card.links.linkHeader, data_type: 'markdown', width: 'auto' },
      ],
      rows: card.links.rows.map(row => ({
        name: row.name,
        link: `[查看](${linkTarget(row.url)})`,
      })),
    })
  }
  elements.push(note(statusNote(status, task)))
  return {
    schema: CARD_SCHEMA,
    config: CARD_CONFIG,
    header: {
      title: { tag: 'plain_text', content: card.title },
      template: look.template,
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: look.tag }, color: look.color }],
    },
    body: { elements },
  }
}
