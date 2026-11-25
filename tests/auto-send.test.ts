/**
 * Turn-end automatic sending: presented files, files the final reply names,
 * the sent-file ledger, and the switches that turn it off.
 */

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import { DeliverableAutoSend, PRESENTED_EVENT, mentionedPaths } from '../src/deliverables/auto-send.ts'
import { SendFileToolRuntime } from '../src/feishu/send-file.ts'
import type { SendFileTarget } from '../src/feishu/send-file.ts'
import type { DeliverablesPresentedEvent, SessionEvent } from '../src/host/core.ts'
import type { SettledTurn } from '../src/turn/streamer.ts'
import { makeChannel, makeSession, makeTempBaseDir } from './helpers.ts'

interface Harness {
  own: string
  shared: string
  outside: string
  channel: ReturnType<typeof makeChannel>
  warn: ReturnType<typeof vi.fn>
  autoSend: DeliverableAutoSend
  runtime: SendFileToolRuntime
  /** Start turn `turn`, optionally present files, and finalize it with `reply`. */
  turn(turn: number, reply: string, options?: { presented?: string[]; outcome?: SettledTurn['outcome'] }): Promise<void>
  /** File names of the file messages sent so far. */
  sentFiles(): string[]
}

function presentedEvent(turn: number, files: string[]): SessionEvent {
  const event: DeliverablesPresentedEvent = { seq: 1, type: PRESENTED_EVENT, data: { turn, callId: 'call_1', files: files.map(file => ({ path: file })) } }
  return event
}

function setup(config: FeishuConfig = resolveConfig({})): Harness {
  const base = makeTempBaseDir()
  const own = path.join(base, 'p2p', 'u1', 'topics', 't1')
  const shared = path.join(base, 'p2p', 'u1', 'shared')
  const outside = path.join(base, 'p2p', 'u1', 'topics', 't2')
  for (const dir of [own, shared, outside]) mkdirSync(dir, { recursive: true })
  const channel = makeChannel()
  const warn = vi.fn()
  const target: SendFileTarget = { replyTo: 'om_card', inThread: true, rootDir: own, otherRoots: [shared] }
  let autoSend: DeliverableAutoSend | undefined
  const runtime = new SendFileToolRuntime({
    config: () => config,
    channel: () => channel,
    targetOfSession: id => (id === 's1' ? target : undefined),
    onSent: (sessionId, file) => autoSend?.noteSent(sessionId, file),
    warn,
  })
  autoSend = new DeliverableAutoSend({
    config: () => config,
    targetOfSession: id => (id === 's1' ? target : undefined),
    send: async (sessionId, args, signal) => await runtime.send(sessionId, args, signal),
    warn,
  })
  const session = makeSession('s1')
  return {
    own, shared, outside, channel, warn, autoSend: autoSend, runtime,
    async turn(turn, reply, options = {}) {
      autoSend!.onInboxClaimed('s1', turn)
      if (options.presented !== undefined) autoSend!.onSessionEvent(session, presentedEvent(turn, options.presented))
      await autoSend!.onTurnFinalized('s1', turn, { outcome: options.outcome ?? 'done', reply })
    },
    sentFiles: () => channel.repliedMedia.flatMap(entry => (entry.media.kind === 'file' ? [entry.media.fileName] : [])),
  }
}

/** Set a file's modification time to one hour ago (written before the turn). */
function age(file: string): void {
  const past = new Date(Date.now() - 3_600_000)
  utimesSync(file, past, past)
}

describe('mentionedPaths', () => {
  it('reads paths out of Chinese reply text, also when text runs into the path', () => {
    const reply = '报告已放到共享目录 /data/home/channels_data/p2p/u1/shared/mmi_cast_analysis.md（结论 + 环节判定表）。'
      + '另见 `notes/timeline.csv`、[图](<chart.png>)，目录/srv/out/a.pdf，以及 https://example.com/x.html 和 v1.2 版本。'
    expect(mentionedPaths(reply)).toEqual([
      '/data/home/channels_data/p2p/u1/shared/mmi_cast_analysis.md',
      'notes/timeline.csv',
      '/timeline.csv',
      'chart.png',
      '目录/srv/out/a.pdf',
      '/srv/out/a.pdf',
      'v1.2',
    ])
  })
})

describe('DeliverableAutoSend', () => {
  it('sends a shared-directory report the reply only names by path, once', async () => {
    const h = setup()
    const report = path.join(h.shared, 'analysis.md')
    writeFileSync(report, '# 结论\n\n协商失败。')
    age(report)
    await h.turn(1, `报告已放到共享目录 ${report}（结论 + 时间线）`)
    expect(h.sentFiles()).toEqual(['analysis.md'])
    // The Markdown is also shown as a document card before the file.
    expect(h.channel.repliedMedia.map(entry => entry.media.kind)).toEqual(['card', 'file'])
    await h.turn(2, `见 shared/analysis.md 或 ${report}`)
    expect(h.sentFiles()).toEqual(['analysis.md'])
  })

  it('sends a changed file again and skips one the tool already sent unchanged', async () => {
    const h = setup()
    const report = path.join(h.shared, 'r.csv')
    writeFileSync(report, 'a,b\n')
    expect(await h.runtime.send('s1', { path: report }, new AbortController().signal)).toMatchObject({ ok: true })
    await h.turn(1, `已发送 ${report}`)
    expect(h.sentFiles()).toEqual(['r.csv'])
    writeFileSync(report, 'a,b\n1,2\n')
    await h.turn(2, `更新了 ${report}`)
    expect(h.sentFiles()).toEqual(['r.csv', 'r.csv'])
  })

  it('sends a document the turn wrote in its own directory, but not older files, scripts, or other topics', async () => {
    const h = setup()
    const old = path.join(h.own, 'old.md')
    writeFileSync(old, 'old')
    age(old)
    writeFileSync(path.join(h.outside, 'other.md'), 'other topic')
    await new Promise(resolve => setTimeout(resolve, 5))
    const fresh = async (): Promise<void> => {
      writeFileSync(path.join(h.own, 'summary.md'), '# 小结')
      writeFileSync(path.join(h.own, 'parse.py'), 'print(1)')
    }
    h.autoSend.onInboxClaimed('s1', 1)
    await fresh()
    await h.autoSend.onTurnFinalized('s1', 1, {
      outcome: 'done',
      reply: `写好了 summary.md，脚本 parse.py，旧的 old.md，以及 ${path.join(h.outside, 'other.md')}`,
    })
    expect(h.sentFiles()).toEqual(['summary.md'])
  })

  it('sends the files a turn presented first, within the per-turn limit', async () => {
    const h = setup(resolveConfig({ feishuTools: { autoSendMaxFiles: 2 } }))
    for (const name of ['a.xlsx', 'b.pdf', 'c.md']) {
      writeFileSync(path.join(h.shared, name), name)
      age(path.join(h.shared, name))
    }
    await h.turn(1, '见 c.md', { presented: [path.join(h.shared, 'a.xlsx'), path.join(h.shared, 'b.pdf'), path.join(h.shared, 'gone.pdf')] })
    expect(h.sentFiles()).toEqual(['a.xlsx', 'b.pdf'])
  })

  it('sends presented files from any of the Session directories but never from outside them', async () => {
    const h = setup()
    writeFileSync(path.join(h.outside, 'secret.md'), 'x')
    await h.turn(1, '', { presented: [path.join(h.outside, 'secret.md')] })
    expect(h.sentFiles()).toEqual([])
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('automatic sending'), expect.stringContaining('secret.md'), 'PATH_OUTSIDE_WORKSPACE', expect.any(String))
  })

  it('sends nothing for a stopped turn, with sending off, or with presented-only for named files', async () => {
    const write = (h: Harness): string => {
      const file = path.join(h.shared, 'r.md')
      writeFileSync(file, '# r')
      return file
    }
    const stopped = setup()
    await stopped.turn(1, `见 ${write(stopped)}`, { outcome: 'stopped' })
    expect(stopped.sentFiles()).toEqual([])
    const off = setup(resolveConfig({ feishuTools: { autoSendFiles: 'off' } }))
    await off.turn(1, `见 ${write(off)}`, { presented: [write(off)] })
    expect(off.sentFiles()).toEqual([])
    const noTool = setup(resolveConfig({ feishuTools: { sendFile: false } }))
    await noTool.turn(1, '', { presented: [write(noTool)] })
    expect(noTool.sentFiles()).toEqual([])
    const presentedOnly = setup(resolveConfig({ feishuTools: { autoSendFiles: 'presented' } }))
    await presentedOnly.turn(1, `见 ${write(presentedOnly)}`)
    expect(presentedOnly.sentFiles()).toEqual([])
    await presentedOnly.turn(2, '', { presented: [write(presentedOnly)] })
    expect(presentedOnly.sentFiles()).toEqual(['r.md'])
  })

  it('ignores malformed presented events and Sessions without a route', async () => {
    const h = setup()
    // A log written by another version of the present tool.
    const malformed = JSON.parse(JSON.stringify({ seq: 1, type: PRESENTED_EVENT, data: { turn: 'x' } })) as SessionEvent
    h.autoSend.onSessionEvent(makeSession('s1'), malformed)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), PRESENTED_EVENT, 's1')
    const file = path.join(h.shared, 'r.md')
    writeFileSync(file, '# r')
    await h.autoSend.onTurnFinalized('s2', 1, { outcome: 'done', reply: file })
    expect(h.sentFiles()).toEqual([])
  })
})
