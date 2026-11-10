/**
 * Post-connect background checks of one Feishu connection: the granted-scope
 * self-check and the native slash-command panel sync. Each result is kept
 * for the settings panel only while its connection is the current one.
 *
 * @module dsh-channels/feishu/connection-checks
 */

import type { FeishuConfig } from '../config.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { ScopeCheckWire, SlashCommandSyncWire } from '../settings/contract.ts'
import { feishuReason } from './profiles.ts'
import { checkScopes } from './scopes.ts'
import { desiredSlashCommands, syncSlashCommands } from './slash-commands.ts'

/** Upper bound on the post-connect scope grant query. */
const SCOPE_CHECK_TIMEOUT_MS = 10_000
/** Upper bound on the whole post-connect slash-command panel sync (one list plus per-command writes). */
const SLASH_COMMAND_SYNC_TIMEOUT_MS = 30_000

export interface ConnectionChecksDeps {
  config(): FeishuConfig
  /** The current connection; a result for any other is dropped. */
  channel(): FeishuChannel | undefined
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Scope self-check and slash-command panel sync state. */
export class ConnectionChecks {
  private scopeState: ScopeCheckWire | undefined
  private slashState: SlashCommandSyncWire | undefined
  /** Aborts the running panel sync's remaining writes (timeout, shutdown, reconnect). */
  private slashAbort: AbortController | undefined

  constructor(private readonly deps: ConnectionChecksDeps) {}

  /** @returns the latest scope self-check of the current connection, once it finished. */
  scopeCheck(): ScopeCheckWire | undefined {
    return this.scopeState
  }

  /** @returns the latest slash-command panel sync of the current connection, once it finished. */
  slashCommandSync(): SlashCommandSyncWire | undefined {
    return this.slashState
  }

  /** Forget both results and stop a running sync (shutdown). */
  clear(): void {
    this.scopeState = undefined
    this.slashState = undefined
    this.slashAbort?.abort()
    this.slashAbort = undefined
  }

  /**
   * Reconcile Feishu's native `/` panel with the command registry and log the
   * outcome. Never throws; a failure only loses the panel listing, typed
   * commands keep working.
   * @param channel - the connection to sync.
   */
  async syncSlashCommands(channel: FeishuChannel): Promise<void> {
    this.slashState = undefined
    this.slashAbort?.abort()
    this.slashAbort = undefined
    const api = channel.slashCommands
    if (api === undefined) return
    const abort = new AbortController()
    this.slashAbort = abort
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: SlashCommandSyncWire
    try {
      const result = await Promise.race([
        syncSlashCommands(api, desiredSlashCommands(), abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${SLASH_COMMAND_SYNC_TIMEOUT_MS} ms）`)), SLASH_COMMAND_SYNC_TIMEOUT_MS)
        }),
      ])
      state = { state: 'ok', checkedAt: Date.now(), ...result }
    } catch (error) {
      state = { state: 'error', checkedAt: Date.now(), error: feishuReason(error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // A timed-out sync must not keep writing behind a reported failure.
      abort.abort()
      if (this.slashAbort === abort) this.slashAbort = undefined
    }
    // A background sync can outlive its connection (shutdown/reconnect).
    if (this.deps.channel() !== channel) return
    this.slashState = state
    if (state.state === 'ok') {
      this.deps.info('dsh-channels: slash command panel synced (%d commands, %d created, %d updated, %d removed)', state.total, state.created, state.updated, state.removed)
    } else {
      this.deps.warn('dsh-channels: 飞书原生斜杠指令面板同步失败（直接输入命令不受影响）：%s', state.error)
    }
  }

  /**
   * Compare the app's granted scopes with what the plugin uses and log the
   * missing ones. Never throws.
   * @param channel - the connection to check.
   * @param appId - the app the console links point to.
   */
  async checkScopes(channel: FeishuChannel, appId: string): Promise<void> {
    this.scopeState = undefined
    if (channel.grantedScopes === undefined) return
    const config = this.deps.config()
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: ScopeCheckWire
    try {
      const grants = await Promise.race([
        channel.grantedScopes(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${SCOPE_CHECK_TIMEOUT_MS} ms）`)), SCOPE_CHECK_TIMEOUT_MS)
        }),
      ])
      const result = checkScopes(grants, appId, {
        dmEnabled: config.dmMode === 'open',
        requireMention: config.requireMention,
        slashCommandPanel: config.slashCommandPanel,
        sendFile: config.feishuTools.sendFile,
        wikiRead: config.feishuTools.wikiRead && config.wikiRoots.length > 0,
        wikiWrite: config.feishuTools.wikiWrite && config.wikiRoots.length > 0,
      })
      state = result.consoleUrl === undefined
        ? { state: 'ok', checkedAt: Date.now() }
        : {
            state: 'missing',
            checkedAt: Date.now(),
            missing: result.missing.map(item => ({
              scopes: [...item.anyOf], level: item.level, purpose: item.purpose, consoleUrl: item.consoleUrl,
            })),
            consoleUrl: result.consoleUrl,
          }
    } catch (error) {
      state = { state: 'error', checkedAt: Date.now(), error: feishuReason(error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // A background check can outlive its connection (shutdown/reconnect).
    if (this.deps.channel() !== channel) return
    this.scopeState = state
    if (state.state === 'ok') {
      this.deps.info('dsh-channels: scope self-check passed')
    } else if (state.state === 'missing') {
      const lines = state.missing.map(item => `${item.level === 'required' ? '必需' : '可选'} ${item.scopes.join(' 或 ')}：${item.purpose}`)
      this.deps.warn('dsh-channels: 飞书权限缺失 %d 项，开通后需发布新版本（%s）：\n  %s', state.missing.length, state.consoleUrl, lines.join('\n  '))
    } else {
      this.deps.warn('dsh-channels: 飞书权限自检失败：%s', state.error)
    }
  }
}
