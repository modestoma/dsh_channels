/**
 * Cards of the per-user model feature: the `/model` selector (default
 * endpoint models, the user's own endpoint models, reasoning effort) and the
 * private-chat `/llm` form that binds the user's own endpoint.
 *
 * Every action carries the `owner` user_id; only that user's clicks count.
 * The bind form's API key travels in the card callback's `form_value`, never
 * in a chat message, and no card ever renders a key.
 *
 * @module dsh-channels/llm/cards
 */

import { PERSONAL_LLM_APIS } from '../domain.ts'
import type { PersonalLlmApi } from '../domain.ts'
import { columnSet, divider, markdown, note, standaloneCard, textButton } from '../cards/primitives.ts'

/** `decision` of every `/model` selector button. */
export const LLM_PREF_ACTION = 'llm-pref'

/** `decision` of the `/llm` form buttons. */
export const LLM_BIND_ACTION = 'llm-bind'

/** Longest model list rendered as buttons; longer lists render as one dropdown. */
export const MAX_MODEL_BUTTONS = 8

/** Cap on dropdown options (card payload size). */
const MAX_MODEL_OPTIONS = 200

/** One `/model` selector click. */
export type LlmPrefAction =
  | {
    decision: typeof LLM_PREF_ACTION
    kind: 'model'
    owner: string
    source: 'default' | 'own'
    /** Model id; `''` on the default endpoint follows the administrator's default model. */
    model: string
    /** Session the selector also switches. */
    sessionId?: string
  }
  | {
    decision: typeof LLM_PREF_ACTION
    kind: 'effort'
    owner: string
    /** Effort id; `''` follows the default effort of the chosen model. */
    effort: string
    sessionId?: string
  }
  | { decision: typeof LLM_PREF_ACTION; kind: 'bind-form'; owner: string }

/** One `/llm` form click. */
export interface LlmBindAction {
  decision: typeof LLM_BIND_ACTION
  kind: 'submit' | 'unbind'
  owner: string
}

/** The `/llm` form fields read from a submit callback. */
export interface LlmBindForm {
  api: string
  baseURL: string
  apiKey: string
}

/** Display label of each personal endpoint protocol. */
export const API_LABELS: Readonly<Record<PersonalLlmApi, string>> = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

/** Where a model choice points. `other` is a route outside both endpoints. */
export type ChoiceEndpoint = 'default' | 'own' | 'other'

/** Render input of the `/model` selector. */
export interface ModelCardView {
  owner: string
  /** Present when a click also switches this Session. */
  sessionId?: string
  /** Whether `/llm` binding is available in this deployment. */
  bindable: boolean
  /** The administrator's default endpoint. */
  defaults: {
    /** Default model id, when known. */
    model?: string
    /** Models the default route advertises. */
    models: readonly string[]
    /** The administrator's effort on the default model. */
    effort?: string
  }
  /** The user's own endpoint, when bound. */
  own?: { baseURL: string; models: readonly string[] }
  /** The stored choice: endpoint and model (`undefined` = that endpoint's default). */
  selected: { source: 'default' | 'own'; model?: string }
  /** Efforts the chosen model advertises. */
  efforts: readonly { id: string; name: string }[]
  /** The stored effort (`undefined` = the chosen model's default). */
  effort?: string
  /** What the bound Session uses now, when it differs from the stored choice. */
  session?: { endpoint: ChoiceEndpoint; provider?: string; model?: string; effort?: string }
  /** One-line result of the last click. */
  notice?: string
  /** Render nonce carried by every control. */
  rev?: string
}

/**
 * Callback value of one selector control. `rev` leads the object: the
 * channel deduplicates clicks by the first 128 characters of the value, so
 * the nonce must fall inside them for a repeated choice on a redrawn card to
 * stay a distinct click.
 */
function prefValue(view: ModelCardView, action: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(view.rev === undefined ? {} : { rev: view.rev }),
    decision: LLM_PREF_ACTION,
    owner: view.owner,
    ...action,
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
  }
}

function choiceButton(label: string, active: boolean, value: Record<string, unknown>): object {
  return textButton({ label: active ? `✅ ${label}` : label, type: active ? 'primary' : 'default', value })
}

/** Lay buttons out two per row. */
function pairs(buttons: readonly object[]): object[] {
  const rows: object[] = []
  for (let index = 0; index < buttons.length; index += 2) rows.push(columnSet(buttons.slice(index, index + 2)))
  return rows
}

/** One endpoint's model choices as an ordered list of `{ id, label, value }`. */
interface ModelOption {
  /** Model id the click selects (`''` = the administrator's default). */
  value: string
  label: string
  active: boolean
}

/**
 * Model controls of one endpoint: buttons for a short list, one dropdown
 * for a long one. A dropdown click carries the picked model in the
 * callback's `option`.
 */
function modelControls(view: ModelCardView, source: 'default' | 'own', options: readonly ModelOption[]): object[] {
  if (options.length <= MAX_MODEL_BUTTONS) {
    return pairs(options.map(option => choiceButton(
      option.label, option.active, prefValue(view, { kind: 'model', source, model: option.value }),
    )))
  }
  const shown = options.slice(0, MAX_MODEL_OPTIONS)
  const active = shown.find(option => option.active)
  const rows: object[] = [{
    tag: 'select_static',
    name: `llm_model_${source}`,
    placeholder: { tag: 'plain_text', content: '选择模型' },
    options: shown.map(option => ({
      text: { tag: 'plain_text', content: option.label },
      // A dropdown option needs a non-empty value; the default model is named.
      value: option.value === '' ? DEFAULT_MODEL_OPTION : option.value,
    })),
    ...(active === undefined ? {} : { initial_option: active.value === '' ? DEFAULT_MODEL_OPTION : active.value }),
    width: 'fill',
    margin: '4px 0 0 0',
    behaviors: [{ type: 'callback', value: prefValue(view, { kind: 'model', source, pick: true }) }],
  }]
  if (options.length > shown.length) rows.push(note(`只列出前 ${shown.length} 个模型。`))
  return rows
}

/** Dropdown option value of the administrator's default model. */
const DEFAULT_MODEL_OPTION = '@@default'

/** Default endpoint options: the administrator's default model first, marked. */
function defaultModelOptions(view: ModelCardView): ModelOption[] {
  const selected = view.selected.source === 'default' ? view.selected.model ?? '' : undefined
  const defaultModel = view.defaults.model
  const first: ModelOption = {
    value: '',
    label: defaultModel === undefined ? '部署默认模型' : `${defaultModel}（缺省）`,
    active: selected === '' || (selected !== undefined && selected === defaultModel),
  }
  return [first, ...view.defaults.models
    .filter(model => model !== defaultModel)
    .map(model => ({ value: model, label: model, active: selected === model }))]
}

function ownModelOptions(view: ModelCardView, models: readonly string[]): ModelOption[] {
  const selected = view.selected.source === 'own' ? view.selected.model ?? models[0] : undefined
  return models.map(model => ({ value: model, label: model, active: selected === model }))
}

/** Markdown inline code with backticks removed from the value. */
function code(value: string): string {
  return `\`${value.replace(/`/gu, '')}\``
}

const ENDPOINT_LABELS: Readonly<Record<ChoiceEndpoint, string>> = {
  default: '缺省 API',
  own: '我的 API',
  other: '其他 API',
}

/** Whether the stored choice resolves to the administrator's default model. */
function onDefaultModel(view: ModelCardView): boolean {
  if (view.selected.source === 'own' && view.own !== undefined) return false
  return view.selected.model === undefined || view.selected.model === view.defaults.model
}

/** Display name of an effort id among the chosen model's efforts. */
function effortName(view: ModelCardView, effort: string): string {
  return view.efforts.find(item => item.id === effort)?.name || effort
}

/** Label of the "no explicit effort" choice: the administrator's effort on the default model. */
function defaultEffortLabel(view: ModelCardView): string {
  return onDefaultModel(view) && view.defaults.effort !== undefined
    ? `缺省（${effortName(view, view.defaults.effort)}）`
    : '模型默认'
}

/** One-line description of the stored choice. */
export function choiceLine(view: ModelCardView): string {
  const own = view.selected.source === 'own' && view.own !== undefined
  const model = own ? view.selected.model ?? view.own?.models[0] : view.selected.model ?? view.defaults.model
  const effort = view.effort === undefined
    ? (onDefaultModel(view) && view.defaults.effort !== undefined ? code(effortName(view, view.defaults.effort)) : '模型默认')
    : code(effortName(view, view.effort))
  return `**我的模型**：${own ? '我的 API' : '缺省 API'} · ${model === undefined ? '部署默认模型' : code(model)} · 推理强度 ${effort}`
}

/** One-line description of what the bound Session uses now. */
function sessionLine(session: NonNullable<ModelCardView['session']>): string {
  const endpoint = session.endpoint === 'other' && session.provider !== undefined
    ? code(session.provider)
    : ENDPOINT_LABELS[session.endpoint]
  const model = session.model === undefined ? '未知模型' : code(session.model)
  const effort = session.effort === undefined ? '模型默认' : code(session.effort)
  return `本会话目前用的是 ${endpoint} · ${model} · 推理强度 ${effort}，点任一选项会把本会话一起切换过去。`
}

/**
 * The `/model` selector: default endpoint models, the user's own endpoint,
 * and the chosen model's reasoning efforts.
 * @param view - what to render.
 * @returns the card JSON.
 */
export function buildModelCard(view: ModelCardView): object {
  const elements: object[] = [markdown(choiceLine(view))]
  if (view.session !== undefined) elements.push(note(sessionLine(view.session)))
  if (view.notice !== undefined) elements.push(markdown(view.notice))
  elements.push(divider(), markdown('**缺省 API**（管理员配置）'))
  elements.push(...modelControls(view, 'default', defaultModelOptions(view)))

  elements.push(divider(), markdown(view.own === undefined ? '**我的 API**' : `**我的 API** · ${code(view.own.baseURL)}`))
  if (view.own !== undefined) elements.push(...modelControls(view, 'own', ownModelOptions(view, view.own.models)))
  if (view.bindable) {
    elements.push(textButton({
      label: view.own === undefined ? '绑定我的 API' : '修改或解绑我的 API',
      value: prefValue(view, { kind: 'bind-form' }),
    }))
    if (view.own === undefined) elements.push(note('用自己的 API 地址和 key，点击后我会私聊你发一张表单。'))
  } else if (view.own === undefined) {
    elements.push(note('当前部署没有开启个人 API 绑定。'))
  }

  elements.push(divider(), markdown('**推理强度**'))
  if (view.efforts.length === 0) {
    elements.push(note('当前模型没有可选的推理强度。'))
  } else {
    elements.push(...pairs([
      choiceButton(defaultEffortLabel(view), view.effort === undefined, prefValue(view, { kind: 'effort', effort: '' })),
      ...view.efforts.map(item => choiceButton(
        item.name || item.id, view.effort === item.id, prefValue(view, { kind: 'effort', effort: item.id }),
      )),
    ]))
  }
  elements.push(divider())
  elements.push(note(view.sessionId === undefined
    ? '选择会保存为你之后新发起会话的模型 · 仅本人可操作'
    : '选择会立即切换本会话，并保存为你之后新发起会话的模型 · 仅本人可操作'))
  return standaloneCard('**🧠 模型**', elements)
}

/** Render input of the `/llm` form. */
export interface BindCardView {
  owner: string
  /** The current binding, when re-binding. */
  current?: { api: PersonalLlmApi; baseURL: string; models: number }
  /** Protocol and base URL typed in a failed submit, shown again so only the key needs retyping. */
  draft?: { api: PersonalLlmApi; baseURL: string }
  /** Why the last submit failed. */
  error?: string
  /** Render nonce carried by every button. */
  rev?: string
}

/** Callback value of one form control; `rev` leads for the same reason as {@link prefValue}. */
function bindValue(view: BindCardView, kind: LlmBindAction['kind']): Record<string, unknown> {
  return { ...(view.rev === undefined ? {} : { rev: view.rev }), decision: LLM_BIND_ACTION, kind, owner: view.owner }
}

/**
 * The private-chat `/llm` form: protocol, base URL and API key (a password
 * input), plus an unbind button once bound.
 * @param view - what to render.
 * @returns the card JSON.
 */
export function buildBindCard(view: BindCardView): object {
  const elements: object[] = []
  elements.push(markdown(view.current === undefined
    ? '填好后点「验证并绑定」，我会先用这个 key 拉取模型列表，成功后你新发起的会话就改用自己的 API。key 只保存在 DSH 凭据库里，不会出现在聊天记录或卡片中。'
    : `**已绑定**：${API_LABELS[view.current.api]} · ${code(view.current.baseURL)} · ${view.current.models} 个模型\nkey 留空则保留原来的 key。`))
  if (view.error !== undefined) elements.push(markdown(`❌ ${view.error}`))
  const api = view.draft?.api ?? view.current?.api ?? 'openai-completions'
  const baseURL = view.draft?.baseURL ?? view.current?.baseURL
  elements.push({
    tag: 'form',
    name: 'llm_bind_form',
    elements: [
      {
        tag: 'select_static',
        name: 'api',
        placeholder: { tag: 'plain_text', content: '接口协议' },
        options: PERSONAL_LLM_APIS.map(item => ({ text: { tag: 'plain_text', content: API_LABELS[item] }, value: item })),
        initial_option: api,
        width: 'fill',
      },
      {
        tag: 'input',
        name: 'baseURL',
        placeholder: { tag: 'plain_text', content: 'API 地址，例如 https://api.example.com/v1' },
        ...(baseURL === undefined || baseURL === '' ? {} : { default_value: baseURL }),
        width: 'fill',
        margin: '8px 0 0 0',
      },
      {
        tag: 'input',
        name: 'apiKey',
        input_type: 'password',
        placeholder: { tag: 'plain_text', content: view.current === undefined ? 'API key' : 'API key（留空保留原 key）' },
        width: 'fill',
        margin: '8px 0 0 0',
      },
      {
        tag: 'button',
        name: 'llm_bind_submit',
        type: 'primary',
        width: 'fill',
        margin: '8px 0 0 0',
        form_action_type: 'submit',
        text: { tag: 'plain_text', content: view.current === undefined ? '验证并绑定' : '验证并保存' },
        behaviors: [{ type: 'callback', value: bindValue(view, 'submit') }],
      },
    ],
  })
  if (view.current !== undefined) {
    elements.push({
      ...textButton({ label: '解绑我的 API', type: 'danger', value: bindValue(view, 'unbind') }),
      confirm: {
        title: { tag: 'plain_text', content: '解绑我的 API？' },
        text: { tag: 'plain_text', content: '会删除保存的 key，之后新发起的会话改用缺省 API。' },
      },
    })
  }
  elements.push(divider(), note('通常填服务商文档里的 OpenAI 兼容地址（多以 /v1 结尾） · 仅本人可操作'))
  return standaloneCard('**🔑 我的 API**', elements)
}

/** The form while a submit is being verified: replaces the form so it cannot be submitted twice. */
export function buildBindPendingCard(baseURL: string): object {
  return standaloneCard('**🔑 我的 API**', [
    markdown(`⏳ 正在用你填的 key 拉取 ${code(baseURL)} 的模型列表，最多需要十几秒…`),
  ])
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a card action into a `/model` selector action.
 * @param value - the control's callback value.
 * @param option - the picked dropdown option, for a dropdown control.
 * @returns the action, or undefined when the value is not a selector action.
 */
export function parseLlmPrefAction(value: unknown, option?: string): LlmPrefAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.decision !== LLM_PREF_ACTION) return undefined
  const owner = stringField(record, 'owner')
  if (owner === undefined) return undefined
  const sessionId = stringField(record, 'sessionId')
  const session = sessionId === undefined ? {} : { sessionId }
  if (record.kind === 'bind-form') return { decision: LLM_PREF_ACTION, kind: 'bind-form', owner }
  if (record.kind === 'model') {
    const { source } = record
    let model = record.model
    if (record.pick === true) {
      if (option === undefined || option === '') return undefined
      model = option === DEFAULT_MODEL_OPTION ? '' : option
    }
    if ((source !== 'default' && source !== 'own') || typeof model !== 'string') return undefined
    if (source === 'own' && model === '') return undefined
    return { decision: LLM_PREF_ACTION, kind: 'model', owner, source, model, ...session }
  }
  if (record.kind === 'effort') {
    if (typeof record.effort !== 'string') return undefined
    return { decision: LLM_PREF_ACTION, kind: 'effort', owner, effort: record.effort, ...session }
  }
  return undefined
}

/** Parse a card action value into a `/llm` form action. */
export function parseLlmBindAction(value: unknown): LlmBindAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.decision !== LLM_BIND_ACTION) return undefined
  const owner = stringField(record, 'owner')
  if (owner === undefined || (record.kind !== 'submit' && record.kind !== 'unbind')) return undefined
  return { decision: LLM_BIND_ACTION, kind: record.kind, owner }
}

/**
 * Read the `/llm` form fields from a raw `card.action.trigger` event
 * (`action.form_value`). Missing fields read as empty strings.
 * @param raw - the raw callback body kept by the channel.
 * @returns the submitted fields.
 */
export function bindFormOf(raw: unknown): LlmBindForm {
  const action = typeof raw === 'object' && raw !== null ? (raw as { action?: unknown }).action : undefined
  const form = typeof action === 'object' && action !== null ? (action as { form_value?: unknown }).form_value : undefined
  const fields = typeof form === 'object' && form !== null ? form as Record<string, unknown> : {}
  const text = (key: string): string => (typeof fields[key] === 'string' ? fields[key] as string : '')
  return { api: text('api'), baseURL: text('baseURL'), apiKey: text('apiKey') }
}
