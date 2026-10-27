/**
 * Browser-half number fields: display-unit scaling, optional empty values,
 * bound messages in display units, and the byte reading.
 */

import { describe, expect, it } from 'vitest'
import { bytesReading, numberDraftValue, numberInputStep, numberInputValue } from '../src/client/number-field.ts'
import { PANEL_COPY } from '../src/settings/contract.ts'
import type { EditableFieldWire } from '../src/settings/contract.ts'

function numberField(partial: Partial<EditableFieldWire> = {}): EditableFieldWire {
  return {
    key: 'approvalTimeoutMs',
    label: '审批卡片等待',
    kind: 'number',
    group: 'cards',
    restartRequired: false,
    ...partial,
  }
}

const SECONDS = numberField({ min: 10_000, max: 3_600_000, step: 1_000, unit: '秒', scale: 1_000 })

describe('numberInputValue / numberInputStep', () => {
  it('shows stored values in display units and keeps typed text as is', () => {
    expect(numberInputValue(SECONDS, 300_000)).toBe('300')
    expect(numberInputValue(SECONDS, '12.5')).toBe('12.5')
    expect(numberInputValue(SECONDS, undefined)).toBe('')
    expect(numberInputValue(numberField({ scale: 86_400_000 }), 0.3 * 86_400_000)).toBe('0.3')
    expect(numberInputValue(numberField(), 750)).toBe('750')
  })

  it('scales the step into display units', () => {
    expect(numberInputStep(SECONDS)).toBe(1)
    expect(numberInputStep(numberField({ step: 100 }))).toBe(100)
    expect(numberInputStep(numberField())).toBeUndefined()
  })
})

describe('numberDraftValue', () => {
  it('converts typed display units back to stored units', () => {
    expect(numberDraftValue(SECONDS, ' 90 ')).toEqual({ ok: true, value: 90_000 })
    expect(numberDraftValue(numberField({ scale: 86_400_000 }), '1.5')).toEqual({ ok: true, value: 129_600_000 })
    expect(numberDraftValue(SECONDS, 300_000)).toEqual({ ok: true, value: 300_000 })
  })

  it('clears an optional field on empty input and rejects empty required input', () => {
    expect(numberDraftValue(numberField({ optional: true }), '  ')).toEqual({ ok: true, value: '' })
    expect(numberDraftValue(SECONDS, '')).toEqual({ ok: false, message: PANEL_COPY.numberInvalid })
    expect(numberDraftValue(SECONDS, 'abc')).toEqual({ ok: false, message: PANEL_COPY.numberInvalid })
  })

  it('reports bounds in display units with the unit', () => {
    const low = numberDraftValue(SECONDS, '5')
    expect(low.ok).toBe(false)
    expect(low.ok ? '' : low.message).toContain('10 秒')
    const high = numberDraftValue(SECONDS, '3601')
    expect(high.ok ? '' : high.message).toContain('3600 秒')
    const plain = numberDraftValue(numberField({ min: 1 }), '0')
    expect(plain.ok ? '' : plain.message).toContain('1')
  })
})

describe('bytesReading', () => {
  it('reads byte counts in binary units', () => {
    expect(bytesReading('512')).toBe('512 B')
    expect(bytesReading('20971520')).toBe('20 MiB')
    expect(bytesReading('1536')).toBe('1.5 KiB')
    expect(bytesReading('')).toBeUndefined()
    expect(bytesReading('0')).toBeUndefined()
    expect(bytesReading('x')).toBeUndefined()
  })
})
