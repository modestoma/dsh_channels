import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  armRenewCommand, buildCommandResultCard, commandResultCardKind, mountChannelCommands, parseSlashCommand,
  registerChannelCommands, RouteOperationQueue, supportedCommandHelp, supportedCommandList,
} from '../src/commands.ts'
import type { AgentContext } from '../src/dsh-types.ts'
import { makeAgent, makeAgentContext, makeCommandRuntime, makeSession } from './helpers.ts'

describe('slash command primitives', () => {
  it('parses the Harness command grammar and preserves raw input', () => {
    expect(parseSlashCommand('/workspace  now ')).toEqual({ name: 'workspace', rawInput: '  now ' })
    expect(parseSlashCommand('/health')).toEqual({ name: 'health', rawInput: '' })
    expect(parseSlashCommand('/Health')).toBeUndefined()
    expect(parseSlashCommand('/1health')).toBeUndefined()
    expect(parseSlashCommand('/health!')).toBeUndefined()
  })

  it('lists the private user-id and group-id commands in help', () => {
    expect(supportedCommandList()).toContain('/userid')
    expect(supportedCommandList()).toContain('/groupid')
    expect(supportedCommandHelp()).toContain('**/userid** — 在私聊中显示当前用户 ID')
    expect(supportedCommandHelp()).toContain('**/groupid** — 在群聊中显示当前群组 ID')
  })

  it('registers only channel-scoped definitions and leaves compact global', async () => {
    const commands = makeCommandRuntime()
    registerChannelCommands(commands)
    expect([...commands.definitions.keys()].sort()).toEqual([
      'export', 'health', 'help', 'history', 'renew', 'status', 'workspace',
    ])
    expect(commands.definitions.has('compact')).toBe(false)

    const agent = makeAgent(makeSession(), {}, makeAgentContext(commands))

    expect(await commands.definitions.get('help')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'success', text: supportedCommandHelp() })
    expect(await commands.definitions.get('help')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: ' extra',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'error', text: '用法错误：/help 不接受参数。' })

    expect(await commands.definitions.get('health')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: ' extra',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'error', text: '用法错误：/health 不接受参数。' })
    expect(await commands.definitions.get('health')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'success', text: '健康检查已完成。' })
    expect(await commands.definitions.get('status')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'success', text: 'Session 状态已读取。' })
    expect(await commands.definitions.get('workspace')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: ' extra',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'error', text: '用法错误：/workspace 不接受参数。' })
    expect(await commands.definitions.get('history')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'success', text: 'Session 历史已读取。' })
    expect(await commands.definitions.get('history')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: ' extra',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'error', text: '用法错误：/history 不接受参数。' })
    expect(await commands.definitions.get('export')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'success', text: '导出已请求。' })
    expect(await commands.definitions.get('export')!.handler({
      commandId: 'cmd-test' as never,
      agent,
      rawInput: ' extra',
      signal: new AbortController().signal,
    })).toEqual({ kind: 'error', text: '用法错误：/export 不接受参数。' })
  })

  it('mounts scoped commands through an explicit commands injection', async () => {
    const ctx = new Context()
    const commands = makeCommandRuntime()
    ctx.provide('commands', commands)

    let bareAgentCtx!: Context
    await ctx.plugin((inner) => { bareAgentCtx = inner })
    expect(bareAgentCtx.get('commands')).toBe(commands)

    await mountChannelCommands(bareAgentCtx as unknown as AgentContext)
    expect([...commands.definitions.keys()].sort()).toEqual([
      'export', 'health', 'help', 'history', 'renew', 'status', 'workspace',
    ])

    await ctx.fiber.dispose()
  })

  it('never reads commands from an uninjected Agent context', async () => {
    const commands = makeCommandRuntime()
    const injectedCtx = makeAgentContext(commands)
    let directReads = 0
    const guardedCtx = {
      get commands() {
        directReads += 1
        throw new Error('cannot get property "commands" without inject')
      },
      async inject(dependencies: readonly string[], callback: (ctx: AgentContext) => void) {
        expect(dependencies).toEqual(['commands'])
        callback(injectedCtx)
      },
    } as unknown as AgentContext

    await mountChannelCommands(guardedCtx)
    expect(directReads).toBe(0)
    expect(commands.definitions.has('health')).toBe(true)
  })

  it('requires one armed Feishu admission for /renew and rejects busy inboxes first', async () => {
    const commands = makeCommandRuntime()
    registerChannelCommands(commands)
    const agent = makeAgent(makeSession(), {}, makeAgentContext(commands))
    const signal = new AbortController().signal
    const invocation = {
      commandId: 'cmd-renew' as never,
      agent,
      rawInput: '',
      signal,
    }
    const handler = commands.definitions.get('renew')!.handler
    expect(await handler(invocation)).toMatchObject({ kind: 'error', text: expect.stringContaining('已授权') })

    const operation = vi.fn(async () => ({ kind: 'success' as const, text: 'renewed' }))
    const disarm = armRenewCommand(signal, operation)
    expect(await handler(invocation)).toEqual({ kind: 'success', text: 'renewed' })
    expect(operation).toHaveBeenCalledTimes(1)
    disarm()

    ;(agent.inbox.nextTurn as unknown[]).push({ queued: true })
    const busyOperation = vi.fn(async () => ({ kind: 'success' as const }))
    const disarmBusy = armRenewCommand(signal, busyOperation)
    expect(await handler(invocation)).toMatchObject({ kind: 'error', text: expect.stringContaining('正忙') })
    expect(busyOperation).not.toHaveBeenCalled()
    disarmBusy()
  })

  it('serializes operations per route without poisoning the queue after failure', async () => {
    const queue = new RouteOperationQueue()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.run('route-a', async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
      throw new Error('expected')
    })
    const second = queue.run('route-a', () => { order.push('second'); return 2 })
    const other = queue.run('route-b', () => { order.push('other'); return 3 })

    await expect(other).resolves.toBe(3)
    expect(order).toEqual(['first:start', 'other'])
    release()
    await expect(first).rejects.toThrow('expected')
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second'])
  })

  it('builds standalone cards for every admission outcome without raw error fields', () => {
    const card = buildCommandResultCard({
      kind: 'unknown', command: 'foo', text: '未找到命令 /foo。', supported: supportedCommandList(),
    })
    const json = JSON.stringify(card)
    expect(card).toMatchObject({ schema: '2.0', config: { width_mode: 'fill' } })
    expect(json).toContain('未知命令')
    expect(json).toContain('/health')
    expect(json).not.toContain('stack')
    expect(json).not.toContain('cause')
  })

  it('maps usage and busy failures to their dedicated cards', () => {
    expect(commandResultCardKind({ kind: 'error', text: 'Usage: /compact (no arguments)' })).toBe('input-error')
    expect(commandResultCardKind({
      kind: 'error',
      text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
    })).toBe('busy')
    expect(commandResultCardKind({ kind: 'error', text: 'backend unavailable' })).toBe('unavailable')
  })

  it('runs different route keys independently', async () => {
    const queue = new RouteOperationQueue()
    const run = vi.fn()
    await Promise.all([
      queue.run('one', async () => { run('one') }),
      queue.run('two', async () => { run('two') }),
    ])
    expect(run).toHaveBeenCalledTimes(2)
  })
})
