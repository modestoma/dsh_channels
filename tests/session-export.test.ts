import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  createLogicalSessionExport, DSH_CHANNELS_VERSION, LOGICAL_EXPORT_FORMAT,
  LOGICAL_EXPORT_FORMAT_VERSION, serializeLogicalSession,
} from '../src/session-export.ts'
import type { SessionEvent } from '../src/dsh-types.ts'
import { makeSession } from './helpers.ts'

const gunzipBuffer = promisify(gunzip)

describe('logical Session export', () => {
  it('serializes a versioned manifest followed by unchanged logical events', () => {
    const session = makeSession('session-export', '/workspace/alice')
    const events = session.events as unknown as SessionEvent[]
    events.push(
      { type: 'command/run', seq: 7, time: 100, data: {
        commandId: 'cmd-export', name: 'export', source: { kind: 'user' },
      } } as SessionEvent,
      { type: 'command/done', seq: 8, time: 120, ignorable: true, data: {
        commandId: 'cmd-export', kind: 'success', text: '导出已请求。',
      } } as SessionEvent,
    )

    const lines = serializeLogicalSession(session, {
      exportedAt: new Date('2026-08-17T01:02:03.000Z'),
      pluginVersion: '9.8.7',
    }).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as unknown)

    expect(lines[0]).toEqual({
      format: LOGICAL_EXPORT_FORMAT,
      formatVersion: LOGICAL_EXPORT_FORMAT_VERSION,
      logical: true,
      exportedAt: '2026-08-17T01:02:03.000Z',
      plugin: { name: 'dsh-channels', version: '9.8.7' },
      includes: { descendants: false, attachments: false, rawArtifacts: false },
      session: { id: session.id, header: session.header },
    })
    expect(lines.slice(1)).toEqual(events)
    expect(lines.slice(1).map(event => (event as SessionEvent).type)).toEqual([
      'command/run', 'command/done',
    ])
  })

  it('uses the package version and produces an in-memory gzip file', async () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const session = makeSession('session-gzip')
    const file = await createLogicalSessionExport(session, {
      exportedAt: new Date('2026-08-17T00:00:00.000Z'),
    })

    expect(DSH_CHANNELS_VERSION).toBe(metadata.version)
    expect(file.fileName).toBe('dsh-session-session-gzip.logical.jsonl.gz')
    const manifest = JSON.parse((await gunzipBuffer(file.source)).toString('utf8').split('\n')[0]!) as {
      plugin: { version: string }
    }
    expect(manifest.plugin.version).toBe(metadata.version)
  })

  it('takes the JSONL snapshot before awaiting compression and surfaces compressor failures', async () => {
    const session = makeSession('session-snapshot')
    const events = session.events as unknown as SessionEvent[]
    events.push({ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: 'complete' } } as SessionEvent)
    let compressedInput = ''
    const compress = vi.fn(async (source: Buffer) => {
      compressedInput = source.toString('utf8')
      events.push({ type: 'turn/end', seq: 2, time: 2, data: { turn: 2, reason: 'late' } } as SessionEvent)
      return Buffer.from('compressed')
    })
    await createLogicalSessionExport(session, { compress })
    expect(compressedInput).toContain('"seq":1')
    expect(compressedInput).not.toContain('"seq":2')

    const failure = new Error('simulated gzip failure')
    await expect(createLogicalSessionExport(session, {
      compress: async () => { throw failure },
    })).rejects.toBe(failure)
  })

  it('fails rather than silently altering an unserializable logical event', () => {
    const session = makeSession('session-circular')
    const data: Record<string, unknown> = {}
    data.self = data
    ;(session.events as unknown as SessionEvent[]).push({
      type: 'custom/event', seq: 1, time: 1, data,
    } as unknown as SessionEvent)
    expect(() => serializeLogicalSession(session)).toThrow()
  })
})
