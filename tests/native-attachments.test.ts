/**
 * Native attachment storage layer tests: image admission, streamed file
 * storage, handle text, read-path failures, and failure classification.
 *
 * The host attachment packages are never imported here either: every test uses
 * the local narrow types, which is also what proves the AC1 "no DSH runtime
 * dependency" claim on the runtime modules.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AttachmentStore } from '../src/host/attachments.ts'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef } from '../src/host/attachments.ts'
import type { SaveFileStreamAttachment, SaveImageAttachment } from '../src/host/attachments.ts'
import {
  NativeAttachmentStore,
  attachmentErrorCodeOf,
  formatFileHandle,
} from '../src/feishu/native-attachments.ts'

/** A minimal but valid PNG signature + a few payload bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02])

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 8 * 1024 * 1024,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 40 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'sha256:1111222233334444',
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 2,
  height: 2,
}

const FILE_REF: FileAttachmentRef = {
  attachmentId: 'sha256:5555666677778888',
  name: 'file.bin',
  bytes: 5,
}

interface FakeStore extends AttachmentStore {
  readonly saveImage: Mock<AttachmentStore['saveImage']>
  readonly saveFileStream: Mock<AttachmentStore['saveFileStream']>
  readonly fileHostPath: Mock<AttachmentStore['fileHostPath']>
  readonly imageHostPath: Mock<AttachmentStore['imageHostPath']>
}

/** Build one structurally complete `ctx.attachments` stub. */
function makeStore(overrides: Partial<AttachmentStore> = {}): FakeStore {
  const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
    ...IMAGE_REF,
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    ...(input.name === undefined ? {} : { name: input.name }),
  }))
  const saveFileStream = vi.fn(async (input: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return { attachmentId: FILE_REF.attachmentId, name: input.name ?? FILE_REF.name, bytes }
  })
  const fileHostPath = vi.fn((): string | undefined => '/host/attachments/v1/objects/aa/bb')
  const imageHostPath = vi.fn((): string | undefined => '/host/attachments/v1/objects/cc/dd')
  return {
    saveImage,
    saveFileStream,
    fileHostPath,
    imageHostPath,
    ...overrides,
  } as unknown as FakeStore
}

function makeNative(service: AttachmentStore): NativeAttachmentStore {
  return new NativeAttachmentStore({ service: () => service })
}

describe('attachment library bridge (AC1)', () => {
  it('imports no DSH package from the runtime bridge or storage layer', () => {
    // Comments may name the upstream packages as documentation; only actual
    // import/require statements would make them compile- or runtime-visible.
    const dshImport = /(?:from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\/)/u
    for (const relative of ['../src/host/attachments.ts', '../src/feishu/native-attachments.ts']) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
      expect(source, relative).not.toMatch(dshImport)
    }
  })

  it('exposes no DSH runtime dependency in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).some(name => name.startsWith('@deepseek-ai/'))).toBe(false)
  })
})

describe('image admission (AC2)', () => {
  it('stores image bytes and returns an ImageBlock shape', async () => {
    const service = makeStore()
    const native = makeNative(service)
    const result = await native.saveImage({ bytes: PNG, name: '../../shots/x.png' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.block).toEqual({ type: 'image', attachment: result.value.ref })
    expect(result.value.ref.mediaType).toBe('image/png')
    expect(result.value.ref.bytes).toBe(PNG.byteLength)
    // Display names are sanitized (no directory traversal) before reaching the host.
    expect(service.saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'x.png' })
  })

  it('rejects a declared media type that disagrees with the bytes', async () => {
    const service = makeStore()
    const result = await makeNative(service).saveImage({ bytes: PNG, mediaType: 'image/jpeg' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('IMAGE_TYPE_MISMATCH')
      expect(result.reason).toContain('不一致')
    }
    expect(service.saveImage).not.toHaveBeenCalled()
  })

  it('rejects undecodable bytes as an unsupported image', async () => {
    const service = makeStore()
    const result = await makeNative(service).saveImage({ bytes: new Uint8Array([1, 2, 3, 4]) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_IMAGE_TYPE')
    expect(service.saveImage).not.toHaveBeenCalled()
  })

  it('enforces the host image byte limit before writing', async () => {
    const service = makeStore({ imageLimits: { ...IMAGE_LIMITS, maxImageBytes: 4 } })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('IMAGE_TOO_LARGE')
      expect(result.reason).toContain('大小上限')
    }
    expect(service.saveImage).not.toHaveBeenCalled()
  })

  it('maps a host decode failure to a structured code and readable reason', async () => {
    const failure = Object.assign(new Error('decode failed'), { code: 'INVALID_IMAGE' })
    const service = makeStore({
      isAttachmentError: (error: unknown) => (error as { code?: string }).code === 'INVALID_IMAGE',
      saveImage: vi.fn(async () => {
        throw failure
      }),
    })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_IMAGE')
      expect(result.reason).toBe('图片内容损坏或无法解码')
    }
  })

  it('maps an unrelated thrown error to a generic structured failure', async () => {
    const service = makeStore({
      saveImage: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ATTACHMENT_STORE_ERROR')
      expect(result.reason).toContain('disk full')
    }
  })

  it('does not throw on a malformed host limits object', async () => {
    const service = makeStore({
      imageLimits: { maxImageBytes: 'nope', mediaTypes: null } as unknown as ImageAttachmentLimits,
    })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(true)
    expect(service.saveImage).toHaveBeenCalledTimes(1)
  })

  it('keeps thrown object values readable instead of [object Object]', async () => {
    const service = makeStore({
      saveImage: vi.fn(async () => {
        throw { detail: 'boom' }
      }),
    })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).not.toContain('[object Object]')
      expect(result.reason).toContain('boom')
    }
  })

  it('truncates an oversized error description in the reason', async () => {
    const service = makeStore({
      saveImage: vi.fn(async () => {
        throw { detail: 'x'.repeat(4000) }
      }),
    })
    const result = await makeNative(service).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('已截断')
      expect(result.reason.length).toBeLessThan(700)
    }
  })
})

describe('file streamed admission (AC3)', () => {
  it('streams chunks and returns a FileAttachmentRef with name and bytes', async () => {
    const service = makeStore()
    const payload = new TextEncoder().encode('exact bytes')
    async function* source(): AsyncGenerator<Uint8Array> {
      yield payload.subarray(0, 5)
      yield payload.subarray(5)
    }
    const result = await makeNative(service).saveFile({ source: source(), name: '../../etc/report?.pdf' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ref).toEqual({
      attachmentId: FILE_REF.attachmentId,
      name: 'report_.pdf',
      bytes: payload.byteLength,
    })
    expect(result.value.block).toEqual({ type: 'file', attachment: result.value.ref })
    expect(result.value.hostPath).toBe('/host/attachments/v1/objects/aa/bb')
    expect(result.value.handleText).toContain('report_.pdf')
    expect(result.value.handleText).toContain(`${payload.byteLength} bytes`)
    expect(result.value.handleText).toContain('sha256:55556666')
    expect(result.value.handleText).toContain('/host/attachments/v1/objects/aa/bb')
  })

  it('applies a fallback name when the resource carries none', async () => {
    const service = makeStore()
    const result = await makeNative(service).saveFile({
      source: (async function* () {
        yield new Uint8Array([1])
      })(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.ref.name).toBe('file.bin')
  })

  it('never collects the whole file in memory', async () => {
    let produced = 0
    let consumed = 0
    let maxOutstanding = 0
    const chunks = 16
    const chunkBytes = 1024 * 1024
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < chunks; index += 1) {
        produced += 1
        yield new Uint8Array(chunkBytes)
      }
    }
    const service = makeStore({
      saveFileStream: vi.fn(async (input: SaveFileStreamAttachment) => {
        let bytes = 0
        for await (const chunk of input.data) {
          consumed += 1
          maxOutstanding = Math.max(maxOutstanding, produced - consumed)
          bytes += chunk.byteLength
          await Promise.resolve()
        }
        return { attachmentId: FILE_REF.attachmentId, name: input.name ?? 'file.bin', bytes }
      }),
    })
    const result = await makeNative(service).saveFile({ source: source(), name: 'big.bin' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.ref.bytes).toBe(chunks * chunkBytes)
    expect(produced).toBe(chunks)
    expect(consumed).toBe(chunks)
    // A buffering implementation would run ahead of the consumer by many chunks.
    expect(maxOutstanding).toBeLessThanOrEqual(1)
  })

  it('honors cancellation between chunks and reports ABORTED', async () => {
    const controller = new AbortController()
    const seenSignals: AbortSignal[] = []
    const service = makeStore({
      saveFileStream: vi.fn(async (input: SaveFileStreamAttachment) => {
        if (input.signal !== undefined) seenSignals.push(input.signal)
        let index = 0
        for await (const _chunk of input.data) {
          index += 1
          if (index === 1) controller.abort()
        }
        return { attachmentId: FILE_REF.attachmentId, name: input.name ?? 'file.bin', bytes: 0 }
      }),
    })
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 4; index += 1) yield new Uint8Array([index])
    }
    const result = await makeNative(service).saveFile({
      source: source(),
      name: 'slow.bin',
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ABORTED')
      expect(result.reason).toBe('操作已取消')
    }
    expect(seenSignals).toEqual([controller.signal])
  })

  it('refuses a pre-aborted stream before calling the host', async () => {
    const controller = new AbortController()
    controller.abort()
    const service = makeStore()
    const result = await makeNative(service).saveFile({
      source: (async function* () {
        yield new Uint8Array([1])
      })(),
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ABORTED')
    expect(service.saveFileStream).not.toHaveBeenCalled()
  })

  it('surfaces a read-path failure instead of silently dropping the path', async () => {
    const missing = Object.assign(new Error('gone'), { code: 'ATTACHMENT_NOT_FOUND' })
    const service = makeStore({
      fileHostPath: vi.fn(() => {
        throw missing
      }),
    })
    const result = await makeNative(service).saveFile({
      source: (async function* () {
        yield new Uint8Array([1, 2])
      })(),
      name: 'x.bin',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.hostPath).toBeUndefined()
    expect(result.value.readPathError?.code).toBe('ATTACHMENT_NOT_FOUND')
    expect(result.value.handleText).toContain('cannot access a readable path')
    expect(result.value.handleText).not.toContain('saved at')
  })

  it('reports the read path of a stored file and image', async () => {
    const native = makeNative(makeStore())
    expect(native.fileReadPath(FILE_REF)).toEqual({
      ok: true,
      value: '/host/attachments/v1/objects/aa/bb',
    })
    expect(native.imageReadPath(IMAGE_REF)).toEqual({
      ok: true,
      value: '/host/attachments/v1/objects/cc/dd',
    })
  })

  it('reports a missing read path as a structured failure', async () => {
    const native = makeNative(makeStore({ fileHostPath: vi.fn(() => undefined) }))
    const result = native.fileReadPath(FILE_REF)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ATTACHMENT_PROJECTION_UNSUPPORTED')
  })
})

describe('handle text and failure classification', () => {
  it('formats a deterministic handle with and without a readable path', () => {
    const ref: FileAttachmentRef = { attachmentId: 'sha256:0123456789abcdef', name: 'a"b.pdf', bytes: 12 }
    const withPath = formatFileHandle(ref, '/host/attachments/v1/objects/aa/bb')
    expect(withPath).toContain('File "a\\"b.pdf" (12 bytes, sha256:01234567)')
    expect(withPath).toContain('verbatim read-only copy saved at "/host/attachments/v1/objects/aa/bb"')
    expect(withPath).toContain('copy it to a writable location')
    const withoutPath = formatFileHandle(ref)
    expect(withoutPath).toContain('cannot access a readable path')
    expect(withoutPath).not.toContain('saved at')
  })

  it('classifies host attachment codes through the structural contract', () => {
    const service = makeStore()
    expect(attachmentErrorCodeOf({ code: 'IMAGE_TOO_LARGE' })).toBe('IMAGE_TOO_LARGE')
    expect(attachmentErrorCodeOf({ code: 'NOT_A_CODE' })).toBeUndefined()
    expect(attachmentErrorCodeOf(new Error('plain'))).toBeUndefined()
    // When the host classifier rejects the value, a colliding `code` is not trusted.
    expect(attachmentErrorCodeOf({ code: 'INVALID_IMAGE' }, makeStore({ isAttachmentError: () => false })))
      .toBeUndefined()
    expect(attachmentErrorCodeOf({ code: 'INVALID_IMAGE' }, service)).toBe('INVALID_IMAGE')
  })
})
