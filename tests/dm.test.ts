/**
 * Private-chat projects mode: the person's directory layout, the read roots
 * per role, the move to a Session's own directory, and the main-Session tool
 * gate.
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
})
