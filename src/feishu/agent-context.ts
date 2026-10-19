/**
 * Agent-scoped system-prompt guidance for Feishu attachments.
 *
 * The channel archives inbound images/files/forwarded records below
 * `<workspace>/attachments/` without any model turn. This section is what
 * makes that convention discoverable: it tells the Agent where attachments
 * live, how to read them, and that reading is opt-in per user request.
 *
 * Registered inside the Agent scope (through `inject(['systemPrompt'])`), so
 * it is disposed with the Agent and does not leak into other compositions.
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
Images, files, and forwarded chat records sent through Feishu are archived verbatim under the \`attachments/\` directory of the current working directory. Each file name starts with its receipt time (\`YYYYMMDD-HHmmss-\`), so newer attachments sort later and \`ls -lt attachments/\` lists the newest first.

Attachments are never inserted into the conversation automatically. Read them only when the user's request needs them, and do not read attachments the user did not mention:
- images: use \`read_image\` with the file path;
- text and code: use \`read\` when the session mounts that tool, otherwise \`bash\` (for example \`sed -n '1,200p' <file>\`);
- other formats (PDF, Office, archives, ...): inspect or convert them with \`bash\`.
If the user refers to "the file/image I just sent" without a name, list the directory and pick the most recent matching attachment.`

/**
 * Full guidance for one Session. The absolute workspace path is appended when
 * known so the convention still resolves after the Agent changes its working
 * directory with the `working_directory` tool.
 */
export function attachmentsGuidance(workspacePath?: string): string {
  if (workspacePath === undefined || workspacePath === '') return FEISHU_ATTACHMENTS_GUIDANCE
  return `${FEISHU_ATTACHMENTS_GUIDANCE}\n\nThe archive directory for this session is \`${workspacePath.replace(/`/gu, "'")}/attachments/\` (absolute).`
}

/**
 * Mount the attachment guidance into one Agent scope. Call from agent setup;
 * a missing `systemPrompt` service degrades to a no-op (headless hosts).
 */
export async function mountChannelGuidance(
  agentCtx: AgentContext,
  workspacePath?: string,
): Promise<void> {
  await agentCtx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt?.section({
      name: FEISHU_ATTACHMENTS_SECTION,
      order: FEISHU_ATTACHMENTS_ORDER,
      text: attachmentsGuidance(workspacePath),
    })
  })
}
