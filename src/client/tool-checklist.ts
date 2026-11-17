/**
 * 浏览器半区的「主会话可用工具」勾选列表辅助：在 `dmMainTools` 的字符串
 * 列表草稿上勾选、取消，并找出配置里有、主会话里却没有的名字。
 *
 * 不含 JSX/React，便于单测。
 *
 * @module dsh-channels/client/tool-checklist
 */

import { PANEL_COPY } from '../settings/contract.ts'
import type { ConfigValue, MainToolCatalogWire } from '../settings/contract.ts'
import { listItems } from './string-list.ts'

/**
 * The non-empty, trimmed entries of a draft, in order and without repeats.
 * @param value - Draft or effective `dmMainTools` value.
 * @returns The tool names.
 */
export function toolNames(value: ConfigValue | undefined): string[] {
  const names: string[] = []
  for (const item of listItems(value)) {
    const name = item.trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Tick or untick one tool.
 * @param value - Draft value.
 * @param name - The tool.
 * @param checked - Whether it is now ticked.
 * @returns The next draft entries (ticked tools are appended).
 */
export function withTool(value: ConfigValue | undefined, name: string, checked: boolean): string[] {
  const names = toolNames(value).filter(entry => entry !== name)
  return checked ? [...names, name] : names
}

/**
 * Names in the draft that the catalog does not list (nor always allows).
 * @param value - Draft value.
 * @param catalog - The main-Session tool catalog.
 * @returns The names, in draft order.
 */
export function unknownTools(value: ConfigValue | undefined, catalog: MainToolCatalogWire): string[] {
  const known = new Set([
    ...catalog.groups.flatMap(group => group.tools.map(tool => tool.name)),
    ...catalog.alwaysAllowed.map(entry => entry.name),
  ])
  return toolNames(value).filter(name => !known.has(name))
}

/**
 * The line above the checklist: where the list came from.
 * @param catalog - The main-Session tool catalog.
 * @param formatTime - Renders the read time (locale-dependent in the browser).
 * @returns The note.
 */
export function toolCatalogNote(catalog: MainToolCatalogWire, formatTime: (epochMs: number) => string): string {
  return catalog.live ? PANEL_COPY.toolsLive : PANEL_COPY.toolsSaved.replace('{time}', formatTime(catalog.observedAt))
}
