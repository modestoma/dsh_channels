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

/** Cap on rendered model buttons per endpoint. */
export const MAX_MODEL_OPTIONS = 12

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
    /** Render nonce: repeated clicks of one choice across renders stay distinct callbacks. */
    rev?: string
  }
  | {
    decision: typeof LLM_PREF_ACTION
    kind: 'effort'
    owner: string
    /** Effort id; `''` follows the model default. */
    effort: string
    sessionId?: string
    rev?: string
  }
  | { decision: typeof LLM_PREF_ACTION; kind: 'bind-form'; owner: string; rev?: string }

/** One `/llm` form click. */
export interface LlmBindAction {
  decision: typeof LLM_BIND_ACTION
  kind: 'submit' | 'unbind'
  owner: string
  /** Render nonce: a re-submit after a failed attempt stays a distinct callback. */
  rev?: string
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
  }
  /** The user's own endpoint, when bound. */
  own?: { baseURL: string; models: readonly string[] }
  /** The stored choice: endpoint and model (`undefined` = that endpoint's default). */
  selected: { source: 'default' | 'own'; model?: string }
  /** Efforts the effective model advertises. */
  efforts: readonly { id: string; name: string }[]
  /** The stored effort (`undefined` = the model default). */
  effort?: string
  /** One-line result of the last click. */
  notice?: string
  /** Render nonce carried by every button. */
  rev?: string
}

function modelButton(view: ModelCardView, source: 'default' | 'own', model: string, label: string, active: boolean): object {
  const value: LlmPrefAction = {
    decision: LLM_PREF_ACTION,
    kind: 'model',
    owner: view.owner,
    source,
    model,
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    ...(view.rev === undefined ? {} : { rev: view.rev }),
  }
  return textButton({ label: active ? `✅ ${label}` : label, type: active ? 'primary' : 'default', value })
}

function effortButton(view: ModelCardView, effort: string, label: string, active: boolean): object {
  const value: LlmPrefAction = {
    decision: LLM_PREF_ACTION,
    kind: 'effort',
    owner: view.owner,
    effort,
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    ...(view.rev === undefined ? {} : { rev: view.rev }),
  }
  return textButton({ label: active ? `✅ ${label}` : label, type: active ? 'primary' : 'default', value })
}

/** Lay buttons out two per row. */
function pairs(buttons: readonly object[]): object[] {
  const rows: object[] = []
  for (let index = 0; index < buttons.length; index += 2) rows.push(columnSet(buttons.slice(index, index + 2)))
  return rows
}

/** Model buttons of one endpoint, capped, plus a typed-only note for the rest. */
function modelRows(view: ModelCardView, source: 'default' | 'own', models: readonly string[]): object[] {
  const shown = models.slice(0, MAX_MODEL_OPTIONS)
  const rows = pairs(shown.map(model => modelButton(
    view, source, model, model, view.selected.source === source && view.selected.model === model,
  )))
  if (models.length > shown.length) rows.push(note(`另有 ${models.length - shown.length} 个模型未展示。`))
  return rows
}

/** Markdown inline code with backticks removed from the value. */
function code(value: string): string {
  return `\`${value.replace(/`/gu, '')}\``
}

/** One-line description of the effective choice. */
export function choiceLine(view: ModelCardView): string {
  const endpoint = view.selected.source === 'own' && view.own !== undefined ? '我的 API' : '缺省 API'
  const model = view.selected.source === 'own' && view.own !== undefined
    ? view.selected.model ?? view.own.models[0]
    : view.selected.model ?? view.defaults.model
  const effort = view.effort === undefined ? '模型默认' : code(view.efforts.find(item => item.id === view.effort)?.name ?? view.effort)
  return `**当前**：${endpoint} · ${model === undefined ? '部署默认模型' : code(model)} · 推理强度 ${effort}`
}

/**
 * The `/model` selector: default endpoint models, the user's own endpoint,
 * and the effective model's reasoning efforts.
 * @param view - what to render.
 * @returns the card JSON.
 */
export function buildModelCard(view: ModelCardView): object {
  const elements: object[] = [markdown(choiceLine(view))]
  if (view.notice !== undefined) elements.push(note(view.notice))
  elements.push(divider(), markdown('**缺省 API**（管理员配置）'))
  const followsDefault = view.selected.source === 'default' && view.selected.model === undefined
  elements.push(modelButton(
    view, 'default', '',
    view.defaults.model === undefined ? '跟随管理员缺省' : `跟随管理员缺省（${view.defaults.model}）`,
    followsDefault,
  ))
  elements.push(...modelRows(view, 'default', view.defaults.models))

  elements.push(divider(), markdown('**我的 API**'))
  if (view.own !== undefined) {
    elements.push(note(code(view.own.baseURL)))
    elements.push(...modelRows(view, 'own', view.own.models))
  }
  if (view.bindable) {
    const value: LlmPrefAction = {
      decision: LLM_PREF_ACTION, kind: 'bind-form', owner: view.owner, ...(view.rev === undefined ? {} : { rev: view.rev }),
    }
    elements.push(textButton({ label: view.own === undefined ? '绑定我的 API' : '修改或解绑我的 API', value }))
    elements.push(note('点击后我会私聊你发一张表单，key 只在私聊里填写。'))
  } else if (view.own === undefined) {
    elements.push(note('当前部署没有开启个人 API 绑定。'))
  }

  elements.push(divider(), markdown('**推理强度**'))
  if (view.efforts.length === 0) {
    elements.push(note('当前模型没有可选的推理强度。'))
  } else {
    elements.push(...pairs([
      effortButton(view, '', '模型默认', view.effort === undefined),
      ...view.efforts.map(item => effortButton(view, item.id, item.name || item.id, view.effort === item.id)),
    ]))
  }
  elements.push(divider())
  elements.push(note(view.sessionId === undefined
    ? '选择会作为你之后新发起会话的默认模型 · 仅本人可操作'
    : `选择会立即切换当前会话，并作为你之后新发起会话的默认模型 · 仅本人可操作 · 🔑 ${view.sessionId}`))
  return standaloneCard('**🧠 模型**', elements)
}

/** Render input of the `/llm` form. */
export interface BindCardView {
  owner: string
  /** The current binding, when re-binding. */
  current?: { api: PersonalLlmApi; baseURL: string; models: number }
  /** Why the last submit failed. */
  error?: string
  /** Render nonce carried by every button. */
  rev?: string
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
    ? '绑定后，你可以在 /model 里选择自己 API 上的模型。key 只保存在本机的 DSH 凭据库里，不会出现在聊天记录或卡片中。'
    : `**已绑定**：${API_LABELS[view.current.api]} · ${code(view.current.baseURL)} · ${view.current.models} 个模型\nkey 留空则保留原来的 key。`))
  if (view.error !== undefined) elements.push(markdown(`❌ ${view.error}`))
  const rev = view.rev === undefined ? {} : { rev: view.rev }
  const submit: LlmBindAction = { decision: LLM_BIND_ACTION, kind: 'submit', owner: view.owner, ...rev }
  elements.push({
    tag: 'form',
    name: 'llm_bind_form',
    elements: [
      {
        tag: 'select_static',
        name: 'api',
        placeholder: { tag: 'plain_text', content: '接口协议' },
        options: PERSONAL_LLM_APIS.map(api => ({ text: { tag: 'plain_text', content: API_LABELS[api] }, value: api })),
        initial_option: view.current?.api ?? 'openai-completions',
        width: 'fill',
      },
      {
        tag: 'input',
        name: 'baseURL',
        placeholder: { tag: 'plain_text', content: 'API 地址，例如 https://api.example.com/v1' },
        ...(view.current === undefined ? {} : { default_value: view.current.baseURL }),
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
        behaviors: [{ type: 'callback', value: submit }],
      },
    ],
  })
  if (view.current !== undefined) {
    const unbind: LlmBindAction = { decision: LLM_BIND_ACTION, kind: 'unbind', owner: view.owner, ...rev }
    elements.push(textButton({ label: '解绑我的 API', type: 'danger', value: unbind }))
  }
  elements.push(divider(), note('提交后会先用这个 key 拉取模型列表验证，验证通过才保存 · 仅本人可操作'))
  return standaloneCard('**🔑 我的 API**', elements)
}

/** Result card after a successful bind or unbind. */
export function buildBindDoneCard(text: string): object {
  return standaloneCard('**🔑 我的 API**', [markdown(text), divider(), note('发送 /model 选择对话使用的模型。')])
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Parse a card action value into a `/model` selector action. */
export function parseLlmPrefAction(value: unknown): LlmPrefAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.decision !== LLM_PREF_ACTION) return undefined
  const owner = stringField(record, 'owner')
  if (owner === undefined) return undefined
  const sessionId = stringField(record, 'sessionId')
  const session = sessionId === undefined ? {} : { sessionId }
  if (record.kind === 'bind-form') return { decision: LLM_PREF_ACTION, kind: 'bind-form', owner }
  if (record.kind === 'model') {
    const { source, model } = record
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
