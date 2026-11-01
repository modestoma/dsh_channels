/**
 * Per-user model choice on the channel plane: the `/model` selector, the
 * private-chat `/llm` bind form, and the model a user's new Sessions start
 * from.
 *
 * The administrator's default endpoint is the channel's `provider` / `model`
 * / `reasoningEffort` configuration (else the deployment default). A user's
 * stored preference either picks a model and effort on that endpoint or
 * switches to the user's own endpoint (a personal `llm-pi-ai` route). A
 * selector click inside a Session the user started also switches that
 * Session through the regular `/model` / `/effort` command lifecycle.
 *
 * @module dsh-channels/llm/feature
 */

import { randomUUID } from 'node:crypto'
import type { FeishuConfig } from '../config.ts'
import type { AgentDefaultModel, LlmService } from '../dsh-types.ts'
import { PERSONAL_LLM_APIS } from '../domain.ts'
import type { PersonalLlmApi, RouteRecord, SessionLlm, UserLlmRecord } from '../domain.ts'
import type { CardActionEvent, FeishuChannel } from '../feishu-channel.ts'
import {
  bindFormOf, buildBindCard, buildBindPendingCard, buildModelCard, parseLlmBindAction, parseLlmPrefAction,
} from './cards.ts'
import type { ChoiceEndpoint, LlmBindAction, LlmPrefAction, ModelCardView } from './cards.ts'
import type { BindFailureReason, PersonalRoutes } from './personal-routes.ts'
import { sessionLlmFor } from './selection.ts'
import type { DefaultEndpoint } from './selection.ts'
import type { UserLlmChange, UserLlmStore } from './store.ts'

/** Upper bound of one catalog lookup while rendering the selector. */
const LOOKUP_TIMEOUT_MS = 4_000

export interface UserModelsDeps {
  store: UserLlmStore
  routes: PersonalRoutes
  config(): FeishuConfig
  llm(): LlmService | undefined
  /** The host's deployment default model, when mounted. */
  defaultModel(): AgentDefaultModel | undefined
  channel(): FeishuChannel | undefined
  /** Whether the user may use the bot at all (chat access, or administrator). */
  mayChat(userId: string): boolean
  /** Display name for the user's personal route. */
  displayName(userId: string): string | undefined
  /** The route bound to a Session. */
  routeOf(sessionId: string): RouteRecord | undefined
  /**
   * Run `/model …` and `/effort …` lines against a route's live Session.
   * @returns an error text, or undefined when every line succeeded.
   */
  switchSession(route: RouteRecord, lines: readonly string[]): Promise<string | undefined>
  /** What a live Session's next request uses; undefined when the Session is not live here. */
  sessionChoice(sessionId: string): SessionChoice | undefined
  warn(message: string, ...args: unknown[]): void
}

/** The provider, model and effort a live Session's next request uses, as far as known. */
export interface SessionChoice {
  provider?: string
  model?: string
  effort?: string
}

const BIND_ERRORS: Readonly<Record<BindFailureReason, string>> = {
  'unavailable': '当前部署无法绑定个人 API：需要宿主提供 settings、模型发现和凭据服务，并启用 llm-pi-ai。',
  'invalid-url': 'API 地址需要是 http:// 或 https:// 开头的完整地址。',
  'missing-key': '请填写 API key。',
  'invalid-key': 'API key 只能包含可见的 ASCII 字符，不能有空格。',
  'discovery-failed': '用这个地址和 key 拉取模型列表失败',
  'no-models': '验证通过，但这个地址没有返回任何模型。',
  'write-failed': '保存失败',
}

/** Resolve `work`, or undefined after `ms` or on failure. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { resolve(undefined) }, ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work.catch(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isPersonalApi(value: string): value is PersonalLlmApi {
  return (PERSONAL_LLM_APIS as readonly string[]).includes(value)
}

export class UserModels {
  /** Tail of each user's queue of endpoint and preference changes. */
  private readonly userQueues = new Map<string, Promise<void>>()

  constructor(private readonly deps: UserModelsDeps) {}

  /** The administrator's default endpoint: channel config, else the deployment default. */
  defaultEndpoint(): DefaultEndpoint {
    const config = this.deps.config()
    let fallback: { provider: string; model: string } | undefined
    try {
      fallback = this.deps.defaultModel()?.currentSelection()
    } catch (error) {
      this.deps.warn('dsh-channels: reading the deployment default model failed: %s', String(error))
    }
    const provider = config.provider ?? fallback?.provider
    const model = config.model ?? (provider === fallback?.provider ? fallback?.model : undefined)
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(config.reasoningEffort === undefined ? {} : { effort: config.reasoningEffort }),
    }
  }

  /**
   * Starting model choice of a Session `userId` creates now. A personal
   * route the host no longer lists (removed on the Web Models page) falls
   * back to the default endpoint instead of failing every request.
   * @param userId - the Session owner's Feishu user_id.
   * @returns the choice to record on the route; undefined follows the deployment default.
   */
  sessionLlmFor(userId: string): SessionLlm | undefined {
    const record = this.deps.store.get(userId)
    if (record?.source === 'own' && record.own !== undefined && !this.registered(record.own.route)) {
      this.deps.warn('dsh-channels: personal route %s of %s is not registered; using the default endpoint', record.own.route, userId)
      return undefined
    }
    return sessionLlmFor(record, this.defaultEndpoint())
  }

  /**
   * Provider routes a Session owner may switch to with `/model`: the default
   * endpoint and the owner's own endpoint.
   * @param ownerUserId - the Session owner's Feishu user_id.
   * @returns the allowed provider route ids.
   */
  allowedProviders(ownerUserId: string): Set<string> {
    const allowed = new Set<string>()
    const provider = this.defaultEndpoint().provider
    if (provider !== undefined) allowed.add(provider)
    const own = this.deps.store.get(ownerUserId)?.own
    if (own !== undefined) allowed.add(own.route)
    return allowed
  }

  /** Whether personal endpoints can be bound in this deployment. */
  bindable(): boolean {
    return this.deps.routes.available()
  }

  /**
   * Short description of a user's preference for the settings panel.
   * @param userId - Feishu user_id.
   * @returns e.g. `我的 API · gpt-4o · high`, or undefined without a stored preference.
   */
  summary(userId: string): string | undefined {
    const record = this.deps.store.get(userId)
    if (record === undefined) return undefined
    const own = record.source === 'own' ? record.own : undefined
    const model = own === undefined ? record.model ?? '缺省模型' : record.model ?? own.models[0] ?? '—'
    return [own === undefined ? '缺省 API' : '我的 API', model, ...(record.effort === undefined ? [] : [record.effort])].join(' · ')
  }

  /**
   * Render the `/model` selector for one user.
   * @param userId - the selector owner.
   * @param sessionId - the Session a click also switches, when any.
   * @param notice - one-line result of the previous click.
   * @returns the card JSON.
   */
  async selectorCard(userId: string, sessionId?: string, notice?: string): Promise<object> {
    return buildModelCard(await this.selectorView(userId, sessionId, notice))
  }

  /**
   * Render the `/llm` bind form for one user.
   * @param userId - the form owner.
   * @param error - why the previous submit failed.
   * @returns the card JSON.
   */
  bindCard(userId: string, error?: string, draft?: { api: PersonalLlmApi; baseURL: string }): object {
    const own = this.deps.store.get(userId)?.own
    return buildBindCard({
      owner: userId,
      rev: randomUUID().slice(0, 8),
      ...(own === undefined ? {} : { current: { api: own.api, baseURL: own.baseURL, models: own.models.length } }),
      ...(draft === undefined ? {} : { draft }),
      ...(error === undefined ? {} : { error }),
    })
  }

  /**
   * Handle selector and bind-form clicks; other card actions are ignored.
   * Clicks by anyone but the card owner, or by a user without chat access,
   * are ignored too.
   * @param event - the card action.
   */
  async onCardAction(event: CardActionEvent): Promise<void> {
    const userId = event.operator.userId
    const pref = parseLlmPrefAction(event.action.value, event.action.option)
    if (pref !== undefined) {
      if (userId !== pref.owner || !this.deps.mayChat(userId)) return
      await this.exclusive(userId, () => this.onPrefAction(event, userId, pref))
      return
    }
    const bind = parseLlmBindAction(event.action.value)
    if (bind === undefined || userId !== bind.owner || !this.deps.mayChat(userId)) return
    await this.exclusive(userId, () => this.onBindAction(event, userId, bind))
  }

  /** Handle one bind-form click; runs inside the user's exclusive section. */
  private async onBindAction(event: CardActionEvent, userId: string, bind: LlmBindAction): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) return
    if (bind.kind === 'unbind') {
      await this.forgetEndpoint(userId)
      await channel.updateCard(event.messageId, await this.selectorCard(userId, undefined, '已解绑你的 API，之后新发起的会话改用缺省 API。'))
      return
    }
    const form = bindFormOf(event.raw)
    const api = form.api === '' ? 'openai-completions' : form.api
    if (!isPersonalApi(api)) {
      await channel.updateCard(event.messageId, this.bindCard(userId, '请选择接口协议。'))
      return
    }
    const draft = { api, baseURL: form.baseURL.trim() }
    const previous = this.deps.store.get(userId)
    const name = this.deps.displayName(userId) ?? userId
    await channel.updateCard(event.messageId, buildBindPendingCard(draft.baseURL))
    const result = await this.deps.routes.bind({
      userId,
      displayName: `飞书 · ${name}`,
      api,
      baseURL: form.baseURL,
      apiKey: form.apiKey,
      ...(previous?.own === undefined ? {} : { previous: previous.own }),
    })
    if (!result.ok) {
      const detail = result.detail === undefined ? '' : `：${result.detail}`
      await channel.updateCard(event.messageId, this.bindCard(userId, `${BIND_ERRORS[result.reason]}${detail}`, draft))
      return
    }
    // Binding switches new Sessions to the user's own endpoint; a model the
    // endpoint still lists stays selected.
    const keepModel = previous?.source === 'own' && previous.model !== undefined && result.own.models.includes(previous.model)
    const stored = await this.deps.store.update(userId, {
      own: result.own,
      source: 'own',
      ...(keepModel ? {} : { model: null, effort: null }),
    })
    const model = stored.model ?? result.own.models[0] ?? ''
    await channel.updateCard(event.messageId, await this.selectorCard(
      userId, undefined,
      `✅ 已绑定，拉取到 ${result.own.models.length} 个模型。之后新发起的会话用你的 API 上的 \`${model}\`，想换模型直接在下面点。`,
    ))
  }

  /**
   * Drop a user's preference and personal endpoint (user removed from the
   * access table).
   * @param userId - Feishu user_id.
   */
  async forget(userId: string): Promise<void> {
    await this.exclusive(userId, async () => {
      const record = this.deps.store.get(userId)
      if (record?.own !== undefined) await this.deps.routes.unbind(record.own)
      await this.deps.store.remove(userId)
    })
  }

  /**
   * Run one user's endpoint or preference change after that user's previous
   * one settles. Two open forms share one route and credential reference, so
   * a bind, its rollback and the stored record must not interleave with
   * another change of the same user.
   */
  private async exclusive<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.userQueues.get(userId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(() => undefined, () => undefined)
    this.userQueues.set(userId, settled)
    try {
      return await run
    } finally {
      if (this.userQueues.get(userId) === settled) this.userQueues.delete(userId)
    }
  }

  /** Remove the personal endpoint and fall back to the default endpoint. */
  private async forgetEndpoint(userId: string): Promise<void> {
    const own = this.deps.store.get(userId)?.own
    if (own === undefined) return
    await this.deps.routes.unbind(own)
    await this.deps.store.update(userId, { own: null })
  }

  private async onPrefAction(event: CardActionEvent, userId: string, action: LlmPrefAction): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) return
    const sessionId = action.kind === 'bind-form' ? undefined : action.sessionId
    const redraw = async (notice: string): Promise<void> => {
      await channel.updateCard(event.messageId, await this.selectorCard(userId, sessionId, notice))
    }
    if (action.kind === 'bind-form') {
      if (!this.bindable()) {
        await redraw('当前部署没有开启个人 API 绑定。')
        return
      }
      try {
        await channel.send(userId, { card: this.bindCard(userId) })
      } catch (error) {
        this.deps.warn('dsh-channels: sending the /llm form to %s failed: %s', userId, String(error))
        await redraw('私聊发送绑定表单失败，请先私聊我发送 /llm。')
        return
      }
      await redraw('已私聊你发送绑定表单，请到和我的私聊里填写。')
      return
    }
    const record = this.deps.store.get(userId)
    let change: UserLlmChange
    if (action.kind === 'effort') {
      // A click from an older card may name an effort of a model no longer saved.
      if (action.effort !== '' && !(await this.savedModelOffers(userId, action.effort))) {
        await redraw('这个推理强度不适用于你现在选的模型，请在下面重新选择。')
        return
      }
      change = { effort: action.effort === '' ? null : action.effort }
    } else if (action.source === 'own') {
      if (record?.own === undefined || !record.own.models.includes(action.model)) {
        await redraw('你的 API 没有这个模型，请重新绑定后再选。')
        return
      }
      // Efforts are model-specific: a new model starts on its default effort.
      change = { source: 'own', model: action.model, effort: null }
    } else {
      // Naming the administrator's default model is the same as following it.
      const followsDefault = action.model === '' || action.model === this.defaultEndpoint().model
      change = { source: 'default', model: followsDefault ? null : action.model, effort: null }
    }
    const stored = await this.deps.store.update(userId, change)
    await redraw(await this.applyToSession(userId, sessionId, action, stored))
  }

  /** Switch the selector's Session when its owner clicked; returns the notice. */
  private async applyToSession(
    userId: string,
    sessionId: string | undefined,
    action: LlmPrefAction,
    stored: UserLlmRecord,
  ): Promise<string> {
    const saved = '已保存为你之后新发起会话的默认模型。'
    if (sessionId === undefined) return saved
    const route = this.deps.routeOf(sessionId)
    if (route === undefined) return `${saved}当前会话已不在这个话题里，没有切换。`
    if (route.senderUserId !== userId) return `${saved}当前会话由发起人决定，没有切换。`
    const target = this.routeOfChoice(stored)
    if (target === undefined) return `${saved}缺省模型未知，当前会话没有切换。`
    const lines: string[] = []
    if (action.kind === 'effort') {
      // Efforts belong to the saved model, so a Session on another model switches to it first.
      const current = this.deps.sessionChoice(sessionId)
      if (current?.provider !== target.provider || current.model !== target.model) {
        lines.push(`/model ${target.provider}/${target.model}`)
      }
      lines.push(stored.effort === undefined ? this.defaultEffortLine(stored) : `/effort ${stored.effort}`)
    } else {
      lines.push(`/model ${target.provider}/${target.model}`, this.defaultEffortLine(stored))
    }
    const error = await this.deps.switchSession(route, lines)
    return error === undefined ? `已切换当前会话，并${saved}` : `${saved}切换当前会话失败：${error}`
  }

  /**
   * The `/effort` line that gives a Session the default effort of the
   * preference's model: the administrator's effort on the default model,
   * otherwise the model's own default. `/effort reset` would restore the
   * Session's starting effort, which belongs to the model it started on.
   */
  private defaultEffortLine(record: UserLlmRecord): string {
    const effort = this.defaultEffortOf(record)
    return effort === undefined ? '/effort default' : `/effort ${effort}`
  }

  /** The effort a preference without its own effort runs at: the administrator's, on the default model only. */
  private defaultEffortOf(record: UserLlmRecord): string | undefined {
    const defaults = this.defaultEndpoint()
    const onDefaultModel = !(record.source === 'own' && record.own !== undefined)
      && (record.model === undefined || record.model === defaults.model)
    return onDefaultModel ? defaults.effort : undefined
  }

  /** Provider and model a stored preference names. */
  private routeOfChoice(record: UserLlmRecord): { provider: string; model: string } | undefined {
    if (record.source === 'own' && record.own !== undefined) {
      const model = record.model ?? record.own.models[0]
      return model === undefined ? undefined : { provider: record.own.route, model }
    }
    const defaults = this.defaultEndpoint()
    const model = record.model ?? defaults.model
    return defaults.provider === undefined || model === undefined ? undefined : { provider: defaults.provider, model }
  }

  private async selectorView(userId: string, sessionId: string | undefined, notice: string | undefined): Promise<ModelCardView> {
    const record = this.deps.store.get(userId)
    const defaults = this.defaultEndpoint()
    const own = record?.own
    const source = record?.source === 'own' && own !== undefined ? 'own' : 'default'
    const effective = { ...(record ?? { userId, updatedAt: 0 }), source } as UserLlmRecord
    const choice = this.routeOfChoice(effective)
    const session = sessionId === undefined ? undefined : this.sessionDifference(sessionId, effective, choice)
    return {
      owner: userId,
      rev: randomUUID().slice(0, 8),
      ...(sessionId === undefined ? {} : { sessionId }),
      bindable: this.bindable(),
      defaults: {
        ...(defaults.model === undefined ? {} : { model: defaults.model }),
        models: defaults.provider === undefined ? [] : await this.models(defaults.provider),
        ...(defaults.effort === undefined ? {} : { effort: defaults.effort }),
      },
      ...(own === undefined ? {} : { own: { baseURL: own.baseURL, models: own.models } }),
      selected: { source, ...(record?.model === undefined ? {} : { model: record.model }) },
      efforts: choice === undefined ? [] : await this.efforts(choice.provider, choice.model),
      ...(record?.effort === undefined ? {} : { effort: record.effort }),
      ...(session === undefined ? {} : { session }),
      ...(notice === undefined ? {} : { notice }),
    }
  }

  /**
   * What the bound Session uses, when that differs from the stored choice
   * (started before the choice changed, or switched with a typed command).
   */
  private sessionDifference(
    sessionId: string,
    record: UserLlmRecord,
    choice: { provider: string; model: string } | undefined,
  ): ModelCardView['session'] {
    const current = this.deps.sessionChoice(sessionId)
    if (current === undefined) return undefined
    const effort = record.effort ?? this.defaultEffortOf(record)
    if (current.provider === choice?.provider && current.model === choice?.model && current.effort === effort) return undefined
    const defaults = this.defaultEndpoint()
    const endpoint: ChoiceEndpoint = current.provider === defaults.provider
      ? 'default'
      : current.provider !== undefined && current.provider === record.own?.route ? 'own' : 'other'
    return {
      endpoint,
      ...(current.provider === undefined ? {} : { provider: current.provider }),
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.effort === undefined ? {} : { effort: current.effort }),
    }
  }

  /** Whether the user's saved model advertises an effort. */
  private async savedModelOffers(userId: string, effort: string): Promise<boolean> {
    const record: UserLlmRecord = this.deps.store.get(userId) ?? { userId, source: 'default', updatedAt: 0 }
    const source = record.source === 'own' && record.own !== undefined ? 'own' : 'default'
    const choice = this.routeOfChoice({ ...record, source })
    if (choice === undefined) return false
    return (await this.efforts(choice.provider, choice.model)).some(item => item.id === effort)
  }

  private registered(route: string): boolean {
    const providers = this.deps.llm()?.listProviders?.()
    return providers === undefined || providers.some(provider => provider.id === route)
  }

  private async models(provider: string): Promise<string[]> {
    const listed = await within(this.deps.llm()?.listModels?.(provider) ?? Promise.resolve([]), LOOKUP_TIMEOUT_MS)
    return (listed ?? []).map(entry => entry.id ?? '').filter(id => id !== '')
  }

  private async efforts(provider: string, model: string): Promise<Array<{ id: string; name: string }>> {
    const llm = this.deps.llm()
    if (llm === undefined) return []
    const info = await within(llm.resolveModelInfo(provider, model), LOOKUP_TIMEOUT_MS)
    return (info?.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name }))
  }
}
