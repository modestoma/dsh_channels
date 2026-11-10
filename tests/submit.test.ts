/**
 * Prompt submission through `session/prompt`: one Peer per principal, image
 * staging by receipt, re-staging after a restart, the queued-card merge, and
 * the wording of refused submissions.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PeerRegistry } from '../src/access/peers.ts'
import { feishuGroupPrincipal, feishuUserPrincipal, type ChannelPrincipal } from '../src/access/principal.ts'
import { ROUTE_NOT_PERMITTED } from '../src/access/remote-policy.ts'
import type { UserMessage } from '../src/host/index.ts'
import { requireRemoteServices } from '../src/host/remote.ts'
import type { ChannelPrompt } from '../src/session/prompt.ts'
import { PromptSubmitter, steerQueued, submissionFailureText } from '../src/session/submit.ts'
import { FakeTurnDriver, makeAgentRegistry, makeAttachmentStore, makeRemoteServices, makeSession, remoteError, sessionEvents } from './helpers.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

async function setup() {
  const claimed: UserMessage[] = []
  const driver = new FakeTurnDriver((_session, message) => { claimed.push(message) })
  const agents = makeAgentRegistry({ driver })
  const attachments = makeAttachmentStore()
  const remote = makeRemoteServices({ agents: agents.registry, attachments, llm: { resolveModelInfo: vi.fn(async () => ({})) } })
  const warn = vi.fn()
  const peers = new PeerRegistry({ connection: () => remote.connection, warn })
  const submitter = new PromptSubmitter({
    gateway: () => remote.gateway,
    fileUploads: () => remote.fileUploads,
    attachments: () => attachments,
    peers,
    warn,
  })
  const handle = await agents.registry.create({ sessionId: 's_1' as never })
  // Every Session is permitted: the policy is tested in remote-policy.test.ts.
  remote.remoteAccess.registerPolicy('feishu-user', { bindings: () => [{ role: { name: 'r', resource: 'session', actions: ['session/prompt'] }, resource: { kind: 'session', id: 's_1' } }] })
  remote.remoteAccess.registerPolicy('feishu-group', { bindings: () => [{ role: { name: 'r', resource: 'session', actions: ['session/prompt'] }, resource: { kind: 'session', id: 's_1' } }] })
  return { agents, attachments, remote, peers, submitter, agent: handle.agent, driver, claimed, warn }
}

const textPrompt = (requestId: string, principal: ChannelPrincipal = feishuUserPrincipal('u_alice')): ChannelPrompt =>
  ({ requestId, principal, content: [{ type: 'text', text: `hi ${requestId}` }] })

describe('PromptSubmitter', () => {
  it('submits as the Peer of the prompt\'s principal, one Peer per principal value', async () => {
    const { submitter, agent, remote, peers, claimed, driver } = await setup()
    await submitter.submit(agent, textPrompt('r1'), 'queue')
    await submitter.submit(agent, textPrompt('r2'), 'queue')
    await submitter.submit(agent, textPrompt('r3', feishuGroupPrincipal('oc_g', 'u_alice')), 'queue')
    await submitter.submit(agent, textPrompt('r4', feishuGroupPrincipal('oc_g', 'u_bob')), 'queue')
    expect(remote.connection.peers.map(peer => peer.principal)).toEqual([
      feishuUserPrincipal('u_alice'), feishuGroupPrincipal('oc_g', 'u_alice'), feishuGroupPrincipal('oc_g', 'u_bob'),
    ])
    expect(peers.size()).toBe(3)
    expect(remote.gateway.calls.map(call => [call.namespace, call.method, call.peer.principal.kind])).toEqual([
      ['session', 'prompt', 'feishu-user'], ['session', 'prompt', 'feishu-user'], ['session', 'prompt', 'feishu-group'], ['session', 'prompt', 'feishu-group'],
    ])
    expect(remote.gateway.calls[0]!.args).toEqual({ request: { requestId: 'r1', sessionId: 's_1', mode: 'queue', content: [{ type: 'text', text: 'hi r1' }] } })
    // DSH minted the messages and recorded the request id and principal on
    // each; the fake loop claimed the first and queues the rest behind it.
    const submitted = [...claimed, ...driver.queued(agent.session)]
    expect(submitted.map(message => message.source)).toEqual([
      { kind: 'user', rpcId: 'r1', principal: feishuUserPrincipal('u_alice') },
      { kind: 'user', rpcId: 'r2', principal: feishuUserPrincipal('u_alice') },
      { kind: 'user', rpcId: 'r3', principal: feishuGroupPrincipal('oc_g', 'u_alice') },
      { kind: 'user', rpcId: 'r4', principal: feishuGroupPrincipal('oc_g', 'u_bob') },
    ])
    expect(submitted.every(message => typeof message.id === 'string' && message.id !== '')).toBe(true)

    // A disposed Peer is replaced on the next use; clear() disposes them all.
    await remote.connection.peers[0]!.dispose()
    await submitter.submit(agent, textPrompt('r5'), 'queue')
    expect(remote.connection.peers).toHaveLength(4)
    await peers.clear()
    expect(peers.size()).toBe(0)
    expect(remote.connection.peers.every(peer => peer.signal.aborted)).toBe(true)
  })

  it('stages a prefetched image for the live Session and cites it by receipt', async () => {
    const { submitter, agent, remote, attachments, claimed } = await setup()
    const staged = await submitter.stageImage(agent, PNG, 'shot.png')
    expect(staged).toMatchObject({ ok: true, block: { type: 'image', attachment: { mediaType: 'image/png', name: 'shot.png' }, receiptId: expect.stringMatching(/^receipt-/) } })
    if (!staged.ok) throw new Error('unreachable')
    expect(attachments.savedImages).toHaveLength(1)
    expect(await submitter.stageImage(agent, new Uint8Array([1, 2, 3]))).toEqual({ ok: false, reason: expect.stringContaining('不支持的图片格式') })

    await submitter.submit(agent, { requestId: 'r-img', principal: feishuUserPrincipal('u_alice'), content: [{ type: 'text', text: '看图' }, staged.block] }, 'queue')
    expect(remote.gateway.calls[0]!.args).toEqual({ request: {
      requestId: 'r-img', sessionId: 's_1', mode: 'queue',
      content: [{ type: 'text', text: '看图' }, { type: 'file', receiptId: staged.block.receiptId }],
    } })
    expect(claimed[0]!.content).toEqual([{ type: 'text', text: '看图' }, { type: 'image', attachment: staged.block.attachment }])
  })

  it('re-stages a durable reference whose receipt is gone (a restart), and degrades a block it cannot restore to text', async () => {
    const { submitter, agent, remote, attachments, claimed, warn } = await setup()
    const staged = await submitter.stageImage(agent, PNG, 'shot.png')
    if (!staged.ok) throw new Error('unreachable')
    // The restart snapshot stored the reference only; the bytes are in the host store.
    const hostPath = attachments.imageHostPath(staged.block.attachment)!
    mkdirSync(path.dirname(hostPath), { recursive: true })
    writeFileSync(hostPath, PNG)
    const { receiptId: _gone, ...durable } = staged.block
    const missing = { ...durable, attachment: { ...durable.attachment, attachmentId: 'sha256:missing', name: 'lost.png' } }

    await submitter.submit(agent, { requestId: 'r-replay', principal: feishuUserPrincipal('u_alice'), content: [{ type: 'text', text: '看图' }, durable, missing] }, 'queue')
    // The first upload staged the image; the replay re-staged the restorable
    // block only, as the missing one has no bytes in the host store.
    expect(remote.fileUploads.uploadImageStream).toHaveBeenCalledTimes(2)
    const parts = (remote.gateway.calls[0]!.args.request as { content: Array<{ type: string; text?: string }> }).content
    expect(parts.map(part => part.type)).toEqual(['text', 'file', 'text'])
    expect(parts[2]!.text).toContain('附件 lost.png 在重启后无法恢复')
    expect(claimed[0]!.content[1]).toEqual({ type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png' }) })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-staging attachment'), 'lost.png', 's_1', expect.any(String))
  })

  it('submits a steer as the running turn\'s next-step input', async () => {
    const { submitter, agent } = await setup()
    await submitter.submit(agent, textPrompt('r-steer'), 'steer')
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('propagates a refused submission as the Remote failure', async () => {
    const { submitter, agent, remote } = await setup()
    remote.remoteAccess.policies.delete('feishu-user')
    await expect(submitter.submit(agent, textPrompt('r-denied'), 'queue')).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(agent.followup).not.toHaveBeenCalled()
  })
})

describe('steerQueued', () => {
  it('moves the queued message of a request into the running turn and reports a message no longer pending', async () => {
    const { submitter, agent, driver } = await setup()
    // Occupy the loop so the next prompts queue.
    driver.followup(agent.session, { id: 'm0' as never, role: 'user', content: [], source: { kind: 'user' } })
    await submitter.submit(agent, textPrompt('r1'), 'queue')
    await submitter.submit(agent, textPrompt('r2'), 'queue')
    expect(agent.inbox.nextTurn).toHaveLength(2)

    expect(steerQueued(agent, 'r-unknown')).toBe(false)
    expect(steerQueued(agent, 'r2')).toBe(true)
    expect(agent.steer).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ rpcId: 'r2' }) }))
    expect(agent.inbox.nextTurn.map(message => (message as UserMessage).source.rpcId)).toEqual(['r1'])
    expect(steerQueued(agent, 'r2')).toBe(false)
  })
})

describe('submissionFailureText', () => {
  it('words each Remote failure for the card', () => {
    expect(submissionFailureText(remoteError('remote-access/denied', 'x', { action: 'session/prompt', reason: ROUTE_NOT_PERMITTED }))).toContain('你没有权限向这个会话发消息')
    expect(submissionFailureText(remoteError('remote-access/denied', 'x', { action: 'session/prompt', reason: 'no-allow' }))).toBe('访问被拒绝：no-allow')
    expect(submissionFailureText(remoteError('session/attachment-invalid', 'x', { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }))).toContain('当前模型不支持图片输入')
    expect(submissionFailureText(remoteError('session/attachment-invalid', 'too big', { reason: 'IMAGE_TOO_LARGE' }))).toBe('附件无法提交：too big')
    expect(submissionFailureText(remoteError('session/not-found', 'x'))).toBe('会话已不存在，请重新发起对话')
    expect(submissionFailureText(remoteError('session/agent-busy', 'prompt rejected', { reason: 'Error: closed' }))).toBe('提交失败：Error: closed')
    expect(submissionFailureText(remoteError('gateway/internal', 'boom'))).toBe('提交失败：boom（gateway/internal）')
    expect(submissionFailureText(new Error('plain'))).toBe('提交失败：plain')
  })
})

describe('requireRemoteServices', () => {
  it('names every missing service in one error', () => {
    const present = { connection: {}, typertGateway: {}, remoteAccess: {}, fileUploads: {} } as Record<string, unknown>
    expect(() => requireRemoteServices({ get: name => present[name] })).not.toThrow()
    expect(() => requireRemoteServices({ get: name => (name === 'connection' ? present[name] : undefined) }))
      .toThrow(/typertGateway、remoteAccess、fileUploads/)
    expect(() => requireRemoteServices({})).toThrow(/connection、typertGateway、remoteAccess、fileUploads/)
  })

  it('leaves a dedupe-only submission to the host when the request is already known', async () => {
    const { submitter, agent } = await setup()
    sessionEvents(agent.session).push({ type: 'user/message', seq: 0, data: { id: 'm' as never, role: 'user', content: [], source: { kind: 'user', rpcId: 'r-known' } } })
    await submitter.submit(agent, textPrompt('r-known'), 'queue')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(makeSession).toBeDefined()
  })
})
