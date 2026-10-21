/**
 * Command picker cards: `/model`, `/effort` and `/permissions` without
 * arguments answer with clickable choices instead of ids to retype.
 *
 * A click carries the command and its argument back to the service, which
 * runs it exactly like the typed `/<command> <arg>` line, so admission,
 * ownership and validation stay in one place.
 *
 * @module dsh-channels/cards/picker
 */

import { columnSet, divider, markdown, note, standaloneCard, textButton } from './primitives.ts'

/** `decision` carried by every picker button. */
export const PICK_ACTION = 'command-pick'

/** Commands that answer their bare form with a picker card. */
export const PICKER_COMMANDS = ['model', 'effort', 'permissions'] as const
export type PickerCommand = typeof PICKER_COMMANDS[number]

/** Cap on rendered choices so one picker cannot approach the card budget. */
export const MAX_PICKER_OPTIONS = 12

/** Callback value of one picker button. */
export interface PickAction {
  decision: typeof PICK_ACTION
  command: PickerCommand
  /** Argument appended to the command line (`/model <arg>`). */
  arg: string
  /** Session the picker was rendered for; a rebound topic makes it stale. */
  sessionId: string
}

/** One selectable choice. */
export interface PickerOption {
  label: string
  /** Command argument; never contains whitespace. */
  arg: string
}

/** One picker card's render input. */
export interface PickerCardInput {
  title: string
  command: PickerCommand
  /** Markdown shown above the choices (the command's own text answer). */
  text: string
  sessionId: string
  options: readonly PickerOption[]
  /** `arg` of the active choice, rendered highlighted. */
  current?: string
  /** Add a 恢复默认 button that runs `/<command> reset`. */
  reset?: boolean
}

function pickButton(input: PickerCardInput, label: string, arg: string): object {
  const active = arg === input.current
  const value: PickAction = { decision: PICK_ACTION, command: input.command, arg, sessionId: input.sessionId }
  return textButton({
    label: active ? `✅ ${label}` : label,
    type: active ? 'primary' : 'default',
    width: 'fill',
    margin: '0px',
    value,
  })
}

/** Choices in two-column rows. */
function optionRows(input: PickerCardInput, options: readonly PickerOption[]): object[] {
  const rows: object[] = []
  for (let index = 0; index < options.length; index += 2) {
    const pair = options.slice(index, index + 2).map(option => pickButton(input, option.label, option.arg))
    rows.push(columnSet(pair))
  }
  return rows
}

/** Whether a value can be appended to a command line as one argument. */
export function isPickerArg(value: string): boolean {
  return value !== '' && !/\s/u.test(value)
}

/**
 * The picker card. Options whose argument cannot form one command-line token
 * are skipped; when more than `MAX_PICKER_OPTIONS` remain the rest are
 * reported as typed-only.
 */
export function buildPickerCard(input: PickerCardInput): object {
  const usable = input.options.filter(option => isPickerArg(option.arg))
  const shown = usable.slice(0, MAX_PICKER_OPTIONS)
  const elements: object[] = [markdown(input.text), ...optionRows(input, shown)]
  if (usable.length > shown.length) {
    elements.push(note(`另有 ${usable.length - shown.length} 项未展示，可直接输入 /${input.command} <id>。`))
  }
  if (input.reset === true) {
    elements.push(textButton({
      label: '恢复默认',
      value: { decision: PICK_ACTION, command: input.command, arg: 'reset', sessionId: input.sessionId } satisfies PickAction,
    }))
  }
  elements.push(divider())
  elements.push(note(`点击即切换 · 仅发起该会话的用户可操作 · 🔑 ${input.sessionId}`))
  return standaloneCard(`**${input.title}**`, elements)
}

/** Parse a card action value into a picker action; undefined for anything else. */
export function parsePickAction(value: unknown): PickAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.decision !== PICK_ACTION) return undefined
  const { command, arg, sessionId } = record
  if (typeof command !== 'string' || !(PICKER_COMMANDS as readonly string[]).includes(command)) return undefined
  if (typeof arg !== 'string' || !isPickerArg(arg)) return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return { decision: PICK_ACTION, command: command as PickerCommand, arg, sessionId }
}
