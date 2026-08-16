/**
 * Workspace directory resolution: one DSH workspace per (user × chat).
 *
 * - p2p:    `<baseDir>/p2p/<open_id>/`           (the user's private workspace)
 * - group:  `<baseDir>/groups/<chat_id>/<open_id>/` (per-user workspace inside a group)
 *
 * Feishu ids (`ou_…`, `oc_…`) are safe path segments, but they are validated
 * anyway so a hostile id can never escape `baseDir`.
 *
 * @module dsh-channels/workspaces
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { HostContext, Workspace } from './dsh-types.ts'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

export function safeSegment(raw: string, what: string): string {
  const segment = raw.replace(/^\/+|\/+$/g, '')
  if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`dsh-channels: unsafe ${what} for workspace path: ${JSON.stringify(raw)}`)
  }
  return segment
}

/** Deterministic workspace directory for one (chat, user) pair. */
export function workspacePathFor(
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
): string {
  const chat = safeSegment(chatId, 'chatId')
  const user = safeSegment(senderOpenId, 'senderOpenId')
  return chatType === 'p2p'
    ? path.join(baseDir, 'p2p', user)
    : path.join(baseDir, 'groups', chat, user)
}

/** Human-friendly workspace title shown in the DSH workspace list. */
export function workspaceTitleFor(chatType: 'p2p' | 'group', chatId: string, senderOpenId: string): string {
  return chatType === 'p2p'
    ? `飞书私聊 · ${senderOpenId}`
    : `飞书群聊 · ${chatId} · ${senderOpenId}`
}

/**
 * Ensure the workspace directory exists and is registered with the host's
 * workspace registry. Idempotent: repeated calls return the same record.
 */
export async function ensureWorkspace(
  ctx: HostContext,
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
): Promise<Workspace> {
  const dir = workspacePathFor(baseDir, chatType, chatId, senderOpenId)
  await mkdir(dir, { recursive: true })
  return ctx.workspaceRegistry.create(dir, workspaceTitleFor(chatType, chatId, senderOpenId))
}
