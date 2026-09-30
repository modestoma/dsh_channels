/**
 * ImageIntake tests: resource → durable image-block conversion, capability
 * gates, per-image failure containment, and the max-image cap.
 */

import { describe, expect, it, vi } from 'vitest'
import { ImageIntake } from '../src/feishu/inbound-image.ts'
import type { AttachmentService } from '../src/host/services.ts'
import { makeChannel, makeMessage } from './helpers.ts'

function makeIntake(overrides: {
  enabled?: boolean
  maxImages?: number
  attachments?: AttachmentService | undefined
  download?: () => Promise<{ data: Uint8Array; mediaType?: string }>
} = {}) {
  const channel = makeChannel({
    downloadResource: overrides.download ?? (() => Promise.resolve({
      data: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), mediaType: 'image/png',
    })),
  })
  let saved = 0
  const saveImages = vi.fn(async (inputs: readonly unknown[]) =>
    inputs.map(() => ({ id: `att_${++saved}` })))
  const warn = vi.fn()
  const attachments = 'attachments' in overrides
    ? overrides.attachments
    : { saveImages } as unknown as AttachmentService
  const intake = new ImageIntake({
    enabled: () => overrides.enabled ?? true,
    maxImages: () => overrides.maxImages ?? 4,
    channel: () => channel,
    attachments: () => attachments,
    warn,
  })
  return { intake, channel, saveImages, warn }
}

const imageMessage = (fileKeys = ['img_1']) => makeMessage({
  content: '看这张图',
  resources: fileKeys.map(fileKey => ({ type: 'image', fileKey })) as never,
})

describe('ImageIntake', () => {
  it('commits each image resource and returns durable image blocks', async () => {
    const { intake, channel, saveImages } = makeIntake()
    const blocks = await intake.blocksFor(imageMessage(['img_1', 'img_2']))
    expect(channel.downloadResource).toHaveBeenCalledTimes(2)
    expect(saveImages).toHaveBeenCalledTimes(2)
    expect(blocks).toEqual([
      { type: 'image', attachment: { id: 'att_1' } },
      { type: 'image', attachment: { id: 'att_2' } },
    ])
  })

  it('caps the forwarded images per message', async () => {
    const { intake, saveImages } = makeIntake({ maxImages: 1 })
    const blocks = await intake.blocksFor(imageMessage(['a', 'b', 'c']))
    expect(blocks).toHaveLength(1)
    expect(saveImages).toHaveBeenCalledTimes(1)
  })

  it('returns nothing when images are disabled or no resource is present', async () => {
    const { intake } = makeIntake({ enabled: false })
    expect(await intake.blocksFor(imageMessage())).toEqual([])
    const enabled = makeIntake()
    expect(await enabled.intake.blocksFor(makeMessage({ content: '纯文本' }))).toEqual([])
  })

  it('degrades to text-only without the attachment service, warning once', async () => {
    const { intake, warn, saveImages } = makeIntake({ attachments: undefined })
    expect(await intake.blocksFor(imageMessage())).toEqual([])
    expect(await intake.blocksFor(imageMessage())).toEqual([])
    expect(saveImages).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('skips an unsupported media type and contains a download failure', async () => {
    const unsupported = makeIntake({ download: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: undefined }) })
    expect(await unsupported.intake.blocksFor(imageMessage(['bad']))).toEqual([])
    expect(unsupported.warn).toHaveBeenCalled()

    const failing = makeIntake({ download: async () => { throw new Error('download failed') } })
    expect(await failing.intake.blocksFor(imageMessage(['x']))).toEqual([])
    expect(failing.warn).toHaveBeenCalled()
  })
})
