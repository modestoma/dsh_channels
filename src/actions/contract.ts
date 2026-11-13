/**
 * Public contract of the `feishuActions` service (version 1) and the
 * `propose_actions` model tool: domain-agnostic, non-blocking follow-up action
 * proposals attached to a Feishu-routed Session.
 *
 * Unlike `approval/request` and `user-questions/request` (which block a live
 * turn while waiting for a human answer), an action proposal is posted as a
 * standalone Feishu Card 2.0 message without holding the turn open. Clicking a
 * button checks channel ownership and `requiredAccess` up front, transitions
 * the durable state atomically, and starts a new follow-up turn as the clicker.
 *
 * @module dsh-channels/actions/contract
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Service name registered on the Cordis context (`ctx.provide('feishuActions', ...)`). */
export const FEISHU_ACTIONS_SERVICE = 'feishuActions' as const

export type FeishuActionsServiceName = typeof FEISHU_ACTIONS_SERVICE

/** Contract version implemented by this package. */
export const FEISHU_ACTIONS_VERSION = 1 as const

export type FeishuActionsVersion = typeof FEISHU_ACTIONS_VERSION

/** Reserved action id used by the automatic trailing dismiss button. */
export const RESERVED_DISMISS_ACTION_ID = 'dismiss' as const

/** Channel access levels an action button may require before waking the Session. */
export const ACTION_ACCESS_LEVELS = ['chat', 'code-write', 'wiki-write', 'admin'] as const

export type ActionAccessLevel = (typeof ACTION_ACCESS_LEVELS)[number]

/** Visual style of a proposal button on the Feishu card. */
export type ActionButtonStyle = 'primary' | 'default'

/** One selectable follow-up action on a proposal card. */
export interface ActionProposalItem {
  /** Unique short identifier within the proposal (1–64 visible ASCII; `'dismiss'` is reserved). */
  readonly id: string
  /** Button label shown on the card (1–32 characters after trimming). */
  readonly label: string
  /** Visual button style: `'primary'` highlights a recommended choice; defaults to `'default'`. */
  readonly style?: ActionButtonStyle
  /**
   * Channel access level verified before waking the Session:
   * - `'chat'` (default): private-chat owner, or admitted member in a group chat
   * - `'code-write'`: `'codeWrite'` switch enabled for the private user or group
   * - `'wiki-write'`: `'wikiWrite'` switch enabled for the private user or group
   * - `'admin'`: administrator in a private chat
   */
  readonly requiredAccess?: ActionAccessLevel
  /** Self-contained follow-up prompt submitted to the Session when clicked (1–8000 characters). */
  readonly followUpPrompt: string
  /**
   * Whether other pending buttons stay clickable after this action is chosen.
   * Defaults to `false` (choosing this action dismisses the remaining pending buttons).
   */
  readonly independent?: boolean
}

/** Input schema shared with the model-facing `propose_actions` tool. */
export interface ProposeActionsInput {
  /** Short plain-text lead shown above the action buttons (1–120 characters after trimming). */
  readonly prompt: string
  /** 1–4 candidate actions; the channel appends a trailing `'暂不处理'` button automatically. */
  readonly actions: readonly ActionProposalItem[]
}

/** Input to {@link FeishuActionsService.propose}. */
export interface ActionProposalSpec extends ProposeActionsInput {
  /** Idempotency key (1–200 visible ASCII characters). */
  readonly key: string
  /** DSH Session ID currently bound to the target Feishu route. */
  readonly sessionId: string
}

/** Failure codes returned by {@link FeishuActionsService.propose}. */
export type ActionProposalFailureCode =
  | 'invalid'
  | 'not-connected'
  | 'unrouted-session'
  | 'send-failed'

/** Outcome of {@link FeishuActionsService.propose}. */
export type ActionProposalPostResult =
  | { readonly ok: true; readonly replayed: boolean; readonly cardMessageId: string }
  | { readonly ok: false; readonly code: ActionProposalFailureCode; readonly message: string }

/** Host service contract exposed as `ctx.get('feishuActions')`. */
export interface FeishuActionsService {
  readonly version: FeishuActionsVersion
  /** Post a standalone follow-up action proposal card into the Session's Feishu topic/chat. */
  propose(spec: ActionProposalSpec): Promise<ActionProposalPostResult>
  /** Mark any remaining pending actions under `key` as superseded and refresh its card. */
  supersede(key: string, reason?: string): Promise<void>
}

// ---- Validation & canonical fingerprinting -------------------------------

/** Visible non-whitespace ASCII identifier (`0x21`–`0x7E`). */
const VISIBLE_ASCII_64 = /^[\x21-\x7E]{1,64}$/u
const VISIBLE_ASCII_200 = /^[\x21-\x7E]{1,200}$/u

export const actionAccessLevelSchema = z.enum(ACTION_ACCESS_LEVELS)

export const actionButtonStyleSchema = z.enum(['primary', 'default'])

export const actionProposalItemSchema = z.object({
  id: z.string()
    .regex(VISIBLE_ASCII_64, 'must be 1-64 visible ASCII characters')
    .refine(id => id !== RESERVED_DISMISS_ACTION_ID, `action id "${RESERVED_DISMISS_ACTION_ID}" is reserved`),
  label: z.string().trim().min(1, 'must not be blank').max(32, 'must be at most 32 characters'),
  style: actionButtonStyleSchema.optional(),
  requiredAccess: actionAccessLevelSchema.optional(),
  followUpPrompt: z.string().trim().min(1, 'must not be blank').max(8_000, 'must be at most 8000 characters'),
  independent: z.boolean().optional(),
}).strict()

export const proposeActionsInputSchema = z.object({
  prompt: z.string().trim().min(1, 'must not be blank').max(120, 'must be at most 120 characters'),
  actions: z.array(actionProposalItemSchema)
    .min(1, 'must include at least 1 action')
    .max(4, 'must include at most 4 actions')
    .superRefine((items, ctx) => {
      const seen = new Set<string>()
      for (let index = 0; index < items.length; index += 1) {
        const id = items[index]!.id
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: `duplicate action id "${id}"`,
          })
        }
        seen.add(id)
      }
    }),
}).strict()

export const actionProposalIdempotencyKeySchema = z.string()
  .regex(VISIBLE_ASCII_200, 'must be 1-200 visible ASCII characters')

export const actionProposalSpecSchema = proposeActionsInputSchema.extend({
  key: actionProposalIdempotencyKeySchema,
  sessionId: z.string().trim().min(1, 'must not be blank').max(200, 'must be at most 200 characters'),
}).strict()

export type ValidatedProposeActionsInput = z.infer<typeof proposeActionsInputSchema>
export type ValidatedActionProposalSpec = z.infer<typeof actionProposalSpecSchema>

/**
 * Deterministic SHA-256 content fingerprint of a validated proposal spec
 * (excluding `key`), normalizing optional fields to their effective defaults
 * so idempotent retries match while divergent specs under the same key fail.
 */
export function fingerprintProposalSpec(spec: ValidatedActionProposalSpec): string {
  const canonical = {
    sessionId: spec.sessionId,
    prompt: spec.prompt,
    actions: spec.actions.map(item => ({
      id: item.id,
      label: item.label,
      style: item.style ?? 'default',
      requiredAccess: item.requiredAccess ?? 'chat',
      followUpPrompt: item.followUpPrompt,
      independent: item.independent ?? false,
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
