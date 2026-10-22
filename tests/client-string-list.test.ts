/**
 * Browser-half `string-list` fields: draft validation before save (per-entry
 * issues carry the input index, empty inputs are ignored) and the row
 * operations behind the one-input-per-entry control (add / edit / remove,
 * add disabled at `maxItems`).
 */

import { describe, expect, it } from 'vitest'
import {
  listIsFull,
  listItems,
  listRows,
  stringListDraftValue,
  stringListIssues,
  withBlankListEntry,
  withListEntry,
  withoutListEntry,
} from '../src/client/string-list.ts'
import { WIKI_ROOT_LINK_ERRORS } from '../src/feishu/wiki/links.ts'
import type { EditableFieldWire } from '../src/settings/contract.ts'
import { FIELD_DESCRIPTORS } from '../src/settings/surface.ts'

const SPACE = 'https://acme.feishu.cn/wiki/space/7012345678901234567'
const NODE = 'https://acme.feishu.cn/wiki/AbCdEf1234567890'

/** The Host descriptor the panel receives for `wikiRoots`. */
function rootsField(partial: Partial<EditableFieldWire> = {}): EditableFieldWire {
  const field = FIELD_DESCRIPTORS.find(item => item.key === 'wikiRoots')
  if (field === undefined) throw new Error('wikiRoots descriptor missing')
  return { ...field, ...partial }
}

describe('string-list draft validation', () => {
  it('reads only list values as entries', () => {
    expect(listItems([SPACE])).toEqual([SPACE])
    expect(listItems(undefined)).toEqual([])
    expect(listItems('x')).toEqual([])
  })

  it('reports each invalid entry with its input index and ignores empty inputs', () => {
    const issues = stringListIssues(rootsField(), [SPACE, '', ' http://acme.feishu.cn/wiki/space/1 ', NODE, 'nope'])
    expect(issues).toEqual([
      { key: 'wikiRoots', index: 2, message: `第 3 项「http://acme.feishu.cn/wiki/space/1」：${WIKI_ROOT_LINK_ERRORS['not-https']}` },
      { key: 'wikiRoots', index: 4, message: `第 5 项「nope」：${WIKI_ROOT_LINK_ERRORS['not-a-url']}` },
    ])
  })

  it('accepts any entry when the field declares no item format', () => {
    expect(stringListIssues(rootsField({ itemFormat: undefined }), ['anything'])).toEqual([])
  })

  it('bounds the non-empty entry count by maxItems', () => {
    const field = rootsField({ maxItems: 2 })
    expect(stringListIssues(field, [SPACE, NODE, '', ' '])).toEqual([])
    expect(stringListIssues(field, [SPACE, NODE, SPACE])).toEqual([
      { key: 'wikiRoots', message: '最多 2 项（空输入框不计）' },
    ])
  })

  it('submits valid entries as typed and blocks the save on an invalid entry', () => {
    expect(stringListDraftValue(rootsField(), [` ${SPACE}`, ''])).toEqual({ ok: true, value: [` ${SPACE}`, ''] })
    expect(stringListDraftValue(rootsField(), [SPACE, 'https://acme.feishu.cn/docx/AbCdEf1234567890'])).toEqual({
      ok: false,
      issues: [{
        key: 'wikiRoots',
        index: 1,
        message: `第 2 项「https://acme.feishu.cn/docx/AbCdEf1234567890」：${WIKI_ROOT_LINK_ERRORS['not-a-wiki-link']}`,
      }],
    })
  })
})

describe('string-list control rows', () => {
  it('renders one blank input for an empty list', () => {
    expect(listRows([])).toEqual([''])
    expect(listRows(undefined)).toEqual([''])
    expect(withListEntry(listRows([]), 0, SPACE)).toEqual([SPACE])
  })

  it('edits, removes, and appends entries by input position', () => {
    const rows = listRows([SPACE, NODE])
    expect(rows).toEqual([SPACE, NODE])
    expect(withListEntry(rows, 1, 'x')).toEqual([SPACE, 'x'])
    expect(withoutListEntry(rows, 0)).toEqual([NODE])
    expect(withBlankListEntry(rows)).toEqual([SPACE, NODE, ''])
  })

  it('disables adding at maxItems inputs', () => {
    expect(listIsFull(rootsField({ maxItems: 2 }), [SPACE, NODE])).toBe(true)
    expect(listIsFull(rootsField({ maxItems: 2 }), [SPACE])).toBe(false)
    expect(listIsFull(rootsField({ maxItems: undefined }), [SPACE, NODE])).toBe(false)
  })
})
