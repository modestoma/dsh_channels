/**
 * Feishu wiki (知识库) link parsing: the `wikiRoots` allow-list entries and
 * the document references the model passes to the wiki tools.
 *
 * Pure module: no I/O. Hosts are not checked because tenants use their own
 * subdomains (`<tenant>.feishu.cn`) and the API never uses the link host.
 *
 * @module dsh-channels/feishu/wiki/links
 */

/** Feishu wiki space id: decimal digits. */
const SPACE_ID_PATTERN = /^\d{1,32}$/u

/** Feishu wiki node / docx token: letters and digits. */
const TOKEN_PATTERN = /^[A-Za-z0-9]{8,64}$/u

/** One configured `wikiRoots` entry. */
export type WikiRoot =
  | {
    /** A whole wiki space (`/wiki/space/<space_id>`). */
    readonly kind: 'space'
    readonly spaceId: string
    /** The link as configured. */
    readonly link: string
  }
  | {
    /** One wiki node and every node below it (`/wiki/<node_token>`). */
    readonly kind: 'node'
    readonly nodeToken: string
    /** The link as configured. */
    readonly link: string
  }

/** Why a `wikiRoots` entry was rejected. */
export type WikiRootLinkError =
  | 'not-a-url'
  | 'not-https'
  | 'not-a-wiki-link'

/** Readable reasons for {@link WikiRootLinkError}. */
export const WIKI_ROOT_LINK_ERRORS: Readonly<Record<WikiRootLinkError, string>> = {
  'not-a-url': '不是有效的链接',
  'not-https': '必须是 https 链接',
  'not-a-wiki-link': '只支持知识空间链接 https://<租户>.feishu.cn/wiki/space/<space_id> 或节点链接 https://<租户>.feishu.cn/wiki/<node_token>',
}

/**
 * Parse one `wikiRoots` entry.
 *
 * @param link Link as configured (surrounding whitespace is ignored).
 * @returns The root, or the reason it is invalid.
 */
export function parseWikiRootLink(link: string): { ok: true; root: WikiRoot } | { ok: false; error: WikiRootLinkError } {
  const trimmed = link.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Unparseable input: reported as a configuration error below.
    return { ok: false, error: 'not-a-url' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not-https' }
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments[0] !== 'wiki') return { ok: false, error: 'not-a-wiki-link' }
  if (segments.length === 3 && segments[1] === 'space' && SPACE_ID_PATTERN.test(segments[2]!)) {
    return { ok: true, root: { kind: 'space', spaceId: segments[2]!, link: trimmed } }
  }
  if (segments.length === 2 && segments[1] !== 'space' && TOKEN_PATTERN.test(segments[1]!)) {
    return { ok: true, root: { kind: 'node', nodeToken: segments[1]!, link: trimmed } }
  }
  return { ok: false, error: 'not-a-wiki-link' }
}

/**
 * Parse every configured root. Callers validate the config first, so an
 * invalid entry here is a programming error.
 *
 * @param links Validated `wikiRoots` entries.
 * @returns The parsed roots, in configuration order.
 */
export function parseWikiRoots(links: readonly string[]): WikiRoot[] {
  return links.map((link) => {
    const parsed = parseWikiRootLink(link)
    if (!parsed.ok) throw new Error(`dsh-channels: invalid wikiRoots entry ${link}: ${WIKI_ROOT_LINK_ERRORS[parsed.error]}`)
    return parsed.root
  })
}

/** A document or node the model names: a wiki node, a docx, or a whole space. */
export type WikiRef =
  | { readonly kind: 'node'; readonly token: string }
  | { readonly kind: 'docx'; readonly token: string }
  | { readonly kind: 'space'; readonly spaceId: string }

/**
 * Parse a model-supplied reference: a wiki node link, a docx link, a space
 * link, or a bare node token.
 *
 * @param input Raw tool argument.
 * @returns The reference, or `undefined` when it names nothing recognizable.
 */
export function parseWikiRef(input: string): WikiRef | undefined {
  const trimmed = input.trim()
  if (TOKEN_PATTERN.test(trimmed)) return { kind: 'node', token: trimmed }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Neither a token nor a URL.
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments[0] === 'wiki' && segments.length === 3 && segments[1] === 'space' && SPACE_ID_PATTERN.test(segments[2]!)) {
    return { kind: 'space', spaceId: segments[2]! }
  }
  if (segments.length === 2 && TOKEN_PATTERN.test(segments[1]!)) {
    if (segments[0] === 'wiki' && segments[1] !== 'space') return { kind: 'node', token: segments[1]! }
    if (segments[0] === 'docx') return { kind: 'docx', token: segments[1]! }
  }
  return undefined
}
