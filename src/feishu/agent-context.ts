/**
 * Agent-scoped system-prompt guidance for Feishu attachments.
 *
 * The channel archives inbound images/files/forwarded records below
 * `<session working directory>/attachments/` without any model turn. This
 * section is what makes that convention discoverable: it tells the Agent where
 * attachments live, how to read them, and that reading is opt-in per user
 * request.
 *
 * Registered inside the Agent scope (through `inject(['systemPrompt'])`), so
 * it is disposed with the Agent and does not leak into other compositions.
 * It is mounted only after the Session's effective working directory is known
 * (see `SessionManager.mountGuidance`), so the absolute path is accurate even
 * when that directory is a Git worktree created after Agent creation.
 *
 * @module dsh-channels/feishu/agent-context
 */

import type { AgentContext } from '../host/agent.ts'

/** Stable prompt-section name; one registration per Agent scope. */
export const FEISHU_ATTACHMENTS_SECTION = 'dsh-channels:feishu-attachments'

/**
 * Placement between the harness file-reference section (900) and the
 * filesystem tool descriptions (1000): the convention is read before the
 * tool that implements it.
 */
const FEISHU_ATTACHMENTS_ORDER = 950

/** Model-facing text. Kept stable so unchanged sessions keep their KV cache. */
export const FEISHU_ATTACHMENTS_GUIDANCE = `## Feishu attachments
Every Feishu conversation (topic) has its own working directory inside its user's workspace, and every working directory has its own \`attachments/\` directory. Images, files, and forwarded chat records sent through Feishu are archived verbatim in this conversation's \`attachments/\` directory. Each file name starts with its receipt time (\`YYYYMMDD-HHmmss-\`), so newer attachments sort later and \`ls -lt <dir>\` lists the newest first.

Attachments are never inserted into the conversation automatically. Read them only when the user's request needs them, and do not read attachments the user did not mention:
- images: use \`read_image\` with the file path;
- text and code: use \`read\` when the session mounts that tool, otherwise \`bash\` (for example \`sed -n '1,200p' <file>\`);
- other formats (PDF, Office, archives, ...): inspect or convert them with \`bash\`.
If the user refers to "the file/image I just sent" without a name, list this conversation's attachments directory and pick the most recent matching attachment. Other Feishu conversations work in separate directories: never read outside this conversation's working directory, and never mention files from another conversation.`

/**
 * Full guidance for one Session. The absolute per-session directory is
 * appended when known so the convention still resolves after the Agent changes
 * its working directory with the `working_directory` tool.
 */
export function attachmentsGuidance(attachmentsDir?: string): string {
  if (attachmentsDir === undefined || attachmentsDir === '') return FEISHU_ATTACHMENTS_GUIDANCE
  return `${FEISHU_ATTACHMENTS_GUIDANCE}\n\nThis conversation's attachment directory is \`${attachmentsDir.replace(/`/gu, "'")}\` (absolute).`
}

/**
 * Mount the attachment guidance into one Agent scope. Call from agent setup;
 * a missing `systemPrompt` service degrades to a no-op (headless hosts).
 */
export async function mountChannelGuidance(
  agentCtx: AgentContext,
  attachmentsDir?: string,
): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({
      name: FEISHU_ATTACHMENTS_SECTION,
      order: FEISHU_ATTACHMENTS_ORDER,
      text: attachmentsGuidance(attachmentsDir),
    })
  })
}
