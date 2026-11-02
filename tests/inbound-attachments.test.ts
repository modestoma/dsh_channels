/**
 * Inbound attachment classification tests: rich-text post files, placeholder
 * stripping, name safety, failure wording, and the attachment guidance.
 */

import { describe, expect, it } from 'vitest'
import {
  attachmentResources, describeFailure, inboundAttachmentState, postAttachedFiles, sanitizeFileName,
  stripAttachmentPlaceholders,
} from '../src/feishu/inbound-attachments.ts'
import { FEISHU_ATTACHMENTS_GUIDANCE, FEISHU_ATTACHMENTS_SECTION } from '../src/feishu/agent-context.ts'
import { makeMessage } from './helpers.ts'

describe('agent guidance', () => {
  it('describes the native library and the lazy fetch manifest', () => {
    expect(FEISHU_ATTACHMENTS_SECTION).toBe('dsh-channels:feishu-attachments')
    const guidance = FEISHU_ATTACHMENTS_GUIDANCE
    expect(guidance).toContain('native attachment library')
    expect(guidance).toContain('feishu_attachment_fetch')
    expect(guidance).toContain('<feishu_context>')
    expect(guidance).toContain('not loaded')
    expect(guidance).toContain('read-only copy')
    expect(guidance).toContain('copy it into the working directory')
    expect(guidance).not.toContain('`attachments/` directory')
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

  it('recovers files the SDK post converter drops', () => {
    const state = inboundAttachmentState(makeMessage({
      messageId: 'om_post_file',
      rawContentType: 'post',
      content: '看一下这个文件的内容',
      raw: postRaw([{
        file_key: 'file_v3_bugreport', file_name: 'bugreport-2025-11-04-141749.zip', is_folder: false,
      }]),
    }))

    expect(state.hasPayload).toBe(true)
    expect(state.resources).toEqual([
      { type: 'file', fileKey: 'file_v3_bugreport', fileName: 'bugreport-2025-11-04-141749.zip' },
    ])
    expect(state.attachmentOnly).toBe(false)
    expect(state.text).toBe('看一下这个文件的内容')
  })

  it('treats a file-only post as attachment-only', () => {
    const state = inboundAttachmentState(makeMessage({
      messageId: 'om_post_only',
      rawContentType: 'post',
      content: '[rich text message]',
      raw: postRaw([{ file_key: 'file_v3_only', file_name: 'only.bin' }], ''),
    }))
    expect(state.hasPayload).toBe(true)
    expect(state.attachmentOnly).toBe(true)
    expect(state.text).toBe('')
  })

  it('marks folder attachments in locale-wrapped payloads', () => {
    const state = inboundAttachmentState(makeMessage({
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
    }))
    expect(state.resources).toEqual([{ type: 'file', fileKey: 'file_v3_dir', fileName: 'logs', folder: true }])
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
    expect(inboundAttachmentState(msg).hasPayload).toBe(true)
    expect(inboundAttachmentState(makeMessage({ messageId: 'om_plain', content: '纯文本' })).hasPayload).toBe(false)
  })

  it('maps download failures to actionable reasons', () => {
    expect(describeFailure(new Error('Request failed with status code 400')))
      .toContain('拒绝请求')
    expect(describeFailure(new Error('Request failed with status code 403')))
      .toContain('无权限')
    expect(describeFailure(new Error('boom'))).toBe('boom')
  })
})

describe('attachment name helpers', () => {
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
