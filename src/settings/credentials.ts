/**
 * The Feishu application credentials: resolving the configured references
 * through the host credentials seam, and the settings panel's credential slots.
 *
 * @module dsh-channels/settings/credentials
 */

import type { FeishuConfig } from '../config.ts'
import type { CredentialInfo, CredentialProvider, HostContext } from '../host/index.ts'
import type { CredentialField } from './contract.ts'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The host credentials seam, when mounted. */
function credentialProvider(ctx: HostContext): CredentialProvider | undefined {
  return ctx.get?.('credentials') as CredentialProvider | undefined
}

/**
 * Resolve one credential reference through the host credentials seam.
 *
 * Precedence is owned by the provider (env > `$DSH_HOME/.credentials.yaml`
 * > `.env` fallbacks). Without a mounted seam the process environment is the
 * whole credential plane.
 * @param ctx - the host context.
 * @param ref - the reference name.
 * @returns the value.
 * @throws Error naming the reference when it does not resolve.
 */
export async function resolveCredentialRef(ctx: HostContext, ref: string): Promise<string> {
  const provider = credentialProvider(ctx)
  if (provider !== undefined) {
    const hit = await provider.resolve(ref)
    if (hit !== undefined) return hit.value
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient !== '') return ambient
  }
  throw new Error(
    `dsh-channels: credential "${ref}" is not configured; add it to $DSH_HOME/.credentials.yaml `
    + `(e.g. "${ref}: <value>") or export it in the launching environment`,
  )
}

export interface CredentialSlotsDeps {
  ctx: HostContext
  config(): FeishuConfig
  /** Re-read credential presence after a write. */
  refreshed(): Promise<void>
}

/** The panel's App ID / App Secret slots. Values are never returned or logged. */
export class CredentialSlots {
  constructor(private readonly deps: CredentialSlotsDeps) {}

  /** @returns presence, source, and writability of each slot's reference. */
  async states(): Promise<Record<CredentialField, CredentialInfo>> {
    const provider = credentialProvider(this.deps.ctx)
    const read = async (ref: string): Promise<CredentialInfo> => {
      try {
        if (provider?.describe !== undefined) {
          const info = await provider.describe(ref)
          return {
            configured: info?.configured === true,
            writable: info?.writable !== false && provider.set !== undefined,
            ...(info?.source === undefined ? {} : { source: info.source }),
          }
        }
        if (provider === undefined) {
          const ambient = process.env[ref]
          return { configured: ambient !== undefined && ambient !== '', writable: false }
        }
        return { configured: (await provider.resolve(ref)) !== undefined, writable: provider.set !== undefined }
      } catch {
        return { configured: false, writable: false }
      }
    }
    const config = this.deps.config()
    const [appId, appSecret] = await Promise.all([read(config.appId), read(config.appSecret)])
    return { appId, appSecret }
  }

  /**
   * Store one slot's value through the host seam.
   * @param field - the slot.
   * @param value - the secret value.
   */
  async set(field: CredentialField, value: string): Promise<void> {
    const provider = credentialProvider(this.deps.ctx)
    if (provider?.set === undefined) {
      throw new Error('主机的凭据服务不可写（未挂载 credentials.set，或当前提供方只读）')
    }
    const ref = this.ref(field)
    try {
      await provider.set(ref, value)
    } catch (error) {
      throw new Error(`写入凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
    await this.deps.refreshed()
  }

  /**
   * Remove one slot's stored value.
   * @param field - the slot.
   */
  async clear(field: CredentialField): Promise<void> {
    const provider = credentialProvider(this.deps.ctx)
    if (provider?.unset === undefined) {
      throw new Error('主机的凭据服务不支持移除凭据')
    }
    const ref = this.ref(field)
    try {
      await provider.unset(ref)
    } catch (error) {
      throw new Error(`移除凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
    await this.deps.refreshed()
  }

  /** The overlay-independent ref name backing one slot. */
  private ref(field: CredentialField): string {
    const config = this.deps.config()
    switch (field) {
      case 'appId': return config.appId
      case 'appSecret': return config.appSecret
    }
  }
}
