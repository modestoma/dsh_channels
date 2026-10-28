/**
 * Web 面板覆盖层：`$DSH_HOME/dsh-channels/settings.json` 的读写、schema 校验与合并。
 *
 * 设计取舍：
 *  - 覆盖层只存 Web 面板可编辑的字段（`EDITABLE_KEYS`），凭据引用刻意不可
 *    覆盖（变动等于换凭据）；`baseDir` 可覆盖，但走 `workspaces.ts` 的严格
 *    规范化（绝对路径 / `~` 展开 / 拒绝根目录），不接受相对路径。
 *  - 文件损坏/字段过期时**降级为空覆盖**并告警，绝不阻止飞书通道启动；
 *    面板保存时则由 zod 完整校验后整体落盘。
 *  - 写入走同目录临时文件 + rename，避免半截文件。
 *
 * @module dsh-channels/settings/overlay
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { configSchema, MOVED_ANALYZE_NOTICE, movedAnalyzeKeysOf } from '../config.ts'
import type { FeishuConfig } from '../config.ts'
import { normalizeWorkspaceBaseDir } from '../workspaces.ts'
import { EDITABLE_KEYS } from './contract.ts'
import type { ConfigValue, EditableKey, EditableValues } from './contract.ts'

/** Prefix of a nested panel key that addresses one `feishuTools` field. */
const FEISHU_TOOLS_PREFIX = 'feishuTools.'

/** Panel keys that address a nested `feishuTools` field (e.g. `feishuTools.topicMessages`). */
export type NestedEditableKey = Extract<EditableKey, `feishuTools.${string}`>

/** Panel keys that address a top-level config field. */
export type TopLevelEditableKey = Exclude<EditableKey, NestedEditableKey>

/** One partial `feishuTools` object inside the overlay layer. */
export type FeishuToolsOverlay = Partial<FeishuConfig['feishuTools']>

/**
 * The subset of `FeishuConfig` the Web panel may override. `feishuTools` stays
 * partial: the overlay only records the sub-fields the operator actually
 * changed, and the merge keeps every other value from the profile layer.
 */
export type OverlayPatch = Partial<Pick<FeishuConfig, TopLevelEditableKey>> & {
  feishuTools?: FeishuToolsOverlay
}

/** Whether one editable key addresses a nested `feishuTools` field. */
export function isNestedEditableKey(key: EditableKey): key is NestedEditableKey {
  return key.startsWith(FEISHU_TOOLS_PREFIX)
}

/** `attachmentFetch` for the panel key `feishuTools.attachmentFetch`. */
function nestedFieldOf(key: NestedEditableKey): keyof FeishuConfig['feishuTools'] {
  return key.slice(FEISHU_TOOLS_PREFIX.length) as keyof FeishuConfig['feishuTools']
}

/** The `feishuTools` object of an untyped overlay/config record, when usable. */
function toolsRecordOf(container: Record<string, unknown>): Record<string, unknown> | undefined {
  const tools = container.feishuTools
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return undefined
  return tools as Record<string, unknown>
}

/** Read one editable value out of an untyped overlay record (nested-aware). */
export function overlayValueOf(source: Record<string, unknown>, key: EditableKey): unknown {
  if (!isNestedEditableKey(key)) return source[key]
  return toolsRecordOf(source)?.[nestedFieldOf(key)]
}

/** Write one editable value into an untyped overlay record (nested-aware). */
export function setOverlayValue(target: Record<string, unknown>, key: EditableKey, value: unknown): void {
  if (!isNestedEditableKey(key)) {
    target[key] = value
    return
  }
  const tools = toolsRecordOf(target) ?? {}
  tools[nestedFieldOf(key)] = value
  target.feishuTools = tools
}

/** Read one editable value out of a resolved config (nested-aware). */
export function configValueOf(config: FeishuConfig, key: EditableKey): ConfigValue | undefined {
  if (!isNestedEditableKey(key)) return config[key] as ConfigValue | undefined
  return config.feishuTools[nestedFieldOf(key)] as ConfigValue | undefined
}

/** Deep-merge one overlay patch over another (only `feishuTools` is nested). */
export function mergeOverlayPatch(base: OverlayPatch, addition: OverlayPatch): OverlayPatch {
  const merged: OverlayPatch = { ...base, ...addition }
  if (base.feishuTools !== undefined || addition.feishuTools !== undefined) {
    merged.feishuTools = { ...base.feishuTools, ...addition.feishuTools }
  }
  return merged
}

/** Remove one editable key from an overlay patch (nested-aware). */
export function deleteOverlayKey(patch: OverlayPatch, key: EditableKey): void {
  if (!isNestedEditableKey(key)) {
    delete patch[key as TopLevelEditableKey]
    return
  }
  const tools = patch.feishuTools
  if (tools === undefined) return
  delete tools[nestedFieldOf(key)]
  if (Object.keys(tools).length === 0) delete patch.feishuTools
}

/** Fields whose empty string means "clear the override" (optional text config). */
const OPTIONAL_TEXT_KEYS = new Set<EditableKey>(['provider', 'model', 'reasoningEffort', 'agentPreset'])

/**
 * Validate only the keys actually present in the input. Validating through
 * the canonical `configSchema` field-by-field keeps one source of truth for
 * bounds/enums — and, unlike `z.object(shape).partial()`, it does not leak
 * schema defaults into the overlay (which would otherwise turn a one-field
 * edit into "override every editable key").
 */
export function parseOverlay(raw: unknown): { ok: true; patch: OverlayPatch } | { ok: false; issues: Array<{ path: string; message: string }> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '', message: '必须是 JSON 对象' }] }
  }
  const source = raw as Record<string, unknown>
  const issues: Array<{ path: string; message: string }> = []
  const patch: Record<string, unknown> = {}
  const shape = configSchema.shape as unknown as Record<string, z.ZodType>
  const toolsShape = configSchema.shape.feishuTools
  if (Object.hasOwn(source, 'feishuTools') && source.feishuTools !== undefined
    && toolsRecordOf(source) === undefined) {
    issues.push({ path: 'feishuTools', message: '必须是 JSON 对象' })
  }
  for (const key of EDITABLE_KEYS) {
    // Nested keys have no own property on the root object, so read through the
    // shared accessor instead of `Object.hasOwn`.
    const value = overlayValueOf(source, key)
    if (value === undefined) continue
    // `baseDir` needs location semantics the shared string schema cannot
    // express (absolute only, `~` expansion, no filesystem root).
    if (key === 'baseDir') {
      const checked = normalizeWorkspaceBaseDir(value)
      if (!checked.ok) issues.push({ path: key, message: checked.message })
      else setOverlayValue(patch, key, checked.value)
      continue
    }
    // Nested `feishuTools` values validate against the canonical sub-object
    // schema; only the edited sub-field is copied out of the parsed result so
    // schema defaults never leak into the overlay.
    const parsed = isNestedEditableKey(key)
      ? toolsShape.safeParse({ [nestedFieldOf(key)]: value })
      : shape[key]!.safeParse(value)
    if (!parsed.success) {
      issues.push({ path: key, message: parsed.error.issues[0]?.message ?? '非法值' })
      continue
    }
    const normalizedValue = isNestedEditableKey(key)
      ? (parsed.data as FeishuConfig['feishuTools'])[nestedFieldOf(key)]
      : parsed.data
    setOverlayValue(patch, key, normalizedValue)
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, patch: normalizeOverlay(patch) }
}

/** `$DSH_HOME` resolution shared with the rest of the DSH ecosystem. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Default overlay path: `$DSH_HOME/dsh-channels/settings.json`. */
export function defaultOverlayPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'dsh-channels', 'settings.json')
}

/** Warn sink used for degraded reads (never throws). */
export interface OverlayLogger {
  warn?(message: string, ...args: unknown[]): void
}

/** Strip `undefined`; drop empty-string overrides for optional text fields. */
export function normalizeOverlay(patch: Record<string, unknown>): OverlayPatch {
  const normalized: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    const value = overlayValueOf(patch, key)
    if (value === undefined) continue
    if (OPTIONAL_TEXT_KEYS.has(key) && value === '') continue
    setOverlayValue(normalized, key, value)
  }
  return normalized as OverlayPatch
}

/** Merge the Web overlay over the profile-provided base config. */
export function mergeOverlay(base: FeishuConfig, overlay: OverlayPatch): FeishuConfig {
  const { feishuTools, ...topLevel } = overlay
  const merged: FeishuConfig = { ...base, ...topLevel }
  if (feishuTools !== undefined) merged.feishuTools = { ...base.feishuTools, ...feishuTools }
  return merged
}

/** Project one config onto the editable-key subset (wire shape, nested keys dotted). */
export function pickEditable(config: FeishuConfig): Record<EditableKey, ConfigValue | undefined> {
  const picked: Record<string, ConfigValue | undefined> = {}
  for (const key of EDITABLE_KEYS) picked[key] = configValueOf(config, key)
  return picked as Record<EditableKey, ConfigValue | undefined>
}

/**
 * Project an overlay patch onto flat editable keys (nested `feishuTools.*`
 * values become dotted keys). The panel wire uses the same key space as
 * `fields` / `overriddenKeys`, so the client never has to know the nested
 * storage layout.
 */
export function overlayValues(patch: OverlayPatch): EditableValues {
  const values: Record<string, ConfigValue> = {}
  for (const key of EDITABLE_KEYS) {
    const value = overlayValueOf(patch as Record<string, unknown>, key)
    if (value !== undefined) values[key] = value as ConfigValue
  }
  return values as EditableValues
}

/**
 * One JSON overlay file. Reads degrade to `{}` with a warning; writes are
 * atomic and owner-readable only.
 */
export class OverlayStore {
  constructor(
    readonly file: string,
    private readonly logger?: OverlayLogger,
  ) {}

  /** Load the overlay; a missing/corrupt/stale file degrades to an empty overlay. */
  async load(): Promise<OverlayPatch> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn?.('dsh-channels: Web 覆盖配置读取失败（%s），按未覆盖处理：%s', this.file, String(error))
      }
      return {}
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      this.logger?.warn?.('dsh-channels: Web 覆盖配置不是合法 JSON（%s），按未覆盖处理：%s', this.file, String(error))
      return {}
    }
    const moved = movedAnalyzeKeysOf(raw)
    if (moved.length > 0) this.logger?.warn?.(MOVED_ANALYZE_NOTICE, `${this.file} 中的 ${moved.join('、')}`)
    const parsed = parseOverlay(raw)
    if (!parsed.ok) {
      this.logger?.warn?.(
        'dsh-channels: Web 覆盖配置含非法字段（%s），按未覆盖处理：%s',
        this.file,
        parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '),
      )
      return {}
    }
    return parsed.patch
  }

  /** Persist the validated overlay atomically. */
  async save(patch: OverlayPatch): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(normalizeOverlay(patch as Record<string, unknown>), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await fs.rename(temporary, this.file)
  }

  /** Remove the overlay file; the plugin falls back to the profile config. */
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true })
  }
}
