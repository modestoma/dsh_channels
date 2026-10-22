/**
 * Root card of a log-platform analysis: who started which analysis when, the
 * log-platform detail pages behind it, and a status tag (分析中 → 已完成 /
 * 已停止 / 失败). The analysis itself streams in the topic below the card
 * through the ordinary streaming card.
 *
 * @module dsh-channels/cards/analyze
 */

import { CARD_CONFIG, CARD_SCHEMA, markdown, note } from './primitives.ts'

/** One log-platform detail page listed on the root card. */
export interface AnalyzeLogDetail {
  readonly name: string
  readonly url: string
}

/** Subject of one analysis, as the root card names it. */
export interface AnalyzeSubject {
  /** Requester user_id (rendered as an @-mention). */
  readonly requesterUserId: string
  /** Trigger time as the platform sent it (shown verbatim). */
  readonly triggeredAt: string
  readonly app: string
  readonly errorCode: string
  readonly logDetails: readonly AnalyzeLogDetail[]
}

/**
 * Root card status: `running` until the first turn settles (`done`,
 * `stopped`, `error`), or `failed` when the analysis could not start.
 */
export type AnalyzeStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error' }
  | { readonly kind: 'failed'; readonly reason: string }

/** Rows per table page (Feishu caps `page_size` at 10). */
const TABLE_PAGE_SIZE = 10

/** Escape markdown emphasis characters in platform-supplied text. */
function plain(text: string): string {
  return text.replace(/([*_~`[\]\\])/gu, '\\$1')
}

/** Percent-encode the characters that would end a markdown link target early. */
function linkTarget(url: string): string {
  return url.replace(/[()\s]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** Header tag text, tag color, and header template of each status. */
function statusLook(status: AnalyzeStatus): { tag: string; color: string; template: string } {
  switch (status.kind) {
    case 'running': return { tag: '分析中', color: 'blue', template: 'blue' }
    case 'done': return { tag: '已完成', color: 'green', template: 'green' }
    case 'stopped': return { tag: '已停止', color: 'neutral', template: 'grey' }
    case 'error':
    case 'failed': return { tag: '失败', color: 'red', template: 'red' }
  }
}

/** Footer line of each status. */
function statusNote(status: AnalyzeStatus): string {
  switch (status.kind) {
    case 'running': return '分析过程在本卡片下的话题内实时输出；群内已授权的成员可以在话题内直接回复追问。'
    case 'done': return '分析已完成，结果见话题；在话题内回复即可继续追问。'
    case 'stopped': return '分析已停止；在话题内回复即可继续。'
    case 'error': return '分析回合失败，原因见话题；在话题内回复即可重试或追问。'
    case 'failed': return `分析未能开始：${plain(status.reason)}`
  }
}

/**
 * The analysis root card.
 * @param subject - the analysis subject.
 * @param status - the status the card shows.
 * @returns card JSON.
 */
export function buildAnalyzeRootCard(subject: AnalyzeSubject, status: AnalyzeStatus): object {
  const look = statusLook(status)
  return {
    schema: CARD_SCHEMA,
    config: CARD_CONFIG,
    header: {
      title: { tag: 'plain_text', content: '日志分析' },
      template: look.template,
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: look.tag }, color: look.color }],
    },
    body: {
      elements: [
        markdown(`<at id=${subject.requesterUserId}></at> 于 ${plain(subject.triggeredAt)} 发起了对 **${plain(subject.app)}** 应用 **${plain(subject.errorCode)}** 错误码不良日志的分析。`),
        {
          tag: 'table',
          page_size: TABLE_PAGE_SIZE,
          row_height: 'low',
          header_style: { background_style: 'grey', bold: true, lines: 1 },
          columns: [
            { name: 'name', display_name: '日志', data_type: 'text', width: 'auto' },
            { name: 'link', display_name: '详情页', data_type: 'markdown', width: 'auto' },
          ],
          rows: subject.logDetails.map(detail => ({
            name: detail.name,
            link: `[查看](${linkTarget(detail.url)})`,
          })),
        },
        note(statusNote(status)),
      ],
    },
  }
}
