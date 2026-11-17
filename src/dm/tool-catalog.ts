/**
 * The tools a private-chat projects-mode main Session can see, for the
 * settings panel's「主会话可用工具」checklist.
 *
 * Tools are registered per Agent scope (agent presets mount them), so the
 * list is read from a live main Session through the host `tools` registry
 * and grouped by name prefix. Each read is saved (`dm_tool_snapshots`), so
 * the panel still shows the last list after a restart, before any main
 * Session runs again. No main Session seen yet: no catalog, and the panel
 * keeps the free-text list.
 *
 * Topic tools and PTC's `run_code` are listed apart as always allowed: the
 * main-Session tool gate never denies them.
 *
 * @module dsh-channels/dm/tool-catalog
 */

import { z } from 'zod'
import type { Agent } from '../host/index.ts'
import type { MainToolCatalogWire, MainToolGroupWire } from '../settings/contract.ts'
import type { DomainTable } from '../storage/table.ts'
import { DM_TOPIC_TOOL_NAMES } from './tools.ts'

/** The `run_code` tool of `dsh-tool-executor-ptc`. */
export const RUN_CODE_TOOL = 'run_code'

/** Key of the single saved snapshot. */
const SNAPSHOT_KEY = 'main'

/** Longest tool summary shown, in characters. */
const SUMMARY_MAX_CHARS = 80

/** Most tools saved per snapshot (the registry is never this large in practice). */
const SNAPSHOT_MAX_TOOLS = 500

export const dmToolSnapshotSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })).max(SNAPSHOT_MAX_TOOLS),
})

/** The tools one main Session saw, saved for the panel. */
export type DmToolSnapshot = z.infer<typeof dmToolSnapshotSchema>

/** The slice of the host `tools` registry the catalog reads. */
export interface ToolRegistryView {
  /**
   * Visible tool definitions of one scope.
   * @param scope - the viewing Agent.
   * @returns its definitions.
   */
  definitions(scope?: object): readonly { readonly name: string; readonly description: string }[]
}

export interface DmMainToolCatalogDeps {
  /** The host `tools` registry, when mounted. */
  tools(): ToolRegistryView | undefined
  /** Live projects-mode main Session Agents. */
  mainAgents(): readonly Agent[]
  /** Snapshot table; undefined while storage is closed. */
  table(): DomainTable<DmToolSnapshot> | undefined
  warn(message: string, ...args: unknown[]): void
  now?(): number
}

/** Always-allowed tools and why, as the panel shows them. */
const ALWAYS_ALLOWED: readonly { name: string; reason: string }[] = [
  ...DM_TOPIC_TOOL_NAMES.map(name => ({ name, reason: '主会话开话题、跟进话题用' })),
  { name: RUN_CODE_TOOL, reason: 'PTC 部署里模型只能通过它调工具；程序里调用的每个工具仍按勾选检查，不能提升沙箱' },
]

const ALWAYS_ALLOWED_NAMES = new Set(ALWAYS_ALLOWED.map(entry => entry.name))

/** Label of the group holding tools whose name prefix no other tool shares. */
const GENERAL_GROUP = '通用'

/**
 * First line or sentence of a tool description, cut to {@link SUMMARY_MAX_CHARS}.
 * @param description - the tool description.
 * @returns the summary.
 */
export function toolSummary(description: string): string {
  const line = description.trim().split('\n')[0]?.trim() ?? ''
  const sentence = /^(.+?(?:[。！？]|[.!?](?=\s|$)))/u.exec(line)?.[1] ?? line
  const chars = [...sentence]
  return chars.length <= SUMMARY_MAX_CHARS ? sentence : `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join('')}…`
}

/**
 * Group tools by name prefix (the text before the first `_`): a prefix two or
 * more tools share is its own group (`feishu_*`); the rest go under 通用.
 * Always-allowed tools are left out.
 * @param tools - the tools.
 * @returns groups, 通用 first, then by prefix; tools sorted by name.
 */
export function groupTools(tools: readonly { name: string; description: string }[]): MainToolGroupWire[] {
  const unique = new Map<string, string>()
  for (const tool of tools) {
    if (!ALWAYS_ALLOWED_NAMES.has(tool.name) && !unique.has(tool.name)) unique.set(tool.name, tool.description)
  }
  const prefixOf = (name: string): string | undefined => {
    const index = name.indexOf('_')
    return index > 0 ? name.slice(0, index) : undefined
  }
  const counts = new Map<string, number>()
  for (const name of unique.keys()) {
    const prefix = prefixOf(name)
    if (prefix !== undefined) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  const groups = new Map<string, MainToolGroupWire>()
  for (const name of [...unique.keys()].sort()) {
    const prefix = prefixOf(name)
    const label = prefix !== undefined && (counts.get(prefix) ?? 0) >= 2 ? `${prefix}_*` : GENERAL_GROUP
    const group = groups.get(label) ?? { label, tools: [] }
    group.tools.push({ name, summary: toolSummary(unique.get(name) ?? '') })
    groups.set(label, group)
  }
  return [...groups.values()].sort((left, right) =>
    left.label === GENERAL_GROUP ? -1 : right.label === GENERAL_GROUP ? 1 : left.label.localeCompare(right.label))
}

export class DmMainToolCatalog {
  constructor(private readonly deps: DmMainToolCatalogDeps) {}

  /**
   * Save the tools one main Session sees (after its turns; best-effort).
   * @param agent - the main Session's Agent.
   */
  async observe(agent: Agent): Promise<void> {
    const tools = this.read(agent)
    if (tools === undefined) return
    const table = this.deps.table()
    if (table === undefined) return
    const saved = table.get(SNAPSHOT_KEY)
    if (saved !== undefined && sameTools(saved.tools, tools)) return
    try {
      await table.put(SNAPSHOT_KEY, { observedAt: this.now(), tools })
    } catch (error) {
      this.deps.warn('dsh-channels: saving the main-Session tool list failed: %s', String(error))
    }
  }

  /**
   * The checklist catalog: read from a live main Session when one exists
   * (and saved), otherwise the last saved list.
   * @returns the catalog, or undefined when no main Session was ever seen.
   */
  async catalog(): Promise<MainToolCatalogWire | undefined> {
    for (const agent of this.deps.mainAgents()) {
      const tools = this.read(agent)
      if (tools === undefined) continue
      await this.observe(agent)
      return this.wire(tools, this.now(), true)
    }
    const saved = this.deps.table()?.get(SNAPSHOT_KEY)
    return saved === undefined ? undefined : this.wire(saved.tools, saved.observedAt, false)
  }

  private read(agent: Agent): DmToolSnapshot['tools'] | undefined {
    const registry = this.deps.tools()
    if (registry === undefined) return undefined
    try {
      const tools = registry.definitions(agent)
        .map(definition => ({ name: definition.name, description: definition.description }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, SNAPSHOT_MAX_TOOLS)
      return tools.length === 0 ? undefined : tools
    } catch (error) {
      this.deps.warn('dsh-channels: reading the main-Session tool list failed: %s', String(error))
      return undefined
    }
  }

  private wire(tools: DmToolSnapshot['tools'], observedAt: number, live: boolean): MainToolCatalogWire {
    return { live, observedAt, groups: groupTools(tools), alwaysAllowed: [...ALWAYS_ALLOWED] }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function sameTools(left: DmToolSnapshot['tools'], right: DmToolSnapshot['tools']): boolean {
  return left.length === right.length
    && left.every((tool, index) => tool.name === right[index]?.name && tool.description === right[index]?.description)
}
