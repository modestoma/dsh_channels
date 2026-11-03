/**
 * The prompt this channel submits for one Feishu turn, before DSH turns it
 * into a `UserMessage`: the request id this channel mints, the principal it
 * is submitted as, and its content blocks (text, plus the durable references
 * of prefetched images). The request id is what every later correlation uses
 * (`agent/inbox/claimed`, the restart snapshot, the queued-card merge), since
 * DSH assigns the message id itself.
 *
 * @module dsh-channels/session/prompt
 */

import { randomUUID } from 'node:crypto'
import type { ChannelPrincipal } from '../access/principal.ts'
import { INFLIGHT_PROMPT_MAX_BYTES } from '../domain.ts'
import type { InflightSnapshot } from '../domain.ts'
import type { FileAttachmentRef, FileUploadReceiptId, ImageAttachmentRef } from '../dsh-types.ts'

/** Text of a prompt. */
export interface PromptTextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * A prefetched image: its durable reference, and the staged-upload receipt
 * the submission cites while the Session that staged it stays live
 * (transient; absent in a restart snapshot, which re-stages from the reference).
 */
export interface PromptImageBlock {
  readonly type: 'image'
  readonly attachment: ImageAttachmentRef
  readonly receiptId?: FileUploadReceiptId
}

/** A stored file, with the same receipt rule as {@link PromptImageBlock}. */
export interface PromptFileBlock {
  readonly type: 'file'
  readonly attachment: FileAttachmentRef
  readonly receiptId?: FileUploadReceiptId
}

export type PromptBlock = PromptTextBlock | PromptImageBlock | PromptFileBlock

/** One prompt this channel submits. */
export interface ChannelPrompt {
  /** Fresh per prompt; becomes `source.rpcId` of the message DSH creates. */
  readonly requestId: string
  /** The principal the prompt is submitted as (the Peer it goes through). */
  readonly principal: ChannelPrincipal
  readonly content: readonly PromptBlock[]
}

/**
 * A text-only prompt with a fresh request id.
 * @param text - the prompt text.
 * @param principal - who submits it.
 * @returns the prompt.
 */
export function channelPrompt(text: string, principal: ChannelPrincipal): ChannelPrompt {
  return { requestId: randomUUID(), principal, content: [{ type: 'text', text }] }
}

/**
 * The prompt as stored in a restart snapshot (receipts stripped), or
 * undefined when its JSON exceeds `INFLIGHT_PROMPT_MAX_BYTES` (restart
 * recovery then cannot replay it).
 * @param prompt - the prompt handed to the submitter.
 * @returns the snapshot field value.
 */
export function storablePrompt(prompt: ChannelPrompt): InflightSnapshot['prompt'] {
  const stored = {
    requestId: prompt.requestId,
    principal: { ...prompt.principal },
    content: prompt.content.map(block => {
      if (block.type === 'text') return { ...block }
      const { receiptId: _transient, ...durable } = block
      return { ...durable }
    }),
  }
  return Buffer.byteLength(JSON.stringify(stored)) <= INFLIGHT_PROMPT_MAX_BYTES ? stored : undefined
}

/**
 * Rebuild the prompt stored in a snapshot. Content blocks are kept as
 * written; a block of an unknown type is dropped.
 * @param stored - the snapshot field.
 * @returns the prompt to replay.
 */
export function promptOfSnapshot(stored: NonNullable<InflightSnapshot['prompt']>): ChannelPrompt {
  const content: PromptBlock[] = []
  for (const block of stored.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if ((block.type === 'image' || block.type === 'file') && typeof block.attachment === 'object' && block.attachment !== null) {
      content.push({ type: block.type, attachment: block.attachment } as PromptImageBlock | PromptFileBlock)
    }
  }
  return { requestId: stored.requestId, principal: stored.principal, content }
}
