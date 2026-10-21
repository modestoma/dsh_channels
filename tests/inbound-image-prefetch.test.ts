/**
 * Trigger-message attachment classification and image prefetch tests.
 *
 * `inboundAttachmentState` must agree with the legacy archive intake while
 * never downloading; `prefetchImageAttachments` must keep message order, stay
 * inside the single-image/total/timeout bounds, and contain every failure as a
 * value (never a throw). Every dependency is stubbed: no network, no host
 * attachment library, no filesystem.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AttachmentResource, ImagePrefetchInput, ImagePrefetchSaveResult,
} from '../src/feishu/inbound-attachments.ts'
import {
  attachmentResources, hasAttachmentPayload, inboundAttachmentState, prefetchImageAttachments,
} from '../src/feishu/inbound-attachments.ts'
import type { ImageAttachmentRef, ImageBlock } from '../src/host/attachments.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import { makeChannel, makeMessage } from './helpers.ts'

/** Minimal PNG signature plus payload bytes (the prefetch never decodes it). */
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02])

afterEach(() => {
  vi.useRealTimers()
})

// ---- inboundAttachmentState ---------------------------------------------

function imageMessage() {
  return makeMessage({
    messageId: 'om_image',
    content: '![image](img_1)',
    resources: [{ type: 'image', fileKey: 'img_1' }] as never,
  })
}

function captionMessage() {
  return makeMessage({
    messageId: 'om_caption',
    content: '看这张图 ![image](img_1) 里有什么',
    resources: [{ type: 'image', fileKey: 'img_1' }] as never,
  })
}

function fileMessage() {
  return makeMessage({
    messageId: 'om_file',
    content: '<file key="file_1" name="report.pdf"/>',
    resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }] as never,
  })
}

function forwardedMessage() {
  return makeMessage({
    messageId: 'om_forward',
    content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
    rawContentType: 'merge_forward',
  })
}

function postRaw(files: unknown[], text = '看一下这个文件的内容') {
  return {
    message: {
      message_type: 'post',
      content: JSON.stringify({
        title: '',
        content: [[{ tag: 'text', text, style: [] }]],
        files,
      }),
    },
  }
}

function postMessage() {
  return makeMessage({
    messageId: 'om_post',
    rawContentType: 'post',
    content: '看一下这个文件的内容',
    raw: postRaw([{ file_key: 'file_v3_bugreport', file_name: 'bugreport.zip', is_folder: false }]),
  })
}

describe('inboundAttachmentState', () => {
  it('classifies a pure image message as attachment-only with no prompt text', () => {
    expect(inboundAttachmentState(imageMessage())).toEqual({
      hasPayload: true,
      resources: [{ type: 'image', fileKey: 'img_1' }],
      forwarded: false,
      text: '',
      attachmentOnly: true,
    })
  })

  it('keeps a caption as prompt text while stripping its image placeholder', () => {
    const state = inboundAttachmentState(captionMessage())
    expect(state.hasPayload).toBe(true)
    expect(state.text).toBe('看这张图 里有什么')
    expect(state.attachmentOnly).toBe(false)
    expect(state.resources).toEqual([{ type: 'image', fileKey: 'img_1' }])
  })

  it('classifies a pure file message without downloading it', () => {
    expect(inboundAttachmentState(fileMessage())).toEqual({
      hasPayload: true,
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }],
      forwarded: false,
      text: '',
      attachmentOnly: true,
    })
  })

  it('unstrips an expanded merged-forward record and marks it attachment-only', () => {
    const state = inboundAttachmentState(forwardedMessage())
    expect(state).toEqual({
      hasPayload: true,
      resources: [],
      forwarded: true,
      text: '',
      attachmentOnly: true,
    })
    // A forward whose record failed to expand still classifies as a payload.
    const empty = inboundAttachmentState(makeMessage({
      messageId: 'om_forward_empty', content: '<forwarded_messages/>', rawContentType: 'merge_forward',
    }))
    expect(empty.hasPayload).toBe(true)
    expect(empty.text).toBe('')
    expect(empty.attachmentOnly).toBe(true)
  })

  it('returns ordinary text unchanged when there is no attachment payload', () => {
    expect(inboundAttachmentState(makeMessage({ messageId: 'om_text', content: '纯文本' }))).toEqual({
      hasPayload: false,
      resources: [],
      forwarded: false,
      text: '纯文本',
      attachmentOnly: false,
    })
  })

  it('recovers post files[] a rich-text message attached', () => {
    expect(inboundAttachmentState(postMessage())).toEqual({
      hasPayload: true,
      resources: [{ type: 'file', fileKey: 'file_v3_bugreport', fileName: 'bugreport.zip' }],
      forwarded: false,
      text: '看一下这个文件的内容',
      attachmentOnly: false,
    })
    const fileOnly = inboundAttachmentState(makeMessage({
      messageId: 'om_post_only',
      rawContentType: 'post',
      content: '[rich text message]',
      raw: postRaw([{ file_key: 'file_v3_only', file_name: 'only.bin' }], ''),
    }))
    expect(fileOnly.hasPayload).toBe(true)
    expect(fileOnly.text).toBe('')
    expect(fileOnly.attachmentOnly).toBe(true)
  })

  it('agrees with attachmentResources and hasAttachmentPayload on payload detection', () => {
    const samples = [
      imageMessage(), captionMessage(), fileMessage(), forwardedMessage(),
      makeMessage({ messageId: 'om_plain', content: '纯文本' }), postMessage(),
    ]
    for (const msg of samples) {
      const state = inboundAttachmentState(msg)
      expect(state.resources).toEqual(attachmentResources(msg))
      const payload = attachmentResources(msg).length > 0 || msg.rawContentType === 'merge_forward'
      expect(state.hasPayload).toBe(payload)
      if (payload) expect(hasAttachmentPayload(msg)).toBe(true)
      else expect(state.text).toBe(msg.content ?? '')
    }
    // Untracked resource kinds are not a payload in either classification.
    const audio = makeMessage({
      messageId: 'om_audio', content: '<audio key="x"/>', resources: [{ type: 'audio', fileKey: 'x' }] as never,
    })
    expect(inboundAttachmentState(audio)).toEqual({
      hasPayload: false, resources: [], forwarded: false, text: '<audio key="x"/>', attachmentOnly: false,
    })
  })
})

// ---- prefetchImageAttachments -------------------------------------------

function imageResource(fileKey: string, fileName?: string): AttachmentResource {
  return { type: 'image', fileKey, ...(fileName === undefined ? {} : { fileName }) }
}

function fileResource(fileKey: string, fileName?: string): AttachmentResource {
  return { type: 'file', fileKey, ...(fileName === undefined ? {} : { fileName }) }
}

function imageAttachmentRef(name?: string): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${(name ?? 'image').padEnd(16, '0').slice(0, 16)}`,
    mediaType: 'image/png',
    bytes: PNG.byteLength,
    width: 1,
    height: 1,
    ...(name === undefined ? {} : { name }),
  }
}

function imageBlock(name?: string): ImageBlock {
  return { type: 'image', attachment: imageAttachmentRef(name) }
}

function saveOk(name?: string): ImagePrefetchSaveResult {
  return { ok: true, block: imageBlock(name) }
}

function streamOf(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

type DownloadHandler = (
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>

/** Channel whose resource stream is scripted per test (only downloadResource is consumed). */
function channelWithDownload(handler: DownloadHandler): FeishuChannel {
  const channel = makeChannel()
  channel.downloadResource = async (messageId, fileKey, type) => await handler(messageId, fileKey, type)
  return channel
}

function never(): Promise<AsyncIterable<Uint8Array>> {
  return new Promise<AsyncIterable<Uint8Array>>(() => {})
}

function baseInput(overrides: Partial<ImagePrefetchInput> = {}): ImagePrefetchInput {
  return {
    msg: makeMessage({ messageId: 'om_trigger', content: '看下 ![image](img_1)' }),
    resources: [imageResource('img_1', 'a.png')],
    channel: makeChannel({ downloadResource: () => [PNG] }),
    saveImage: async (_bytes, name) => saveOk(name),
    maxImageBytes: 1024,
    maxTotalBytes: 4096,
    timeoutMs: 1000,
    ...overrides,
  }
}

describe('prefetchImageAttachments', () => {
  it('returns an empty result when nothing is prefetchable, without downloading', async () => {
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))
    const channel = makeChannel()
    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [fileResource('file_1'), { type: 'image', fileKey: 'folder_1', folder: true }],
      saveImage,
    }))

    expect(result.blocks).toEqual([])
    expect([...result.loadedFileKeys]).toEqual([])
    expect(result.failures).toEqual([])
    expect(saveImage).not.toHaveBeenCalled()
    expect(vi.mocked(channel.downloadResource)).not.toHaveBeenCalled()
  })

  it('stores every image in input order and reports the loaded file keys', async () => {
    const downloads: Array<{ fileKey: string; type: string }> = []
    const savedCalls: Array<{ bytes: number; name?: string }> = []
    const channel = channelWithDownload((_messageId, fileKey, type) => {
      downloads.push({ fileKey, type })
      return streamOf([fileKey === 'img_1' ? PNG : new Uint8Array([1, 2, 3])])
    })
    const saveImage = vi.fn(async (bytes: Uint8Array, name?: string) => {
      savedCalls.push({ bytes: bytes.byteLength, ...(name === undefined ? {} : { name }) })
      return saveOk(name)
    })

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
      saveImage,
    }))

    expect(result.failures).toEqual([])
    expect(result.blocks).toEqual([imageBlock('a.png'), imageBlock('b.png')])
    expect([...result.loadedFileKeys]).toEqual(['img_1', 'img_2'])
    expect(downloads).toEqual([
      { fileKey: 'img_1', type: 'image' },
      { fileKey: 'img_2', type: 'image' },
    ])
    expect(savedCalls).toEqual([{ bytes: PNG.byteLength, name: 'a.png' }, { bytes: 3, name: 'b.png' }])
  })

  it('reports a structured save failure and keeps processing later images', async () => {
    const channel = makeChannel({ downloadResource: () => [PNG] })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string): Promise<ImagePrefetchSaveResult> => (
      name === 'b.png' ? { ok: false, reason: '图片内容损坏或无法解码' } : saveOk(name)
    ))

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png'), imageResource('img_3', 'c.png')],
      saveImage,
    }))

    expect(result.blocks.map(block => block.attachment.name)).toEqual(['a.png', 'c.png'])
    expect([...result.loadedFileKeys]).toEqual(['img_1', 'img_3'])
    expect(result.failures).toEqual([{ name: 'b.png', reason: '图片内容损坏或无法解码' }])
    expect(saveImage).toHaveBeenCalledTimes(3)
  })

  it('contains a mid-stream download failure and continues with later images', async () => {
    const channel = channelWithDownload((_messageId, fileKey) => {
      if (fileKey === 'img_2') {
        return (async function* () {
          yield PNG
          throw new Error('stream broke')
        })()
      }
      return streamOf([PNG])
    })

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png'), imageResource('img_3', 'c.png')],
    }))

    expect(result.blocks.map(block => block.attachment.name)).toEqual(['a.png', 'c.png'])
    expect([...result.loadedFileKeys]).toEqual(['img_1', 'img_3'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('b.png')
    expect(result.failures[0]!.reason).toContain('stream broke')
  })

  it('describes thrown non-Error values readably and bounds long reasons', async () => {
    const channel = channelWithDownload((_messageId, fileKey) => {
      if (fileKey === 'img_1') throw { statusCode: 503, msg: 'gateway down' }
      throw new Error('x'.repeat(2000))
    })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
      saveImage,
    }))

    expect(result.blocks).toEqual([])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]!.reason).toContain('statusCode=503')
    expect(result.failures[0]!.reason).not.toContain('[object Object]')
    expect(result.failures[1]!.reason).toContain('…')
    expect(result.failures[1]!.reason.length).toBeLessThanOrEqual(500)
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses only the image above the single-image cap and still tries later ones', async () => {
    const downloads: string[] = []
    const channel = channelWithDownload((_messageId, fileKey) => {
      downloads.push(fileKey)
      // img_1 is above the cap, img_2 is exactly at it.
      return streamOf([fileKey === 'img_1' ? PNG : PNG.subarray(0, PNG.byteLength - 1)])
    })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
      saveImage,
      maxImageBytes: PNG.byteLength - 1,
    }))

    expect(downloads).toEqual(['img_1', 'img_2'])
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(result.blocks.map(block => block.attachment.name)).toEqual(['b.png'])
    expect([...result.loadedFileKeys]).toEqual(['img_2'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('a.png')
    expect(result.failures[0]!.reason).toContain('大小上限')
  })

  it('stops after the total byte budget is exhausted and records the remaining images', async () => {
    const downloads: string[] = []
    const channel = channelWithDownload((_messageId, fileKey) => {
      downloads.push(fileKey)
      return streamOf([PNG])
    })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png'), imageResource('img_3', 'c.png')],
      saveImage,
      maxTotalBytes: PNG.byteLength + 1,
    }))

    expect(downloads).toEqual(['img_1', 'img_2'])
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(result.blocks.map(block => block.attachment.name)).toEqual(['a.png'])
    expect([...result.loadedFileKeys]).toEqual(['img_1'])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]!.reason).toContain('总字节上限')
    expect(result.failures[1]!.reason).toContain('总字节上限')
  })

  it('fails every prefetchable image when the channel is not running', async () => {
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))
    const folderImage: AttachmentResource = { type: 'image', fileKey: 'folder_1', folder: true }

    const result = await prefetchImageAttachments(baseInput({
      channel: undefined,
      resources: [imageResource('img_1', 'a.png'), fileResource('file_1'), folderImage, imageResource('img_2')],
      saveImage,
    }))

    expect(result.blocks).toEqual([])
    expect([...result.loadedFileKeys]).toEqual([])
    expect(result.failures).toEqual([
      { name: 'a.png', reason: '飞书连接未运行' },
      { name: '图片', reason: '飞书连接未运行' },
    ])
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('returns within the deadline and keeps images stored before it', async () => {
    const channel = channelWithDownload((_messageId, fileKey) => (
      fileKey === 'img_1' ? streamOf([PNG]) : never()
    ))
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))

    const started = Date.now()
    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
      saveImage,
      timeoutMs: 20,
    }))
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(result.blocks.map(block => block.attachment.name)).toEqual(['a.png'])
    expect([...result.loadedFileKeys]).toEqual(['img_1'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('b.png')
    expect(result.failures[0]!.reason).toContain('超时')
  })

  it('treats a non-positive timeout as already expired and never starts a download', async () => {
    const downloads: string[] = []
    const channel = channelWithDownload((_messageId, fileKey) => {
      downloads.push(fileKey)
      return streamOf([PNG])
    })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
      saveImage,
      timeoutMs: 0,
    }))

    expect(downloads).toEqual([])
    expect(saveImage).not.toHaveBeenCalled()
    expect(result.blocks).toEqual([])
    expect(result.failures).toHaveLength(2)
    for (const failure of result.failures) expect(failure.reason).toContain('超时')
  })

  it('leaves no dangling timer after the deadline fires (fake timers)', async () => {
    vi.useFakeTimers()
    const channel = channelWithDownload(() => never())
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name))
    try {
      const pending = prefetchImageAttachments(baseInput({
        channel,
        resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png')],
        saveImage,
        timeoutMs: 500,
      }))
      await vi.advanceTimersByTimeAsync(500)
      const result = await pending

      expect(result.blocks).toEqual([])
      expect(result.failures).toHaveLength(2)
      for (const failure of result.failures) expect(failure.reason).toContain('超时')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears its deadline timer when the prefetch completes early (fake timers)', async () => {
    vi.useFakeTimers()
    try {
      const result = await prefetchImageAttachments(baseInput({
        channel: makeChannel({ downloadResource: () => [PNG] }),
        timeoutMs: 5000,
      }))
      expect(result.failures).toEqual([])
      expect(result.blocks).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a thrown storage error and keeps processing later images', async () => {
    const channel = makeChannel({ downloadResource: () => [PNG] })
    const saveImage = vi.fn(async (_bytes: Uint8Array, name?: string): Promise<ImagePrefetchSaveResult> => {
      if (name === 'b.png') throw new Error('store exploded')
      return saveOk(name)
    })

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png'), imageResource('img_2', 'b.png'), imageResource('img_3', 'c.png')],
      saveImage,
    }))

    expect(result.blocks.map(block => block.attachment.name)).toEqual(['a.png', 'c.png'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('b.png')
    expect(result.failures[0]!.reason).toContain('入库失败')
    expect(result.failures[0]!.reason).toContain('store exploded')
  })

  it('never throws when the warning sink itself throws', async () => {
    const channel = channelWithDownload(() => {
      throw new Error('download failed')
    })

    const result = await prefetchImageAttachments(baseInput({
      channel,
      resources: [imageResource('img_1', 'a.png')],
      saveImage: vi.fn(async (_bytes: Uint8Array, name?: string) => saveOk(name)),
      warn: () => {
        throw new Error('warn exploded')
      },
    }))

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toContain('download failed')
  })
})
