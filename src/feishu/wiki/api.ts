/**
 * Feishu wiki (知识库) and docx OpenAPI calls used by the wiki tools, made
 * with the app identity (tenant access token).
 *
 * Structure calls use `wiki/v2` (`spaces/get_node`, `spaces/:id`,
 * `spaces/:id/nodes`); document content uses the `docs_ai/v1` document
 * endpoints, which read and write Markdown or Feishu document XML directly
 * (block ids are exported only in XML); the revision check uses
 * `docx/v1/documents/:id`. Every call maps a thrown transport error or a
 * non-zero Feishu `code` to {@link FeishuApiError}.
 *
 * @module dsh-channels/feishu/wiki/api
 */

import { FeishuApiError } from '../../feishu-channel.ts'

/** Object kinds a wiki node can hold. */
export type WikiObjType = 'doc' | 'docx' | 'sheet' | 'mindnote' | 'bitable' | 'file' | 'slides'

/** One wiki node as the tools use it. */
export interface WikiNode {
  readonly spaceId: string
  readonly nodeToken: string
  /** Token of the document the node holds (the docx `document_id` for docx). */
  readonly objToken: string
  readonly objType: WikiObjType
  /** Parent node; absent for a top-level node of its space. */
  readonly parentNodeToken?: string
  readonly nodeType: 'origin' | 'shortcut'
  readonly title: string
  readonly hasChild: boolean
  /** Owner id as Feishu reports it (an open_id; the app's bot open_id when the app owns it). */
  readonly owner?: string
  /** Web link, when Feishu returned one. */
  readonly url?: string
}

/** One page of child nodes. */
export interface WikiNodePage {
  readonly items: readonly WikiNode[]
  /** Cursor of the next page; absent on the last page. */
  readonly pageToken?: string
}

/** Read scopes of `docs_ai` fetch. */
export type WikiReadScope = 'full' | 'outline' | 'section' | 'range' | 'keyword'

/** Content format of `docs_ai` reads and writes. */
export type WikiDocFormat = 'markdown' | 'xml'

/** One `docs_ai` fetch request. */
export interface WikiFetchRequest {
  readonly format: WikiDocFormat
  /** Export block ids (XML only; Feishu ignores it for Markdown). */
  readonly withBlockIds: boolean
  readonly scope: WikiReadScope
  readonly startBlockId?: string
  readonly endBlockId?: string
  readonly keyword?: string
  /** `outline`: heading level cap; other scopes: subtree depth. */
  readonly maxDepth?: number
}

/** One fetched document. */
export interface WikiDocument {
  readonly revisionId: number
  readonly content: string
}

/** `docs_ai` update commands. */
export type WikiUpdateCommand =
  | 'str_replace'
  | 'block_insert_after'
  | 'block_replace'
  | 'block_delete'
  | 'overwrite'

/** One `docs_ai` update request. */
export interface WikiUpdateRequest {
  readonly command: WikiUpdateCommand
  readonly format: WikiDocFormat
  readonly content?: string
  readonly pattern?: string
  /** Anchor or target block; `-1` = document end for `block_insert_after`. */
  readonly blockId?: string
  readonly startBlockId?: string
  readonly endBlockId?: string
}

/** Outcome of one update. */
export interface WikiUpdateResult {
  /** `success`, `partial_success`, or `failed` as Feishu reports it. */
  readonly result: string
  readonly revisionId?: number
  readonly updatedBlocks?: number
  readonly warnings: readonly string[]
}

/** The wiki/docx endpoints the wiki tools consume. */
export interface WikiApi {
  /**
   * Resolve a node token (or, with `objType: 'docx'`, a docx token mounted in
   * the wiki) to its node.
   * @param token Node token or docx token.
   * @param objType `wiki` for a node token, `docx` for a document token.
   * @returns The node.
   */
  getNode(token: string, objType: 'wiki' | 'docx'): Promise<WikiNode>
  /**
   * Name of one space.
   * @param spaceId Wiki space id.
   * @returns The space name.
   */
  spaceName(spaceId: string): Promise<string>
  /**
   * One page of children; the space's top-level nodes without a parent.
   * @param spaceId Wiki space id.
   * @param parentNodeToken Parent node, or undefined for the space top level.
   * @param pageToken Cursor from the previous page.
   * @returns The page.
   */
  listChildren(spaceId: string, parentNodeToken: string | undefined, pageToken?: string): Promise<WikiNodePage>
  /**
   * Create one empty docx node.
   * @param spaceId Wiki space id.
   * @param parentNodeToken Parent node, or undefined for the space top level.
   * @param title Node title.
   * @returns The new node.
   */
  createDocxNode(spaceId: string, parentNodeToken: string | undefined, title: string): Promise<WikiNode>
  /**
   * Current revision of one docx document.
   * @param documentId Docx document id (the node's `objToken`).
   * @returns The revision id.
   */
  documentRevision(documentId: string): Promise<number>
  /**
   * Read one docx document.
   * @param documentId Docx document id.
   * @param request Format and scope.
   * @returns Content and revision.
   */
  fetchDocument(documentId: string, request: WikiFetchRequest): Promise<WikiDocument>
  /**
   * Apply one update command to a docx document.
   * @param documentId Docx document id.
   * @param request The command.
   * @returns Feishu's outcome.
   */
  updateDocument(documentId: string, request: WikiUpdateRequest): Promise<WikiUpdateResult>
}

/** The SDK's generic authenticated request (`Client.request`). */
export type WikiRawRequest = <T>(input: {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  params?: Record<string, string | number>
  data?: object
}) => Promise<T>

interface FeishuEnvelope<T> {
  code?: number
  msg?: string
  data?: T
}

interface RawNode {
  space_id?: string
  node_token?: string
  obj_token?: string
  obj_type?: string
  parent_node_token?: string
  node_type?: string
  title?: string
  has_child?: boolean
  owner?: string
  url?: string
}

const OBJ_TYPES: ReadonlySet<string> = new Set(['doc', 'docx', 'sheet', 'mindnote', 'bitable', 'file', 'slides'])

/** Feishu's per-page maximum for `spaces/:id/nodes`. */
const LIST_PAGE_SIZE = 50

function thrownError(error: unknown): FeishuApiError {
  if (error instanceof FeishuApiError) return error
  const data = (error as { response?: { data?: { code?: unknown; msg?: unknown } } } | undefined)?.response?.data
  const code = typeof data?.code === 'number' ? data.code : undefined
  const msg = typeof data?.msg === 'string' ? data.msg : undefined
  if (code === undefined && msg === undefined) return new FeishuApiError(error instanceof Error ? error.message : String(error))
  return new FeishuApiError([code === undefined ? undefined : `code=${code}`, msg].filter(Boolean).join(' '), code)
}

async function call<T>(request: WikiRawRequest, input: Parameters<WikiRawRequest>[0]): Promise<T> {
  let response: FeishuEnvelope<T>
  try {
    response = await request<FeishuEnvelope<T>>(input)
  } catch (error) {
    throw thrownError(error)
  }
  if (response.code !== undefined && response.code !== 0) {
    throw new FeishuApiError(`code=${response.code}${response.msg === undefined ? '' : ` ${response.msg}`}`, response.code)
  }
  if (response.data === undefined) throw new FeishuApiError(`${input.url}: response has no data`)
  return response.data
}

function wikiNode(raw: RawNode | undefined, where: string): WikiNode {
  if (raw?.space_id === undefined || raw.node_token === undefined || raw.obj_token === undefined
    || raw.obj_type === undefined || !OBJ_TYPES.has(raw.obj_type)) {
    throw new FeishuApiError(`${where}: response node is incomplete`)
  }
  return {
    spaceId: raw.space_id,
    nodeToken: raw.node_token,
    objToken: raw.obj_token,
    objType: raw.obj_type as WikiObjType,
    ...(raw.parent_node_token === undefined || raw.parent_node_token === '' ? {} : { parentNodeToken: raw.parent_node_token }),
    nodeType: raw.node_type === 'shortcut' ? 'shortcut' : 'origin',
    title: raw.title ?? '',
    hasChild: raw.has_child === true,
    ...(raw.owner === undefined || raw.owner === '' ? {} : { owner: raw.owner }),
    ...(raw.url === undefined || raw.url === '' ? {} : { url: raw.url }),
  }
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

/**
 * {@link WikiApi} over the SDK's generic authenticated request.
 *
 * @param request `Client.request` of the connected SDK client.
 * @returns The API.
 */
export function createWikiApi(request: WikiRawRequest): WikiApi {
  return {
    async getNode(token, objType) {
      const url = '/open-apis/wiki/v2/spaces/get_node'
      const data = await call<{ node?: RawNode }>(request, { method: 'GET', url, params: { token, obj_type: objType } })
      return wikiNode(data.node, url)
    },
    async spaceName(spaceId) {
      const data = await call<{ space?: { name?: string } }>(request, {
        method: 'GET', url: `/open-apis/wiki/v2/spaces/${segment(spaceId)}`,
      })
      return data.space?.name ?? ''
    },
    async listChildren(spaceId, parentNodeToken, pageToken) {
      const url = `/open-apis/wiki/v2/spaces/${segment(spaceId)}/nodes`
      const data = await call<{ items?: RawNode[]; page_token?: string; has_more?: boolean }>(request, {
        method: 'GET',
        url,
        params: {
          page_size: LIST_PAGE_SIZE,
          ...(parentNodeToken === undefined ? {} : { parent_node_token: parentNodeToken }),
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        },
      })
      return {
        items: (data.items ?? []).map(item => wikiNode(item, url)),
        ...(data.has_more === true && data.page_token !== undefined && data.page_token !== '' ? { pageToken: data.page_token } : {}),
      }
    },
    async createDocxNode(spaceId, parentNodeToken, title) {
      const url = `/open-apis/wiki/v2/spaces/${segment(spaceId)}/nodes`
      const data = await call<{ node?: RawNode }>(request, {
        method: 'POST',
        url,
        data: {
          obj_type: 'docx',
          node_type: 'origin',
          title,
          ...(parentNodeToken === undefined ? {} : { parent_node_token: parentNodeToken }),
        },
      })
      return wikiNode(data.node, url)
    },
    async documentRevision(documentId) {
      const url = `/open-apis/docx/v1/documents/${segment(documentId)}`
      const data = await call<{ document?: { revision_id?: number } }>(request, { method: 'GET', url })
      const revision = data.document?.revision_id
      if (typeof revision !== 'number') throw new FeishuApiError(`${url}: response has no revision_id`)
      return revision
    },
    async fetchDocument(documentId, fetch) {
      const url = `/open-apis/docs_ai/v1/documents/${segment(documentId)}/fetch`
      const ids = fetch.format === 'xml' && fetch.withBlockIds
      const readOption = fetch.scope === 'full' ? undefined : {
        read_mode: fetch.scope,
        ...(fetch.startBlockId === undefined ? {} : { start_block_id: fetch.startBlockId }),
        ...(fetch.endBlockId === undefined ? {} : { end_block_id: fetch.endBlockId }),
        ...(fetch.keyword === undefined ? {} : { keyword: fetch.keyword }),
        ...(fetch.maxDepth === undefined ? {} : { max_depth: String(fetch.maxDepth) }),
      }
      const data = await call<{ document?: { revision_id?: number; content?: string } }>(request, {
        method: 'POST',
        url,
        data: {
          format: fetch.format,
          export_option: { export_block_id: ids, export_style_attrs: false, export_cite_extra_data: false },
          ...(readOption === undefined ? {} : { read_option: readOption }),
        },
      })
      const document = data.document
      if (document === undefined || typeof document.content !== 'string') {
        throw new FeishuApiError(`${url}: response has no document content`)
      }
      return { revisionId: document.revision_id ?? 0, content: document.content }
    },
    async updateDocument(documentId, update) {
      const url = `/open-apis/docs_ai/v1/documents/${segment(documentId)}`
      const data = await call<{
        result?: string
        updated_blocks_count?: number
        warnings?: unknown
        document?: { revision_id?: number }
      }>(request, {
        method: 'PUT',
        url,
        data: {
          format: update.format,
          command: update.command,
          ...(update.content === undefined ? {} : { content: update.content }),
          ...(update.pattern === undefined ? {} : { pattern: update.pattern }),
          ...(update.blockId === undefined ? {} : { block_id: update.blockId }),
          ...(update.startBlockId === undefined ? {} : { start_block_id: update.startBlockId }),
          ...(update.endBlockId === undefined ? {} : { end_block_id: update.endBlockId }),
        },
      })
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.filter((item): item is string => typeof item === 'string' && item !== '')
        : []
      return {
        result: data.result ?? 'success',
        ...(data.document?.revision_id === undefined ? {} : { revisionId: data.document.revision_id }),
        ...(data.updated_blocks_count === undefined ? {} : { updatedBlocks: data.updated_blocks_count }),
        warnings,
      }
    },
  }
}
