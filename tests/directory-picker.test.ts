/**
 * 系统目录选择器适配层：native 后端识别、browse/缺失宿主的降级、惰性解析
 * （插件可能先于宿主 picker 行 apply）、一次一个模态框的互斥，以及面板字段
 * 的 `browse: 'directory'` 标记。
 */

import { describe, expect, it } from 'vitest'
import type { HostContext } from '../src/dsh-types.ts'
import { createSettingsDirectoryPicker } from '../src/settings/directory-picker.ts'
import type { HostDirectoryPickerService } from '../src/settings/directory-picker.ts'
import { FIELD_DESCRIPTORS, withDirectoryBrowse } from '../src/settings/surface.ts'

/** Minimal host context: only `get('directoryPicker')` matters here. */
function hostWith(get: (name: string) => unknown): HostContext {
  return { get } as unknown as HostContext
}

/** Host seam stub serving one native capability. */
function nativeService(
  pick: (signal: AbortSignal) => Promise<string | null>,
): HostDirectoryPickerService {
  return { capability: () => ({ kind: 'native', pick }) }
}

function hostServing(service: HostDirectoryPickerService): HostContext {
  return hostWith(name => (name === 'directoryPicker' ? service : undefined))
}

describe('createSettingsDirectoryPicker', () => {
  it('exposes the native chooser and forwards the picked absolute path', async () => {
    const picker = createSettingsDirectoryPicker(hostServing(nativeService(async () => '/Users/me/workspaces')))
    expect(picker.available).toBe(true)
    await expect(picker.pick(new AbortController().signal)).resolves.toBe('/Users/me/workspaces')
  })

  it('forwards the caller signal so an abandoned page can close the dialog', async () => {
    const seen: AbortSignal[] = []
    const picker = createSettingsDirectoryPicker(hostServing(nativeService(async (signal) => {
      seen.push(signal)
      return null
    })))
    const controller = new AbortController()
    await expect(picker.pick(controller.signal)).resolves.toBeNull()
    expect(seen).toEqual([controller.signal])
  })

  it('treats a missing service, a browse backend, or an incomplete capability as unavailable', async () => {
    const contexts: HostContext[] = [
      hostWith(() => undefined),
      hostWith(() => ({})),
      hostServing({ capability: () => ({ kind: 'browse' }) }),
      // native kind without a callable pick is not a usable chooser either.
      hostServing({ capability: () => ({ kind: 'native' }) as unknown as { kind: 'native'; pick: never } }),
    ]
    for (const ctx of contexts) {
      const picker = createSettingsDirectoryPicker(ctx)
      expect(picker.available).toBe(false)
      await expect(picker.pick(new AbortController().signal)).rejects.toThrow('不提供系统目录选择器')
    }
  })

  it('degrades to unavailable when the seam throws', () => {
    const service: HostDirectoryPickerService = {
      capability: () => { throw new Error('seam exploded') },
    }
    expect(createSettingsDirectoryPicker(hostServing(service)).available).toBe(false)
  })

  it('resolves lazily so a picker mounted after apply is still discovered', async () => {
    let service: HostDirectoryPickerService | undefined
    const picker = createSettingsDirectoryPicker(hostWith(name => (
      name === 'directoryPicker' ? service : undefined
    )))
    // The plugin may be applied before the host's picker row finishes mounting.
    expect(picker.available).toBe(false)
    service = nativeService(async () => '/tmp/late-workspace')
    expect(picker.available).toBe(true)
    await expect(picker.pick(new AbortController().signal)).resolves.toBe('/tmp/late-workspace')
  })

  it('rejects blank paths from a broken backend', async () => {
    const picker = createSettingsDirectoryPicker(hostServing(nativeService(async () => '   ')))
    await expect(picker.pick(new AbortController().signal)).rejects.toThrow('无效路径')
  })

  it('allows one modal at a time and releases the slot when it settles', async () => {
    let release: (value: string | null) => void = () => {}
    let calls = 0
    const pending = new Promise<string | null>((resolve) => { release = resolve })
    const picker = createSettingsDirectoryPicker(hostServing(nativeService(() => {
      calls += 1
      return calls === 1 ? pending : Promise.resolve('/tmp/second')
    })))
    const first = picker.pick(new AbortController().signal)
    await expect(picker.pick(new AbortController().signal)).rejects.toThrow('已有目录选择窗口正在打开')
    release('/tmp/workspaces')
    await expect(first).resolves.toBe('/tmp/workspaces')
    await expect(picker.pick(new AbortController().signal)).resolves.toBe('/tmp/second')
  })

  it('returns null without opening the chooser when the signal is already aborted', async () => {
    let called = 0
    const picker = createSettingsDirectoryPicker(hostServing(nativeService(async () => {
      called += 1
      return '/tmp/never'
    })))
    const controller = new AbortController()
    controller.abort()
    await expect(picker.pick(controller.signal)).resolves.toBeNull()
    expect(called).toBe(0)
  })
})

describe('withDirectoryBrowse', () => {
  it('marks only the workspace root when the native chooser is mounted', () => {
    const fields = withDirectoryBrowse(FIELD_DESCRIPTORS, true)
    expect(fields.find(field => field.key === 'baseDir')?.browse).toBe('directory')
    expect(fields.filter(field => field.browse !== undefined).map(field => field.key))
      .toEqual(['baseDir'])
    // The shared descriptors stay immutable; only the panel payload is marked.
    expect(FIELD_DESCRIPTORS.every(field => field.browse === undefined)).toBe(true)
  })

  it('keeps every field plain when the host has no native chooser', () => {
    const fields = withDirectoryBrowse(FIELD_DESCRIPTORS, false)
    expect(fields.every(field => field.browse === undefined)).toBe(true)
    expect(fields).not.toBe(FIELD_DESCRIPTORS)
  })
})
