/**
 * Native slash-command panel sync: the registry-derived entries, the
 * reconcile plan, and the service running it after the handshake (panel
 * state, log, scope self-check feed).
 */

import { describe, expect, it, vi } from 'vitest'
import { CHANNEL_COMMANDS } from '../src/commands/registry.ts'
import type { FeishuConfig } from '../src/config.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { ScopeGrant } from '../src/feishu/scopes.ts'
import { desiredSlashCommands, planSlashCommandSync, syncSlashCommands } from '../src/feishu/slash-commands.ts'
import type { RemoteSlashCommand, SlashCommandApi, SlashCommandEntry } from '../src/feishu/slash-commands.ts'
import { FeishuService } from '../src/service.ts'
import { makeAccessConfig } from './access-fixtures.ts'
import { makeChannel, makeHostContext, makeTempBaseDir } from './helpers.ts'

/** In-memory Feishu panel recording every write. */
function fakeApi(initial: readonly RemoteSlashCommand[] = []) {
  let serial = 0
  const remote = [...initial]
  const writes: string[] = []
  const api: SlashCommandApi = {
    list: vi.fn(async () => [...remote]),
    create: vi.fn(async (entry: SlashCommandEntry) => {
      writes.push(`create ${entry.command}`)
      remote.push({ id: `new_${++serial}`, ...entry })
    }),
    delete: vi.fn(async (id: string) => {
      writes.push(`delete ${id}`)
      remote.splice(remote.findIndex(item => item.id === id), 1)
    }),
  }
  return { api, remote, writes }
}

describe('desiredSlashCommands', () => {
  it('lists every canonical registry command once, without aliases', () => {
    const entries = desiredSlashCommands()
    expect(entries.map(entry => entry.command)).toEqual(CHANNEL_COMMANDS.map(spec => spec.name))
    expect(entries.find(entry => entry.command === 'help')).toEqual({ command: 'help', description: '显示当前支持的斜杠命令' })
    expect(entries.some(entry => entry.command === 'new')).toBe(false)
  })
})

describe('planSlashCommandSync', () => {
  const desired = [{ command: 'help', description: 'h' }, { command: 'stop', description: 's' }]

  it('creates missing commands and keeps current ones', () => {
    expect(planSlashCommandSync([{ id: '1', command: 'help', description: 'h' }], desired))
      .toEqual({ remove: [], create: [{ command: 'stop', description: 's' }] })
  })

  it('recreates changed descriptions and deletes stale and duplicate commands', () => {
    const remote = [
      { id: '1', command: 'help', description: 'old' },
      { id: '2', command: 'stop', description: 's' },
      { id: '3', command: 'stop', description: 's' },
      { id: '4', command: 'gone', description: 'g' },
    ]
    expect(planSlashCommandSync(remote, desired)).toEqual({
      remove: [remote[0], remote[2], remote[3]],
      create: [{ command: 'help', description: 'h' }],
    })
  })
})

describe('syncSlashCommands', () => {
  it('deletes before creating and is a no-op on the second run', async () => {
    const { api, writes } = fakeApi([{ id: 'x', command: 'legacy', description: 'l' }])
    const desired = desiredSlashCommands()
    await expect(syncSlashCommands(api, desired)).resolves.toEqual({ created: desired.length, removed: 1, total: desired.length })
    expect(writes[0]).toBe('delete x')
    writes.length = 0
    await expect(syncSlashCommands(api, desired)).resolves.toEqual({ created: 0, removed: 0, total: desired.length })
    expect(writes).toEqual([])
  })

  it('stops at the first failed write', async () => {
    const { api } = fakeApi()
    vi.mocked(api.create).mockRejectedValueOnce(new FeishuApiError('code=99991672 denied', 99991672))
    await expect(syncSlashCommands(api, desiredSlashCommands())).rejects.toBeInstanceOf(FeishuApiError)
    expect(api.create).toHaveBeenCalledTimes(1)
  })
})

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return makeAccessConfig({ baseDir: makeTempBaseDir(), statusRefreshMs: 60_000, routeTtlMs: 0, welcomeOnboarding: false, ...partial })
}

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

async function boot(options: Parameters<typeof makeChannel>[0]) {
  const ctxState = makeHostContext()
  const channel = makeChannel(options)
  const service = new FeishuService(ctxState.ctx, makeConfig(), () => channel)
  await service.start()
  return { service, ctxState }
}

describe('FeishuService slash-command panel sync', () => {
  it('syncs after connecting, records the counts, and clears them on shutdown', async () => {
    const { api } = fakeApi()
    const { service, ctxState } = await boot({ slashCommands: api })
    await vi.waitFor(() => expect(service.slashCommandSync()?.state).toBe('ok'))
    const total = CHANNEL_COMMANDS.length
    expect(service.slashCommandSync()).toMatchObject({ created: total, removed: 0, total })
    expect(mock(ctxState.ctx.logger?.info).mock.calls).toContainEqual([
      'dsh-channels: slash command panel synced (%d commands, %d created, %d removed)', total, total, 0,
    ])
    await service.shutdown()
    expect(service.slashCommandSync()).toBeUndefined()
  })

  it('records a Feishu rejection, warns, and lists the slash-command scope in the self-check', async () => {
    const { api } = fakeApi()
    vi.mocked(api.list).mockRejectedValueOnce(new FeishuApiError('code=99991672 Access denied', 99991672))
    const grants: readonly ScopeGrant[] = [
      'im:message', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly',
      'im:message.group_msg', 'contact:user.employee_id:readonly', 'im:chat:readonly',
    ].map(name => ({ name, granted: true }))
    const { service, ctxState } = await boot({ slashCommands: api, grantedScopes: async () => grants })
    await vi.waitFor(() => expect(service.scopeCheck()?.state).toBe('missing'))
    expect(service.slashCommandSync()).toMatchObject({ state: 'error', error: 'code=99991672 Access denied' })
    expect(mock(ctxState.ctx.logger?.warn).mock.calls).toContainEqual([
      'dsh-channels: 飞书原生斜杠指令面板同步失败（直接输入命令不受影响）：%s', 'code=99991672 Access denied',
    ])
    const check = service.scopeCheck()
    expect(check?.state === 'missing' ? check.missing.map(item => item.scopes[0]) : [])
      .toEqual(['application:app_slash_command:write'])
    await service.shutdown()
  })

  it('does not blame the scope for a transport failure', async () => {
    const { api } = fakeApi()
    vi.mocked(api.list).mockRejectedValueOnce(new Error('socket hang up'))
    const { service } = await boot({ slashCommands: api, grantedScopes: async () => [] })
    await vi.waitFor(() => expect(service.scopeCheck()?.state).toBe('missing'))
    expect(service.slashCommandSync()).toMatchObject({ state: 'error', error: 'socket hang up' })
    const check = service.scopeCheck()
    expect(check?.state === 'missing' && check.missing.some(item => item.scopes[0] === 'application:app_slash_command:write')).toBe(false)
    await service.shutdown()
  })
})
