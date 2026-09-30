/**
 * Host bridge, human-interaction surface: the `approval/request` waterfall
 * (HITL approvals) and the `user-questions/request` waterfall
 * (`ask_user_question`).
 *
 * @module dsh-channels/host/interaction
 */

import type { Agent } from './agent.ts'

// ---- Approval (HITL) surface --------------------------------------------

/**
 * Closed approval outcomes, mirrored from
 * `@deepseek-ai/dsh-user-approval/types`: a one-shot grant, explicit
 * rejection, withdrawn request, or unavailable answerer. Callers fail closed
 * on anything but `allowed-once`; a missing answerer yields `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Readonly same-process permission question (the payload of the host's
 * `approval/request` waterfall event). `callId` links to an already-presented
 * tool call; the plugin only renders `toolName` + `reason` on its decision
 * card and does not duplicate tool arguments.
 */
export interface ApprovalRequest {
  /** The agent on whose behalf the question is asked (routes + audit). */
  readonly agent: Agent
  /** The tool the question is about (model-facing name, e.g. `bash`). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Localized presentation-only text (DSH 0.2.0). Preferred over `reason`
   * when rendering; never part of the durable audit trail.
   */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /**
   * Aborting withdraws the question: the request settles `'cancelled'` and a
   * late answer is discarded.
   */
  readonly signal?: AbortSignal
}

/**
 * One `approval/request` waterfall listener: return an outcome to claim the
 * request, or delegate by returning `next()`. The first claim occupies the
 * single decision slot.
 */
export type ApprovalAnswererListener = (
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>


// ---- Structured user questions -------------------------------------------

/** One selectable answer offered by `ask_user_question`. */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

/** One question in a `user-questions/request` waterfall payload. */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string; callId?: string }
}

export interface AskUserQuestionRequestEvent {
  questions: AskUserQuestionItem[]
  /** Owner agent; present for every agent-originated ask. */
  agent?: Agent
  signal?: AbortSignal
  wait?: { callId: string; timed?: boolean }
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

export type UserQuestionAnswererListener = (
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>


