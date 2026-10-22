/**
 * `feishu_send_file`: workspace containment, Feishu size/type limits, reply
 * targeting, and readable failures.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { ToolDefinition, ToolRuntime } from '../src/host/agent.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import {
  FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, SEND_FILE_TOOL_NAME, SendFileToolRuntime,
  presentSendFileCall, renderSendFileResult,
} from '../src/feishu/send-file.ts'
import type { SendFileTarget, SendFileValue } from '../src/feishu/send-file.ts'
import { makeAgentContext, makeChannel, makeTempBaseDir } from './helpers.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

interface Harness {
  root: string
  outside: string
  channel: ReturnType<typeof makeChannel>
  warn: ReturnType<typeof vi.fn>
  definitions: Map<string, ToolDefinition>
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<SendFileValue>
}

async function setup(options: {
  config?: FeishuConfig
  target?: Partial<SendFileTarget> | null
  channel?: FeishuChannel | null
} = {}): Promise<Harness> {
  const base = makeTempBaseDir()
  const root = path.join(base, 'ws', 'topics', 't1')
  const outside = path.join(base, 'ws', 'topics', 't2')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const channel = makeChannel()
  const warn = vi.fn()
  const config = options.config ?? resolveConfig({})
  const target: SendFileTarget | undefined = options.target === null ? undefined : {
    replyTo: 'om_card', inThread: true, rootDir: root, ...options.target,
  }
  const runtime = new SendFileToolRuntime({
    config: () => config,
    channel: () => (options.channel === null ? undefined : options.channel ?? channel),
    targetOfSession: id => (id === 's1' ? target : undefined),
    warn,
  })
  const definitions = new Map<string, ToolDefinition>()
  const ctx = makeAgentContext()
  ctx.tools = { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) } } as unknown as ToolRuntime
  await runtime.mount(ctx, 's1')
  return {
    root, outside, channel, warn, definitions,
    async run(args, signal) {
      const definition = definitions.get(SEND_FILE_TOOL_NAME)
      if (definition === undefined) throw new Error('not mounted')
      return await definition.execute(args, { signal: signal ?? new AbortController().signal }) as SendFileValue
    },
  }
}

describe('feishu_send_file', () => {
  it('sends a PNG as an image reply inside the topic', async () => {
    const h = await setup()
    writeFileSync(path.join(h.root, 'chart.png'), PNG)
    const value = await h.run({ path: 'chart.png' })
    expect(value).toMatchObject({ ok: true, kind: 'image', file_name: 'chart.png', bytes: PNG.length, message_id: 'om_1' })
    expect(h.channel.repliedMedia).toEqual([{
      replyTo: 'om_card',
      media: { kind: 'image', data: PNG },
      options: { replyInThread: true },
    }])
  })

  it('sends other content as a file with the given name and replies on the main timeline for chat routes', async () => {
    const h = await setup({ target: { inThread: false } })
    writeFileSync(path.join(h.root, 'report.csv'), 'a,b\n1,2\n')
    const value = await h.run({ path: path.join(h.root, 'report.csv'), file_name: '季度报表.csv' })
    expect(value).toMatchObject({ ok: true, kind: 'file', file_name: '季度报表.csv' })
    expect(h.channel.repliedMedia[0]).toEqual({
      replyTo: 'om_card',
      media: { kind: 'file', data: Buffer.from('a,b\n1,2\n'), fileName: '季度报表.csv' },
      options: { replyInThread: false },
    })
  })

  it('sends an image as a file when kind=file and strips separators from file_name', async () => {
    const h = await setup()
    writeFileSync(path.join(h.root, 'a.png'), PNG)
    const value = await h.run({ path: 'a.png', kind: 'file', file_name: '../x/y.png' })
    expect(value).toMatchObject({ ok: true, kind: 'file', file_name: '.._x_y.png' })
  })

  it('refuses paths outside the topic directory, including .. and symlinks', async () => {
    const h = await setup()
    writeFileSync(path.join(h.outside, 'secret.txt'), 'other topic')
    symlinkSync(path.join(h.outside, 'secret.txt'), path.join(h.root, 'link.txt'))
    for (const target of ['../t2/secret.txt', path.join(h.outside, 'secret.txt'), 'link.txt', '/etc/hostname', '../t2/missing.txt']) {
      expect(await h.run({ path: target })).toMatchObject({ ok: false, code: 'PATH_OUTSIDE_WORKSPACE' })
    }
    expect(h.channel.repliedMedia).toEqual([])
  })

  it('reports missing, directory and empty files', async () => {
    const h = await setup()
    mkdirSync(path.join(h.root, 'dir'))
    writeFileSync(path.join(h.root, 'empty.txt'), '')
    expect(await h.run({ path: 'nope.txt' })).toMatchObject({ ok: false, code: 'FILE_NOT_FOUND' })
    expect(await h.run({ path: 'dir' })).toMatchObject({ ok: false, code: 'NOT_A_FILE' })
    expect(await h.run({ path: 'empty.txt' })).toMatchObject({ ok: false, code: 'EMPTY_FILE' })
  })

  it('enforces the Feishu image and file limits', async () => {
    const h = await setup()
    const bigImage = Buffer.alloc(FEISHU_IMAGE_MAX_BYTES + 1)
    PNG.copy(bigImage)
    writeFileSync(path.join(h.root, 'big.png'), bigImage)
    writeFileSync(path.join(h.root, 'huge.bin'), Buffer.alloc(FEISHU_FILE_MAX_BYTES + 1, 1))
    writeFileSync(path.join(h.root, 'notes.txt'), 'hi')
    expect(await h.run({ path: 'big.png', kind: 'image' })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(await h.run({ path: 'huge.bin' })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(await h.run({ path: 'notes.txt', kind: 'image' })).toMatchObject({ ok: false, code: 'NOT_AN_IMAGE' })
    // auto: an image over the image limit falls back to a file message.
    expect(await h.run({ path: 'big.png' })).toMatchObject({ ok: true, kind: 'file' })
  })

  it('fails closed with REPLY_TARGET_GONE when the reply card was recalled', async () => {
    const channel = makeChannel()
    const h = await setup({ channel })
    writeFileSync(path.join(h.root, 'a.txt'), 'x')
    vi.mocked(channel.replyMedia).mockRejectedValueOnce(new FeishuApiError('code=230020 message recalled', 230020))
    expect(await h.run({ path: 'a.txt' })).toMatchObject({ ok: false, code: 'REPLY_TARGET_GONE' })
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('maps a Feishu scope rejection to PERMISSION_DENIED and other failures to SEND_FAILED', async () => {
    const channel = makeChannel()
    const h = await setup({ channel })
    writeFileSync(path.join(h.root, 'a.txt'), 'x')
    vi.mocked(channel.replyMedia).mockRejectedValueOnce(Object.assign(new Error('file upload failed'), {
      cause: { response: { data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:resource]' } } },
    }))
    const denied = await h.run({ path: 'a.txt' })
    expect(denied).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(denied.ok === false && denied.reason).toContain('im:resource')
    vi.mocked(channel.replyMedia).mockRejectedValueOnce(new Error('network down'))
    expect(await h.run({ path: 'a.txt' })).toMatchObject({ ok: false, code: 'SEND_FAILED', reason: '飞书上传或发送失败：network down' })
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it('returns readable failures without a route, channel, or when disabled at call time', async () => {
    expect(await (await setup({ target: null })).run({ path: 'a' })).toMatchObject({ ok: false, code: 'ROUTE_NOT_FOUND' })
    const offline = await setup({ channel: null })
    writeFileSync(path.join(offline.root, 'a.txt'), 'x')
    expect(await offline.run({ path: 'a.txt' })).toMatchObject({ ok: false, code: 'CHANNEL_UNAVAILABLE' })
    const config = resolveConfig({})
    const live = await setup({ config })
    config.feishuTools.sendFile = false
    expect(await live.run({ path: 'a' })).toMatchObject({ ok: false, code: 'TOOL_DISABLED' })
  })

  it('reports ABORTED when the call is cancelled during the upload', async () => {
    const channel = makeChannel()
    const h = await setup({ channel })
    writeFileSync(path.join(h.root, 'a.txt'), 'x')
    vi.mocked(channel.replyMedia).mockReturnValueOnce(new Promise(() => {}))
    const controller = new AbortController()
    const pending = h.run({ path: 'a.txt' }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'ABORTED' })
  })

  it('rejects invalid arguments with a thrown error and is not mounted when disabled', async () => {
    const h = await setup()
    await expect(h.run({ path: '' })).rejects.toThrow(/feishu_send_file: invalid path/u)
    await expect(h.run({ path: 'a', extra: 1 })).rejects.toThrow(/invalid arguments/u)
    const off = resolveConfig({ feishuTools: { sendFile: false } })
    expect((await setup({ config: off })).definitions.size).toBe(0)
  })

  it('presents the call and the result', () => {
    expect(presentSendFileCall({ path: 'out/chart.png' })).toBe('发送到飞书：out/chart.png')
    expect(renderSendFileResult({ ok: false, code: 'EMPTY_FILE', reason: '文件为空' }))
      .toEqual([{ type: 'text', text: '发送失败（EMPTY_FILE）：文件为空' }])
  })
})
