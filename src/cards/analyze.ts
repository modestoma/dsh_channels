/**
 * Cards of log-platform analysis topics: the placeholder posted when a request
 * is accepted, the preface line the settled result card keeps, and the
 * terminal failure card. The result card itself is the ordinary streaming
 * card rendered once (quiet turn) into the placeholder message.
 *
 * @module dsh-channels/cards/analyze
 */

import { markdown, note, standaloneCard } from './primitives.ts'

/** Subject of one analysis, as the cards name it. */
export interface AnalyzeSubject {
  /** Requester user_id (rendered as an @-mention). */
  readonly requesterUserId: string
  readonly app: string
  readonly errorCode: string
  /** Number of log packages in the request. */
  readonly logCount: number
}

/** Topic hint posted as the first reply below the placeholder (it also opens the topic). */
export const ANALYZE_TOPIC_HINT = '💬 分析完成后，在本话题内直接回复即可基于结果追问（群内已授权的成员都可以）。'

/** Escape markdown emphasis characters in user-supplied subject text. */
function plain(text: string): string {
  return text.replace(/([*_~`[\]\\])/gu, '\\$1')
}

/**
 * The fixed line naming who analyzes what; kept at the top of the result card.
 * @param subject - the analysis subject.
 * @returns markdown notation text.
 */
export function analyzePreface(subject: AnalyzeSubject): string {
  return `📋 <at id=${subject.requesterUserId}></at> 发起的日志分析 · 应用 **${plain(subject.app)}** · 错误码 **${plain(subject.errorCode)}** · ${subject.logCount} 个日志包`
}

/**
 * Placeholder card posted into the target group when a request is accepted.
 * @param subject - the analysis subject.
 * @returns card JSON.
 */
export function buildAnalyzePlaceholderCard(subject: AnalyzeSubject): object {
  return standaloneCard('**🔍 日志分析中**', [
    markdown(`<at id=${subject.requesterUserId}></at> 正在分析 **${plain(subject.app)}** 应用的 **${plain(subject.errorCode)}** 问题（${subject.logCount} 个日志包）。`),
    note('分析完成后结果会更新在这张卡片上。'),
  ])
}

/**
 * Terminal card replacing the placeholder when the analysis could not start.
 * @param subject - the analysis subject.
 * @param reason - readable failure reason.
 * @returns card JSON.
 */
export function buildAnalyzeFailureCard(subject: AnalyzeSubject, reason: string): object {
  return standaloneCard('**❌ 日志分析未能开始**', [
    note(analyzePreface(subject)),
    markdown(plain(reason)),
  ])
}
