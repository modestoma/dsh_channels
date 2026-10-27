/**
 * A1 notation helpers for the wiki sheet tools: column letters, single cells,
 * and rectangle end rows. Ranges never carry a sheet prefix (`Sheet1!`); the
 * sub-sheet is selected separately.
 *
 * @module dsh-channels/feishu/wiki/a1
 */

/** Largest column the helpers accept (`ZZZ`). */
const MAX_COLUMN = 18_278

/** Largest row the helpers accept. */
const MAX_ROW = 10_000_000

/** One cell position, 1-based. */
export interface A1Cell {
  readonly column: number
  readonly row: number
}

/**
 * Column letters to a 1-based index (`A` → 1, `AA` → 27).
 *
 * @param letters Column letters, any case.
 * @returns The index, or undefined when invalid or beyond `ZZZ`.
 */
export function columnIndex(letters: string): number | undefined {
  if (!/^[A-Za-z]{1,3}$/u.test(letters)) return undefined
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return index <= MAX_COLUMN ? index : undefined
}

/**
 * A 1-based column index to letters (1 → `A`, 27 → `AA`).
 *
 * @param index Column index, at least 1.
 * @returns The letters.
 */
export function columnLetters(index: number): string {
  let letters = ''
  let rest = index
  while (rest > 0) {
    const digit = (rest - 1) % 26
    letters = String.fromCharCode(65 + digit) + letters
    rest = Math.floor((rest - 1) / 26)
  }
  return letters
}

/**
 * Parse one cell (`B3`).
 *
 * @param value Cell reference.
 * @returns The position, or undefined when it is not a single valid cell.
 */
export function parseCell(value: string): A1Cell | undefined {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,7})$/u.exec(value.trim())
  if (match === null) return undefined
  const column = columnIndex(match[1] ?? '')
  const row = Number(match[2])
  return column === undefined || row > MAX_ROW ? undefined : { column, row }
}

/**
 * The rectangle that starts at `start` and spans `rows` × `columns` cells.
 *
 * @param start Top-left cell.
 * @param rows Row count, at least 1.
 * @param columns Column count, at least 1.
 * @returns The range (`B3:D10`).
 */
export function rectangle(start: A1Cell, rows: number, columns: number): string {
  return `${columnLetters(start.column)}${start.row}:${columnLetters(start.column + columns - 1)}${start.row + rows - 1}`
}

/**
 * Last row of a range (`A1:B5` → 5, `C7` → 7); undefined for whole-column ranges (`A:C`).
 *
 * @param range A1 range.
 * @returns The row, or undefined.
 */
export function rangeEndRow(range: string): number | undefined {
  const end = range.split(':').at(-1) ?? ''
  const match = /(\d+)$/u.exec(end.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * Whether a range is plain A1 (`A1`, `A1:F30`, `A:C`, `3:5`) without a sheet prefix.
 *
 * @param range Candidate range.
 * @returns True when acceptable.
 */
export function isA1Range(range: string): boolean {
  return /^(?:[A-Za-z]{1,3}\d{0,8}|\d{1,8})(?::(?:[A-Za-z]{1,3}\d{0,8}|\d{1,8}))?$/u.test(range)
}
