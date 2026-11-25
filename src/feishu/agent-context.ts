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
 * {@link FEISHU_DELIVERY_SECTION} replaces the host's Web file-delivery text
 * in every Feishu Session: results go into the reply or are sent as files.
 * A private-chat projects-mode Session also gets {@link FEISHU_PROJECT_SECTION}:
 * its own directory, the person's `shared/` directory, and for the main
 * Session where work that needs the full toolset goes.
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
- Keep it short: usually one to three sentences. Leave out plans, process narration, file paths, commands, test counts and library choices unless the person asked for them; put technical detail in the merge request description.
- When the person asked for an analysis, investigation or report, the reply carries its conclusion and key findings, not a pointer to where they are stored; deliver the full report into the chat as described in "Delivering results in Feishu".
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

/**
 * Name of the host's Web file-delivery section. A Feishu Session registers
 * its own section under this name: an Agent-scoped section shadows the
 * same-named global one, so the Web text (link full paths, file cards) never
 * reaches a Feishu Session.
 */
export const FEISHU_DELIVERY_SECTION = 'ui:deliverable-file-references'

/** Host section-order slot of {@link FEISHU_DELIVERY_SECTION}, used when the registry does not resolve slot names. */
const FEISHU_DELIVERY_ORDER = 9000

/** Host section-order slot name of {@link FEISHU_DELIVERY_SECTION}. */
const FEISHU_DELIVERY_ORDER_NAME = 'DELIVERABLE_FILE_REFERENCES'

/** The settings {@link deliveryGuidance} reads. */
export interface DeliverySettings {
  /** `feishu_send_file` is mounted (`feishuTools.sendFile`). */
  readonly sendFile: boolean
  /** `feishuTools.autoSendFiles`. */
  readonly autoSendFiles: 'mentioned' | 'presented' | 'off'
  /** `feishuTools.inlineMarkdownChars`. */
  readonly inlineMarkdownChars: number
}

/**
 * How a Feishu Session hands results to the person: in the reply, or as files
 * sent into the chat, never as a path. Model-facing text stays stable for a
 * given configuration so unchanged sessions keep their KV cache.
 * @param settings - the current delivery settings.
 * @returns the section text.
 */
export function deliveryGuidance(settings: DeliverySettings): string {
  const lines = [
    '## Delivering results in Feishu',
    'The person sees your work only in this Feishu chat. They cannot open paths on this machine, links to local files, or the working directory, so a file path alone delivers nothing.',
    '',
    '- Put the result itself in your final reply: the conclusion, the key findings, and a table when it helps. Refer to a file by its file name, never by its full path.',
  ]
  if (!settings.sendFile) {
    lines.push('- Files cannot be sent in this conversation. When the person needs a file\'s content, put that content in your reply.')
    return lines.join('\n')
  }
  lines.push('- When the person needs a whole file (a report, spreadsheet, slide deck, image or archive), send it to the chat with `feishu_send_file` once it is final, then say in one sentence what it holds.')
  if (settings.inlineMarkdownChars > 0) {
    lines.push(`- A Markdown file of at most ${settings.inlineMarkdownChars} characters sent this way also appears in the chat as readable text, so write reports as Markdown.`)
  }
  if (settings.autoSendFiles === 'mentioned') {
    lines.push('- After your turn, a file your final reply names that you have not sent yet is sent automatically when it is in the shared directory, or when you created or changed it during the turn.')
  }
  return lines.join('\n')
}

/**
 * Mount the Feishu delivery guidance into one Agent scope, shadowing the
 * host's Web file-delivery section. The text is resolved on every model
 * request. A missing `systemPrompt` service degrades to a no-op (headless hosts).
 * @param agentCtx - the Agent scope the section is registered in.
 * @param settings - reads the current delivery settings.
 */
export async function mountDeliveryGuidance(agentCtx: AgentContext, settings: () => DeliverySettings): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    const prompt = ctx.systemPrompt
    if (prompt === undefined) return
    let order = FEISHU_DELIVERY_ORDER
    try {
      order = prompt.getSectionOrder?.(FEISHU_DELIVERY_ORDER_NAME) ?? order
    } catch {
      // A host without this slot name has no Web section to shadow either; the fixed value only places the text.
    }
    prompt.section({ name: FEISHU_DELIVERY_SECTION, order, text: () => deliveryGuidance(settings()) })
  })
}

/** Stable prompt-section name of the private-chat projects-mode guidance; one registration per Agent scope. */
export const FEISHU_PROJECT_SECTION = 'dsh-channels:feishu-project'

/** Placement right after the reply guidance (960). */
const FEISHU_PROJECT_ORDER = 970

/**
 * Projects-mode guidance for one Session: where it works, what it may read,
 * and (main Session) where work that needs more tools goes. The text names
 * the Session's directories, which never change for a route, so it stays
 * stable for the KV cache.
 * @param role - main Session or topic.
 * @param ownDir - the Session's own directory.
 * @param sharedDir - the person's shared directory.
 * @returns the section text.
 */
export function projectGuidance(role: 'main' | 'topic', ownDir: string, sharedDir: string): string {
  if (role === 'main') {
    return `## Feishu private chat: main conversation
This is the person's main conversation with you in a Feishu private chat. It stays one ongoing session; deeper work happens in topics, each with its own session.

- Your working directory is ${ownDir}. You can read it and the person's shared directory ${sharedDir}; the topics' directories are not visible to you.
- Here you talk, read, search and look things up. Running commands, writing files and changing code are not available in this conversation.
- Reply as in a chat. When a request needs tools or several steps, first write one or two short sentences saying what you understood and what you will do, then call the tools; the person sees each piece of text as soon as you write it. Answer simple questions directly and briefly.
- When the person asks for a file from ${sharedDir}, or a topic's summary names one they should see, send it with \`feishu_send_file\` instead of naming its path.
- Open a topic with \`feishu_topic_open\` when a request needs those tools, several investigation steps, or more than a few minutes of focused work. Write the brief so the topic can work without this conversation: background, goal, known facts, constraints, expected output. Then tell the person in one sentence which topic you opened, and end your turn; do not wait for the topic. Answer quick questions yourself instead of opening a topic.
- The person can also open a topic by replying in a topic (Feishu 「回复话题」) on any message.
- After a topic's turn its summary reaches you in a \`<dm_topic_updates>\` block on the person's next message. Use \`feishu_topic_list\` for an overview, \`feishu_topic_read\` for a topic's latest replies, and \`feishu_topic_send\` to pass a follow-up request into an existing topic instead of opening a duplicate.
- Results that topics put in ${sharedDir} are readable here.`
  }
  return `## Feishu private chat: topic
This session is one topic of the person's Feishu private chat. The person's main conversation and their other topics are separate sessions.

- Your working directory is ${ownDir}. You can access it and the person's shared directory ${sharedDir}, and nothing of the other topics or the main conversation.
- Save deliverables the person or other topics will reuse (reports, exported files, summaries) in ${sharedDir}; keep scratch work in your own directory. Saving a file there does not show it to the person: deliver it into this topic as described in "Delivering results in Feishu".
- The person's main conversation learns about this topic only from a summary. End every final reply with this block, keeping its four labels exactly as written:

小结
做了：<what you did this turn>
结果：<the outcome itself, such as the conclusion; never only where a file is stored>
需要你：<what the person must decide or do, or 无>`
}

/**
 * Mount the projects-mode guidance into one Agent scope. A missing
 * `systemPrompt` service degrades to a no-op (headless hosts).
 * @param agentCtx - the Agent scope the section is registered in.
 * @param text - the section text ({@link projectGuidance}).
 */
export async function mountProjectGuidance(agentCtx: AgentContext, text: string): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({ name: FEISHU_PROJECT_SECTION, order: FEISHU_PROJECT_ORDER, text })
  })
}
