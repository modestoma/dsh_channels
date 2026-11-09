/**
 * Code-write gate: which tool calls it inspects, whose switches decide (the
 * route's location, never the speaker), how subagent Sessions inherit their
 * routed ancestor, and which speaker it names for commit trailers.
 */

import { describe, expect, it } from 'vitest'
import { CodeWriteGate } from '../src/access/code-write.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { Agent, PreToolExecution } from '../src/host/index.ts'
import type { UserMessage } from '../src/host/core.ts'

const PUSH = 'repo_workspace_push'

/** A gate over one routed Session `s_root` opened by `u_owner` in a private chat. */
function setup(route: Partial<RouteRecord> = {}, writable: (route: RouteRecord) => boolean = () => false) {
  const routes = new Map<string, RouteRecord>([['s_root', { chatId: 'oc_p2p', chatType: 'p2p', senderUserId: 'u_owner', ...route } as RouteRecord]])
  const tools = [PUSH, 'repo_mr_create']
  const gate = new CodeWriteGate({
    config: () => ({ codeWriteTools: tools }),
    routeOf: sessionId => routes.get(sessionId),
    mayWrite: writable,
  })
  return { gate, routes, tools }
}

/** One pending call by the agent of `sessionId`. */
function call(sessionId: string, parentSession?: string, name = PUSH): PreToolExecution {
  const agent = { session: { id: sessionId, header: { parentSession } } } as unknown as Agent
  return { name, agent }
}

/** A claimed prompt DSH created for one Feishu user's private-chat submission. */
function from(userId: string): Pick<UserMessage, 'source'> {
  return { source: { kind: 'user', rpcId: 'r', principal: { kind: 'feishu-user', userId } } }
}

/** A claimed prompt DSH created for one member's submission in a group. */
function fromGroup(chatId: string, userId: string): Pick<UserMessage, 'source'> {
  return { source: { kind: 'user', rpcId: 'r', principal: { kind: 'feishu-group', chatId, userId } } }
}

describe('CodeWriteGate', () => {
  it('denies a gated tool when the private-chat person lacks codeWrite, naming the user and the fix', () => {
    const { gate } = setup()
    const decision = gate.decide(call('s_root'))
    expect(decision?.kind).toBe('deny')
    expect(decision && 'reason' in decision ? decision.reason : '').toContain('飞书用户 u_owner 没有代码改动权限，不能调用 repo_workspace_push')
    expect(decision && 'reason' in decision ? decision.reason : '').toContain('/auth set code on')
  })

  it('denies a gated tool in a group whose permission record lacks codeWrite, pointing at the group table', () => {
    const { gate } = setup({ chatId: 'oc_group', chatType: 'group' })
    const decision = gate.decide(call('s_root'))
    expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringContaining('本群没有代码改动权限') })
    expect(decision && 'reason' in decision ? decision.reason : '').toContain('「群权限」')
  })

  it('delegates when the route location holds codeWrite, whoever speaks', () => {
    const { gate } = setup({}, () => true)
    expect(gate.decide(call('s_root'))).toBeUndefined()
    gate.onClaimed('s_root', from('u_stranger'))
    expect(gate.decide(call('s_root'))).toBeUndefined()
    gate.onClaimed('s_root', { source: { kind: 'user', rpcId: 'r', principal: { kind: 'share-viewer', shareId: 's' } } })
    expect(gate.decide(call('s_root'))).toBeUndefined()
  })

  it('reads the switch live: a denied route delegates once its location is granted', () => {
    let granted = false
    const { gate } = setup({}, () => granted)
    expect(gate.decide(call('s_root'))?.kind).toBe('deny')
    granted = true
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

  it('applies the routed ancestor rule to subagents, including nested ones, until cleared', () => {
    const { gate, routes } = setup()
    expect(gate.decide(call('s_child', 's_root'))?.kind).toBe('deny')
    expect(gate.decide(call('s_grandchild', 's_child'))?.kind).toBe('deny')

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

  it('resolves the routed root of a Session through the live parent chain and remembers it', () => {
    const { gate } = setup()
    const parents = new Map([['s_child', 's_root'], ['s_grandchild', 's_child'], ['s_loop', 's_loop'], ['s_web_child', 's_web']])
    const parentOf = (id: string) => parents.get(id)
    expect(gate.resolveRoot('s_root', parentOf)).toBe('s_root')
    expect(gate.resolveRoot('s_grandchild', parentOf)).toBe('s_root')
    // Remembered: the chain is not walked again, and the speaker follows.
    expect(gate.resolveRoot('s_grandchild', () => undefined)).toBe('s_root')
    expect(gate.speakerOf('s_child')).toBe('u_owner')
    expect(gate.resolveRoot('s_web_child', parentOf)).toBeUndefined()
    expect(gate.resolveRoot('s_loop', parentOf)).toBeUndefined()
    expect(gate.resolveRoot('s_orphan', () => undefined)).toBeUndefined()
  })

  it('names the speaker of routed Sessions and of descendants it has seen', () => {
    const { gate } = setup()
    expect(gate.speakerOf('s_root')).toBe('u_owner')
    expect(gate.speakerOf('s_child')).toBeUndefined()
    gate.decide(call('s_child', 's_root', 'read_file'))
    gate.onClaimed('s_root', from('u_bob'))
    expect(gate.speakerOf('s_child')).toBe('u_bob')
    expect(gate.speakerOf('s_web')).toBeUndefined()
  })

  it('keeps the speaker across turns no Feishu message started', () => {
    const { gate } = setup()
    gate.onClaimed('s_root', from('u_bob'))
    gate.onClaimed('s_root', { source: { kind: 'user' } })
    gate.onClaimed('s_root', { source: { kind: 'user', rpcId: 'r1' } as UserMessage['source'] })
    gate.onClaimed('s_root', { source: { kind: 'subagent-settled' } })
    expect(gate.speakerOf('s_root')).toBe('u_bob')
    gate.onClaimed('s_root', from('u_carol'))
    expect(gate.speakerOf('s_root')).toBe('u_carol')
  })

  it('names no speaker for a turn whose sender is not a Feishu user, until a Feishu message is claimed', () => {
    const { gate } = setup()
    gate.onClaimed('s_root', { source: { kind: 'user', rpcId: 'r', principal: { kind: 'share-viewer', shareId: 's' } } })
    expect(gate.speakerOf('s_root')).toBeUndefined()
    gate.onClaimed('s_root', from('u_owner'))
    expect(gate.speakerOf('s_root')).toBe('u_owner')
  })

  it('falls back to the route\'s last recorded speaker before any claimed message, then to the initiator', () => {
    const { gate, routes } = setup({ chatId: 'oc_group', chatType: 'group', lastSpeakerUserId: 'u_last' })
    expect(gate.speakerOf('s_root')).toBe('u_last')
    routes.set('s_root', { ...routes.get('s_root')!, lastSpeakerUserId: undefined })
    expect(gate.speakerOf('s_root')).toBe('u_owner')
    gate.onClaimed('s_root', fromGroup('oc_group', 'u_bob'))
    expect(gate.speakerOf('s_root')).toBe('u_bob')
  })

  it('reads the speaker from the durable principal, so it needs no record of submitted messages', () => {
    const { gate } = setup()
    // The same message read back from the Session log.
    gate.onClaimed('s_root', JSON.parse(JSON.stringify(from('u_bob'))) as UserMessage)
    expect(gate.speakerOf('s_root')).toBe('u_bob')
  })

  it('takes the member of a group principal as the speaker; a group principal without its chat is malformed', () => {
    const { gate } = setup({ chatId: 'oc_group', chatType: 'group' })
    gate.onClaimed('s_root', fromGroup('oc_group', 'u_bob'))
    expect(gate.speakerOf('s_root')).toBe('u_bob')
    gate.onClaimed('s_root', { source: { kind: 'user', rpcId: 'r', principal: { kind: 'feishu-group', userId: 'u_carol' } } })
    expect(gate.speakerOf('s_root')).toBeUndefined()
  })
})
