/**
 * Prompt submission through DSH's `session/prompt`.
 *
 * Every Feishu prompt is handed to the Gateway as the Peer of its principal
 * (`../access/peers.ts`), so DSH records the sender on the message source and
 * decides the call against this channel's access policy. Prefetched images are
 * staged through the host's in-process `fileUploads` service and cited by
 * receipt; a receipt lives only as long as the Session that staged it, so a
 * replay after a restart stages the durable reference again from the host
 * attachment store. A staging failure degrades that block to a text notice
 * and the prompt still goes out.
 *
 * The Agent must already be live (`SessionManager.ensureLive`): `session/prompt`
 * resumes a cold Session with the host's generic composition, which lacks this
 * channel's tools and guidance.
 *
 * @module dsh-channels/session/submit
 */

import { readFile } from 'node:fs/promises'
import type { PeerRegistry } from '../access/peers.ts'
import { ROUTE_NOT_PERMITTED } from '../access/remote-policy.ts'
import type { Agent, AttachmentStore, FileUploads, PromptContentPart, SessionPromptRequest, TypertGateway, UserMessage } from '../host/index.ts'
import { remoteFailureOf } from '../host/remote.ts'
import { promptRequestIdOf } from '../access/principal.ts'
import { sniffImageMediaType } from '../feishu-channel.ts'
import { sanitizeFileName } from '../feishu/inbound-attachments.ts'
import type { ChannelPrompt, PromptBlock, PromptImageBlock } from './prompt.ts'

/** Namespace and method of the session controller's prompt endpoint. */
const SESSION_NAMESPACE = 'session'
const PROMPT_METHOD = 'prompt'

export interface PromptSubmitterDeps {
  gateway(): TypertGateway
  fileUploads(): FileUploads
  /** The host attachment store, read for the host path of a reference to re-stage. */
  attachments(): AttachmentStore
  peers: PeerRegistry
  warn(message: string, ...args: unknown[]): void
}

/** Why a staged image was refused (a value, never a throw). */
export type StageImageResult =
  | { readonly ok: true; readonly block: PromptImageBlock }
  | { readonly ok: false; readonly reason: string }

export class PromptSubmitter {
  constructor(private readonly deps: PromptSubmitterDeps) {}

  /**
   * Validate, store and stage one downloaded image for a live Session.
   * @param agent - the Session's live Agent.
   * @param bytes - the encoded image.
   * @param name - optional display name.
   * @returns the image block (durable reference plus receipt), or the refusal.
   */
  async stageImage(agent: Agent, bytes: Uint8Array, name?: string): Promise<StageImageResult> {
    const mediaType = sniffImageMediaType(bytes)
    if (mediaType === undefined) return { ok: false, reason: '不支持的图片格式（仅支持 PNG/JPEG/WebP/GIF）' }
    const safeName = sanitizeFileName(name)
    try {
      const staged = await this.deps.fileUploads().uploadImageStream({
        sessionId: agent.id,
        data: (async function* () { yield bytes })(),
        mediaType,
        ...(safeName === undefined ? {} : { name: safeName }),
      })
      return { ok: true, block: { type: 'image', attachment: staged.image, receiptId: staged.receiptId } }
    } catch (error) {
      return { ok: false, reason: failureText(error) }
    }
  }

  /**
   * Submit one prompt to a live Agent as its principal.
   * @param agent - the live Agent of the prompt's Session.
   * @param prompt - the prompt.
   * @param mode - `queue` for a new turn, `steer` to join the running turn.
   * @throws the Remote failure of a refused or failed submission
   *   (`remote-access/denied`, `session/attachment-invalid`, `session/not-found`, …);
   *   {@link submissionFailureText} words it for the card.
   */
  async submit(agent: Agent, prompt: ChannelPrompt, mode: 'queue' | 'steer'): Promise<void> {
    const content: PromptContentPart[] = []
    for (const block of prompt.content) content.push(await this.partOf(agent, block))
    const request: SessionPromptRequest = { requestId: prompt.requestId, sessionId: agent.id, mode, content }
    await this.deps.gateway().invoke({
      namespace: SESSION_NAMESPACE,
      method: PROMPT_METHOD,
      args: { request },
      peer: this.deps.peers.peerFor(prompt.principal),
    })
  }

  /** The wire part of one block: text as is, an attachment by a live receipt. */
  private async partOf(agent: Agent, block: PromptBlock): Promise<PromptContentPart> {
    if (block.type === 'text') return { type: 'text', text: block.text }
    const uploads = this.deps.fileUploads()
    if (block.receiptId !== undefined && uploads.resolve(agent, block.receiptId) !== undefined) {
      return { type: 'file', receiptId: block.receiptId }
    }
    const label = block.attachment.name ?? block.attachment.attachmentId
    try {
      return { type: 'file', receiptId: await this.restage(agent, block) }
    } catch (error) {
      this.deps.warn('dsh-channels: re-staging attachment %s for session %s failed: %s', label, agent.id, String(error))
      return { type: 'text', text: `[附件 ${label} 在重启后无法恢复：${failureText(error)}]` }
    }
  }

  /** Stage a durable reference again from the host attachment store. */
  private async restage(agent: Agent, block: Exclude<PromptBlock, { type: 'text' }>): Promise<string> {
    const store = this.deps.attachments()
    const uploads = this.deps.fileUploads()
    const name = block.attachment.name
    if (block.type === 'image') {
      const hostPath = store.imageHostPath(block.attachment)
      if (hostPath === undefined) throw new Error('attachment store is not host-file-backed')
      const bytes = await readFile(hostPath)
      const staged = await uploads.uploadImageStream({
        sessionId: agent.id,
        data: (async function* () { yield new Uint8Array(bytes) })(),
        mediaType: block.attachment.mediaType,
        ...(name === undefined ? {} : { name }),
      })
      return staged.receiptId
    }
    const hostPath = store.fileHostPath(block.attachment)
    if (hostPath === undefined) throw new Error('attachment store is not host-file-backed')
    const bytes = await readFile(hostPath)
    const staged = await uploads.upload(agent, { data: bytes.toString('base64'), name }, new AbortController().signal)
    return staged.receiptId
  }
}

/**
 * Move the queued message of a request out of the Agent's next-turn queue
 * into the running turn's next step (the queued card's 「并入本轮」).
 * @param agent - the running Agent.
 * @param requestId - the prompt's request id.
 * @returns false when no pending message carries the request id (the driver
 *   already claimed it).
 */
export function steerQueued(agent: Agent, requestId: string): boolean {
  for (const queued of agent.inbox.nextTurn) {
    const message = queuedUserMessage(queued)
    if (message === undefined || promptRequestIdOf(message.source) !== requestId) continue
    if (!agent.inbox.remove(message.id)) return false
    agent.steer(message)
    return true
  }
  return false
}

/** The inbox entry as a user message, when it is one (the inbox is typed `unknown`). */
function queuedUserMessage(value: unknown): UserMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const message = value as { id?: unknown; role?: unknown; content?: unknown; source?: unknown }
  const sourced = typeof message.source === 'object' && message.source !== null
    && typeof (message.source as { kind?: unknown }).kind === 'string'
  return typeof message.id === 'string' && message.role === 'user' && Array.isArray(message.content) && sourced
    ? value as UserMessage
    : undefined
}

/**
 * The card notice of a refused or failed submission.
 * @param error - the value `submit` threw.
 * @returns a one-line Chinese reason.
 */
export function submissionFailureText(error: unknown): string {
  const failure = remoteFailureOf(error)
  if (failure === undefined) return `提交失败：${failureText(error)}`
  switch (failure.code) {
    case 'remote-access/denied':
      return reasonOf(failure.details) === ROUTE_NOT_PERMITTED
        ? '你没有权限向这个会话发消息（不是这个话题的发起人，或没有对话准入）'
        : `访问被拒绝：${reasonOf(failure.details) ?? failure.message}`
    case 'session/attachment-invalid':
      return reasonOf(failure.details) === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
        ? '当前模型不支持图片输入；请换一个支持图片的模型，或只发文字'
        : `附件无法提交：${failure.message}`
    case 'session/not-found':
      return '会话已不存在，请重新发起对话'
    case 'session/agent-busy':
      return `提交失败：${reasonOf(failure.details) ?? failure.message}`
    default:
      return `提交失败：${failure.message}（${failure.code}）`
  }
}

function reasonOf(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

function failureText(error: unknown): string {
  const failure = remoteFailureOf(error)
  if (failure !== undefined) return failure.message
  return error instanceof Error ? error.message : String(error)
}

/** The card a turn streams into, as routing hands it over. */
export interface TurnCard {
  /** The already-sent main card (patched in place). */
  readonly cardMessageId: string
  /** The message carrying the Typing → DONE/No reaction; absent for a turn no Feishu message started. */
  readonly triggerMessageId?: string
  /** The Typing reaction to remove, when one was added. */
  readonly reactionId?: string
  /** Called once when the turn's card reaches its final state. */
  readonly onSettled?: (outcome: 'done' | 'stopped' | 'error') => void
}

/** Whether a submission entered the Agent inbox. */
export type SubmissionOutcome =
  | { readonly accepted: true }
  /** Refused or failed; `reason` is the notice the card already shows. */
  | { readonly accepted: false; readonly reason: string }

/**
 * How routing starts a card-bound turn. The service implements it, since it
 * owns the streamer the card is bound to and the submitter the prompt goes
 * through.
 */
export interface TurnSubmission {
  /** Stage one downloaded image for the Session's live Agent; see {@link PromptSubmitter.stageImage}. */
  stageImage(agent: Agent, bytes: Uint8Array, name?: string): Promise<StageImageResult>
  /**
   * Bind `card` to the turn `prompt` starts, then submit the prompt as its
   * principal. A refused or failed submission settles the card with the
   * reason and reports it instead of throwing; the returned promise settles
   * once the prompt entered the Agent inbox (or was refused), so callers
   * serialize turns by awaiting it.
   */
  run(agent: Agent, prompt: ChannelPrompt, card: TurnCard): Promise<SubmissionOutcome>
}
