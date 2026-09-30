/**
 * Host bridge, human-command surface (`ctx.commands`).
 *
 * @module dsh-channels/host/commands
 */

import type { Agent } from './agent.ts'
import type { CommandId } from './core.ts'

// ---- Human-command surface ---------------------------------------------

export interface CommandInputDescriptor {
  readonly hint: string
}

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandExecution {
  readonly commandId: CommandId
  readonly result: CommandResult
}

export interface CommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: CommandInputDescriptor
}

export interface CommandInvocation {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}

export interface CommandDefinition extends CommandDescriptor {
  readonly recordInput?: boolean
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Exact wire image input accepted by the Host command runtime. */
export interface EncodedImageAttachment {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
}

/** Minimal structural bridge to `@deepseek-ai/dsh-commands`' runtime. */
export interface CommandRuntime {
  register(definition: CommandDefinition): () => void
  list(agent: Agent): readonly CommandDescriptor[]
  find(agent: Agent, name: string): CommandDefinition | undefined
  execute(
    agent: Agent,
    line: string,
    images: readonly EncodedImageAttachment[],
    signal: AbortSignal,
  ): Promise<CommandExecution | undefined>
}

/** Agent-scoped Cordis context slice used to register scoped commands. */
