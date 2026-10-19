/**
 * Inbound attachment archival tests: workspace layout, file-name safety,
 * merged-forward records, placeholder stripping, capability gates, and
 * per-attachment failure containment.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENTS_DIR, AttachmentIntake, compactTimestamp, sanitizeFileName, stripAttachmentPlaceholders,
} from '../src/feishu/inbound-attachments.ts'
import { FEISHU_ATTACHMENTS_SECTION, attachmentsGuidance } from '../src/feishu/agent-context.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import { makeChannel, makeMessage } from './helpers.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01])

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-channels-attachments-'))
}

function makeIntake(options: {
  enabled?: boolean
  channel?: FeishuChannel
  now?: number
} = {}) {
  const channel = options.channel ?? makeChannel()
  const warn = vi.fn()
  const intake = new AttachmentIntake({
    enabled: () => options.enabled ?? true,
    channel: () => channel,
    warn,
    now: () => options.now ?? Date.UTC(2026, 9, 18, 12, 0, 0),
  })
  return { intake, channel, warn }
}

describe('attachment intake', () => {
  it('streams an image resource into the workspace attachments directory', async () => {
    const workspace = makeWorkspace()
    const { intake, channel } = makeIntake({
      channel: makeChannel({ downloadResource: () => [PNG] }),
    })
    const result = await intake.archive(makeMessage({
      messageId: 'om_img', content: '![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), workspace)

    expect(result).toEqual({ saved: 1, failed: 0, attachmentOnly: true, text: '' })
    const dir = path.join(workspace, ATTACHMENTS_DIR)
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^20261018-120000-image-1\.png$/)
    expect(readFileSync(path.join(dir, files[0]!))).toEqual(Buffer.from(PNG))
    expect((channel as unknown as { reactions: unknown[] }).reactions).toEqual([
      { messageId: 'om_img', emojiType: 'DONE' },
    ])
  })

  it('keeps the original file bytes and sanitizes hostile names', async () => {
    const workspace = makeWorkspace()
    const payload = new TextEncoder().encode('exact bytes')
    const { intake } = makeIntake({
      channel: makeChannel({ downloadResource: () => [payload] }),
    })
    const result = await intake.archive(makeMessage({
      messageId: 'om_file',
      content: '<file key="file_1" name="../../etc/report?.pdf"/>',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: '../../etc/report?.pdf' }] as never,
    }), workspace)

    expect(result.saved).toBe(1)
    const [name] = readdirSync(path.join(workspace, ATTACHMENTS_DIR))
    expect(name).toBe('20261018-120000-report_.pdf')
    expect(readFileSync(path.join(workspace, ATTACHMENTS_DIR, name!))).toEqual(Buffer.from(payload))
  })

  it('archives an expanded merged-forward record as text and strips its placeholder', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_forward',
      content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
      rawContentType: 'merge_forward',
    }), workspace)

    expect(result).toEqual({ saved: 1, failed: 0, attachmentOnly: true, text: '' })
    const dir = path.join(workspace, ATTACHMENTS_DIR)
    const [name] = readdirSync(dir)
    expect(name).toBe('20261018-120000-forwarded-record.txt')
    expect(readFileSync(path.join(dir, name!), 'utf8')).toContain('明天评审')
  })

  it('keeps a caption as prompt text while archiving its images', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_caption',
      content: '看这张图 ![image](img_1) 里有什么',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), workspace)

    expect(result.saved).toBe(1)
    expect(result.attachmentOnly).toBe(false)
    expect(result.text).toBe('看这张图 里有什么')
  })

  it('reports a failed empty forwarded record instead of writing an empty file', async () => {
    const workspace = makeWorkspace()
    const { intake, channel } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_forward_empty', content: '<forwarded_messages/>', rawContentType: 'merge_forward',
    }), workspace)

    expect(result).toEqual({ saved: 0, failed: 1, attachmentOnly: true, text: '' })
    expect(existsSync(path.join(workspace, ATTACHMENTS_DIR))).toBe(true)
    expect(readdirSync(path.join(workspace, ATTACHMENTS_DIR))).toEqual([])
    expect((channel as unknown as { reactions: unknown[] }).reactions).toEqual([
      { messageId: 'om_forward_empty', emojiType: 'No' },
    ])
  })

  it('does nothing when archiving is disabled, keeping mixed text', async () => {
    const workspace = makeWorkspace()
    const { intake, channel } = makeIntake({ enabled: false })
    const result = await intake.archive(makeMessage({
      messageId: 'om_disabled',
      content: '说明 ![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), workspace)

    expect(result).toEqual({ saved: 0, failed: 0, attachmentOnly: false, text: '说明' })
    expect(existsSync(path.join(workspace, ATTACHMENTS_DIR))).toBe(false)
    expect((channel as unknown as { reactions: unknown[] }).reactions).toEqual([])
  })

  it('contains a download failure and leaves no temporary file behind', async () => {
    const workspace = makeWorkspace()
    const channel = makeChannel({
      downloadResource: () => {
        throw new Error('download failed')
      },
    })
    const { intake, warn } = makeIntake({ channel })
    const result = await intake.archive(makeMessage({
      messageId: 'om_bad', content: '![image](img_bad)',
      resources: [{ type: 'image', fileKey: 'img_bad' }] as never,
    }), workspace)

    expect(result).toEqual({ saved: 0, failed: 1, attachmentOnly: true, text: '' })
    const dir = path.join(workspace, ATTACHMENTS_DIR)
    expect(readdirSync(dir)).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect((channel as unknown as { reactions: unknown[] }).reactions).toEqual([
      { messageId: 'om_bad', emojiType: 'No' },
    ])
  })

  it('gives colliding names distinct destinations', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_two',
      content: '<file key="a" name="same.txt"/><file key="b" name="same.txt"/>',
      resources: [
        { type: 'file', fileKey: 'a', fileName: 'same.txt' },
        { type: 'file', fileKey: 'b', fileName: 'same.txt' },
      ] as never,
    }), workspace)

    expect(result.saved).toBe(2)
    expect(readdirSync(path.join(workspace, ATTACHMENTS_DIR)).sort()).toEqual([
      '20261018-120000-same-2.txt',
      '20261018-120000-same.txt',
    ])
  })

  it('ignores untracked resource kinds and returns text unchanged', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_audio', content: '<audio key="x"/>',
      resources: [{ type: 'audio', fileKey: 'x' }] as never,
    }), workspace)
    expect(result).toEqual({ saved: 0, failed: 0, attachmentOnly: false, text: '<audio key="x"/>' })
  })
})

describe('agent guidance', () => {
  it('names the attachments directory and appends the absolute archive path', () => {
    expect(attachmentsGuidance()).toContain('`attachments/`')
    const withPath = attachmentsGuidance('/tmp/feishu-ws')
    expect(withPath).toContain('/tmp/feishu-ws/attachments/')
    expect(FEISHU_ATTACHMENTS_SECTION).toBe('dsh-channels:feishu-attachments')
  })

  it('escapes backticks in a hostile workspace path', () => {
    expect(attachmentsGuidance('/tmp/a`b')).toContain("/tmp/a'b/attachments/")
  })
})

describe('attachment name helpers', () => {
  it('formats a sortable UTC timestamp', () => {
    expect(compactTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })

  it('strips directories, control characters, and reserved name characters', () => {
    expect(sanitizeFileName('../../a\x01b:c?.pdf')).toBe('a_b_c_.pdf')
    expect(sanitizeFileName('   ')).toBeUndefined()
    expect(sanitizeFileName(undefined)).toBeUndefined()
  })

  it('truncates an over-long name on a character boundary', () => {
    const name = sanitizeFileName('图'.repeat(200))
    expect(name).toBeDefined()
    expect(Buffer.byteLength(name!)).toBeLessThanOrEqual(120)
    expect(name!.endsWith('图')).toBe(true)
  })

  it('strips only attachment placeholders from prompt text', () => {
    expect(stripAttachmentPlaceholders('a ![image](k) b <file key="k" name="n"/> c', false))
      .toBe('a b c')
    expect(stripAttachmentPlaceholders('<forwarded_messages>\nx\n</forwarded_messages>', true)).toBe('')
  })
})
