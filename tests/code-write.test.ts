/**
 * Code-write gate: which tool calls it inspects, who drives a turn, and how
 * subagent Sessions inherit their routed ancestor.
 */

import { describe, expect, it } from 'vitest'
import { CodeWriteGate } from '../src/access/code-write.ts'
import type { AccessPermission, RouteRecord } from '../src/domain.ts'
import type { Agent, PreToolExecution } from '../src/dsh-types.ts'
import type { UserMessage } from '../src/host/core.ts'
import { feishuUserMessage } from '../src/access/principal.ts'

const PUSH = 'repo_workspace_push'

/** A gate over one routed Session `s_root` owned by `u_owner`. */
function setup(granted: Record<string, AccessPermission[]> = {}) {
  const routes = new Map<string, RouteRecord>([['s_root', { senderUserId: 'u_owner' } as RouteRecord]])
  const tools = [PUSH, 'repo_mr_create']
  const gate = new CodeWriteGate({
    config: () => ({ codeWriteTools: tools }),
    routeOf: sessionId => routes.get(sessionId),
    mayUse: (userId, permission) => userId === 'u_admin' || (granted[userId] ?? []).includes(permission),
  })
  return { gate, routes, tools }
}

/** One pending call by the agent of `sessionId`. */
function call(sessionId: string, parentSession?: string, name = PUSH): PreToolExecution {
  const agent = { session: { id: sessionId, header: { parentSession } } } as unknown as Agent
  return { name, agent }
}

/** A claimed prompt sent by one Feishu user. */
function from(userId: string): Pick<UserMessage, 'source'> {
  return feishuUserMessage('prompt', userId)
}

describe('CodeWriteGate', () => {
  it('denies a gated tool when the route owner lacks codeWrite, naming the user and the fix', () => {
    const { gate } = setup()
    const decision = gate.decide(call('s_root'))
    expect(decision?.kind).toBe('deny')
    expect(decision && 'reason' in decision ? decision.reason : '').toContain('飞书用户 u_owner 没有代码改动权限，不能调用 repo_workspace_push')
    expect(decision && 'reason' in decision ? decision.reason : '').toContain('/auth set code on')
  })

  it('delegates when the driver holds codeWrite or is the administrator', () => {
    expect(setup({ u_owner: ['codeWrite'] }).gate.decide(call('s_root'))).toBeUndefined()
    const { gate } = setup()
    gate.onClaimed('s_root', from('u_admin'))
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('ignores tools outside codeWriteTools, calls without an agent, and Sessions it does not route', () => {
    const { gate, tools } = setup()
    expect(gate.decide(call('s_root', undefined, 'read_file'))).toBeUndefined()
    expect(gate.decide({ name: PUSH })).toBeUndefined()
    expect(gate.decide(call('s_web'))).toBeUndefined()
    expect(gate.decide(call('s_web_child', 's_web'))).toBeUndefined()
    // The tool list is read live.
    tools.length = 0
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('uses the sender of the claimed message as the driver, keeping it across turns no message started', () => {
    const { gate } = setup({ u_bob: ['codeWrite'] })
    gate.onClaimed('s_root', from('u_bob'))
    expect(gate.decide(call('s_root'))).toBeUndefined()
    // A turn no Feishu user started (owner, command, subagent result, job) keeps Bob.
    gate.onClaimed('s_root', { source: { kind: 'user' } })
    gate.onClaimed('s_root', { source: { kind: 'user', rpcId: 'r1' } as UserMessage['source'] })
    gate.onClaimed('s_root', { source: { kind: 'subagent-settled' } })
    expect(gate.decide(call('s_root'))).toBeUndefined()

    gate.onClaimed('s_root', from('u_carol'))
    expect(gate.decide(call('s_root'))?.kind).toBe('deny')
  })

  it('applies the routed ancestor driver to subagents, including nested ones, until cleared', () => {
    const { gate, routes } = setup()
    expect(gate.decide(call('s_child', 's_root'))?.kind).toBe('deny')
    expect(gate.decide(call('s_grandchild', 's_child'))?.kind).toBe('deny')

    gate.onClaimed('s_root', from('u_admin'))
    expect(gate.decide(call('s_grandchild', 's_child'))).toBeUndefined()

    gate.clear()
    expect(gate.decide(call('s_grandchild', 's_child'))).toBeUndefined()
    routes.delete('s_root')
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('gates a grandchild whose parent only ever called ungated tools', () => {
    const { gate } = setup()
    expect(gate.decide(call('s_child', 's_root', 'subagent_spawn'))).toBeUndefined()
    expect(gate.decide(call('s_grandchild', 's_child'))?.kind).toBe('deny')
  })

  it('names the driver of routed Sessions and of descendants it has seen', () => {
    const { gate } = setup()
    expect(gate.driverOf('s_root')).toBe('u_owner')
    expect(gate.driverOf('s_child')).toBeUndefined()
    gate.decide(call('s_child', 's_root', 'read_file'))
    gate.onClaimed('s_root', from('u_bob'))
    expect(gate.driverOf('s_child')).toBe('u_bob')
    expect(gate.driverOf('s_web')).toBeUndefined()
  })

  it('denies every gated call of a turn whose sender is unknown, and names no driver for it', () => {
    const { gate } = setup({ u_owner: ['codeWrite'] })
    gate.markSenderUnknown('s_root')
    const decision = gate.decide(call('s_root'))
    expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringContaining('无法确认这一轮的飞书发言人') })
    expect(gate.decide(call('s_root', undefined, 'read_file'))).toBeUndefined()
    expect(gate.driverOf('s_root')).toBeUndefined()
    gate.onClaimed('s_root', from('u_owner'))
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('reads the driver from the durable principal, so it needs no record of submitted messages', () => {
    const { gate } = setup({ u_bob: ['codeWrite'] })
    const prompt = feishuUserMessage('ship it', 'u_bob')
    expect(prompt.source).toMatchObject({ kind: 'user', principal: { kind: 'feishu-user', userId: 'u_bob' } })
    // The same message read back from a restart snapshot.
    gate.onClaimed('s_root', JSON.parse(JSON.stringify(prompt)) as UserMessage)
    expect(gate.decide(call('s_root'))).toBeUndefined()
    expect(gate.driverOf('s_root')).toBe('u_bob')
  })

  it('fails closed on a principal that is not a well-formed Feishu user, until a Feishu user is claimed', () => {
    const { gate } = setup({ u_owner: ['codeWrite'], u_bob: ['codeWrite'] })
    const sources = [
      { kind: 'user', rpcId: 'r', principal: { kind: 'share-viewer', shareId: 's' } },
      { kind: 'user', rpcId: 'r', principal: { kind: 'feishu-user', userId: '' } },
      { kind: 'user', rpcId: 'r', principal: { kind: 'feishu-user' } },
      { kind: 'user', rpcId: 'r', principal: 'u_bob' },
      { kind: 'user', rpcId: 'r', principal: null },
    ]
    for (const source of sources) {
      gate.onClaimed('s_root', from('u_bob'))
      gate.onClaimed('s_root', { source: source as UserMessage['source'] })
      expect(gate.decide(call('s_root'))).toMatchObject({ kind: 'deny', reason: expect.stringContaining('无法确认这一轮的飞书发言人') })
      // A message without a principal keeps the unknown driver.
      gate.onClaimed('s_root', { source: { kind: 'tool-jobs' } })
      expect(gate.decide(call('s_root'))?.kind).toBe('deny')
    }
    gate.onClaimed('s_root', from('u_bob'))
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('ignores a principal on a source that is not a user prompt', () => {
    const { gate } = setup({ u_owner: ['codeWrite'] })
    gate.onClaimed('s_root', { source: { kind: 'tool-jobs', principal: { kind: 'feishu-user', userId: 'u_carol' } } as UserMessage['source'] })
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })
})
