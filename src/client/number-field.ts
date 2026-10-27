/**
 * 浏览器半区的 `number` 字段辅助：按 Host 描述的 `scale` 在显示单位与存储
 * 单位之间换算、保存前校验上下界，以及字节数的 MiB 读数。
 *
 * 不含 JSX/React，便于单测。Host 保存时按 config schema 复核。
 *
 * @module dsh-channels/client/number-field
 */

import { fillCopy, PANEL_COPY } from '../settings/contract.ts'
import type { ConfigValue, EditableFieldWire } from '../settings/contract.ts'

/** Drop float noise from `stored / scale` (e.g. 0.30000000000000004). */
function tidy(value: number): number {
  return Number(value.toPrecision(12))
}

/**
 * Value the input shows for one field.
 *
 * @param field - The Host descriptor (`kind: 'number'`).
 * @param value - Draft (the typed string) or effective value (stored units).
 * @returns The input text.
 */
export function numberInputValue(field: EditableFieldWire, value: ConfigValue | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'number') return ''
  return String(field.scale === undefined ? value : tidy(value / field.scale))
}

/**
 * Input `step` in display units.
 *
 * @param field - The Host descriptor (`kind: 'number'`).
 * @returns The step, or `undefined` when the Host gives none.
 */
export function numberInputStep(field: EditableFieldWire): number | undefined {
  if (field.step === undefined) return undefined
  return field.scale === undefined ? field.step : tidy(field.step / field.scale)
}

/** One bound in display units with the field's unit appended. */
function boundLabel(field: EditableFieldWire, stored: number): string {
  const shown = field.scale === undefined ? stored : tidy(stored / field.scale)
  return field.unit === undefined ? String(shown) : `${shown} ${field.unit}`
}

/**
 * Turn one number draft into its save payload, checking the Host bounds.
 *
 * @param field - The Host descriptor (`kind: 'number'`).
 * @param raw - The draft: the typed string, or a stored-unit number.
 * @returns The stored-unit value (`''` clears an optional field), or the reason it is rejected.
 */
export function numberDraftValue(
  field: EditableFieldWire,
  raw: ConfigValue | undefined,
): { ok: true; value: number | '' } | { ok: false; message: string } {
  let stored: number
  if (typeof raw === 'number') {
    stored = raw
  } else {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') {
      return field.optional === true ? { ok: true, value: '' } : { ok: false, message: PANEL_COPY.numberInvalid }
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return { ok: false, message: PANEL_COPY.numberInvalid }
    stored = field.scale === undefined ? parsed : Math.round(parsed * field.scale)
  }
  if (field.min !== undefined && stored < field.min) {
    return { ok: false, message: fillCopy(PANEL_COPY.numberMin, { n: boundLabel(field, field.min) }) }
  }
  if (field.max !== undefined && stored > field.max) {
    return { ok: false, message: fillCopy(PANEL_COPY.numberMax, { n: boundLabel(field, field.max) }) }
  }
  return { ok: true, value: stored }
}

/**
 * Human reading of a byte count, e.g. `20 MiB`.
 *
 * @param text - The input text (bytes).
 * @returns The reading, or `undefined` when the text is not a positive number.
 */
export function bytesReading(text: string): string | undefined {
  const bytes = Number(text)
  if (text.trim() === '' || !Number.isFinite(bytes) || bytes <= 0) return undefined
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Number(value.toFixed(value >= 100 || unit === 0 ? 0 : 1))} ${units[unit]}`
}
