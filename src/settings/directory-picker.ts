/**
 * 系统目录选择器的 Host 适配层：把宿主可选的 `directoryPicker` 服务折叠成
 * 设置面板的最小 picker。
 *
 * 宿主的目录选择 seam 有两种后端（`native` / `browse`，见
 * `@deepseek-ai/dsh-host-directory-picker-auto` 的启动判定）：
 *
 * - `native`：桌面/本地 GUI 会话，`pick(signal)` 打开操作系统的目录选择框；
 *   面板据此给「工作区根目录」加「选择目录…」按钮。
 * - `browse`：远程/无头/SSH 会话，没有可服务的显示会话，只能由前端自绘
 *   目录浏览器；本插件不实现那套 UI，`browse` 后端按“不可用”处理，字段
 *   保持手写输入。
 *
 * 与 `src/host/` 的其余桥接一致：这里只声明消费到的结构类型，不 import
 * 任何 DSH 内部包，因此宿主缺该服务（旧版本/无 GUI）时插件照常加载。
 *
 * @module dsh-channels/settings/directory-picker
 */

import type { HostContext } from '../dsh-types.ts'

/** 宿主 native 能力的最小结构副本（`kind` + `pick`，其余字段不关心）。 */
export interface NativeDirectoryPickerCapability {
  kind: 'native'
  /**
   * 打开系统目录选择框。
   * @param signal - 调用方生命周期；中止会关闭选择框。
   * @returns 绝对路径；操作者取消时为 `null`。
   */
  pick(signal: AbortSignal): Promise<string | null>
}

/** 宿主能力联合的保守副本：只识别 `native`，其余后端一律视为不可用。 */
export type HostDirectoryPickerCapability =
  | NativeDirectoryPickerCapability
  | { kind: string; [key: string]: unknown }

/** `ctx.directoryPicker` 的结构副本（抽象服务，只有一个 `capability()`）。 */
export interface HostDirectoryPickerService {
  capability(): HostDirectoryPickerCapability
}

/** 设置面板消费的最小 picker（surface / routes 只依赖这个接口，便于单测）。 */
export interface SettingsDirectoryPicker {
  /** 宿主是否提供可用的系统目录选择框。 */
  readonly available: boolean
  /**
   * 打开系统目录选择框；同一 picker 同时只允许一个选择框。
   * @param signal - 调用方生命周期；中止会关闭选择框。
   * @returns 绝对路径；操作者取消时为 `null`。
   */
  pick(signal: AbortSignal): Promise<string | null>
}

/** 取出 native 能力；服务缺失、后端为 browse 或 capability 抛错都返回 undefined。 */
function nativeCapability(
  service: HostDirectoryPickerService | undefined,
): NativeDirectoryPickerCapability | undefined {
  if (service === undefined || typeof service.capability !== 'function') return undefined
  let capability: unknown
  try {
    capability = service.capability()
  } catch {
    // A broken picker seam must not break the settings panel: fall back to text.
    return undefined
  }
  if (typeof capability !== 'object' || capability === null) return undefined
  const record = capability as { kind?: unknown; pick?: unknown }
  if (record.kind !== 'native' || typeof record.pick !== 'function') return undefined
  return capability as NativeDirectoryPickerCapability
}

/**
 * 从宿主上下文取出可用的系统目录选择器。
 *
 * 解析是**惰性**的：插件可能先于 `dsh-web-app` 的 directory-picker 行完成
 * apply，而设置面板只会在宿主全部加载完成后被请求。因此 `available` 与
 * `pick()` 每次都按需解析（成功结果缓存；失败不缓存，晚挂载的服务仍能被
 * 发现），避免把加载时序固化成「永远没有按钮」。
 *
 * @param ctx - 宿主上下文；`ctx.get('directoryPicker')` 是可选服务。
 * @returns picker；`available` 为 false 时面板保留手写输入。
 */
export function createSettingsDirectoryPicker(ctx: HostContext): SettingsDirectoryPicker {
  let resolved: NativeDirectoryPickerCapability | undefined
  const resolve = (): NativeDirectoryPickerCapability | undefined => {
    if (resolved !== undefined) return resolved
    try {
      const service = ctx.get?.('directoryPicker') as HostDirectoryPickerService | undefined
      resolved = nativeCapability(service)
    } catch {
      // A throwing service lookup must not take the settings panel down.
      resolved = undefined
    }
    return resolved
  }
  /** 互斥：一个原生模态框同时只应存在一个（双击/多标签页不得叠窗）。 */
  let picking = false
  return {
    get available(): boolean {
      return resolve() !== undefined
    },
    async pick(signal: AbortSignal): Promise<string | null> {
      const capability = resolve()
      if (capability === undefined) throw new Error('当前宿主机不提供系统目录选择器')
      if (picking) throw new Error('已有目录选择窗口正在打开')
      if (signal.aborted) return null
      picking = true
      try {
        const picked = await capability.pick.call(capability, signal)
        if (picked === null || picked === undefined) return null
        if (typeof picked !== 'string' || picked.trim() === '') {
          throw new Error('目录选择器返回了无效路径')
        }
        return picked
      } finally {
        picking = false
      }
    },
  }
}
