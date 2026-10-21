/**
 * Native slash-command panel sync: keeps the commands Feishu lists when a
 * user types `/` in a chat with the bot (`application/v7/app_slash_commands`)
 * equal to the channel command registry.
 *
 * The plugin owns the bot's whole command vocabulary (one dsh instance per
 * bot), so the sync is a full reconcile: missing commands are created,
 * commands whose description changed are updated in place, and commands the
 * registry no longer has (or duplicates) are deleted. A second run with an
 * unchanged registry issues no writes. Feishu clients cache the panel for
 * about five minutes after a write.
 *
 * @module dsh-channels/feishu/slash-commands
 */

import { CHANNEL_COMMANDS } from '../commands/registry.ts'
import type { ChannelCommandSpec } from '../commands/registry.ts'

/** One command as the plugin wants Feishu to list it. */
export interface SlashCommandEntry {
  /** Command name without the leading slash. */
  readonly command: string
  /** Panel description (zh_cn and default text). */
  readonly description: string
}

/** One command as Feishu currently lists it for the app. */
export interface RemoteSlashCommand {
  /** Feishu `command_id`, needed for deletion. */
  readonly id: string
  readonly command: string
  /** `description.default_value`; empty when Feishu omitted it. */
  readonly description: string
}

/**
 * The app's slash-command endpoints. Every method rejects with a
 * `FeishuApiError` when Feishu answers a non-zero code or the transport fails.
 */
export interface SlashCommandApi {
  /** Every command currently registered for the app. */
  list(): Promise<readonly RemoteSlashCommand[]>
  /** Register one command. */
  create(entry: SlashCommandEntry): Promise<void>
  /** Replace the description of the command with Feishu id `id`. */
  update(id: string, entry: SlashCommandEntry): Promise<void>
  /** Delete one command by its Feishu id. */
  delete(id: string): Promise<void>
}

/** Writes a reconcile needs, in execution order (deletions first). */
export interface SlashCommandSyncPlan {
  /** Remote commands to delete: stale or duplicated. */
  readonly remove: readonly RemoteSlashCommand[]
  /** Remote commands whose description changed, with their new entry. */
  readonly update: ReadonlyArray<{ readonly id: string; readonly entry: SlashCommandEntry }>
  /** Entries Feishu does not list yet. */
  readonly create: readonly SlashCommandEntry[]
}

/** Outcome of one successful reconcile. */
export interface SlashCommandSyncResult {
  readonly created: number
  readonly updated: number
  readonly removed: number
  /** Commands the panel lists after the sync. */
  readonly total: number
}

/**
 * The panel entries derived from the command registry, in registry order.
 * Aliases are left out: the panel lists each command once.
 *
 * @returns One entry per canonical channel command.
 */
export function desiredSlashCommands(): readonly SlashCommandEntry[] {
  const specs: readonly ChannelCommandSpec[] = CHANNEL_COMMANDS
  return specs.map(spec => ({ command: spec.name, description: spec.description }))
}

/**
 * Diff the remote commands against the desired entries.
 *
 * @param remote Commands Feishu lists for the app.
 * @param desired Entries the panel should list.
 * @returns Deletions and creations; both empty when the panel is current.
 */
export function planSlashCommandSync(
  remote: readonly RemoteSlashCommand[],
  desired: readonly SlashCommandEntry[],
): SlashCommandSyncPlan {
  const wanted = new Map(desired.map(entry => [entry.command, entry]))
  const matched = new Set<string>()
  const remove: RemoteSlashCommand[] = []
  const update: Array<{ id: string; entry: SlashCommandEntry }> = []
  for (const item of remote) {
    const entry = wanted.get(item.command)
    if (entry === undefined || matched.has(item.command)) {
      remove.push(item)
      continue
    }
    matched.add(item.command)
    if (entry.description !== item.description) update.push({ id: item.id, entry })
  }
  return { remove, update, create: desired.filter(entry => !matched.has(entry.command)) }
}

/**
 * Reconcile the app's panel with `desired`. Stops at the first failed call
 * and rethrows it; a later run resumes from whatever state Feishu kept. Once
 * `signal` aborts, no further write starts (a write already sent completes).
 *
 * @param api The app's slash-command endpoints.
 * @param desired Entries the panel should list.
 * @param signal Aborted when the caller stops waiting (timeout, shutdown).
 * @returns Write counts and the resulting panel size.
 */
export async function syncSlashCommands(
  api: SlashCommandApi,
  desired: readonly SlashCommandEntry[],
  signal?: AbortSignal,
): Promise<SlashCommandSyncResult> {
  const plan = planSlashCommandSync(await api.list(), desired)
  const writes = [
    ...plan.remove.map(item => () => api.delete(item.id)),
    ...plan.update.map(item => () => api.update(item.id, item.entry)),
    ...plan.create.map(entry => () => api.create(entry)),
  ]
  for (const write of writes) {
    signal?.throwIfAborted()
    await write()
  }
  return { created: plan.create.length, updated: plan.update.length, removed: plan.remove.length, total: desired.length }
}
