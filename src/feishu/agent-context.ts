/**
 * Agent-scoped system-prompt guidance for Feishu attachments.
 *
 * Which guidance is mounted follows the *effective* attachment backend
 * (`attachmentStore`, decisions D6/D2):
 * - `native` (the default): inbound images/files live in the DSH native
 *   attachment library. Trigger-message images are prefetched and already
 *   visible; files stay unloaded and the prompt carries a stable
 *   `<feishu_context>` manifest (see `manifest.ts`) that the Agent uses with the
 *   `feishu_attachment_fetch` tool on demand.
 * - `archive` (legacy / fallback): inbound images/files are archived below
 *   `<session working directory>/attachments/` and read with filesystem tools.
 *   Kept for explicit `attachmentStore: 'archive'` deployments and for native
 *   deployments whose host does not mount `ctx.attachments`.
 *
 * Registered inside the Agent scope (through `inject(['systemPrompt'])`), so it
 * is disposed with the Agent and does not leak into other compositions. The
 * archive flavor is mounted only after the Session's effective working
 * directory is known (see `SessionManager.mountGuidance`), so its absolute path
 * is accurate even when that directory is a Git worktree created after Agent
 * creation.
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

/** Attachment backend whose guidance to mount; mirrors `attachmentStore`. */
export type AttachmentGuidanceMode = 'native' | 'archive'

/**
 * Native-library guidance (new default). Model-facing text kept stable so
 * unchanged sessions keep their KV cache.
 */
export const FEISHU_ATTACHMENTS_NATIVE_GUIDANCE = `## Feishu attachments
Inbound Feishu images and files are stored in the DSH native attachment library and are tied to this conversation's session; they are not copied into the working directory automatically.

- Images that arrived in the message which triggered this turn are already visible to you as image blocks. Never load them again.
- Files are not loaded by default: the conversation only carries their metadata, not their bytes.
- The user message may carry a manifest in a \`<${FEISHU_CONTEXT_TAG}>\` block. It lists attachments that are not loaded yet, each with its message_id, type, and, when known, file_key and file name. A line with type=merge_forward is a forwarded-chat container: use its message_id without file_key. An image that could not be prefetched is listed the same way as a file.
- The user message may also carry \`<feishu_quote>\` (the message this one replies to) and, on a new session's first turn, \`<feishu_history>\` (bounded recent topic messages). Attachments named there are not loaded; fetch one with \`feishu_attachment_fetch\` using the message_id shown on its line.
- Use the \`feishu_topic_messages\` tool to read a quoted message in full, or to page through earlier messages of this topic (newest first, limit/cursor). Messages and attachments it returns are authorized for \`feishu_attachment_fetch\`.

When the user's request genuinely needs an attachment, fetch it with the \`feishu_attachment_fetch\` tool: pass message_id, and add file_key to fetch one specific file of that message. Fetch nothing when the request can be answered without the bytes, and do not proactively enumerate or fetch attachments the user did not mention.

A fetched file is an immutable, read-only copy in the native attachment library. Before changing it, copy it into the working directory and modify the copy. Only access attachments of this conversation; never read or mention another conversation's attachments.`

/**
 * Legacy archive guidance: attachments are archived under the conversation
 * workspace's `attachments/` directory and read through filesystem tools.
 * Model-facing text kept stable so unchanged sessions keep their KV cache.
 */
export const FEISHU_ATTACHMENTS_ARCHIVE_GUIDANCE = `## Feishu attachments
Every Feishu conversation (topic) has its own working directory inside its user's workspace, and every working directory has its own \`attachments/\` directory. Images, files, and forwarded chat records sent through Feishu are archived verbatim in this conversation's \`attachments/\` directory. Each file name starts with its receipt time (\`YYYYMMDD-HHmmss-\`), so newer attachments sort later and \`ls -lt <dir>\` lists the newest first.

Attachments are never inserted into the conversation automatically. Read them only when the user's request needs them, and do not read attachments the user did not mention:
- images: use \`read_image\` with the file path;
- text and code: use \`read\` when the session mounts that tool, otherwise \`bash\` (for example \`sed -n '1,200p' <file>\`);
- other formats (PDF, Office, archives, ...): inspect or convert them with \`bash\`.
If the user refers to "the file/image I just sent" without a name, list this conversation's attachments directory and pick the most recent matching attachment. Other Feishu conversations work in separate directories: never read outside this conversation's working directory, and never mention files from another conversation.

A message may also carry \`<feishu_quote>\` / \`<feishu_history>\` text excerpts. Attachments named there arrive lazily and are not in this directory in this deployment; describe what the excerpt says instead of claiming to have read the file.`

/**
 * Full guidance text for one Session.
 *
 * The native flavor ignores `attachmentsDir` (there is no per-conversation
 * directory to name). The archive flavor appends the absolute per-session
 * directory when known so the convention still resolves after the Agent changes
 * its working directory with the `working_directory` tool.
 */
export function attachmentsGuidance(
  mode: AttachmentGuidanceMode = 'native',
  attachmentsDir?: string,
): string {
  if (mode !== 'archive') return FEISHU_ATTACHMENTS_NATIVE_GUIDANCE
  if (attachmentsDir === undefined || attachmentsDir === '') return FEISHU_ATTACHMENTS_ARCHIVE_GUIDANCE
  return `${FEISHU_ATTACHMENTS_ARCHIVE_GUIDANCE}\n\nThis conversation's attachment directory is \`${attachmentsDir.replace(/`/gu, "'")}\` (absolute).`
}

/**
 * Mount the attachment guidance into one Agent scope. Call from agent setup;
 * a missing `systemPrompt` service degrades to a no-op (headless hosts).
 */
export async function mountChannelGuidance(
  agentCtx: AgentContext,
  mode: AttachmentGuidanceMode = 'native',
  attachmentsDir?: string,
): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({
      name: FEISHU_ATTACHMENTS_SECTION,
      order: FEISHU_ATTACHMENTS_ORDER,
      text: attachmentsGuidance(mode, attachmentsDir),
    })
  })
}
