/**
 * Web 面板覆盖层：`$DSH_HOME/dsh-channels/settings.json` 的读写、schema 校验与合并。
 *
 * 设计取舍：
 *  - 覆盖层只存 Web 面板可编辑的字段（`EDITABLE_KEYS`），凭据引用与 baseDir
 *    刻意不可覆盖 —— 前者变动等于换凭据，后者会让已有工作区路径失配。
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
import { configSchema } from '../config.ts'
import type { FeishuConfig } from '../config.ts'
import { EDITABLE_KEYS } from './contract.ts'
import type { ConfigValue, EditableKey } from './contract.ts'

/** The subset of `FeishuConfig` the Web panel may override. */
export type OverlayPatch = Partial<Pick<FeishuConfig, EditableKey>>

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
  for (const key of EDITABLE_KEYS) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (value === undefined) continue
    const parsed = shape[key]!.safeParse(value)
    if (!parsed.success) {
      issues.push({ path: key, message: parsed.error.issues[0]?.message ?? '非法值' })
      continue
    }
    patch[key] = parsed.data
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
    const value = patch[key]
    if (value === undefined) continue
    if (OPTIONAL_TEXT_KEYS.has(key) && value === '') continue
    normalized[key] = value
  }
  return normalized as OverlayPatch
}

/** Merge the Web overlay over the profile-provided base config. */
export function mergeOverlay(base: FeishuConfig, overlay: OverlayPatch): FeishuConfig {
  return { ...base, ...overlay }
}

/** Project one config onto the editable-key subset (wire shape). */
export function pickEditable(config: FeishuConfig): Record<EditableKey, ConfigValue | undefined> {
  const picked: Record<string, ConfigValue | undefined> = {}
  for (const key of EDITABLE_KEYS) picked[key] = config[key] as ConfigValue | undefined
  return picked as Record<EditableKey, ConfigValue | undefined>
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
