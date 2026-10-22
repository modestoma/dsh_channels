/**
 * A1 notation helpers of the wiki sheet tools.
 */

import { describe, expect, it } from 'vitest'
import { columnIndex, columnLetters, isA1Range, parseCell, rangeEndRow, rectangle } from '../src/feishu/wiki/a1.ts'

describe('A1 helpers', () => {
  it('converts columns both ways up to ZZZ', () => {
    expect([columnIndex('A'), columnIndex('z'), columnIndex('AA'), columnIndex('ZZZ'), columnIndex('AAAA'), columnIndex('A1')])
      .toEqual([1, 26, 27, 18_278, undefined, undefined])
    expect([1, 26, 27, 702, 703, 18_278].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA', 'ZZZ'])
  })

  it('parses single cells and builds rectangles', () => {
    expect(parseCell(' b3 ')).toEqual({ column: 2, row: 3 })
    expect([parseCell('B0'), parseCell('B'), parseCell('A1:B2'), parseCell('A99999999')]).toEqual([undefined, undefined, undefined, undefined])
    expect(rectangle({ column: 2, row: 3 }, 2, 3)).toBe('B3:D4')
  })

  it('reads range end rows and accepts bare A1 ranges only', () => {
    expect([rangeEndRow('A1:B5'), rangeEndRow('C7'), rangeEndRow('A:C')]).toEqual([5, 7, undefined])
    expect(['A1', 'A1:F30', 'A:C', '3:5'].every(isA1Range)).toBe(true)
    expect(['Sheet1!A1', 'A1:B2:C3', '', 'A-1'].some(isA1Range)).toBe(false)
  })
})
