/**
 * Card JSON 2.0 primitives shared by every card this plugin renders.
 *
 * One envelope + one element vocabulary keeps the byte budget, the width
 * mode and the callback shape in a single place; card modules only describe
 * their content.
 *
 * @module dsh-channels/cards/primitives
 */

/** Feishu card JSON schema version this plugin targets. */
export const CARD_SCHEMA = '2.0'

/** Default card config: full-width cards in the chat pane. */
export const CARD_CONFIG: Record<string, unknown> = { width_mode: 'fill' }

/** Wrap elements in a card 2.0 envelope. */
export function card(elements: object[], config: Record<string, unknown> = CARD_CONFIG): object {
  return { schema: CARD_SCHEMA, config, body: { elements } }
}

/** Markdown element with optional presentation fields (`text_size`, …). */
export function markdown(content: string, extra: Record<string, unknown> = {}): object {
  return { tag: 'markdown', content, ...extra }
}

/** Small notation-size markdown, used for hints and footers. */
export function note(content: string): object {
  return markdown(content, { text_size: 'notation' })
}

/** Horizontal divider. */
export function divider(): object {
  return { tag: 'hr' }
}

export interface TextButtonOptions {
  label: string
  /** Callback payload carried back by `card.action.trigger`. */
  value: unknown
  type?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  width?: 'fill' | 'default'
  margin?: string
}

/** One callback button (`behaviors[0].value` is the plugin's action object). */
export function textButton(options: TextButtonOptions): object {
  return {
    tag: 'button',
    type: options.type ?? 'default',
    width: options.width ?? 'fill',
    margin: options.margin ?? '4px 0 0 0',
    ...(options.disabled === true ? { disabled: true } : {}),
    text: { tag: 'plain_text', content: options.label },
    behaviors: [{ type: 'callback', value: options.value }],
  }
}

/** A row of equal-width columns, each holding one element. */
export function columnSet(
  columns: object[],
  options: { flexMode?: string; spacing?: string; margin?: string } = {},
): object {
  return {
    tag: 'column_set',
    flex_mode: options.flexMode ?? 'bisect',
    horizontal_spacing: options.spacing ?? 'medium',
    margin: options.margin ?? '4px 0 0 0',
    columns: columns.map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })),
  }
}

/** Titled standalone card: bold title element followed by the body elements. */
export function standaloneCard(title: string, elements: object[], config?: Record<string, unknown>): object {
  return card([markdown(title), ...elements], config)
}

/** Titled card whose body is one markdown element per supplied line. */
export function standaloneInfoCard(title: string, lines: readonly string[]): object {
  return standaloneCard(title, lines.map(line => markdown(line)))
}
