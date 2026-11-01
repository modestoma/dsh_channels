/**
 * Code-write gate: which tool calls it inspects, who drives a turn, and how
 * subagent Sessions inherit their routed ancestor.
 */

import { describe, expect, it } from 'vitest'
import { CodeWriteGate } from '../src/access/code-write.ts'
import type { AccessPermission, RouteRecord } from '../src/domain.ts'
import type { Agent, PreToolExecution } from '../src/dsh-types.ts'

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
    gate.noteMessage('m1', 'u_admin')
    gate.onClaimed('s_root', 'm1')
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
    gate.noteMessage('m_bob', 'u_bob')
    gate.onClaimed('s_root', 'm_bob')
    expect(gate.decide(call('s_root'))).toBeUndefined()
    // A turn without a noted message (subagent result, job) keeps Bob.
    gate.onClaimed('s_root', 'm_unknown')
    expect(gate.decide(call('s_root'))).toBeUndefined()

    gate.noteMessage('m_carol', 'u_carol')
    gate.onClaimed('s_root', 'm_carol')
    expect(gate.decide(call('s_root'))?.kind).toBe('deny')
  })

  it('applies the routed ancestor driver to subagents, including nested ones, until cleared', () => {
    const { gate, routes } = setup()
    expect(gate.decide(call('s_child', 's_root'))?.kind).toBe('deny')
    expect(gate.decide(call('s_grandchild', 's_child'))?.kind).toBe('deny')

    gate.noteMessage('m_admin', 'u_admin')
    gate.onClaimed('s_root', 'm_admin')
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
    gate.noteMessage('m_bob', 'u_bob')
    gate.onClaimed('s_root', 'm_bob')
    expect(gate.driverOf('s_child')).toBe('u_bob')
    expect(gate.driverOf('s_web')).toBeUndefined()
  })

  it('denies every gated call of a turn whose sender is unknown, and names no driver for it', () => {
    const { gate } = setup({ u_owner: ['codeWrite'] })
    gate.noteMessage('m_replayed', undefined)
    gate.onClaimed('s_root', 'm_replayed')
    const decision = gate.decide(call('s_root'))
    expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringContaining('无法确认这一轮的飞书发言人') })
    expect(gate.decide(call('s_root', undefined, 'read_file'))).toBeUndefined()
    expect(gate.driverOf('s_root')).toBeUndefined()
    gate.noteMessage('m_next', 'u_owner')
    gate.onClaimed('s_root', 'm_next')
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('forgets the oldest noted senders beyond its bound', () => {
    const { gate } = setup({ u_bob: ['codeWrite'] })
    gate.noteMessage('m_first', 'u_bob')
    for (let index = 0; index < 2_000; index++) gate.noteMessage(`m_${index}`, 'u_carol')
    gate.onClaimed('s_root', 'm_first')
    expect(gate.decide(call('s_root'))?.kind).toBe('deny')
  })
})
