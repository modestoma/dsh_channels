/**
 * Browser-half「主会话可用工具」checklist: ticking and unticking edit the
 * `dmMainTools` string list, configured names the catalog lacks are listed
 * apart, and the note says where the list came from.
 */

import { describe, expect, it } from 'vitest'
import { toolCatalogNote, toolNames, unknownTools, withTool } from '../src/client/tool-checklist.ts'
import type { MainToolCatalogWire } from '../src/settings/contract.ts'

const catalog: MainToolCatalogWire = {
  live: false,
  observedAt: 1_000,
  groups: [
    { label: '通用', tools: [{ name: 'read', summary: 'Read a file.' }, { name: 'grep', summary: 'Search.' }] },
    { label: 'feishu_*', tools: [{ name: 'feishu_send_file', summary: 'Send a file.' }] },
  ],
  alwaysAllowed: [{ name: 'run_code', reason: 'PTC' }],
}

describe('main-Session tool checklist', () => {
  it('reads the draft as trimmed names without blanks or repeats', () => {
    expect(toolNames([' read ', '', 'grep', 'read'])).toEqual(['read', 'grep'])
    expect(toolNames(undefined)).toEqual([])
  })

  it('ticks by appending and unticks by removing', () => {
    expect(withTool(['read'], 'grep', true)).toEqual(['read', 'grep'])
    expect(withTool(['read', 'grep'], 'read', false)).toEqual(['grep'])
    expect(withTool(['read'], 'read', true)).toEqual(['read'])
  })

  it('lists configured names the catalog does not know', () => {
    expect(unknownTools(['read', 'bash', 'run_code', 'old_tool'], catalog)).toEqual(['bash', 'old_tool'])
  })

  it('says whether the list is live or saved', () => {
    expect(toolCatalogNote({ ...catalog, live: true }, () => 'T')).toContain('运行中的私聊主会话')
    expect(toolCatalogNote(catalog, ms => `t${ms}`)).toContain('t1000')
  })
})
