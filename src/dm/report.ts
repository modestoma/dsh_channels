/**
 * The summary a private-chat projects-mode topic reports to the main Session
 * after each turn.
 *
 * A topic's prompt asks every final reply to end with a 「小结」 block of
 * three lines:
 *
 * ```
 * 小结
 * 做了：…
 * 结果：…
 * 需要你：…（没有则写「无」）
 * ```
 *
 * {@link extractTopicReport} reads the last such block of a reply. A reply
 * without one is reported as its last characters, so the main Session still
 * learns how the turn ended.
 *
 * @module dsh-channels/dm/report
 */

/** Heading line of the summary block: `小结`, optionally as a Markdown heading, bold, or with a colon. */
const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*小结\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$/u

/** One field line of the block: label, colon, value (list markers and bold allowed). */
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*)?\s*(做了|结果|需要你)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/u

/** `需要你` values that mean nothing is needed from the person. */
const NOTHING_NEEDED = new Set(['', '无', '无。', '没有', '没有。', '暂无', '不需要', '-', '—', 'none', 'n/a'])

/** What one topic turn reports. */
export interface TopicReport {
  /** The summary text, at most the configured length. */
  readonly summary: string
  /** Whether the reply asks the person for something (`需要你` is not 「无」). */
  readonly needsYou: boolean
}

/**
 * Read the summary of one topic turn from its final reply.
 * @param reply - the reply text of the turn (every text segment, in order).
 * @param maxChars - longest summary returned.
 * @returns the summary, or undefined for an empty reply.
 */
export function extractTopicReport(reply: string, maxChars: number): TopicReport | undefined {
  const text = reply.trim()
  if (text === '') return undefined
  const block = summaryBlock(text)
  if (block !== undefined) {
    const needs = block.fields.get('需要你')
    return {
      summary: clip(block.lines.join('\n'), maxChars),
      needsYou: needs !== undefined && !NOTHING_NEEDED.has(needs.trim().toLowerCase()),
    }
  }
  return { summary: tail(text, maxChars), needsYou: false }
}

/** The field lines of the last 「小结」 block, when the reply has one with at least one field. */
function summaryBlock(text: string): { lines: string[]; fields: Map<string, string> } | undefined {
  const lines = text.split(/\r?\n/u)
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!HEADING.test(lines[start]!)) continue
    const fields = new Map<string, string>()
    const kept: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') continue
      const match = FIELD.exec(line)
      if (match === null) break
      const value = match[2]!.replace(/\*\*\s*$/u, '').trim()
      fields.set(match[1]!, value)
      kept.push(`${match[1]!}：${value}`)
    }
    if (kept.length > 0) return { lines: kept, fields }
  }
  return undefined
}

/**
 * `text` cut to `max` characters, ending with an ellipsis when cut.
 * @param text - the text.
 * @param max - longest result, in characters.
 * @returns the text or its cut start.
 */
export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** The last `max` characters of `text`, starting with an ellipsis when cut. */
function tail(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `…${chars.slice(chars.length - Math.max(0, max - 1)).join('').trimStart()}`
}
