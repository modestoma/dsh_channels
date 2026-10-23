/**
 * Browser-half selector folding: Host panel descriptors + live catalog →
 * generic form fields. Covers the regression where a dependent selector that
 * the Host initially marked `disabled` stayed unusable after the fetched
 * catalog resolved its dependency.
 */

import { describe, expect, it } from 'vitest'
import { applyCatalogFields, catalogFromFields } from '../src/client/catalog.ts'
import type { CatalogWire, EditableFieldWire, EditableKey } from '../src/settings/contract.ts'

function makeField(
  key: EditableKey,
  partial: Partial<EditableFieldWire> = {},
): EditableFieldWire {
  return {
    key,
    label: key,
    kind: 'text',
    group: 'model',
    restartRequired: false,
    ...partial,
  }
}

/** The initial Host panel: nothing configured, so the dependent selectors are disabled. */
function initialFields(): EditableFieldWire[] {
  return [
    makeField('provider', {
      kind: 'select',
      options: [
        { value: '', label: '留空 = 部署默认（deepseek-account）' },
        { value: 'deepseek-account', label: 'DeepSeek Account（deepseek-account）' },
      ],
    }),
    makeField('model', {
      kind: 'select',
      disabled: true,
      help: '先选择模型服务商，再选择模型 id。留空表示沿用部署默认。',
      options: [{ value: '', label: '留空 = 部署默认（deepseek-flash）' }],
    }),
    makeField('reasoningEffort', {
      kind: 'select',
      disabled: true,
      help: '先选择模型服务商与模型 id，再选择推理档位。',
      options: [{ value: '', label: '留空 = 适配器默认' }],
    }),
    makeField('agentPreset', {
      kind: 'select',
      options: [
        { value: '', label: '留空 = roster 默认（standard）' },
        { value: 'standard', label: 'standard' },
      ],
    }),
  ]
}

/** Catalog after a provider is chosen: the model list is available. */
const PROVIDER_CHOSEN: CatalogWire = {
  provider: {
    selectable: true,
    options: [
      { value: '', label: '留空 = 部署默认（deepseek-account）' },
      { value: 'deepseek-account', label: 'DeepSeek Account（deepseek-account）' },
    ],
  },
  model: {
    selectable: true,
    options: [
      { value: '', label: '留空 = 部署默认（deepseek-flash）' },
      { value: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash（deepseek-flash）' },
    ],
  },
  reasoningEffort: {
    selectable: true,
    disabled: true,
    help: '先选择模型服务商与模型 id，再选择推理档位。',
    options: [{ value: '', label: '留空 = 适配器默认' }],
  },
  agentPreset: {
    selectable: true,
    options: [
      { value: '', label: '留空 = roster 默认（standard）' },
      { value: 'standard', label: 'standard' },
    ],
  },
}

describe('catalogFromFields', () => {
  it('returns null when the Host could not resolve any selector', () => {
    const fields = [
      makeField('provider'), makeField('model'), makeField('reasoningEffort'), makeField('agentPreset'),
    ]
    expect(catalogFromFields(fields)).toBeNull()
  })

  it('seeds the catalog from the Host-resolved select descriptors', () => {
    const catalog = catalogFromFields(initialFields())
    expect(catalog).not.toBeNull()
    expect(catalog?.provider.selectable).toBe(true)
    expect(catalog?.model.disabled).toBe(true)
    expect(catalog?.reasoningEffort.disabled).toBe(true)
    expect(catalog?.agentPreset.options.map(option => option.value)).toEqual(['', 'standard'])
  })
})

describe('applyCatalogFields', () => {
  it('re-enables a dependent selector the live catalog resolved', () => {
    const fields = applyCatalogFields(initialFields(), PROVIDER_CHOSEN, { provider: 'deepseek-account' })
    const model = fields.find(field => field.key === 'model')
    // The Host's initial descriptor had disabled: true; the fetched catalog
    // resolved the provider dependency, so the control must be usable.
    expect(model?.kind).toBe('select')
    expect(model?.disabled).toBeUndefined()
    expect(model?.options?.map(option => option.value)).toEqual(['', 'deepseek-flash'])
    expect(model?.help).toBeUndefined()
  })

  it('keeps a selector disabled while the catalog still says so', () => {
    const fields = applyCatalogFields(initialFields(), PROVIDER_CHOSEN, { provider: 'deepseek-account' })
    const effort = fields.find(field => field.key === 'reasoningEffort')
    expect(effort?.kind).toBe('select')
    expect(effort?.disabled).toBe(true)
    expect(effort?.help).toContain('先选择')
  })

  it('falls back to a text control when a group is not enumerable', () => {
    const catalog: CatalogWire = {
      ...PROVIDER_CHOSEN,
      model: { selectable: false, options: [] },
    }
    const fields = applyCatalogFields(initialFields(), catalog, {})
    const model = fields.find(field => field.key === 'model')
    expect(model?.kind).toBe('text')
    expect(model?.options).toBeUndefined()
    expect(model?.help).toContain('手填')
  })

  it('keeps a configured value the catalog does not advertise', () => {
    const fields = applyCatalogFields(initialFields(), PROVIDER_CHOSEN, { model: 'legacy-model' })
    const model = fields.find(field => field.key === 'model')
    expect(model?.options?.map(option => option.value))
      .toEqual(['', 'legacy-model', 'deepseek-flash'])
    expect(model?.options?.[1]?.label).toContain('当前配置')
  })

  it('leaves non-selector fields untouched', () => {
    const baseDir = makeField('baseDir', { kind: 'text', wide: true })
    const fields = applyCatalogFields([...initialFields(), baseDir], PROVIDER_CHOSEN, {})
    expect(fields.find(field => field.key === 'baseDir')).toEqual(baseDir)
  })

  it('passes the attachment controls through unchanged', () => {
    const attachments = makeField('acceptAttachments', { kind: 'boolean', group: 'attachments' })
    const fields = applyCatalogFields([...initialFields(), attachments], PROVIDER_CHOSEN, {})
    expect(fields.find(field => field.key === 'acceptAttachments')).toEqual(attachments)
  })
})
