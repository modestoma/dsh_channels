/**
 * Private-chat projects mode: the person's directory layout, the read roots
 * per role, the move to a Session's own directory, the main-Session tool
 * gate, topic summaries, and the topic directory.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionLineage } from '../src/access/lineage.ts'
import type { RouteRecord } from '../src/domain.ts'
import {
  dmProjectRoot, dmSessionDir, dmSharedDir, enterSessionDir, readRootsOf, routeWorkDir,
} from '../src/dm/layout.ts'
import { MainToolGate } from '../src/dm/tool-gate.ts'
import { extractTopicReport } from '../src/dm/report.ts'
import { DmTopicDirectory, topicTitle, topicUpdatesBlock } from '../src/dm/topic-directory.ts'
import type { DmTopicRecord } from '../src/dm/topic-directory.ts'
import { forwardedPrompt, handOverPrompt } from '../src/dm/topic-opener.ts'
import type { DomainTable } from '../src/storage/table.ts'
import type { Agent, HostContext, PreToolExecution } from '../src/host/index.ts'

describe('projects-mode layout', () => {
  it('places the person, the main Session, topics and shared files below the base directory', () => {
    const root = dmProjectRoot('/srv/feishu', 'u_alice')
    expect(root).toBe('/srv/feishu/p2p/u_alice')
    expect(dmSessionDir(root, 'main')).toBe('/srv/feishu/p2p/u_alice/main')
    expect(dmSessionDir(root, 'topic', 'omt_1')).toBe('/srv/feishu/p2p/u_alice/topics/omt_1')
    expect(dmSharedDir(root)).toBe('/srv/feishu/p2p/u_alice/shared')
    expect(() => dmSessionDir(root, 'topic')).toThrow('topic token')
    expect(() => dmSessionDir(root, 'topic', '../x')).toThrow()
    expect(() => dmProjectRoot('/srv/feishu', '../u_bob')).toThrow()
  })

  it('reads the own directory plus shared/ for projects routes and the workspace otherwise', () => {
    const root = '/srv/feishu/p2p/u_alice'
    expect(routeWorkDir({ workspacePath: root, currentDir: `${root}/main` })).toBe(`${root}/main`)
    expect(routeWorkDir({ workspacePath: '/srv/feishu/p2p/u_alice/omt_9' })).toBe('/srv/feishu/p2p/u_alice/omt_9')
    expect(readRootsOf({ workspacePath: root, currentDir: `${root}/topics/omt_1`, dmRole: 'topic' }))
      .toEqual([`${root}/topics/omt_1`, `${root}/shared`])
    expect(readRootsOf({ workspacePath: `${root}/omt_9` })).toEqual([`${root}/omt_9`])
  })

  it('moves a Session to its own directory, creating it, and degrades to a warning without the service', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-channels-dm-')), 'topics', 'omt_1')
    const agent = { id: 's1' } as unknown as Agent
    const set = vi.fn(async (_agent: Agent, target: string) => target)
    await enterSessionDir({ get: () => ({ set }) } as unknown as HostContext, agent, dir, vi.fn())
    expect(existsSync(dir)).toBe(true)
    expect(set).toHaveBeenCalledWith(agent, dir)
    const warn = vi.fn()
    await enterSessionDir({ get: () => undefined } as unknown as HostContext, agent, dir, warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no working-directory service'), 's1')
  })
})

describe('MainToolGate', () => {
  function gate() {
    const routes = new Map<string, RouteRecord>([
      ['s_main', { dmRole: 'main' } as RouteRecord],
      ['s_topic', { dmRole: 'topic' } as RouteRecord],
      ['s_group', {} as RouteRecord],
    ])
    const config = { dmMainTools: ['read', 'web_search'] }
    const lineage = new SessionLineage(sessionId => routes.get(sessionId))
    return { config, gate: new MainToolGate({ config: () => config, routeOf: id => routes.get(id), lineage }) }
  }
  const call = (name: string, sessionId: string, parentSession?: string): PreToolExecution => ({
    name,
    arguments: {},
    agent: { session: { id: sessionId, header: { parentSession } } } as unknown as Agent,
  })

  it('denies tools outside the allowlist for the main Session and its descendants only', () => {
    const { gate: g, config } = gate()
    expect(g.decide(call('read', 's_main'))).toBeUndefined()
    expect(g.decide(call('bash', 's_main'))).toMatchObject({ kind: 'deny', reason: expect.stringContaining('私聊主会话不能调用 bash') })
    expect(g.decide(call('write', 's_child', 's_main'))).toMatchObject({ kind: 'deny' })
    expect(g.decide(call('bash', 's_topic'))).toBeUndefined()
    expect(g.decide(call('bash', 's_group'))).toBeUndefined()
    expect(g.decide(call('bash', 's_web'))).toBeUndefined()
    expect(g.decide({ name: 'bash', arguments: {} })).toBeUndefined()
    config.dmMainTools = ['read', 'bash']
    expect(g.decide(call('bash', 's_main'))).toBeUndefined()
  })

  it('always allows the main Session its topic tools, whatever dmMainTools lists', () => {
    const { gate: g, config } = gate()
    config.dmMainTools = []
    for (const name of ['feishu_topic_open', 'feishu_topic_list', 'feishu_topic_read', 'feishu_topic_send']) {
      expect(g.decide(call(name, 's_main'))).toBeUndefined()
    }
    expect(g.decide(call('read', 's_main'))).toMatchObject({ kind: 'deny', reason: expect.stringContaining('feishu_topic_open') })
  })
})

describe('topic reports', () => {
  it('reads the last 小结 block, with or without Markdown decoration', () => {
    const reply = [
      '前面的分析……',
      '',
      '小结',
      '做了：旧的',
      '结果：旧的',
      '需要你：无',
      '',
      '更多内容',
      '',
      '**小结：**',
      '- **做了：** 跑了测试',
      '- 结果：3 个用例失败，报告在 shared/report.md',
      '- 需要你：确认是否回滚',
    ].join('\n')
    expect(extractTopicReport(reply, 300)).toEqual({
      summary: '做了：跑了测试\n结果：3 个用例失败，报告在 shared/report.md\n需要你：确认是否回滚',
      needsYou: true,
    })
    expect(extractTopicReport('## 小结\n做了：查了日志\n结果：没问题\n需要你：无', 300)).toEqual({
      summary: '做了：查了日志\n结果：没问题\n需要你：无',
      needsYou: false,
    })
  })

  it('cuts a long summary and falls back to the reply tail without a block', () => {
    const long = extractTopicReport(`小结\n做了：${'很'.repeat(100)}`, 20)
    expect([...long!.summary]).toHaveLength(20)
    expect(long!.summary.endsWith('…')).toBe(true)
    expect(extractTopicReport('开头\n中间\n结论在最后', 6)).toEqual({ summary: '…结论在最后', needsYou: false })
    expect(extractTopicReport('小结\n不是字段', 300)).toEqual({ summary: '小结\n不是字段', needsYou: false })
    expect(extractTopicReport('   ', 300)).toBeUndefined()
  })
})

describe('DmTopicDirectory', () => {
  function fakeTable(): DomainTable<DmTopicRecord> {
    const rows = new Map<string, DmTopicRecord>()
    return {
      get: key => rows.get(key),
      put: async (key, value) => { rows.set(key, value) },
      update: async (key, fn) => {
        const current = rows.get(key)
        if (current === undefined) throw new Error('missing-key')
        rows.set(key, fn(current))
      },
      delete: async key => rows.delete(key),
      entries: () => rows.entries(),
    }
  }
  function directory() {
    let now = 1_000
    const table = fakeTable()
    const routes = new Map<string, RouteRecord>()
    const busy = new Set<string>()
    const waiting = new Set<string>()
    const warn = vi.fn()
    const dir = new DmTopicDirectory({
      table: () => table,
      route: key => routes.get(key),
      busy: id => busy.has(id),
      waiting: id => waiting.has(id),
      warn,
      now: () => now,
    })
    return { dir, routes, busy, waiting, warn, tick: (ms: number) => { now += ms } }
  }

  it('records topics, keeps the last replies, and queues each new summary for the main Session once', async () => {
    const { dir, routes, tick } = directory()
    await dir.register({ key: 'omt_a', userId: 'u_alice', chatId: 'oc_dm', title: '修复登录\n第二行', openedBy: 'main', rootMessageId: 'om_root', brief: '背景' })
    await dir.register({ key: 'omt_b', userId: 'u_bob', chatId: 'oc_dm2', title: '别人的', openedBy: 'user' })
    routes.set('omt_a', { sessionId: 's_a' } as RouteRecord)
    expect(dir.get('omt_a')).toMatchObject({ title: '修复登录', openedBy: 'main', rootMessageId: 'om_root', brief: '背景', replies: [] })
    expect(dir.pendingUpdates('u_alice')).toEqual([])

    for (let turn = 1; turn <= 6; turn += 1) {
      tick(10)
      await dir.recordTurn('omt_a', 'done', `第 ${turn} 轮\n小结\n做了：第 ${turn} 轮\n结果：好\n需要你：无`, 300)
    }
    expect(dir.get('omt_a')!.replies.map(reply => reply.text.split('\n')[0])).toEqual(['第 2 轮', '第 3 轮', '第 4 轮', '第 5 轮', '第 6 轮'])
    const pending = dir.pendingUpdates('u_alice')
    expect(pending.map(record => record.key)).toEqual(['omt_a'])
    expect(topicUpdatesBlock(pending, record => dir.statusOf(record))).toBe([
      '<dm_topic_updates>',
      '自上次以来这些话题有了进展：',
      '',
      '话题「修复登录」（topic_id: omt_a，空闲）',
      '做了：第 6 轮\n结果：好\n需要你：无',
      '</dm_topic_updates>',
    ].join('\n'))

    await dir.markDelivered([{ key: 'omt_a', reportedAt: pending[0]!.reportedAt! }])
    expect(dir.pendingUpdates('u_alice')).toEqual([])
    tick(10)
    await dir.recordTurn('omt_a', 'stopped', '', 300)
    expect(dir.pendingUpdates('u_alice')[0]).toMatchObject({ summary: '本轮被停止。', lastOutcome: 'stopped' })
    // An older delivery never moves the mark back.
    await dir.markDelivered([{ key: 'omt_a', reportedAt: 0 }])
    expect(dir.pendingUpdates('u_alice')).toHaveLength(1)
    expect(topicUpdatesBlock([], () => 'idle')).toBe('')
  })

  it('derives the live status and counts running topics the main Session opened', async () => {
    const { dir, routes, busy, waiting, warn } = directory()
    await dir.register({ key: 'omt_m', userId: 'u_alice', chatId: 'oc_dm', title: 'm', openedBy: 'main' })
    await dir.register({ key: 'omt_u', userId: 'u_alice', chatId: 'oc_dm', title: 'u', openedBy: 'user' })
    await dir.register({ key: 'omt_f', userId: 'u_alice', chatId: 'oc_dm', title: 'f', openedBy: 'main' })
    routes.set('omt_m', { sessionId: 's_m' } as RouteRecord)
    routes.set('omt_u', { sessionId: 's_u' } as RouteRecord)
    await dir.markFailed('omt_f', '会话创建失败')
    const status = (key: string) => dir.statusOf(dir.get(key)!)
    expect([status('omt_m'), status('omt_u'), status('omt_f')]).toEqual(['idle', 'idle', 'failed'])
    expect(dir.get('omt_f')).toMatchObject({ summary: '未能开始：会话创建失败' })

    busy.add('s_m')
    busy.add('s_u')
    expect(status('omt_m')).toBe('running')
    expect(dir.runningOpenedByMain('u_alice')).toBe(1)
    waiting.add('s_m')
    expect(status('omt_m')).toBe('waiting')
    busy.clear()
    waiting.clear()
    await dir.recordTurn('omt_u', 'done', '小结\n做了：x\n需要你：选一个方案', 300)
    expect(status('omt_u')).toBe('waiting')
    routes.delete('omt_u')
    expect(status('omt_u')).toBe('closed')

    await dir.recordTurn('omt_missing', 'done', 'x', 300)
    expect(warn).toHaveBeenCalledWith('dsh-channels: no topic record %s to update', 'omt_missing')
  })

  it('titles a topic after the first non-blank line, cut to 30 characters', () => {
    expect(topicTitle('\n  帮我看看日志  \n第二行')).toBe('帮我看看日志')
    expect([...topicTitle('长'.repeat(40))]).toHaveLength(30)
    expect(topicTitle('  ')).toBe('新话题')
  })

  it('wraps a hand-over and a forwarded message for the topic Session', () => {
    expect(handOverPrompt('修复登录', '  背景：…  ', [{ title: '别的话题' } as DmTopicRecord])).toBe([
      '<dm_topic_brief>',
      '私聊主会话开了这个话题「修复登录」，交接说明如下：',
      '',
      '背景：…',
      '</dm_topic_brief>',
      '',
      '<dm_topics>',
      '这个人的其他话题（只供参考，你看不到它们的目录）：',
      '- 「别的话题」',
      '</dm_topics>',
    ].join('\n'))
    expect(handOverPrompt('t', 'b', [])).not.toContain('<dm_topics>')
    expect(forwardedPrompt(' 再加一个用例 ')).toBe('<dm_main_message>\n私聊主会话转来一条消息：\n\n再加一个用例\n</dm_main_message>')
  })
})
