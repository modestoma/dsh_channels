/**
 * Main-Session wakes of projects mode: merging, waiting for a running main
 * turn, the wake limit, and the switch.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import { RouteOperationQueue } from '../src/commands.ts'
import { dmMainRouteKey } from '../src/domain.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { DmTopicDirectory, DmTopicRecord } from '../src/dm/topic-directory.ts'
import { DmTopicWake } from '../src/dm/topic-wake.ts'
import type { InflightRepair } from '../src/session/repair.ts'
import type { RouteStore } from '../src/session/routes.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { TurnSubmission } from '../src/session/submit.ts'
import { makeChannel } from './helpers.ts'

const MAIN_KEY = dmMainRouteKey('oc_dm', 'u1')

function setup(partial: Record<string, unknown> = {}) {
  const config: FeishuConfig = resolveConfig({ dmTopicWake: 'agent', ...partial })
  const channel = makeChannel()
  let busy = false
  const pending: DmTopicRecord[] = []
  const route = { key: MAIN_KEY, sessionId: 'main', chatId: 'oc_dm', senderUserId: 'u1', dmRole: 'main', cardMessageId: 'om_0' } as RouteRecord
  const routes = new Map<string, RouteRecord>([[MAIN_KEY, route]])
  const delivered = vi.fn(async (items: ReadonlyArray<{ key: string; reportedAt: number }>) => {
    for (const item of items) {
      const index = pending.findIndex(record => record.key === item.key)
      if (index >= 0) pending.splice(index, 1)
    }
  })
  const run = vi.fn(async () => ({ accepted: true as const }))
  const wake = new DmTopicWake({
    config: () => config,
    started: () => true,
    channel: () => channel,
    routes: { get: (key: string) => routes.get(key), put: async (key: string, record: RouteRecord) => { routes.set(key, record) } } as unknown as RouteStore,
    directory: {
      pendingUpdates: () => [...pending],
      statusOf: () => 'idle',
      markDelivered: delivered,
    } as unknown as DmTopicDirectory,
    sessions: { ensureLive: async () => ({ agent: {} }) } as unknown as SessionManager,
    prompts: { run } as unknown as TurnSubmission,
    repair: { write: async () => {} } as unknown as InflightRepair,
    queue: new RouteOperationQueue(),
    busy: () => busy,
    chatReplies: () => true,
    warn: vi.fn(),
    mergeMs: 5,
  })
  const report = (key: string, summary: string): void => {
    pending.push({ key, userId: 'u1', chatId: 'oc_dm', title: key, openedBy: 'main', createdAt: 0, updatedAt: 0, summary, reportedAt: Date.now(), replies: [] })
    wake.topicReported('u1', 'oc_dm')
  }
  return { wake, channel, run, delivered, report, route, setBusy: (value: boolean) => { busy = value } }
}

const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 40))

describe('DmTopicWake', () => {
  it('merges reports that arrive together into one main turn', async () => {
    const h = setup()
    h.report('t1', '结果：A')
    h.report('t2', '结果：B')
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    const prompt = (h.run.mock.calls[0] as unknown as [unknown, { content: Array<{ text: string }> }])[1]
    expect(prompt.content[0]!.text).toContain('结果：A')
    expect(prompt.content[0]!.text).toContain('结果：B')
    expect(h.delivered).toHaveBeenCalledTimes(1)
    await h.wake.drain()
  })

  it('waits for a running main turn and wakes after it settles', async () => {
    const h = setup()
    h.setBusy(true)
    h.report('t1', '结果：A')
    await settle()
    expect(h.run).not.toHaveBeenCalled()
    h.setBusy(false)
    h.wake.mainTurnSettled(h.route)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    await h.wake.drain()
  })

  it('shows notice cards after the wake limit until the person writes again', async () => {
    const h = setup({ dmTopicWakeLimit: 1 })
    h.report('t1', '结果：A')
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    h.report('t2', '结果：B')
    await vi.waitFor(() => expect(JSON.stringify(h.channel.sent.at(-1)?.input)).toContain('话题有进展'))
    expect(h.run).toHaveBeenCalledTimes(1)
    h.wake.personSpoke('u1')
    h.report('t3', '结果：C')
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    await h.wake.drain()
  })

  it('does nothing when switched off or when nothing is waiting any more', async () => {
    const off = setup({ dmTopicWake: 'off' })
    off.report('t1', '结果：A')
    await settle()
    expect(off.run).not.toHaveBeenCalled()
    expect(off.channel.sent).toEqual([])
    const taken = setup()
    taken.wake.topicReported('u1', 'oc_dm')
    await settle()
    expect(taken.run).not.toHaveBeenCalled()
    await taken.wake.drain()
  })
})
