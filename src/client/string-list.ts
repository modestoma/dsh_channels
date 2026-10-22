/**
 * 浏览器半区的 `string-list` 字段辅助：把草稿值读成条目数组，并在保存前
 * 逐项校验，供面板即时标红。Host 保存时按同一规则复核（见
 * `settings/surface.ts` 的 `normalizeStringList`）。
 *
 * 不含 JSX/React，便于单测。条目格式校验直接复用纯函数模块
 * `feishu/wiki/links.ts`（无运行时依赖，可内联进 Client bundle）。
 *
 * @module dsh-channels/client/string-list
 */

import { parseWikiRootLink, WIKI_ROOT_LINK_ERRORS } from '../feishu/wiki/links.ts'
import { PANEL_COPY } from '../settings/contract.ts'
import type {
  ConfigValue,
  EditableFieldWire,
  FieldIssueWire,
  StringListItemFormat,
} from '../settings/contract.ts'

/** Entry checks per item format: the readable reason, or `undefined` when valid. */
const ITEM_FORMAT_CHECKS: Readonly<Record<StringListItemFormat, (entry: string) => string | undefined>> = {
  'wiki-root-link': (entry) => {
    const parsed = parseWikiRootLink(entry)
    return parsed.ok ? undefined : WIKI_ROOT_LINK_ERRORS[parsed.error]
  },
}

/**
 * Entries of a `string-list` value; any other value reads as no entries.
 *
 * @param value - Draft or effective value of a `string-list` field.
 * @returns The entries as stored (untrimmed).
 */
export function listItems(value: ConfigValue | undefined): readonly string[] {
  return typeof value === 'object' ? value : []
}

/**
 * Validate the entries of one `string-list` draft the way the Host will:
 * empty inputs are ignored, every other entry is trimmed and checked against
 * the field's `itemFormat`, and the non-empty count is bounded by `maxItems`.
 *
 * @param field - The Host descriptor (`kind: 'string-list'`).
 * @param items - The draft entries, empty inputs included.
 * @returns Per-entry issues (with `index` into `items`) and a whole-field issue when over `maxItems`.
 */
export function stringListIssues(field: EditableFieldWire, items: readonly string[]): FieldIssueWire[] {
  const issues: FieldIssueWire[] = []
  const check = field.itemFormat === undefined ? undefined : ITEM_FORMAT_CHECKS[field.itemFormat]
  let count = 0
  items.forEach((item, index) => {
    const entry = item.trim()
    if (entry === '') return
    count += 1
    const reason = check?.(entry)
    if (reason === undefined) return
    const position = PANEL_COPY.listEntry.replace('{n}', String(index + 1))
    issues.push({ key: field.key, index, message: `${position}「${entry}」：${reason}` })
  })
  if (field.maxItems !== undefined && count > field.maxItems) {
    issues.push({ key: field.key, message: PANEL_COPY.listTooMany.replace('{max}', String(field.maxItems)) })
  }
  return issues
}

/**
 * Turn one `string-list` draft into its save payload. Entries are submitted as
 * typed (untrimmed, empty inputs included) so Host issue indexes point at the
 * same rendered inputs; the Host trims and drops empty inputs.
 *
 * @param field - The Host descriptor (`kind: 'string-list'`).
 * @param raw - The draft value.
 * @returns The payload entries, or the issues that block the save.
 */
export function stringListDraftValue(
  field: EditableFieldWire,
  raw: ConfigValue | undefined,
): { ok: true; value: string[] } | { ok: false; issues: FieldIssueWire[] } {
  const items = listItems(raw)
  const issues = stringListIssues(field, items)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: [...items] }
}

/**
 * Inputs the list control renders: one per entry, or one blank input for an
 * empty list so the first entry can be typed directly.
 *
 * @param value - Draft or effective value.
 * @returns The input values, in order.
 */
export function listRows(value: ConfigValue | undefined): readonly string[] {
  const items = listItems(value)
  return items.length === 0 ? [''] : items
}

/**
 * Replace the entry at one input position.
 *
 * @param rows - Rendered inputs ({@link listRows}).
 * @param index - Position of the edited input.
 * @param entry - The typed value.
 * @returns The next draft entries.
 */
export function withListEntry(rows: readonly string[], index: number, entry: string): string[] {
  return rows.map((item, position) => (position === index ? entry : item))
}

/**
 * Drop the entry at one input position.
 *
 * @param rows - Rendered inputs ({@link listRows}).
 * @param index - Position of the removed input.
 * @returns The next draft entries.
 */
export function withoutListEntry(rows: readonly string[], index: number): string[] {
  return rows.filter((_, position) => position !== index)
}

/**
 * Append one blank input.
 *
 * @param rows - Rendered inputs ({@link listRows}).
 * @returns The next draft entries.
 */
export function withBlankListEntry(rows: readonly string[]): string[] {
  return [...rows, '']
}

/**
 * Whether the add button is disabled: the inputs already reach `maxItems`.
 *
 * @param field - The Host descriptor.
 * @param rows - Rendered inputs ({@link listRows}).
 * @returns `true` when no further input may be added.
 */
export function listIsFull(field: EditableFieldWire, rows: readonly string[]): boolean {
  return field.maxItems !== undefined && rows.length >= field.maxItems
}
