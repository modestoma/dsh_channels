/**
 * Native attachment storage layer tests: service discovery/degradation, image
 * admission, streamed file storage, handle text, read-path failures, and the
 * `attachmentStore` backend switch with its archive fallback.
 *
 * The host attachment packages are never imported here either: every test uses
 * the local narrow types, which is also what proves the AC1 "no DSH runtime
 * dependency" claim on the runtime modules.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { AttachmentStoreMode } from '../src/config.ts'
import type { AdmittedPromptContentPart, AttachmentAdmissionPart, AttachmentStore } from '../src/host/attachments.ts'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef } from '../src/host/attachments.ts'
import type { SaveFileStreamAttachment, SaveImageAttachment } from '../src/host/attachments.ts'
import type { FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'
import { AttachmentIntake } from '../src/feishu/inbound-attachments.ts'
import {
  ATTACHMENT_SERVICE_UNMOUNTED_REASON,
  InboundAttachmentStore,
  NativeAttachmentStore,
  attachmentErrorCodeOf,
  attachmentServiceState,
  formatFileHandle,
  isAttachmentStore,
  nativeAttachmentStoreOf,
  planAttachmentStorage,
  resolveAttachmentService,
} from '../src/feishu/native-attachments.ts'
import type { StoredNativeFile } from '../src/feishu/native-attachments.ts'
import { makeAgentContext, makeChannel, makeMessage } from './helpers.ts'

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
  readonly admitPromptContent: Mock<AttachmentStore['admitPromptContent']>
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
  const admitPromptContent = vi.fn(
    async (content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]> =>
      content.map(part => (part.type === 'image' ? { type: 'image' as const, attachment: IMAGE_REF } : part)),
  )
  return {
    saveImage,
    saveFileStream,
    fileHostPath,
    imageHostPath,
    admitPromptContent,
    ...overrides,
  } as unknown as FakeStore
}

function makeNative(service: AttachmentStore | undefined): NativeAttachmentStore {
  return new NativeAttachmentStore({ service: () => service })
}

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-channels-native-'))
}

/** Structured warning sink shared by the storage layer and the archive intake. */
type WarnSink = Mock<(message: string, ...args: unknown[]) => void>

interface FacadeHarness {
  store: InboundAttachmentStore
  channel: FeishuChannel
  warn: WarnSink
  /** The topic `attachments/` directory the archive backend writes into. */
  attachments: string
}

function makeFacade(options: {
  enabled?: boolean
  mode?: AttachmentStoreMode
  service?: AttachmentStore
  channel?: FeishuChannel
  now?: number
} = {}): FacadeHarness {
  const warn = vi.fn<(message: string, ...args: unknown[]) => void>()
  const channel = options.channel ?? makeChannel()
  const archive = new AttachmentIntake({
    enabled: () => options.enabled ?? true,
    channel: () => channel,
    warn,
    now: () => options.now ?? Date.UTC(2026, 9, 20, 12, 0, 0),
  })
  const store = new InboundAttachmentStore({
    enabled: () => options.enabled ?? true,
    mode: () => options.mode ?? 'native',
    service: () => options.service,
    channel: () => channel,
    archive,
    warn,
  })
  return {
    store,
    channel,
    warn,
    attachments: path.join(makeWorkspace(), 'attachments'),
  }
}

/** One message carrying both an image and a file resource. */
function mixedMessage(): NormalizedMessage {
  return makeMessage({
    messageId: 'om_mixed',
    content: '看下 ![image](img_1) <file key="file_1" name="报告.pdf"/>',
    resources: [
      { type: 'image', fileKey: 'img_1' },
      { type: 'file', fileKey: 'file_1', fileName: '报告.pdf' },
    ] as never,
  })
}

function mixedChannel(): FeishuChannel {
  return makeChannel({
    downloadResource: (_messageId, _fileKey, type) => (type === 'image'
      ? [PNG]
      : [new TextEncoder().encode('hello')]),
  })
}

describe('attachment service bridge (AC1)', () => {
  it('reads an injected attachment service from the Agent scope', () => {
    const service = makeStore()
    const ctx = makeAgentContext()
    ctx.attachments = service
    expect(resolveAttachmentService(ctx)).toBe(service)
    const state = attachmentServiceState(ctx)
    expect(state.mounted).toBe(true)
    expect(isAttachmentStore(service)).toBe(true)
  })

  it('falls back to the safe ctx.get lookup when the property is not readable', () => {
    const service = makeStore()
    const ctx = makeAgentContext()
    ctx.get = (name: string) => (name === 'attachments' ? service : undefined)
    expect(resolveAttachmentService(ctx)).toBe(service)
  })

  it('reports a cordis-style property throw as unmounted instead of throwing', () => {
    const ctx = makeAgentContext()
    Object.defineProperty(ctx, 'attachments', {
      configurable: true,
      get() {
        throw new Error('cannot get property "attachments" without inject')
      },
    })
    expect(() => resolveAttachmentService(ctx)).not.toThrow()
    expect(resolveAttachmentService(ctx)).toBeUndefined()
    const state = attachmentServiceState(ctx)
    expect(state.mounted).toBe(false)
    if (!state.mounted) {
      expect(state.code).toBe('ATTACHMENT_SERVICE_UNMOUNTED')
      expect(state.reason).toBe(ATTACHMENT_SERVICE_UNMOUNTED_REASON)
    }
  })

  it('reports an undefined Agent context as unmounted', () => {
    const state = attachmentServiceState(undefined)
    expect(state.mounted).toBe(false)
    if (!state.mounted) expect(state.reason).toContain('未挂载')
    const store = nativeAttachmentStoreOf(undefined)
    expect(store.state().mounted).toBe(false)
  })

  it('rejects a partially matching service object', () => {
    expect(isAttachmentStore(undefined)).toBe(false)
    expect(isAttachmentStore({ saveImage: () => undefined })).toBe(false)
    expect(isAttachmentStore({ ...makeStore(), saveFileStream: undefined })).toBe(false)
  })

  it('publishes host limits when the service exposes them', () => {
    const ctx = makeAgentContext()
    ctx.attachments = makeStore({ imageLimits: IMAGE_LIMITS })
    const state = attachmentServiceState(ctx)
    expect(state.mounted).toBe(true)
    if (state.mounted) expect(state.limits).toEqual(IMAGE_LIMITS)
  })

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

  it('refuses to store without a mounted service', async () => {
    const result = await makeNative(undefined).saveImage({ bytes: PNG })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ATTACHMENT_SERVICE_UNMOUNTED')
      expect(result.reason).toBe(ATTACHMENT_SERVICE_UNMOUNTED_REASON)
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

describe('prompt admission and handle text', () => {
  it('passes prompt parts through the host admission', async () => {
    const service = makeStore()
    const result = await makeNative(service).admitPromptContent([
      { type: 'text', text: 'hi' },
      { type: 'image', mediaType: 'image/png', data: 'AA==' },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value[0]).toEqual({ type: 'text', text: 'hi' })
      expect(result.value[1]).toEqual({ type: 'image', attachment: IMAGE_REF })
    }
  })

  it('maps an admission error and an unmounted service', async () => {
    const service = makeStore({
      admitPromptContent: vi.fn(async () => {
        throw Object.assign(new Error('bad'), { code: 'IMAGE_TYPE_MISMATCH' })
      }),
    })
    const failed = await makeNative(service).admitPromptContent([])
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('IMAGE_TYPE_MISMATCH')

    const unmounted = await makeNative(undefined).admitPromptContent([])
    expect(unmounted.ok).toBe(false)
    if (!unmounted.ok) expect(unmounted.code).toBe('ATTACHMENT_SERVICE_UNMOUNTED')
  })

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

describe('attachmentStore backend switch (AC5)', () => {
  it('defaults to native and accepts archive', () => {
    expect(resolveConfig({}).attachmentStore).toBe('native')
    expect(resolveConfig({ attachmentStore: 'archive' }).attachmentStore).toBe('archive')
    expect(() => resolveConfig({ attachmentStore: 's3' })).toThrow(/invalid configuration/u)
  })

  it('plans native when the service is mounted', () => {
    expect(planAttachmentStorage({ configured: 'native', service: makeStore() })).toEqual({
      configured: 'native',
      effective: 'native',
    })
  })

  it('plans archive when configured archive', () => {
    expect(planAttachmentStorage({ configured: 'archive', service: makeStore() })).toEqual({
      configured: 'archive',
      effective: 'archive',
    })
  })

  it('degrades native to archive when the service is absent', () => {
    const plan = planAttachmentStorage({ configured: 'native', service: undefined })
    expect(plan.configured).toBe('native')
    expect(plan.effective).toBe('archive')
    expect(plan.fallback).toBe('attachment-service-unmounted')
    expect(plan.warning).toContain('回退')
  })

  it('stores image and file resources natively without touching the workspace (AC5 native)', async () => {
    const service = makeStore()
    const harness = makeFacade({ service, channel: mixedChannel() })
    const result = await harness.store.store(mixedMessage(), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return

    expect(result.mode).toBe('native')
    expect(result.saved).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.failures).toEqual([])
    expect(result.attachmentOnly).toBe(false)
    expect(result.text).toBe('看下')
    expect(result.stored.map(entry => entry.kind)).toEqual(['image', 'file'])
    expect(service.saveImage).toHaveBeenCalledTimes(1)
    expect(service.saveFileStream).toHaveBeenCalledTimes(1)

    const image = result.stored[0]
    expect(image?.block.type).toBe('image')
    const file = result.stored[1] as StoredNativeFile | undefined
    expect(file?.kind).toBe('file')
    expect(file?.ref.name).toBe('报告.pdf')
    expect(file?.ref.bytes).toBe(5)
    expect(file?.hostPath).toBe('/host/attachments/v1/objects/aa/bb')
    expect(file?.handleText).toContain('verbatim read-only copy saved at')
    expect(file?.block).toEqual({ type: 'file', attachment: file?.ref })

    // Native mode must not create the legacy topic attachments directory.
    expect(existsSync(harness.attachments)).toBe(false)
  })

  it('marks an attachment-only message and strips resource placeholders', async () => {
    const harness = makeFacade({ service: makeStore(), channel: mixedChannel() })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_only',
      content: '![image](img_1) <file key="file_1" name="a.bin"/>',
      resources: [
        { type: 'image', fileKey: 'img_1' },
        { type: 'file', fileKey: 'file_1', fileName: 'a.bin' },
      ] as never,
    }), harness.attachments)
    expect(result?.attachmentOnly).toBe(true)
    expect(result?.text).toBe('')
  })

  it('falls back to the workspace archive when the service is unmounted (AC5 fallback)', async () => {
    const channel = mixedChannel()
    const harness = makeFacade({ channel })
    const result = await harness.store.store(mixedMessage(), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return

    expect(result.mode).toBe('archive')
    expect(result.fallback).toBe('attachment-service-unmounted')
    expect(result.saved).toBe(2)
    expect(result.stored).toEqual([])
    expect(harness.warn).toHaveBeenCalledTimes(1)
    expect(harness.warn.mock.calls[0]?.[0]).toContain('回退')

    const dir = harness.attachments
    expect(readdirSync(dir)).toHaveLength(2)
    expect(readdirSync(dir).some(name => name.includes('报告'))).toBe(true)

    // The unmounted warning is emitted once per storage layer, not per message.
    await harness.store.store(mixedMessage(), harness.attachments)
    expect(harness.warn).toHaveBeenCalledTimes(1)
  })

  it('honors the configured archive backend even when the service is mounted', async () => {
    const service = makeStore()
    const harness = makeFacade({ mode: 'archive', service, channel: mixedChannel() })
    const result = await harness.store.store(mixedMessage(), harness.attachments)
    expect(result?.mode).toBe('archive')
    expect(result?.fallback).toBeUndefined()
    expect(result?.saved).toBe(2)
    expect(service.saveImage).not.toHaveBeenCalled()
    expect(service.saveFileStream).not.toHaveBeenCalled()
    expect(readdirSync(harness.attachments)).toHaveLength(2)
    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('keeps attachment messages inert when accepting is disabled', async () => {
    const service = makeStore()
    const harness = makeFacade({ enabled: false, service, channel: mixedChannel() })
    const withCaption = await harness.store.store(mixedMessage(), harness.attachments)
    expect(withCaption).toBeDefined()
    if (withCaption === undefined) return
    expect(withCaption.saved).toBe(0)
    expect(withCaption.attachmentOnly).toBe(false)
    // Same placeholder stripping as the enabled path: placeholders never reach
    // the model.
    expect(withCaption.text).toBe('看下')
    expect(service.saveImage).not.toHaveBeenCalled()
    expect(existsSync(harness.attachments)).toBe(false)

    // Attachment-only stays inert: nothing is left to prompt with, so the
    // caller can skip the turn instead of starting one on placeholder text.
    const attachmentOnly = await harness.store.store(makeMessage({
      messageId: 'om_only_disabled',
      content: '![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), harness.attachments)
    expect(attachmentOnly?.attachmentOnly).toBe(true)
    expect(attachmentOnly?.text).toBe('')
    expect(attachmentOnly?.stored).toEqual([])
  })

  it('returns undefined for a message without an attachment payload', async () => {
    const harness = makeFacade({ service: makeStore() })
    await expect(harness.store.store(makeMessage({ content: '纯文本' }), harness.attachments))
      .resolves.toBeUndefined()
  })

  it('contains per-resource failures and keeps storing the rest', async () => {
    const channel = makeChannel({
      downloadResource: (_messageId, fileKey, type) => {
        if (fileKey === 'img_ok' && type === 'image') return [PNG]
        throw new Error('Request failed with status code 400')
      },
    })
    const harness = makeFacade({ service: makeStore(), channel })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_partial',
      content: '![image](img_ok) <file key="file_bad" name="bad.zip"/>',
      resources: [
        { type: 'image', fileKey: 'img_ok' },
        { type: 'file', fileKey: 'file_bad', fileName: 'bad.zip' },
      ] as never,
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.mode).toBe('native')
    expect(result.saved).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.failures.map(failure => failure.name)).toEqual(['bad.zip'])
    expect(result.failures[0]?.reason).toContain('拒绝请求')
    expect(harness.warn).toHaveBeenCalledTimes(1)
    // A failing download never creates a workspace fallback directory.
    expect(existsSync(harness.attachments)).toBe(false)
  })

  it('reports folder resources without attempting a download', async () => {
    const channel = makeChannel()
    const harness = makeFacade({ service: makeStore(), channel })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_folder',
      rawContentType: 'post',
      content: '[rich text message]',
      raw: {
        message: {
          message_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [],
            files: [{ file_key: 'file_v3_dir', file_name: 'logs', is_folder: true }],
          }),
        },
      },
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.saved).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0]).toEqual({ name: 'logs', reason: '飞书文件夹消息暂不支持下载' })
    expect(vi.mocked(channel.downloadResource)).not.toHaveBeenCalled()
    expect(existsSync(harness.attachments)).toBe(false)
  })

  it('maps an error thrown from the host stream write to Feishu download wording', async () => {
    const service = makeStore({
      saveFileStream: vi.fn(async () => {
        throw new Error('Request failed with status code 400')
      }),
    })
    const harness = makeFacade({
      service,
      channel: makeChannel({ downloadResource: () => [new Uint8Array([1])] }),
    })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_file_stream_fail',
      content: '<file key="file_1" name="a.bin"/>',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'a.bin' }] as never,
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.saved).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0]?.reason).toContain('拒绝请求')
  })

  it('keeps non-download storage faults on their own code/wording', async () => {
    const service = makeStore({
      saveFileStream: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device')
      }),
    })
    const harness = makeFacade({
      service,
      channel: makeChannel({ downloadResource: () => [new Uint8Array([1])] }),
    })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_file_store_fail',
      content: '<file key="file_1" name="a.bin"/>',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'a.bin' }] as never,
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.failed).toBe(1)
    // A real storage fault must not be mislabeled as a Feishu download refusal.
    expect(result.failures[0]?.reason).toContain('原生附件库操作失败')
    expect(result.failures[0]?.reason).not.toContain('下载接口')
  })

  it('refuses an oversized native image download without storing it', async () => {
    const service = makeStore({ imageLimits: { ...IMAGE_LIMITS, maxImageBytes: 4 } })
    const harness = makeFacade({
      service,
      channel: makeChannel({ downloadResource: () => [PNG] }),
    })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_big_image',
      content: '![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.saved).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0]?.reason).toContain('大小上限')
    expect(service.saveImage).not.toHaveBeenCalled()
  })

  it('reports undeliverable messages when the Feishu connection is down', async () => {
    const harness = makeFacade({ service: makeStore(), channel: makeChannel() })
    const store = new InboundAttachmentStore({
      enabled: () => true,
      mode: () => 'native',
      service: () => makeStore(),
      channel: () => undefined,
      archive: new AttachmentIntake({ enabled: () => true, channel: () => undefined, warn: () => {} }),
      warn: harness.warn,
    })
    const result = await store.store(mixedMessage(), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.saved).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.failures.every(failure => failure.reason.includes('连接未运行'))).toBe(true)
  })

  it('keeps forwarded records on the legacy text archive in native mode', async () => {
    const harness = makeFacade({ service: makeStore(), channel: makeChannel() })
    const result = await harness.store.store(makeMessage({
      messageId: 'om_forward',
      rawContentType: 'merge_forward',
      content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
    }), harness.attachments)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.mode).toBe('archive')
    expect(result.fallback).toBe('forwarded-record')
    expect(result.saved).toBe(1)
    expect(readdirSync(harness.attachments)).toEqual(['20261020-120000-forwarded-record.txt'])
  })
})
