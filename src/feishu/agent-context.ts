/**
 * Agent-scoped system-prompt guidance for Feishu attachments.
 *
 * Inbound images/files live in the DSH native attachment library.
 * Trigger-message images are prefetched and already visible; files stay
 * unloaded and the prompt carries a stable `<feishu_context>` manifest (see
 * `manifest.ts`) that the Agent uses with the `feishu_attachment_fetch` tool on
 * demand.
 *
 * Registered inside the Agent scope (through `inject(['systemPrompt'])`), so it
 * is disposed with the Agent and does not leak into other compositions.
 *
 * The same module mounts the Feishu reply guidance
 * ({@link FEISHU_REPLIES_SECTION}): how a final reply reads in a chat card.
 * It applies to every Feishu Session, and its `replyGuidance` switch is read on every model request.
 *
 * @module dsh-channels/feishu/agent-context
 */

import type { AgentContext } from '../host/agent.ts'
import { FEISHU_CONTEXT_TAG } from './manifest.ts'

/** Stable prompt-section name; one registration per Agent scope. */
export const FEISHU_ATTACHMENTS_SECTION = 'dsh-channels:feishu-attachments'

/**
 * Placement between the harness file-reference section (900) and the
 * filesystem tool descriptions (1000): the convention is read before the
 * tool that implements it.
 */
const FEISHU_ATTACHMENTS_ORDER = 950

/**
 * Attachment guidance. Model-facing text kept stable so unchanged sessions
 * keep their KV cache.
 */
export const FEISHU_ATTACHMENTS_GUIDANCE = `## Feishu attachments
Inbound Feishu images and files are stored in the DSH native attachment library and are tied to this conversation's session; they are not copied into the working directory automatically.

- Images that arrived in the message which triggered this turn are already visible to you as image blocks. Never load them again.
- Files are not loaded by default: the conversation only carries their metadata, not their bytes.
- The user message may carry a manifest in a \`<${FEISHU_CONTEXT_TAG}>\` block. It lists attachments that are not loaded yet, each with its message_id, type, and, when known, file_key and file name. A line with type=merge_forward is a forwarded-chat container: use its message_id without file_key. An image that could not be prefetched is listed the same way as a file.
- The user message may also carry \`<feishu_quote>\` (the message this one replies to) and, on a new session's first turn, \`<feishu_history>\` (bounded recent topic messages). Attachments named there are not loaded; fetch one with \`feishu_attachment_fetch\` using the message_id shown on its line.
- Use the \`feishu_topic_messages\` tool to read a quoted message in full, or to page through earlier messages of this topic (newest first, limit/cursor). Messages and attachments it returns are authorized for \`feishu_attachment_fetch\`.

When the user's request genuinely needs an attachment, fetch it with the \`feishu_attachment_fetch\` tool: pass message_id, and add file_key to fetch one specific file of that message. Fetch nothing when the request can be answered without the bytes, and do not proactively enumerate or fetch attachments the user did not mention.

Never read, copy, or print Feishu app credentials (for example files under the DSH home directory) and never call the Feishu OpenAPI directly with them; use only the Feishu tools provided in this conversation.

A fetched file is an immutable, read-only copy in the native attachment library. Before changing it, copy it into the working directory and modify the copy. Only access attachments of this conversation; never read or mention another conversation's attachments.`

/**
 * Mount the attachment guidance into one Agent scope. Call from agent setup;
 * a missing `systemPrompt` service degrades to a no-op (headless hosts).
 */
export async function mountChannelGuidance(agentCtx: AgentContext): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({
      name: FEISHU_ATTACHMENTS_SECTION,
      order: FEISHU_ATTACHMENTS_ORDER,
      text: FEISHU_ATTACHMENTS_GUIDANCE,
    })
  })
}

/** Stable prompt-section name of the Feishu reply guidance; one registration per Agent scope. */
export const FEISHU_REPLIES_SECTION = 'dsh-channels:feishu-replies'

/** Placement right after the attachment guidance (950). */
const FEISHU_REPLIES_ORDER = 960

/**
 * How a final reply reads in a Feishu chat card. The card already streams
 * progress, tool calls and reasoning, so the guidance only shapes the reply
 * text. Model-facing text kept stable so unchanged sessions keep their KV cache.
 */
export const FEISHU_REPLIES_GUIDANCE = `## Replying in Feishu
Your reply appears in a Feishu chat card. The card already shows your progress, tool calls and reasoning, so the final reply is only for what the person needs now.

- Lead with the result: what is done and usable, with a clickable Markdown link (for example the merge request). Then add only a next step the person must take, or a limitation that changes what they can do.
- Keep it short: usually one to three sentences. Leave out plans, process narration, file paths, commands, test counts and library choices unless the person asked for them; put technical detail in the merge request description or a file.
- Be honest about state. An opened merge request is not a finished or merged change; mark a draft as unfinished; report a failure as a failure.
- When you need a decision, ask one concrete question with ask_user_question instead of burying it in a long reply. Do not ask permission for work already requested.
- Reply in the language of the person's message.
- In group chats others can read the reply: never repeat content from direct messages or other conversations.
- Examples in instructions show format only; never state a fact you have not verified.`

/**
 * Mount the Feishu reply guidance into one Agent scope. The section text is
 * resolved on every model request, so turning `replyGuidance` off or on
 * applies to the next request without a new Session. A missing
 * `systemPrompt` service degrades to a no-op (headless hosts).
 * @param agentCtx - the Agent scope the section is registered in.
 * @param enabled - reads the current `replyGuidance` switch.
 */
export async function mountReplyGuidance(agentCtx: AgentContext, enabled: () => boolean): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({
      name: FEISHU_REPLIES_SECTION,
      order: FEISHU_REPLIES_ORDER,
      text: () => enabled() ? FEISHU_REPLIES_GUIDANCE : '',
    })
  })
}
