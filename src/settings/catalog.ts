/**
 * Web 设置面板的 Host 侧选择器目录：把宿主 LLM 服务注册的 provider / model
 * / 推理档位，以及 agent-preset roster 折叠成面板可渲染的选项列表。
 *
 * 目录只用于「选择」：任何查询失败（服务未挂载、方法缺失、超时、抛错）都
 * 降级为 `selectable: false`，客户端据此退回原有自由文本输入框，绝不让
 * 面板加载依赖宿主的网络状态。成功结果按短 TTL 缓存，避免用户来回切换
 * provider/model 时反复查询适配器。
 *
 * @module dsh-channels/settings/catalog
 */

import type {
  AgentDefaultModel,
  AgentPreset,
  AgentPresets,
  HostContext,
  LlmModelInfo,
  LlmProviderInfo,
} from '../dsh-types.ts'
import type { CatalogWire, FieldOptionWire, SelectCatalogWire } from './contract.ts'

/** 目录查询的硬上限：面板加载不能被宿主的模型发现/连接拖住。 */
const LOOKUP_TIMEOUT_MS = 4_000

/** 成功查询的缓存时长（毫秒）。 */
const CACHE_TTL_MS = 30_000

export type CatalogWarn = (message: string, ...args: unknown[]) => void

/** Host capability used by the settings panel to populate its selectors. */
export interface SettingsCatalog {
  /**
   * Resolve the selector catalog for one configured route.
   * @param provider - configured provider route (absent = inherit deployment default).
   * @param model - configured model id (absent = inherit deployment default).
   * @returns selector options; groups the host cannot enumerate are `selectable: false`.
   */
  catalog(provider?: string, model?: string): Promise<CatalogWire>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve `work` or `undefined` after `ms`, so a hanging adapter cannot stall the panel. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { resolve(undefined) }, ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Leading "inherit / clear" choice every selector gets. */
function inheritOption(label: string): FieldOptionWire {
  return { value: '', label }
}

/** `Display name（id）` when the host publishes both, else the id alone. */
function labelledOption(id: string, name: string | undefined): FieldOptionWire {
  const display = name === undefined ? '' : name.trim()
  return { value: id, label: display === '' || display === id ? id : `${display}（${id}）` }
}

/** Non-empty display text, otherwise undefined. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Build the catalog over one live host context.
 * @param ctx - host context carrying `llm` and the optional preset/default-model services.
 * @param warn - optional diagnostic sink for failed lookups.
 * @returns the catalog facade.
 */
export function createHostCatalog(ctx: HostContext, warn?: CatalogWarn): SettingsCatalog {
  const llm = ctx.llm
  const presets = ctx.get?.('agentPresets') as AgentPresets | undefined
  const defaultModel = ctx.get?.('agentDefaultModel') as AgentDefaultModel | undefined
  const cache = new Map<string, { at: number; value: unknown }>()

  /** Cache a successful lookup; failures are re-tried on the next panel refresh. */
  async function cached<T>(key: string, load: () => Promise<T> | T): Promise<T | undefined> {
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T
    try {
      const value = await within(Promise.resolve(load()), LOOKUP_TIMEOUT_MS)
      if (value === undefined) return undefined
      cache.set(key, { at: Date.now(), value })
      return value
    } catch (error) {
      warn?.('dsh-channels: 读取 %s 选择目录失败：%s', key, messageOf(error))
      return undefined
    }
  }

  /** Registered provider routes, `undefined` when the deployment exposes none. */
  async function providerOptions(): Promise<FieldOptionWire[] | undefined> {
    if (typeof llm.listProviders !== 'function') return undefined
    const rows = await cached<readonly LlmProviderInfo[]>('providers', () => llm.listProviders!())
    if (rows === undefined) return undefined
    const options: FieldOptionWire[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const id = textOf((row as { id?: unknown } | undefined)?.id)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      options.push(labelledOption(id, textOf((row as { name?: unknown }).name)))
    }
    return options.length === 0 ? undefined : options
  }

  /** Models advertised for one provider route, `undefined` when it has no catalog. */
  async function modelOptions(provider: string): Promise<FieldOptionWire[] | undefined> {
    if (provider === '' || typeof llm.listModels !== 'function') return undefined
    const rows = await cached<readonly LlmModelInfo[]>(`models:${provider}`, () => llm.listModels!(provider))
    if (rows === undefined) return undefined
    const options: FieldOptionWire[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const id = textOf((row as { id?: unknown } | undefined)?.id)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      options.push(labelledOption(id, textOf((row as { name?: unknown }).name)))
    }
    return options.length === 0 ? undefined : options
  }

  /** Adapter metadata for one exact route; `undefined` when it cannot be resolved. */
  async function modelInfo(provider: string, model: string): Promise<LlmModelInfo | undefined> {
    if (provider === '' || model === '') return undefined
    return await cached<LlmModelInfo>(`model-info:${provider}/${model}`, () => llm.resolveModelInfo(provider, model))
  }

  /** Declared preset rows, `undefined` when the roster has no `list()` or no rows. */
  async function presetRows(): Promise<readonly AgentPreset[] | undefined> {
    if (typeof presets?.list !== 'function') return undefined
    const rows = await cached<readonly AgentPreset[]>('presets', () => presets!.list!())
    if (rows === undefined || rows.length === 0) return undefined
    const filtered = rows.filter(row => textOf((row as { id?: unknown } | undefined)?.id) !== undefined)
    return filtered.length === 0 ? undefined : filtered
  }

  /** Roster default preset id, when the implementation publishes it. */
  function defaultPresetId(): string | undefined {
    try {
      return textOf(presets?.defaultId)
    } catch {
      return undefined
    }
  }

  /** Deployment default model selection, when the host exposes `agentDefaultModel`. */
  function deploymentDefault(): CatalogWire['deploymentDefault'] | undefined {
    try {
      const selection = defaultModel?.currentSelection?.()
      const provider = textOf(selection?.provider)
      const model = textOf(selection?.model)
      if (provider === undefined || model === undefined) return undefined
      const reasoningEffort = textOf(selection?.reasoningEffort)
      return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    } catch {
      return undefined
    }
  }

  /** Selector for the configured provider route. */
  function providerWire(
    providers: readonly FieldOptionWire[] | undefined,
    deployment: CatalogWire['deploymentDefault'],
  ): SelectCatalogWire {
    if (providers === undefined) return { selectable: false, options: [] }
    const label = deployment?.provider === undefined
      ? '留空 = 部署默认'
      : `留空 = 部署默认（${deployment.provider}）`
    return { selectable: true, options: [inheritOption(label), ...providers] }
  }

  /** Selector for the configured model id. */
  function modelWire(
    models: readonly FieldOptionWire[] | undefined,
    provider: string,
    deployment: CatalogWire['deploymentDefault'],
    providers: readonly FieldOptionWire[] | undefined,
  ): SelectCatalogWire {
    const label = deployment?.model === undefined
      ? '留空 = 部署默认'
      : `留空 = 部署默认（${deployment.model}）`
    if (models === undefined) {
      // Provider selectable but none configured yet: keep the model selector
      // visible and disabled so the dependency is discoverable. A provider the
      // adapter cannot enumerate instead falls back to free text.
      if (providers !== undefined && provider === '') {
        return {
          selectable: true,
          options: [inheritOption(label)],
          disabled: true,
          help: '先选择模型服务商，再选择模型 id。留空表示沿用部署默认。',
        }
      }
      return { selectable: false, options: [] }
    }
    const select: SelectCatalogWire = {
      selectable: true,
      options: [inheritOption(label), ...models],
    }
    if (provider === '') {
      select.disabled = true
      select.help = '先选择模型服务商，再选择模型 id。留空表示沿用部署默认。'
    }
    return select
  }

  /** Selector for the configured reasoning effort. */
  function effortWire(
    info: LlmModelInfo | undefined,
    provider: string,
    model: string,
    providers: readonly FieldOptionWire[] | undefined,
  ): SelectCatalogWire {
    // 无法枚举 provider 时，整条选择链都退回自由文本输入。
    if (providers === undefined) return { selectable: false, options: [] }
    if (provider === '' || model === '') {
      return {
        selectable: true,
        options: [inheritOption('留空 = 适配器默认')],
        disabled: true,
        help: '先选择模型服务商与模型 id，再选择推理档位。',
      }
    }
    // 路由无法解析（适配器报错/超时）：退回自由文本，保留手填能力。
    if (info === undefined) return { selectable: false, options: [] }
    const efforts = (info.reasoning?.efforts ?? [])
      .filter(effort => textOf(effort.id) !== undefined)
      .map(effort => labelledOption(effort.id, textOf(effort.name)))
    if (efforts.length === 0) {
      return {
        selectable: true,
        options: [inheritOption('留空 = 适配器默认')],
        disabled: true,
        help: '当前模型没有声明可选推理档位，只能使用适配器默认。',
      }
    }
    const defaultEffort = textOf(info.reasoning?.defaultEffort)
    return {
      selectable: true,
      options: [
        inheritOption(defaultEffort === undefined
          ? '留空 = 适配器默认'
          : `留空 = 适配器默认（${defaultEffort}）`),
        ...efforts,
      ],
    }
  }

  /** Selector for the agent preset id. */
  function presetWire(
    rows: readonly AgentPreset[] | undefined,
    defaultId: string | undefined,
  ): SelectCatalogWire {
    if (rows === undefined) return { selectable: false, options: [] }
    const options = rows.map((row) => {
      const id = textOf(row.id)!
      const option = labelledOption(id, textOf(row.name))
      if (row.broken === undefined) return option
      return { ...option, label: `${option.label}（不可用）` }
    })
    return {
      selectable: true,
      options: [
        inheritOption(defaultId === undefined ? '留空 = roster 默认' : `留空 = roster 默认（${defaultId}）`),
        ...options,
      ],
    }
  }

  return {
    async catalog(provider?: string, model?: string): Promise<CatalogWire> {
      const wantedProvider = textOf(provider) ?? ''
      const wantedModel = textOf(model) ?? ''
      const deployment = deploymentDefault()
      const defaultPreset = defaultPresetId()

      const [providers, models, info, rows] = await Promise.all([
        providerOptions(),
        modelOptions(wantedProvider),
        modelInfo(wantedProvider, wantedModel),
        presetRows(),
      ])

      return {
        provider: providerWire(providers, deployment),
        model: modelWire(models, wantedProvider, deployment, providers),
        reasoningEffort: effortWire(info, wantedProvider, wantedModel, providers),
        agentPreset: presetWire(rows, defaultPreset),
        ...(deployment === undefined ? {} : { deploymentDefault: deployment }),
        ...(defaultPreset === undefined ? {} : { defaultPresetId: defaultPreset }),
      }
    },
  }
}
