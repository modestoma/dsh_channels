import { describe, expect, it, vi } from 'vitest'
import {
  buildCommandResultCard, commandResultCardKind, parseSlashCommand, registerChannelCommands,
  RouteOperationQueue, supportedCommandList,
} from '../src/commands.ts'
import { makeAgent, makeCommandRuntime, makeSession } from './helpers.ts'

describe('slash command primitives', () => {
  it('parses the Harness command grammar and preserves raw input', () => {
    expect(parseSlashCommand('/work-dir  now ')).toEqual({ name: 'work-dir', rawInput: '  now ' })
    expect(parseSlashCommand('/health')).toEqual({ name: 'health', rawInput: '' })
    expect(parseSlashCommand('/Health')).toBeUndefined()
    expect(parseSlashCommand('/1health')).toBeUndefined()
    expect(parseSlashCommand('/health!')).toBeUndefined()
  })

  it('registers only channel-scoped definitions and leaves compact global', async () => {
    const commands = makeCommandRuntime()
    registerChannelCommands(commands)
    expect([...commands.definitions.keys()].sort()).toEqual([
      'export', 'health', 'history', 'renew', 'status', 'work-dir',
    ])
    expect(commands.definitions.has('compact')).toBe(false)

    const agent = makeAgent(makeSession(), {}, { commands })
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
