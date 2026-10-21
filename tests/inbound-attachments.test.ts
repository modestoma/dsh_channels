/**
 * Inbound attachment archival tests: workspace layout, file-name safety,
 * merged-forward records, placeholder stripping, capability gates, and
 * per-attachment failure containment.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  adoptStagedAttachments, ATTACHMENTS_DIR, AttachmentIntake, attachmentResources, attachmentsDir,
  compactTimestamp, describeFailure, hasAttachmentPayload, postAttachedFiles, sanitizeFileName,
  stripAttachmentPlaceholders,
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

    expect(result).toEqual({ saved: 1, failed: 0, failures: [], attachmentOnly: true, text: '' })
    const dir = workspace
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^20261018-120000-image\.png$/)
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
    const [name] = readdirSync(workspace)
    expect(name).toBe('20261018-120000-report_.pdf')
    expect(readFileSync(path.join(workspace, name!))).toEqual(Buffer.from(payload))
  })

  it('archives an expanded merged-forward record as text and strips its placeholder', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_forward',
      content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
      rawContentType: 'merge_forward',
    }), workspace)

    expect(result).toEqual({ saved: 1, failed: 0, failures: [], attachmentOnly: true, text: '' })
    const dir = workspace
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

    expect(result.saved).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.attachmentOnly).toBe(true)
    expect(result.text).toBe('')
    expect(result.failures).toEqual([{ name: '会话记录', reason: '会话记录为空（机器人可能缺少源消息的读取权限）' }])
    expect(existsSync(workspace)).toBe(true)
    expect(readdirSync(workspace)).toEqual([])
    expect((channel as unknown as { reactions: unknown[] }).reactions).toEqual([
      { messageId: 'om_forward_empty', emojiType: 'No' },
    ])
  })

  it('does nothing when archiving is disabled, keeping mixed text', async () => {
    const workspace = makeWorkspace()
    const { intake, channel } = makeIntake({ enabled: false })
    const target = path.join(workspace, 'disabled-target')
    const result = await intake.archive(makeMessage({
      messageId: 'om_disabled',
      content: '说明 ![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), target)

    expect(result).toEqual({ saved: 0, failed: 0, failures: [], attachmentOnly: false, text: '说明' })
    expect(existsSync(target)).toBe(false)
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

    expect(result.saved).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.attachmentOnly).toBe(true)
    expect(result.text).toBe('')
    expect(result.failures).toEqual([{ name: '图片', reason: 'download failed' }])
    const dir = workspace
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
    expect(readdirSync(workspace).sort()).toEqual([
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
    expect(result).toEqual({ saved: 0, failed: 0, failures: [], attachmentOnly: false, text: '<audio key="x"/>' })
  })
})

describe('agent guidance', () => {
  it('points the archive Agent at its conversation attachment directory', () => {
    expect(attachmentsGuidance('archive')).toContain('own `attachments/` directory')
    const withPath = attachmentsGuidance('archive', '/tmp/feishu-ws/topic-1/attachments')
    expect(withPath).toContain('/tmp/feishu-ws/topic-1/attachments')
    expect(withPath).toContain('separate directories')
    expect(FEISHU_ATTACHMENTS_SECTION).toBe('dsh-channels:feishu-attachments')
  })

  it('escapes backticks in a hostile directory path', () => {
    expect(attachmentsGuidance('archive', '/tmp/a`b/topic/attachments')).toContain("/tmp/a'b/topic/attachments")
  })

  it('describes the native library and the lazy fetch manifest by default', () => {
    const native = attachmentsGuidance()
    expect(native).toBe(attachmentsGuidance('native'))
    expect(native).toContain('native attachment library')
    expect(native).toContain('feishu_attachment_fetch')
    expect(native).toContain('<feishu_context>')
    expect(native).toContain('not loaded')
    expect(native).toContain('read-only copy')
    expect(native).toContain('copy it into the working directory')
    expect(native).not.toContain('own `attachments/` directory')

    // The two flavors never leak each other's wording.
    const archive = attachmentsGuidance('archive', '/tmp/feishu-ws/topic-1/attachments')
    expect(archive).not.toContain('native attachment library')
    expect(archive).not.toContain('feishu_attachment_fetch')
    expect(archive).not.toContain('<feishu_context>')
    // Native mode has no per-conversation directory, so it ignores the path.
    expect(attachmentsGuidance('native', '/tmp/feishu-ws/topic-1/attachments'))
      .not.toContain('/tmp/feishu-ws/topic-1/attachments')
  })
})

describe('rich-text post attachments', () => {
  const postRaw = (files: unknown[], text = '看一下这个文件的内容') => ({
    message: {
      message_type: 'post',
      content: JSON.stringify({
        title: '',
        content: [[{ tag: 'text', text, style: [] }]],
        content_v2: [[{ tag: 'text', text, style: [] }]],
        files,
      }),
    },
  })

  it('recovers files the SDK post converter drops', async () => {
    const workspace = makeWorkspace()
    const payload = new TextEncoder().encode('zip-bytes')
    const { intake } = makeIntake({ channel: makeChannel({ downloadResource: () => [payload] }) })
    const result = await intake.archive(makeMessage({
      messageId: 'om_post_file',
      rawContentType: 'post',
      content: '看一下这个文件的内容',
      raw: postRaw([{
        file_key: 'file_v3_bugreport', file_name: 'bugreport-2025-11-04-141749.zip', is_folder: false,
      }]),
    }), workspace)

    expect(result.saved).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.attachmentOnly).toBe(false)
    expect(result.text).toBe('看一下这个文件的内容')
    const [name] = readdirSync(workspace)
    expect(name).toMatch(/-bugreport-2025-11-04-141749\.zip$/)
  })

  it('treats a file-only post as attachment-only', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake({ channel: makeChannel({ downloadResource: () => [PNG] }) })
    const result = await intake.archive(makeMessage({
      messageId: 'om_post_only',
      rawContentType: 'post',
      content: '[rich text message]',
      raw: postRaw([{ file_key: 'file_v3_only', file_name: 'only.bin' }], ''),
    }), workspace)
    expect(result.saved).toBe(1)
    expect(result.attachmentOnly).toBe(true)
    expect(result.text).toBe('')
  })

  it('reports folder attachments and locale-wrapped payloads', async () => {
    const workspace = makeWorkspace()
    const { intake } = makeIntake()
    const result = await intake.archive(makeMessage({
      messageId: 'om_post_folder',
      rawContentType: 'post',
      content: '[rich text message]',
      raw: {
        message: {
          message_type: 'post',
          content: JSON.stringify({
            zh_cn: { title: '', content: [], files: [{ file_key: 'file_v3_dir', file_name: 'logs', is_folder: true }] },
          }),
        },
      },
    }), workspace)
    expect(result.failed).toBe(1)
    expect(result.failures).toEqual([{ name: 'logs', reason: '飞书文件夹消息暂不支持下载' }])
    expect(readdirSync(workspace)).toEqual([])
  })

  it('parses only post payloads that actually carry files', () => {
    expect(postAttachedFiles('post', postRaw([{ file_key: 'k', file_name: 'n.zip' }]))).toEqual([
      { fileKey: 'k', fileName: 'n.zip' },
    ])
    expect(postAttachedFiles('post', postRaw([{ file_key: '', file_name: 'bad.zip' }]))).toEqual([])
    expect(postAttachedFiles('text', postRaw([{ file_key: 'k' }]))).toEqual([])
    expect(postAttachedFiles('post', undefined)).toEqual([])
    expect(postAttachedFiles('post', { message: { content: 'not-json' } })).toEqual([])
  })

  it('merges post files with normalized resources without duplicates', () => {
    const msg = makeMessage({
      messageId: 'om_merge',
      rawContentType: 'post',
      content: '![image](img_1) 看一下',
      raw: postRaw([
        { file_key: 'img_1', file_name: 'ignored-by-image-resource' },
        { file_key: 'file_v3_extra', file_name: 'extra.zip' },
      ], '看一下'),
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    })
    const resources = attachmentResources(msg)
    expect(resources.map(resource => resource.fileKey)).toEqual(['img_1', 'file_v3_extra'])
    expect(hasAttachmentPayload(msg)).toBe(true)
    expect(hasAttachmentPayload(makeMessage({ messageId: 'om_plain', content: '纯文本' }))).toBe(false)
  })

  it('maps download failures to actionable reasons', () => {
    expect(describeFailure(new Error('Request failed with status code 400')))
      .toContain('拒绝请求')
    expect(describeFailure(new Error('Request failed with status code 403')))
      .toContain('无权限')
    expect(describeFailure(new Error('boom'))).toBe('boom')
  })
})

describe('topic workspace attachments', () => {
  it('derives the attachments directory from one topic workspace', () => {
    const workspace = makeWorkspace()
    expect(attachmentsDir(workspace)).toBe(path.join(workspace, ATTACHMENTS_DIR))
    expect(ATTACHMENTS_DIR).toBe('attachments')
  })

  it('adopts staged files into the topic workspace exactly once', async () => {
    const workspace = makeWorkspace()
    const staging = path.join(workspace, 'staging')
    mkdirSync(staging, { recursive: true })
    writeFileSync(path.join(staging, 'a.zip'), 'a')
    writeFileSync(path.join(staging, 'b.zip'), 'b')
    writeFileSync(path.join(staging, '.hidden'), 'ignored')

    expect(await adoptStagedAttachments(staging, workspace)).toBe(2)
    expect(readdirSync(attachmentsDir(workspace)).sort()).toEqual(['a.zip', 'b.zip'])
    expect(readdirSync(staging)).toEqual(['.hidden'])

    // Nothing left to adopt on the next attempt.
    expect(await adoptStagedAttachments(staging, workspace)).toBe(0)
    expect(await adoptStagedAttachments(path.join(workspace, 'missing'), workspace)).toBe(0)
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
