import { describe, expect, it, vi } from 'vitest'
import type { FeishuDomainHandle, UserLlmRecord } from '../src/domain.ts'
import {
  bindFormOf, buildBindCard, buildModelCard, credentialRefFor, normalizeBaseURL, parseLlmBindAction, parseLlmPrefAction,
  personalRouteFor, PersonalRoutes, policyConfigFor, sessionLlmFor, UserLlmStore,
} from '../src/llm/index.ts'
import type { ModelCardView } from '../src/llm/index.ts'

const own = {
  route: 'feishu-0123456789', credentialRef: 'FEISHU_0123456789_API_KEY', api: 'openai-completions' as const,
  baseURL: 'https://api.example.com/v1', models: ['m1', 'm2'], boundAt: 1,
}

function record(partial: Partial<UserLlmRecord>): UserLlmRecord {
  return { userId: 'u_a', source: 'default', updatedAt: 1, ...partial }
}

describe('sessionLlmFor', () => {
  const defaults = { provider: 'deepseek-official', model: 'flash', effort: 'high' }

  it('follows the deployment default without a pinned model', () => {
    expect(sessionLlmFor(undefined, defaults)).toBeUndefined()
    expect(sessionLlmFor(record({}), defaults)).toBeUndefined()
    expect(sessionLlmFor(record({ effort: 'low' }), defaults)).toEqual({ effort: 'low' })
  })

  it('pins a model on the default endpoint', () => {
    expect(sessionLlmFor(record({ model: 'pro', effort: 'max' }), defaults))
      .toEqual({ provider: 'deepseek-official', model: 'pro', effort: 'max' })
    expect(sessionLlmFor(record({ model: 'pro' }), {})).toBeUndefined()
  })

  it('keeps the administrator effort when the default model is pinned by name', () => {
    expect(sessionLlmFor(record({ model: 'flash' }), defaults))
      .toEqual({ provider: 'deepseek-official', model: 'flash', effort: 'high' })
    expect(sessionLlmFor(record({ model: 'flash', effort: 'low' }), defaults))
      .toEqual({ provider: 'deepseek-official', model: 'flash', effort: 'low' })
    expect(sessionLlmFor(record({ model: 'pro' }), defaults)).toEqual({ provider: 'deepseek-official', model: 'pro' })
  })

  it('uses the personal route, defaulting to its first model, and falls back while unbound', () => {
    expect(sessionLlmFor(record({ source: 'own', own }), defaults)).toEqual({ provider: own.route, model: 'm1' })
    expect(sessionLlmFor(record({ source: 'own', own, model: 'm2', effort: 'low' }), defaults))
      .toEqual({ provider: own.route, model: 'm2', effort: 'low' })
    expect(sessionLlmFor(record({ source: 'own', model: 'm2' }), defaults)).toBeUndefined()
  })
})

describe('policyConfigFor', () => {
  const deployment = { provider: 'deepseek-official', model: 'flash', effort: 'high' }

  it('replaces the deployment route and effort for a pinned route', () => {
    expect(policyConfigFor(undefined, deployment)).toBe(deployment)
    expect(policyConfigFor({ provider: 'p', model: 'm' }, deployment)).toEqual({ provider: 'p', model: 'm' })
    expect(policyConfigFor({ provider: 'p', model: 'm', effort: 'low' }, deployment)).toEqual({ provider: 'p', model: 'm', effort: 'low' })
  })

  it('keeps the deployment route for an effort-only choice', () => {
    expect(policyConfigFor({ effort: 'low' }, deployment)).toEqual({ ...deployment, effort: 'low' })
  })
})

describe('personal routes', () => {
  it('derives stable opaque route ids and Web-compatible credential references', () => {
    const route = personalRouteFor('u_a')
    expect(route).toMatch(/^feishu-[0-9a-f]{10}$/u)
    expect(personalRouteFor('u_a')).toBe(route)
    expect(personalRouteFor('u_b')).not.toBe(route)
    expect(route).not.toContain('u_a')
    expect(credentialRefFor('feishu-0a1b')).toBe('FEISHU_0A1B_API_KEY')
  })

  it('accepts only http(s) base URLs and trims trailing slashes', () => {
    expect(normalizeBaseURL(' https://a.example.com/v1// ')).toBe('https://a.example.com/v1')
    expect(normalizeBaseURL('http://localhost:8000')).toBe('http://localhost:8000')
    expect(normalizeBaseURL('ftp://a.example.com')).toBeUndefined()
    expect(normalizeBaseURL('not a url')).toBeUndefined()
  })

  function makeRoutes(overrides: { discover?: () => Promise<unknown[]>; mutate?: () => Promise<void>; env?: Record<string, string> } = {}) {
    const values: Record<string, string> = {}
    const env = overrides.env ?? {}
    const credentials = {
      resolve: vi.fn(async (ref: string) => {
        if (values[ref] !== undefined) return { value: values[ref]!, source: 'file' }
        return env[ref] === undefined ? undefined : { value: env[ref]!, source: 'env' }
      }),
      set: vi.fn(async (ref: string, value: string) => { values[ref] = value }),
      unset: vi.fn(async (ref: string) => { delete values[ref] }),
    }
    const mutate = vi.fn(overrides.mutate ?? (async () => {}))
    const discoverModels = vi.fn(overrides.discover ?? (async () => [{ id: 'm1' }]))
    const routes = new PersonalRoutes({
      settings: () => ({ mutate }),
      llm: () => ({ resolveModelInfo: vi.fn(), discoverModels } as never),
      credentials,
      namespace: () => 'llm-pi-ai',
      warn: vi.fn(),
    })
    return { routes, credentials, mutate, discoverModels, values }
  }

  const request = { userId: 'u_a', displayName: '飞书 · A', api: 'openai-completions' as const, baseURL: 'https://a.example.com', apiKey: 'sk-1' }

  it('rejects invalid input before touching the endpoint', async () => {
    const { routes, discoverModels } = makeRoutes()
    await expect(routes.bind({ ...request, baseURL: 'nope' })).resolves.toEqual({ ok: false, reason: 'invalid-url' })
    await expect(routes.bind({ ...request, apiKey: '  ' })).resolves.toEqual({ ok: false, reason: 'missing-key' })
    await expect(routes.bind({ ...request, apiKey: 'sk 1' })).resolves.toEqual({ ok: false, reason: 'invalid-key' })
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('stores nothing when the endpoint lists no models', async () => {
    const { routes, credentials, mutate } = makeRoutes({ discover: async () => [] })
    await expect(routes.bind(request)).resolves.toEqual({ ok: false, reason: 'no-models' })
    expect(credentials.set).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('rolls a first bind key back when the route write fails', async () => {
    const { routes, values } = makeRoutes({ mutate: async () => { throw new Error('not volatile') } })
    await expect(routes.bind(request)).resolves.toEqual({ ok: false, reason: 'write-failed', detail: 'not volatile' })
    expect(values).toEqual({})
  })

  it('restores the replaced key when a re-bind route write fails', async () => {
    const ref = credentialRefFor(personalRouteFor(request.userId))
    const { routes, values } = makeRoutes({ mutate: async () => { throw new Error('not volatile') } })
    values[ref] = 'sk-old'
    await expect(routes.bind({ ...request, apiKey: 'sk-new' })).resolves.toMatchObject({ ok: false, reason: 'write-failed' })
    expect(values).toEqual({ [ref]: 'sk-old' })
  })

  it('does not store an environment key when rolling a failed bind back', async () => {
    const ref = credentialRefFor(personalRouteFor(request.userId))
    const { routes, values } = makeRoutes({ mutate: async () => { throw new Error('not volatile') }, env: { [ref]: 'sk-env' } })
    await expect(routes.bind(request)).resolves.toMatchObject({ ok: false, reason: 'write-failed' })
    expect(values).toEqual({})
  })

  it('masks the submitted key in failure details', async () => {
    const { routes } = makeRoutes({ discover: async () => { throw new Error(`401 for key sk-1: invalid ${'x'.repeat(400)}`) } })
    const result = await routes.bind(request)
    expect(result).toMatchObject({ ok: false, reason: 'discovery-failed' })
    const detail = result.ok ? '' : result.detail ?? ''
    expect(detail).toContain('401 for key ***: invalid')
    expect(detail).not.toContain('sk-1')
    expect(detail.length).toBeLessThanOrEqual(301)
  })

  it('re-binds with the stored key when the key field is blank', async () => {
    const { routes, discoverModels, values } = makeRoutes()
    values[own.credentialRef] = 'sk-old'
    const result = await routes.bind({ ...request, apiKey: '', previous: own })
    expect(result.ok).toBe(true)
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { api: 'openai-completions', baseURL: 'https://a.example.com', apiKey: 'sk-old' }, expect.anything())
  })

  it('reports itself unavailable without the host services or with an empty namespace', () => {
    const credentials = { resolve: vi.fn() }
    const base = { llm: () => undefined, credentials, warn: vi.fn() }
    expect(new PersonalRoutes({ ...base, settings: () => undefined, namespace: () => 'llm-pi-ai' }).available()).toBe(false)
    expect(makeRoutes().routes.available()).toBe(true)
  })
})

describe('model cards', () => {
  const view: ModelCardView = {
    owner: 'u_a', bindable: true, rev: 'r1',
    defaults: { model: 'flash', models: ['flash', 'pro'] },
    selected: { source: 'default' },
    efforts: [{ id: 'low', name: '低' }],
  }

  it('renders both endpoints and the efforts of the effective model', () => {
    const json = JSON.stringify(buildModelCard(view))
    expect(json).toContain('✅ flash（缺省）')
    expect(json).not.toContain('跟随管理员缺省')
    expect(json).toContain('绑定我的 API')
    expect(json).toContain('✅ 模型默认')
    const owned = JSON.stringify(buildModelCard({ ...view, own: { baseURL: own.baseURL, models: own.models }, selected: { source: 'own' } }))
    expect(owned).toContain('我的 API · `m1`')
    expect(owned).toContain('✅ m1')
    expect(owned).toContain('修改或解绑我的 API')
  })

  it('shows the administrator effort as the default model\'s default effort only', () => {
    const withEffort: ModelCardView = { ...view, defaults: { ...view.defaults, effort: 'low' } }
    const json = JSON.stringify(buildModelCard(withEffort))
    expect(json).toContain('推理强度 `低`')
    expect(json).toContain('✅ 缺省（低）')
    const pinned = JSON.stringify(buildModelCard({ ...withEffort, selected: { source: 'default', model: 'pro' } }))
    expect(pinned).toContain('推理强度 模型默认')
    expect(pinned).toContain('✅ pro')
  })

  it('switches long model lists to one dropdown that reports the picked model', () => {
    const models = Array.from({ length: 20 }, (_, index) => `m${index}`)
    const card = JSON.stringify(buildModelCard({ ...view, own: { baseURL: own.baseURL, models }, selected: { source: 'own', model: 'm7' } }))
    expect(card).toContain('"tag":"select_static"')
    expect(card).toContain('"initial_option":"m7"')
    const value = { rev: 'r1', decision: 'llm-pref', owner: 'u_a', kind: 'model', source: 'own', pick: true }
    expect(parseLlmPrefAction(value, 'm9')).toEqual({ decision: 'llm-pref', kind: 'model', owner: 'u_a', source: 'own', model: 'm9' })
    expect(parseLlmPrefAction(value)).toBeUndefined()
    expect(parseLlmPrefAction({ ...value, source: 'default' }, '@@default'))
      .toEqual({ decision: 'llm-pref', kind: 'model', owner: 'u_a', source: 'default', model: '' })
  })

  it('keeps the render nonce within the channel\'s deduplicated value prefix', () => {
    const card = buildModelCard({ ...view, owner: 'u_0123456789abcdef', sessionId: '01234567-89ab-cdef-0123-456789abcdef' })
    const values = [...JSON.stringify(card).matchAll(/"value":(\{[^}]*\})/gu)].map(match => match[1]!)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value.slice(0, 128)).toContain('"rev":"r1"')
  })

  it('tells the owner when the bound Session runs on something else', () => {
    const json = JSON.stringify(buildModelCard({
      ...view, sessionId: 's1', session: { endpoint: 'other', provider: 'openrouter', model: 'x', effort: 'high' },
    }))
    expect(json).toContain('本会话目前用的是 `openrouter` · `x` · 推理强度 `high`')
    expect(json).not.toContain('🔑')
  })

  it('keeps a failed submit\'s protocol and URL and confirms before unbinding', () => {
    const json = JSON.stringify(buildBindCard({
      owner: 'u_a', rev: 'r1', error: 'x',
      current: { api: 'openai-completions', baseURL: 'https://old', models: 2 },
      draft: { api: 'anthropic-messages', baseURL: 'https://new' },
    }))
    expect(json).toContain('"initial_option":"anthropic-messages"')
    expect(json).toContain('"default_value":"https://new"')
    expect(json).toContain('"confirm"')
  })

  it('parses only well-formed selector and form actions', () => {
    expect(parseLlmPrefAction({ decision: 'llm-pref', kind: 'model', owner: 'u_a', source: 'default', model: '' }))
      .toEqual({ decision: 'llm-pref', kind: 'model', owner: 'u_a', source: 'default', model: '' })
    expect(parseLlmPrefAction({ decision: 'llm-pref', kind: 'model', owner: 'u_a', source: 'own', model: '' })).toBeUndefined()
    expect(parseLlmPrefAction({ decision: 'llm-pref', kind: 'effort', owner: 'u_a', effort: 'low', sessionId: 's' }))
      .toEqual({ decision: 'llm-pref', kind: 'effort', owner: 'u_a', effort: 'low', sessionId: 's' })
    expect(parseLlmPrefAction({ decision: 'llm-pref', kind: 'model', source: 'default', model: 'x' })).toBeUndefined()
    expect(parseLlmPrefAction('x')).toBeUndefined()
    expect(parseLlmBindAction({ decision: 'llm-bind', kind: 'unbind', owner: 'u_a' })).toEqual({ decision: 'llm-bind', kind: 'unbind', owner: 'u_a' })
    expect(parseLlmBindAction({ decision: 'llm-bind', kind: 'other', owner: 'u_a' })).toBeUndefined()
  })

  it('reads form fields from the raw callback', () => {
    expect(bindFormOf({ action: { form_value: { api: 'anthropic-messages', baseURL: 'https://x', apiKey: 'k', extra: 1 } } }))
      .toEqual({ api: 'anthropic-messages', baseURL: 'https://x', apiKey: 'k' })
    expect(bindFormOf(undefined)).toEqual({ api: '', baseURL: '', apiKey: '' })
  })
})

describe('UserLlmStore', () => {
  function makeStore() {
    const rows = new Map<string, UserLlmRecord>()
    const domain = {
      userLlm: {
        get: (key: string) => rows.get(key),
        put: async (key: string, value: UserLlmRecord) => { rows.set(key, value) },
        delete: async (key: string) => { rows.delete(key) },
        entries: () => rows.entries(),
      },
    } as unknown as FeishuDomainHandle
    return { rows, store: new UserLlmStore({ domain: () => domain, warn: vi.fn() }) }
  }

  it('writes through and falls back to the default endpoint when the personal one is removed', async () => {
    const { rows, store } = makeStore()
    await store.update('u_a', { own, source: 'own', model: 'm2', effort: 'low' })
    expect(rows.get('u_a')).toMatchObject({ source: 'own', model: 'm2', effort: 'low', own })
    await store.update('u_a', { effort: null })
    expect(store.get('u_a')?.effort).toBeUndefined()
    const cleared = await store.update('u_a', { own: null })
    expect(cleared).toMatchObject({ source: 'default' })
    expect(cleared.own).toBeUndefined()
    expect(cleared.model).toBeUndefined()
    await expect(store.remove('u_a')).resolves.toMatchObject({ userId: 'u_a' })
    expect(rows.size).toBe(0)
    await expect(store.remove('u_a')).resolves.toBeUndefined()
  })

  it('loads stored records', () => {
    const { rows, store } = makeStore()
    rows.set('u_b', record({ userId: 'u_b', model: 'pro' }))
    store.load()
    expect(store.all()).toEqual([record({ userId: 'u_b', model: 'pro' })])
  })
})
