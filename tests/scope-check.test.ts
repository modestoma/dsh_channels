/**
 * Post-connect scope self-check: the pure requirement comparison, and the
 * service running it after the handshake (panel state + log).
 */

import { describe, expect, it, vi } from 'vitest'
import type { FeishuConfig } from '../src/config.ts'
import { AppOwnerLookupError, FeishuApiError } from '../src/feishu-channel.ts'
import { checkScopes, scopeConsoleUrl, scopeRequirements } from '../src/feishu/scopes.ts'
import type { ScopeGrant } from '../src/feishu/scopes.ts'
import { FeishuService } from '../src/service.ts'
import { makeAccessConfig } from './access-fixtures.ts'
import { makeChannel, makeHostContext, makeTempBaseDir } from './helpers.ts'

const ALL_GRANTED: readonly ScopeGrant[] = [
  'im:message',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_msg',
  'contact:user.employee_id:readonly',
  'contact:user.base:readonly',
  'im:chat:readonly',
  'application:app_slash_command:read',
  'application:app_slash_command:write',
  'im:resource',
].map(name => ({ name, granted: true, type: 'tenant' as const }))

const NO_OWNER_FALLBACK = { dmEnabled: true, requireMention: true, ownerLookupFailed: false, slashCommandPanel: true, sendFile: true, wikiRead: false, wikiWrite: false }

describe('checkScopes', () => {
  it('reports nothing when every applicable need is granted', () => {
    expect(checkScopes(ALL_GRANTED, 'cli_x', NO_OWNER_FALLBACK)).toEqual({ missing: [] })
  })

  it('lists required needs before optional ones with per-scope and aggregate console links', () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'contact:user.employee_id:readonly' && grant.name !== 'im:chat:readonly')
    const result = checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK)
    expect(result.missing.map(item => [item.level, item.anyOf[0]])).toEqual([
      ['required', 'contact:user.employee_id:readonly'],
      ['optional', 'im:chat:readonly'],
    ])
    expect(result.missing[0]!.consoleUrl).toBe(scopeConsoleUrl('cli_x', ['contact:user.employee_id:readonly']))
    expect(result.consoleUrl).toBe(scopeConsoleUrl('cli_x', ['contact:user.employee_id:readonly', 'im:chat:readonly']))
  })

  it('ignores ungranted rows and user-identity grants', () => {
    const grants = ALL_GRANTED.map(grant => grant.name === 'im:message.p2p_msg:readonly'
      ? { ...grant, granted: false }
      : grant.name === 'contact:user.employee_id:readonly' ? { ...grant, type: 'user' as const } : grant)
    const names = checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing.map(item => item.anyOf[0])
    expect(names).toEqual(['im:message.p2p_msg:readonly', 'contact:user.employee_id:readonly'])
  })

  it('lists the contact profile scope as optional for real names and avatars', () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'contact:user.base:readonly')
    expect(checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing).toEqual([
      expect.objectContaining({ anyOf: ['contact:user.base:readonly'], level: 'optional' }),
    ])
  })

  it('accepts any alternative scope of a need', () => {
    const grants = ALL_GRANTED
      .filter(grant => grant.name !== 'im:message' && grant.name !== 'im:message.group_at_msg:readonly')
      .concat([{ name: 'im:message:send_as_bot', granted: true }, { name: 'im:message:update', granted: true },
        { name: 'im:message:readonly', granted: true }, { name: 'im:message.reactions:write_only', granted: true }])
    expect(checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing).toEqual([])
  })

  it('skips the DM scope when DMs are disabled and adds the app-info need when the owner lookup was rejected', () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'im:message.p2p_msg:readonly')
    expect(scopeRequirements({ ...NO_OWNER_FALLBACK, dmEnabled: false }).some(item => item.anyOf.includes('im:message.p2p_msg:readonly'))).toBe(false)
    const result = checkScopes(grants, 'cli_x', { ...NO_OWNER_FALLBACK, dmEnabled: false, ownerLookupFailed: true })
    expect(result.missing.map(item => [item.level, item.anyOf[0]])).toEqual([['optional', 'admin:app.info:readonly']])
  })

  it('lists the slash-command scopes only while the panel sync is enabled', () => {
    const grants = ALL_GRANTED.filter(grant => !grant.name.startsWith('application:app_slash_command'))
    expect(checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing.map(item => item.anyOf[0]))
      .toEqual(['application:app_slash_command:read', 'application:app_slash_command:write'])
    expect(checkScopes(grants, 'cli_x', { ...NO_OWNER_FALLBACK, slashCommandPanel: false }).missing).toEqual([])
  })

  it('lists the upload scope only while feishu_send_file is enabled and accepts im:resource:upload', () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'im:resource')
    expect(checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing.map(item => [item.level, item.anyOf.join('|')]))
      .toEqual([['optional', 'im:resource|im:resource:upload']])
    expect(checkScopes(grants, 'cli_x', { ...NO_OWNER_FALLBACK, sendFile: false }).missing).toEqual([])
    expect(checkScopes(grants.concat([{ name: 'im:resource:upload', granted: true }]), 'cli_x', NO_OWNER_FALLBACK).missing).toEqual([])
  })

  it('lists the wiki scopes only while a wiki tool set is enabled, read accepting readonly scopes', () => {
    expect(checkScopes(ALL_GRANTED, 'cli_x', NO_OWNER_FALLBACK).missing).toEqual([])
    const read = { ...NO_OWNER_FALLBACK, wikiRead: true }
    expect(checkScopes(ALL_GRANTED, 'cli_x', read).missing.map(item => item.anyOf.join('|'))).toEqual([
      'wiki:wiki|wiki:wiki:readonly',
      'docx:document|docx:document:readonly',
      'sheets:spreadsheet:read',
      'base:table:read',
      'base:field:read',
      'base:record:read',
    ])
    const readonly = ALL_GRANTED.concat(['wiki:wiki:readonly', 'docx:document:readonly', 'sheets:spreadsheet:read', 'base:table:read', 'base:field:read', 'base:record:read']
      .map(name => ({ name, granted: true })))
    expect(checkScopes(readonly, 'cli_x', read).missing).toEqual([])
    expect(checkScopes(readonly, 'cli_x', { ...read, wikiWrite: true }).missing.map(item => item.anyOf.join('|')))
      .toEqual(['wiki:wiki', 'docx:document', 'sheets:spreadsheet:write_only', 'base:record:create', 'base:record:update', 'base:record:delete'])
  })

  it('requires group_msg when unmentioned group messages are answered', () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'im:message.group_msg')
    const noMention = { ...NO_OWNER_FALLBACK, requireMention: false }
    expect(checkScopes(grants, 'cli_x', noMention).missing.map(item => [item.level, item.anyOf.join('|')]))
      .toEqual([['required', 'im:message.group_msg']])
    expect(checkScopes(grants, 'cli_x', NO_OWNER_FALLBACK).missing.map(item => [item.level, item.anyOf.join('|')]))
      .toEqual([['optional', 'im:message.group_msg']])
    expect(checkScopes(ALL_GRANTED, 'cli_x', noMention).missing).toEqual([])
  })

  it('builds an encoded console URL', () => {
    expect(scopeConsoleUrl('cli_x', ['im:message', 'im:chat:readonly']))
      .toBe('https://open.feishu.cn/app/cli_x/auth?q=im%3Amessage%2Cim%3Achat%3Areadonly&op_from=openapi&token_type=tenant')
  })
})

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return makeAccessConfig({ baseDir: makeTempBaseDir(), statusRefreshMs: 60_000, routeTtlMs: 0, welcomeOnboarding: false, ...partial })
}

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>

async function boot(partial: Partial<FeishuConfig>, options: Parameters<typeof makeChannel>[0]) {
  const ctxState = makeHostContext()
  const channel = makeChannel(options)
  const service = new FeishuService(ctxState.ctx, makeConfig(partial), () => channel)
  await service.start()
  return { service, ctxState }
}

describe('FeishuService scope self-check', () => {
  it('records a passing check and logs it', async () => {
    const { service, ctxState } = await boot({}, { grantedScopes: async () => ALL_GRANTED })
    await vi.waitFor(() => expect(service.scopeCheck()?.state).toBe('ok'))
    expect(mock(ctxState.ctx.logger?.info).mock.calls).toContainEqual(['dsh-channels: scope self-check passed'])
    await service.shutdown()
    expect(service.scopeCheck()).toBeUndefined()
  })

  it('records missing scopes with deep links and warns about them', async () => {
    const grants = ALL_GRANTED.filter(grant => grant.name !== 'contact:user.employee_id:readonly')
    const { service, ctxState } = await boot({}, { grantedScopes: async () => grants })
    await vi.waitFor(() => expect(service.scopeCheck()?.state).toBe('missing'))
    const check = service.scopeCheck()
    expect(check).toMatchObject({
      missing: [{ scopes: ['contact:user.employee_id:readonly'], level: 'required', consoleUrl: expect.stringContaining('/auth?q=contact') }],
      consoleUrl: expect.stringContaining('open.feishu.cn/app/'),
    })
    const warn = mock(ctxState.ctx.logger?.warn).mock.calls.find(call => String(call[0]).includes('飞书权限缺失'))
    expect(warn?.[1]).toBe(1)
    expect(warn?.[3]).toContain('必需 contact:user.employee_id:readonly')
    await service.shutdown()
  })

  it('lists the app-info need only when the owner fallback was rejected by Feishu', async () => {
    const rejected = await boot({ adminUserId: undefined }, {
      grantedScopes: async () => ALL_GRANTED,
      appOwnerUserId: async () => { throw new AppOwnerLookupError('code=99991672 Access denied', 99991672) },
    })
    await vi.waitFor(() => expect(rejected.service.scopeCheck()?.state).toBe('missing'))
    const check = rejected.service.scopeCheck()
    expect(check?.state === 'missing' ? check.missing.map(item => item.scopes[0]) : []).toEqual(['admin:app.info:readonly'])
    await rejected.service.shutdown()

    const notMember = await boot({ adminUserId: undefined }, { grantedScopes: async () => ALL_GRANTED, appOwnerUserId: async () => undefined })
    await vi.waitFor(() => expect(notMember.service.scopeCheck()?.state).toBe('ok'))
    await notMember.service.shutdown()
  })

  it.each([
    ['Feishu error', async (): Promise<readonly ScopeGrant[]> => { throw new FeishuApiError('code=99991672 denied', 99991672) }, 'code=99991672 denied'],
    ['transport error', async (): Promise<readonly ScopeGrant[]> => { throw new Error('socket hang up') }, 'socket hang up'],
  ])('records a failed check (%s)', async (_name, grantedScopes, reason) => {
    const { service, ctxState } = await boot({}, { grantedScopes })
    await vi.waitFor(() => expect(service.scopeCheck()).toMatchObject({ state: 'error', error: reason }))
    expect(mock(ctxState.ctx.logger?.warn).mock.calls).toContainEqual(['dsh-channels: 飞书权限自检失败：%s', reason])
    await service.shutdown()
  })

  it('drops a result that arrives after shutdown and skips channels without the query', async () => {
    let settle: (grants: readonly ScopeGrant[]) => void = () => {}
    const late = await boot({}, { grantedScopes: () => new Promise(resolve => { settle = resolve }) })
    await late.service.shutdown()
    settle(ALL_GRANTED)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(late.service.scopeCheck()).toBeUndefined()

    const none = await boot({}, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(none.service.scopeCheck()).toBeUndefined()
    await none.service.shutdown()
  })

  it('times out a hanging query', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { service } = await boot({}, { grantedScopes: () => new Promise(() => {}) })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(service.scopeCheck()).toMatchObject({ state: 'error', error: expect.stringContaining('超时') })
      await service.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
})
