/**
 * 浏览器半区的设置面板选择器目录折叠：把 Host 下发的字段描述与实时目录
 * （`/dsh-channels/catalog`）合成通用表单需要的 select 描述。
 *
 * 拆成独立模块（不含 JSX/React）以便单测；`panel.tsx` 只负责串起状态与渲染。
 *
 * @module dsh-channels/client/catalog
 */

import { PANEL_COPY } from '../settings/contract.ts'
import type {
  CatalogWire,
  EditableFieldWire,
  EditableKey,
  FieldOptionWire,
  SelectCatalogWire,
} from '../settings/contract.ts'

/** Keys whose options come from the Host selector catalog. */
export const CATALOG_KEYS = ['provider', 'model', 'reasoningEffort', 'agentPreset'] as const
export type CatalogKey = (typeof CATALOG_KEYS)[number]

export function isCatalogKey(key: EditableKey): key is CatalogKey {
  return (CATALOG_KEYS as readonly string[]).includes(key)
}

/** Read one selector group back out of the Host-resolved panel fields. */
export function selectorOf(field: EditableFieldWire | undefined): SelectCatalogWire {
  if (field?.kind !== 'select') return { selectable: false, options: [] }
  return {
    selectable: true,
    options: field.options === undefined ? [] : [...field.options],
    ...(field.disabled === true ? { disabled: true } : {}),
    ...(field.help === undefined ? {} : { help: field.help }),
  }
}

/** Seed the client catalog from the options the Host already resolved for the panel. */
export function catalogFromFields(fields: readonly EditableFieldWire[]): CatalogWire | null {
  const byKey = new Map(fields.map(field => [field.key, field]))
  const catalog: CatalogWire = {
    provider: selectorOf(byKey.get('provider')),
    model: selectorOf(byKey.get('model')),
    reasoningEffort: selectorOf(byKey.get('reasoningEffort')),
    agentPreset: selectorOf(byKey.get('agentPreset')),
  }
  return CATALOG_KEYS.every(key => !catalog[key].selectable) ? null : catalog
}

/** Current-value option kept when a saved value is missing from the live list. */
function withCurrentOption(options: readonly FieldOptionWire[], value: string): FieldOptionWire[] {
  const [inherit, ...rest] = options
  const extra: FieldOptionWire = { value, label: `${value}（当前配置，不在宿主机列表中）` }
  return inherit === undefined ? [extra] : [inherit, extra, ...rest]
}

/**
 * Layer the live catalog over the Host panel fields. A group the Host cannot
 * enumerate falls back to the free-text control; the rest render as selects.
 *
 * `disabled` must be cleared explicitly: the Host's initial panel descriptor
 * carries `disabled: true` for dependent selectors (model without a provider,
 * effort without a model), and a fetched catalog that resolved the dependency
 * has to re-enable them. Forgetting this is exactly what made the model and
 * reasoning selects permanently unusable after choosing a provider/model.
 */
export function applyCatalogFields(
  fields: readonly EditableFieldWire[],
  catalog: CatalogWire | null,
  current: Partial<Record<CatalogKey, string | undefined>> = {},
): EditableFieldWire[] {
  if (catalog === null) return [...fields]
  return fields.map((field) => {
    if (!isCatalogKey(field.key)) return field
    const selector = catalog[field.key]
    if (!selector.selectable) {
      return field.kind === 'select'
        ? { ...field, kind: 'text', options: undefined, help: PANEL_COPY.catalogUnavailable, disabled: undefined }
        : field
    }
    const value = current[field.key] ?? ''
    const options = value !== '' && !selector.options.some(option => option.value === value)
      ? withCurrentOption(selector.options, value)
      : [...selector.options]
    const next: EditableFieldWire = { ...field, kind: 'select', options }
    if (selector.disabled === true) next.disabled = true
    else delete next.disabled
    if (selector.help === undefined) delete next.help
    else next.help = selector.help
    return next
  })
}