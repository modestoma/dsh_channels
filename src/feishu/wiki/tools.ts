/**
 * Model-facing wiki (知识库) tools: `feishu_wiki_list`, `feishu_wiki_read`
 * (switch `feishuTools.wikiRead`), `feishu_wiki_create`, and
 * `feishu_wiki_edit` (switch `feishuTools.wikiWrite`).
 *
 * Every call acts with the app identity and is gated, in order, by:
 * - the switch and a non-empty `wikiRoots` (otherwise nothing is mounted);
 * - the topic owner being the administrator or on the wiki whitelist
 *   (`/auth wiki add`), checked per call so revocation applies at once;
 * - `wikiRoots` containment of the node (see `scope.ts`);
 * - docx only for reading and editing;
 * - edits only on documents the app owns (wiki node `owner` equals the bot
 *   open_id) whose current revision equals the `revision_id` the model read;
 * - the topic owner's consent card for opening a document (remembered per
 *   Session and document), for every create, and for every edit.
 *
 * Browsing (`feishu_wiki_list`) needs no card. Every failure is a structured
 * value with a stable code and a readable reason.
 *
 * @module dsh-channels/feishu/wiki/tools
 */

import { z } from 'zod'
import type { WikiConsentAction } from '../../cards/wiki.ts'
import type { FeishuConfig } from '../../config.ts'
import type { AgentContext, ToolContentBlock, ToolDefinition, ToolExecution } from '../../host/agent.ts'
import type { FeishuChannel } from '../../feishu-channel.ts'
import { FeishuApiError } from '../../feishu-channel.ts'
import type { InteractionRoute } from '../../interactions/pending.ts'
import {
  consentFailure, describeError, display, failure, failureOf, FAILURE_REASONS, guarded, nodeUrl, ownedByApp,
  parseArgs, preview, previewBlock,
} from './shared.ts'
import type { WikiCallContext, WikiFailure, WikiFailureCode, WikiGate, WikiToolKit, WikiToolSpec } from './shared.ts'
import { MOUNT_INJECT_RETRY_WAIT_MS, MOUNT_INJECT_WAIT_MS, waitForAvailability } from '../tools.ts'
import type { WikiApi, WikiDocFormat, WikiNode, WikiUpdateRequest } from './api.ts'
import type { WikiConsent, WikiConsentOutcome } from './consent.ts'
import { parseWikiRef, parseWikiRoots } from './links.ts'
import type { WikiRef, WikiRoot } from './links.ts'
import { containingRoot, spaceIsRoot } from './scope.ts'
import { BASE_TOOL_SPECS } from './base-tools.ts'
import { SHEET_TOOL_SPECS } from './sheet-tools.ts'
import type { WikiSheetEditValue, WikiSheetReadValue } from './sheet-tools.ts'
import type { WikiBaseEditValue, WikiBaseReadValue } from './base-tools.ts'

// ---- Public identity ----------------------------------------------------

/** Model-facing tool names; stable across releases (session history references them). */
export const WIKI_LIST_TOOL_NAME = 'feishu_wiki_list'
export const WIKI_READ_TOOL_NAME = 'feishu_wiki_read'
export const WIKI_CREATE_TOOL_NAME = 'feishu_wiki_create'
export const WIKI_EDIT_TOOL_NAME = 'feishu_wiki_edit'

/** Most operations one `feishu_wiki_edit` call may apply. */
export const WIKI_EDIT_MAX_OPERATIONS = 20

/** Longest accepted document title (characters). */
const MAX_TITLE_CHARS = 200

/** Longest content one create/edit operation may carry (characters). */
const MAX_CONTENT_CHARS = 200_000

// ---- Arguments ----------------------------------------------------------

const refSchema = z.string().trim().min(1).max(2048)
const blockIdSchema = z.string().trim().min(1).max(128)
const contentSchema = z.string().max(MAX_CONTENT_CHARS)
const formatSchema = z.enum(['markdown', 'xml'])

export const wikiListArgsSchema = z.object({
  parent: refSchema.optional(),
  page_token: z.string().trim().min(1).max(512).optional(),
}).strict()

export const wikiReadArgsSchema = z.object({
  doc: refSchema,
  format: formatSchema.optional(),
  scope: z.enum(['full', 'outline', 'section', 'range', 'keyword']).optional(),
  start_block_id: blockIdSchema.optional(),
  end_block_id: blockIdSchema.optional(),
  keyword: z.string().trim().min(1).max(500).optional(),
  max_depth: z.number().int().min(-1).max(20).optional(),
}).strict()

export const wikiCreateArgsSchema = z.object({
  parent: refSchema,
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  type: z.enum(['docx', 'sheet', 'bitable']).optional(),
  content: contentSchema.optional(),
  format: formatSchema.optional(),
}).strict()

const rangeFields = {
  block_id: blockIdSchema.optional(),
  start_block_id: blockIdSchema.optional(),
  end_block_id: blockIdSchema.optional(),
}

const wikiEditOperationSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('append'), content: contentSchema.min(1) }).strict(),
  z.object({ command: z.literal('insert_after'), block_id: blockIdSchema, content: contentSchema.min(1) }).strict(),
  z.object({ command: z.literal('replace'), ...rangeFields, content: contentSchema.min(1) }).strict(),
  z.object({ command: z.literal('delete'), ...rangeFields }).strict(),
  z.object({ command: z.literal('str_replace'), pattern: z.string().min(1).max(10_000), content: contentSchema }).strict(),
  z.object({ command: z.literal('overwrite'), content: contentSchema.min(1) }).strict(),
])

export type WikiEditOperation = z.infer<typeof wikiEditOperationSchema>

export const wikiEditArgsSchema = z.object({
  doc: refSchema,
  revision_id: z.number().int().min(0),
  format: formatSchema.optional(),
  operations: z.array(wikiEditOperationSchema).min(1).max(WIKI_EDIT_MAX_OPERATIONS),
}).strict()


/** One node as the tools report it. */
export interface WikiNodeView {
  readonly title: string
  readonly node_token: string
  readonly obj_type: string
  readonly node_type: string
  readonly has_child: boolean
  readonly url: string
  /** The app owns the document (it may be edited when wikiWrite is on). */
  readonly owned_by_app: boolean
}

/** Successful `feishu_wiki_list`. */
export interface WikiListValue {
  readonly ok: true
  readonly kind: 'roots' | 'children'
  /** Listed parent (children only). */
  readonly parent?: string
  readonly items: ReadonlyArray<WikiNodeView | WikiRootView>
  readonly page_token?: string
}

/** One configured root in a `kind: 'roots'` listing. */
export interface WikiRootView {
  readonly root: 'space' | 'node'
  readonly title: string
  readonly link: string
  readonly space_id?: string
  readonly node_token?: string
  readonly has_child?: boolean
  readonly error?: string
}

/** Successful `feishu_wiki_read`. */
export interface WikiReadValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly revision_id: number
  readonly format: WikiDocFormat
  readonly editable: boolean
  readonly content: string
}

/** Successful `feishu_wiki_create`. */
export interface WikiCreateValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly revision_id?: number
  readonly warnings: readonly string[]
}

/** Successful `feishu_wiki_edit`. */
export interface WikiEditValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly applied: number
  readonly revision_id?: number
  readonly warnings: readonly string[]
}

export type WikiToolValue =
  | WikiFailure
  | WikiListValue
  | WikiReadValue
  | WikiCreateValue
  | WikiEditValue
  | WikiSheetReadValue
  | WikiSheetEditValue
  | WikiBaseReadValue
  | WikiBaseEditValue

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, reason: { type: 'string' } },
  required: ['ok'],
}

// ---- Descriptions -------------------------------------------------------

const FORMAT_NOTE = 'format 默认 markdown；xml 为飞书文档 XML（类 HTML 标签：<p> <h1>-<h6> <ul>/<ol><li> <pre><code> <table> <callout> 等），只有 xml 读取会给每个块带上 id 属性（block id），需要按块修改时用 xml 读取。'

const LIST_DESCRIPTION =
  '浏览飞书知识库（只能访问插件配置的知识库范围 wikiRoots）。不传 parent 时列出可访问的根（知识空间或节点）；'
  + '传 parent（知识库节点链接、node_token，或知识空间链接）时列出它的直接子节点，has_child 为 true 的节点可以继续往下浏览。'
  + '结果分页，带 page_token 时用它取下一页。返回的 node_token 可直接传给其他知识库工具。'

const READ_DESCRIPTION =
  '读取知识库中的一篇飞书文档（docx；电子表格用 feishu_wiki_sheet_read，多维表格用 feishu_wiki_base_read）。doc 传知识库节点链接或 node_token。'
  + '第一次读取某篇文档会在话题里弹出授权卡，由话题发起人确认，确认后本话题内再次读取同一篇不再询问；等待期间不要重复调用。'
  + 'scope 默认 full（整篇）；大文档先用 outline 看目录，再用 section（start_block_id 为标题块 id）、range（start/end_block_id）或 keyword（关键词，支持 a|b）读取局部；max_depth 在 outline 中表示标题层级上限。'
  + FORMAT_NOTE
  + '返回的 revision_id 用于 feishu_wiki_edit；editable 表示这篇文档能否被修改（只有本应用创建的文档可以修改）。'

const CREATE_DESCRIPTION =
  '在知识库中新建一篇飞书文档（docx，默认）、电子表格（type=sheet）或多维表格（type=bitable）。parent 传父节点（知识库节点链接或 node_token）或知识空间链接（建在空间顶层），必须位于插件配置的知识库范围内；'
  + '新节点本身也可以作为目录，之后把它的 node_token 作为 parent 在下面继续新建子节点。'
  + 'title 为标题；content 为文档正文（仅 docx，可选，不要在正文里重复标题），电子表格和多维表格建好后是空白的，再用 feishu_wiki_sheet_edit / feishu_wiki_base_edit 写入。' + FORMAT_NOTE
  + '每次新建都会在话题里弹出授权卡，由话题发起人确认后才执行；等待期间不要重复调用。'

const EDIT_DESCRIPTION =
  '修改知识库中由本应用创建的飞书文档（docx）。先用 feishu_wiki_read 读取（按块修改时用 format=xml 拿到 block id），把读到的 revision_id 原样传入；文档在此之后被他人改过会被拒绝，需要重新读取。'
  + `operations 按顺序执行（最多 ${WIKI_EDIT_MAX_OPERATIONS} 个）：`
  + 'append（文末追加 content）、insert_after（在 block_id 之后插入 content）、replace（用 content 替换 block_id，或同一父块下 start_block_id 到 end_block_id 的连续块）、'
  + 'delete（删除 block_id，或 start_block_id 到 end_block_id）、str_replace（把文本 pattern 替换为 content，content 为空表示删除）、overwrite（清空后用 content 重写整篇，会丢失评论与不支持的内容，尽量少用）。'
  + '替换和删除会使涉及的旧 block id 失效，同一个块的多处修改请合并成一次 replace。' + FORMAT_NOTE
  + '每次修改都会在话题里弹出授权卡，由话题发起人确认后才执行；等待期间不要重复调用。'

// ---- Runtime ------------------------------------------------------------

const CREATE_TYPE_LABELS: Readonly<Record<'docx' | 'sheet' | 'bitable', string>> = {
  docx: '飞书文档',
  sheet: '电子表格',
  bitable: '多维表格',
}

/** The spreadsheet and Base tool families, mounted with the docx tools under the same switches. */
const FAMILY_SPECS: readonly WikiToolSpec[] = [...SHEET_TOOL_SPECS, ...BASE_TOOL_SPECS]

export interface WikiToolRuntimeDeps {
  /** Live plugin configuration (switches, roots). */
  config(): FeishuConfig
  /** Live Feishu channel; undefined while disconnected/shut down. */
  channel(): FeishuChannel | undefined
  /** Consent placement of one session (its topic and owner), re-read per call. */
  routeOfSession(sessionId: string): InteractionRoute | undefined
  /** Whether a user is the administrator or on the wiki whitelist. */
  mayUseWiki(userId: string): boolean
  /** Topic-owner consent cards. */
  consent: WikiConsent
  /** Structured warning sink. */
  warn(message: string, ...args: unknown[]): void
}

type CallContext = WikiCallContext

/**
 * The wiki tool runtime: mounts the enabled tools into Agent scopes and runs
 * each call through the gates in the module contract.
 */
export class WikiToolRuntime implements WikiToolKit {
  private readonly mountAttempts = new WeakMap<AgentContext, Promise<void>>()
  private readonly spaceNames = new Map<string, string>()
  private warnedUnavailable = false
  private warnedMountFailure = false

  constructor(private readonly deps: WikiToolRuntimeDeps) {}

  /** Tool names the current configuration mounts. */
  enabledTools(): string[] {
    const config = this.deps.config()
    if (config.wikiRoots.length === 0) return []
    const family = (access: 'read' | 'write'): string[] =>
      FAMILY_SPECS.filter(spec => spec.access === access).map(spec => spec.name)
    return [
      ...(config.feishuTools.wikiRead ? [WIKI_LIST_TOOL_NAME, WIKI_READ_TOOL_NAME, ...family('read')] : []),
      ...(config.feishuTools.wikiWrite ? [WIKI_CREATE_TOOL_NAME, WIKI_EDIT_TOOL_NAME, ...family('write')] : []),
    ]
  }

  /**
   * Register the enabled tools inside one Agent scope; same mount policy as
   * the other channel tools (a missing or slow `tools` service never blocks
   * session creation).
   *
   * @param agentCtx Agent scope to register in.
   * @param sessionId Session the tools act for.
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    if (this.enabledTools().length === 0) return
    const existing = this.mountAttempts.get(agentCtx)
    if (existing !== undefined) return await existing
    const attempt = this.mountAttempt(agentCtx, sessionId)
    this.mountAttempts.set(agentCtx, attempt)
    await attempt
  }

  private async mountAttempt(agentCtx: AgentContext, sessionId: string): Promise<void> {
    let injected = false
    const outcome = await waitForAvailability(
      Promise.resolve(agentCtx.inject(['tools'], (ctx) => {
        injected = true
        this.registerInScope(ctx, sessionId)
      })),
      this.warnedUnavailable ? MOUNT_INJECT_RETRY_WAIT_MS : MOUNT_INJECT_WAIT_MS,
    )
    if (outcome === 'failed') {
      this.warnMountFailure('dsh-channels: mounting the wiki tools failed')
      return
    }
    if (!injected && !this.warnedUnavailable) {
      this.warnedUnavailable = true
      this.deps.warn('dsh-channels: 知识库工具未挂载：宿主 tools 服务不可用（会话继续）')
    }
  }

  private registerInScope(agentCtx: AgentContext, sessionId: string): void {
    const tools = agentCtx.tools
    if (tools === undefined || typeof tools.register !== 'function') {
      this.warnMountFailure('dsh-channels: 知识库工具未注册：宿主 tools 服务不可用')
      return
    }
    for (const name of this.enabledTools()) {
      try {
        tools.register(this.definitionFor(name, sessionId))
      } catch (error) {
        this.warnMountFailure(`dsh-channels: registering ${name} failed: ${describeError(error)}`)
      }
    }
  }

  private warnMountFailure(message: string): void {
    if (this.warnedMountFailure) return
    this.warnedMountFailure = true
    this.deps.warn(message)
  }

  private definitionFor(name: string, sessionId: string): ToolDefinition {
    const base = {
      output: { schema: OUTPUT_SCHEMA, render: (_args: Record<string, unknown>, value: unknown) => renderWikiResult(value) },
      presentResult: (_args: Record<string, unknown>, value: unknown) => presentWikiResult(value),
    }
    const spec = FAMILY_SPECS.find(candidate => candidate.name === name)
    if (spec !== undefined) {
      return {
        ...base,
        name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (rawArgs, exec) => await spec.execute(this, sessionId, rawArgs, exec.signal),
        presentCall: args => spec.presentCall(args),
        isConcurrencySafe: () => false,
      }
    }
    switch (name) {
      case WIKI_LIST_TOOL_NAME:
        return {
          ...base,
          name,
          description: LIST_DESCRIPTION,
          parameters: LIST_PARAMETERS,
          execute: async rawArgs => await this.list(sessionId, rawArgs),
          presentCall: () => '浏览知识库',
          isConcurrencySafe: () => true,
        }
      case WIKI_READ_TOOL_NAME:
        return {
          ...base,
          name,
          description: READ_DESCRIPTION,
          parameters: READ_PARAMETERS,
          execute: async (rawArgs, exec) => await this.read(sessionId, rawArgs, exec),
          presentCall: args => `读取知识库文档：${display(args.doc)}`,
          isConcurrencySafe: () => false,
        }
      case WIKI_CREATE_TOOL_NAME:
        return {
          ...base,
          name,
          description: CREATE_DESCRIPTION,
          parameters: CREATE_PARAMETERS,
          execute: async (rawArgs, exec) => await this.create(sessionId, rawArgs, exec),
          presentCall: args => `新建知识库文档：${display(args.title)}`,
          isConcurrencySafe: () => false,
        }
      default:
        return {
          ...base,
          name,
          description: EDIT_DESCRIPTION,
          parameters: EDIT_PARAMETERS,
          execute: async (rawArgs, exec) => await this.edit(sessionId, rawArgs, exec),
          presentCall: args => `修改知识库文档：${display(args.doc)}`,
          isConcurrencySafe: () => false,
        }
    }
  }

  // ---- Gates -----------------------------------------------------------

  gate(sessionId: string, tool: string): WikiGate {
    if (!this.enabledTools().includes(tool)) return failure('TOOL_DISABLED')
    const route = this.deps.routeOfSession(sessionId)
    if (route === undefined) return failure('ROUTE_NOT_FOUND')
    if (!this.deps.mayUseWiki(route.senderUserId)) return failure('NOT_AUTHORIZED')
    const channel = this.deps.channel()
    const api = channel?.wiki
    if (channel === undefined || api === undefined) return failure('CHANNEL_UNAVAILABLE')
    return {
      ok: true,
      context: {
        route,
        api,
        ...(channel.sheets === undefined ? {} : { sheets: channel.sheets }),
        ...(channel.bases === undefined ? {} : { bases: channel.bases }),
        roots: parseWikiRoots(this.deps.config().wikiRoots),
        botOpenId: channel.botOpenId(),
      },
    }
  }

  /** Resolve a node/docx reference and check containment. */
  async containedNode(context: CallContext, ref: WikiRef): Promise<WikiNode | WikiFailure> {
    if (ref.kind === 'space') return failure('INVALID_REFERENCE', '这里需要一个文档或节点，而不是整个知识空间')
    const node = await context.api.getNode(ref.token, ref.kind === 'docx' ? 'docx' : 'wiki')
    const contained = await containingRoot(context.api, context.roots, node)
    return contained === undefined ? failure('OUTSIDE_ROOTS') : node
  }

  async consent(
    sessionId: string,
    context: CallContext,
    action: WikiConsentAction,
    fields: { title: string; url?: string; location: string; details: readonly string[] },
    signal: AbortSignal,
  ): Promise<WikiFailure | undefined> {
    const outcome = await this.deps.consent.request({ sessionId, route: context.route, action, ...fields, signal })
    return consentFailure(outcome)
  }

  private async spaceName(api: WikiApi, spaceId: string): Promise<string> {
    const cached = this.spaceNames.get(spaceId)
    if (cached !== undefined) return cached
    const name = await api.spaceName(spaceId).catch(() => '')
    const label = name === '' ? `知识空间 ${spaceId}` : name
    this.spaceNames.set(spaceId, label)
    return label
  }

  /** `空间 / 父节点` for a node (one parent lookup). */
  async readConsent(sessionId: string, context: CallContext, node: WikiNode, signal: AbortSignal): Promise<WikiFailure | undefined> {
    if (this.deps.consent.hasReadGrant(sessionId, node.objToken)) return undefined
    const denied = await this.consent(sessionId, context, 'read', {
      title: node.title, url: nodeUrl(context.roots, node), location: await this.locationOf(context.api, node), details: [],
    }, signal)
    if (denied === undefined) this.deps.consent.grantRead(sessionId, node.objToken)
    return denied
  }

  grantRead(sessionId: string, documentId: string): void {
    this.deps.consent.grantRead(sessionId, documentId)
  }

  writeEnabled(): boolean {
    return this.deps.config().feishuTools.wikiWrite
  }

  warn(message: string, ...args: unknown[]): void {
    this.deps.warn(message, ...args)
  }

  async locationOf(api: WikiApi, node: WikiNode): Promise<string> {
    const space = await this.spaceName(api, node.spaceId)
    if (node.parentNodeToken === undefined) return space
    const parent = await api.getNode(node.parentNodeToken, 'wiki').catch(() => undefined)
    return parent === undefined || parent.title === '' ? space : `${space} / ${parent.title}`
  }

  private nodeView(context: CallContext, node: WikiNode): WikiNodeView {
    return {
      title: node.title,
      node_token: node.nodeToken,
      obj_type: node.objType,
      node_type: node.nodeType,
      has_child: node.hasChild,
      url: nodeUrl(context.roots, node),
      owned_by_app: ownedByApp(node, context.botOpenId),
    }
  }

  // ---- feishu_wiki_list ------------------------------------------------

  private async list(sessionId: string, rawArgs: Record<string, unknown>): Promise<WikiToolValue> {
    const args = parseArgs(WIKI_LIST_TOOL_NAME, wikiListArgsSchema, rawArgs)
    const gate = this.gate(sessionId, WIKI_LIST_TOOL_NAME)
    if (!gate.ok) return gate
    const { context } = gate
    return await guarded(this.deps, WIKI_LIST_TOOL_NAME, async () => {
      if (args.parent === undefined) {
        const items = await Promise.all(context.roots.map(root => this.rootView(context, root)))
        return { ok: true, kind: 'roots', items }
      }
      const ref = parseWikiRef(args.parent)
      if (ref === undefined) return failure('INVALID_REFERENCE')
      let spaceId: string
      let parentToken: string | undefined
      if (ref.kind === 'space') {
        if (!spaceIsRoot(context.roots, ref.spaceId)) return failure('OUTSIDE_ROOTS')
        spaceId = ref.spaceId
      } else {
        const node = await this.containedNode(context, ref)
        if ('ok' in node) return node
        spaceId = node.spaceId
        parentToken = node.nodeToken
      }
      const page = await context.api.listChildren(spaceId, parentToken, args.page_token)
      return {
        ok: true,
        kind: 'children',
        parent: args.parent,
        items: page.items.map(node => this.nodeView(context, node)),
        ...(page.pageToken === undefined ? {} : { page_token: page.pageToken }),
      }
    })
  }

  private async rootView(context: CallContext, root: WikiRoot): Promise<WikiRootView> {
    try {
      if (root.kind === 'space') {
        return { root: 'space', title: await this.spaceName(context.api, root.spaceId), link: root.link, space_id: root.spaceId }
      }
      const node = await context.api.getNode(root.nodeToken, 'wiki')
      return { root: 'node', title: node.title, link: root.link, node_token: node.nodeToken, has_child: node.hasChild }
    } catch (error) {
      const base = root.kind === 'space'
        ? { root: 'space' as const, space_id: root.spaceId }
        : { root: 'node' as const, node_token: root.nodeToken }
      return { ...base, title: '', link: root.link, error: failureOf(error).reason }
    }
  }

  // ---- feishu_wiki_read ------------------------------------------------

  private async read(sessionId: string, rawArgs: Record<string, unknown>, exec: ToolExecution): Promise<WikiToolValue> {
    const args = parseArgs(WIKI_READ_TOOL_NAME, wikiReadArgsSchema, rawArgs)
    const gate = this.gate(sessionId, WIKI_READ_TOOL_NAME)
    if (!gate.ok) return gate
    const { context } = gate
    return await guarded(this.deps, WIKI_READ_TOOL_NAME, async () => {
      const ref = parseWikiRef(args.doc)
      if (ref === undefined) return failure('INVALID_REFERENCE')
      const node = await this.containedNode(context, ref)
      if ('ok' in node) return node
      if (node.objType !== 'docx') return failure('UNSUPPORTED_TYPE', `${FAILURE_REASONS.UNSUPPORTED_TYPE}（该节点类型：${node.objType}）`)
      const url = nodeUrl(context.roots, node)
      const denied = await this.readConsent(sessionId, context, node, exec.signal)
      if (denied !== undefined) return denied
      if (exec.signal.aborted) return failure('ABORTED')
      const format = args.format ?? 'markdown'
      const document = await context.api.fetchDocument(node.objToken, {
        format,
        withBlockIds: true,
        scope: args.scope ?? 'full',
        ...(args.start_block_id === undefined ? {} : { startBlockId: args.start_block_id }),
        ...(args.end_block_id === undefined ? {} : { endBlockId: args.end_block_id }),
        ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
        ...(args.max_depth === undefined ? {} : { maxDepth: args.max_depth }),
      })
      return {
        ok: true,
        title: node.title,
        node_token: node.nodeToken,
        url,
        revision_id: document.revisionId,
        format,
        editable: this.deps.config().feishuTools.wikiWrite && ownedByApp(node, context.botOpenId),
        content: document.content,
      }
    })
  }

  // ---- feishu_wiki_create ----------------------------------------------

  private async create(sessionId: string, rawArgs: Record<string, unknown>, exec: ToolExecution): Promise<WikiToolValue> {
    const args = parseArgs(WIKI_CREATE_TOOL_NAME, wikiCreateArgsSchema, rawArgs)
    const gate = this.gate(sessionId, WIKI_CREATE_TOOL_NAME)
    if (!gate.ok) return gate
    const { context } = gate
    return await guarded(this.deps, WIKI_CREATE_TOOL_NAME, async () => {
      const ref = parseWikiRef(args.parent)
      if (ref === undefined) return failure('INVALID_REFERENCE')
      let spaceId: string
      let parentToken: string | undefined
      let location: string
      let parentUrl: string | undefined
      if (ref.kind === 'space') {
        if (!spaceIsRoot(context.roots, ref.spaceId)) return failure('OUTSIDE_ROOTS')
        spaceId = ref.spaceId
        location = `${await this.spaceName(context.api, spaceId)}（顶层）`
      } else {
        const parent = await this.containedNode(context, ref)
        if ('ok' in parent) return parent
        spaceId = parent.spaceId
        parentToken = parent.nodeToken
        parentUrl = nodeUrl(context.roots, parent)
        location = `${await this.spaceName(context.api, spaceId)} / ${parent.title === '' ? parent.nodeToken : parent.title}`
      }
      const type = args.type ?? 'docx'
      const format = args.format ?? 'markdown'
      const content = args.content === undefined || args.content.trim() === '' ? undefined : args.content
      if (type !== 'docx' && content !== undefined) {
        return failure('INVALID_OPERATION', 'content 只用于飞书文档；新建电子表格或多维表格后，用 feishu_wiki_sheet_edit / feishu_wiki_base_edit 写入数据')
      }
      const details = type !== 'docx'
        ? [`**类型**：${CREATE_TYPE_LABELS[type]}（空白）`]
        : content === undefined
          ? ['**内容**：空文档']
          : [`**内容预览**（${format === 'xml' ? 'XML' : 'Markdown'}，共 ${content.length} 字）\n${previewBlock(content)}`]
      const denied = await this.consent(sessionId, context, 'create', {
        title: args.title, ...(parentUrl === undefined ? {} : { url: parentUrl }), location, details,
      }, exec.signal)
      if (denied !== undefined) return denied
      if (exec.signal.aborted) return failure('ABORTED')
      const node = await context.api.createNode(spaceId, parentToken, args.title, type)
      const url = nodeUrl(context.roots, node)
      // The topic owner approved this document; reading it back needs no new card.
      this.grantRead(sessionId, node.objToken)
      if (content === undefined) {
        return { ok: true, title: node.title || args.title, node_token: node.nodeToken, url, warnings: [] }
      }
      try {
        const written = await context.api.updateDocument(node.objToken, {
          command: 'block_insert_after', format, content, blockId: '-1',
        })
        if (written.result === 'failed') {
          return { ...failure('CONTENT_FAILED', `${FAILURE_REASONS.CONTENT_FAILED}：${written.warnings.join('；') || '飞书返回 failed'}；可用 feishu_wiki_edit 重新写入`), node_token: node.nodeToken, url }
        }
        if (written.result === 'partial_success') {
          return { ...failure('CONTENT_FAILED', `文档已创建，但内容只部分写入：${written.warnings.join('；') || '飞书返回 partial_success'}；请先用 feishu_wiki_read 核验，再用 feishu_wiki_edit 补齐`), node_token: node.nodeToken, url }
        }
        return {
          ok: true,
          title: node.title || args.title,
          node_token: node.nodeToken,
          url,
          ...(written.revisionId === undefined ? {} : { revision_id: written.revisionId }),
          warnings: written.warnings,
        }
      } catch (error) {
        const reason = failureOf(error).reason
        return { ...failure('CONTENT_FAILED', `${FAILURE_REASONS.CONTENT_FAILED}：${reason}；可用 feishu_wiki_edit 重新写入`), node_token: node.nodeToken, url }
      }
    })
  }

  // ---- feishu_wiki_edit ------------------------------------------------

  private async edit(sessionId: string, rawArgs: Record<string, unknown>, exec: ToolExecution): Promise<WikiToolValue> {
    const args = parseArgs(WIKI_EDIT_TOOL_NAME, wikiEditArgsSchema, rawArgs)
    const gate = this.gate(sessionId, WIKI_EDIT_TOOL_NAME)
    if (!gate.ok) return gate
    const { context } = gate
    const format = args.format ?? 'markdown'
    const requests: WikiUpdateRequest[] = []
    for (const [index, operation] of args.operations.entries()) {
      const request = updateRequestOf(operation, format)
      if (typeof request === 'string') return failure('INVALID_OPERATION', `第 ${index + 1} 个操作（${operation.command}）：${request}`)
      requests.push(request)
    }
    return await guarded(this.deps, WIKI_EDIT_TOOL_NAME, async () => {
      const ref = parseWikiRef(args.doc)
      if (ref === undefined) return failure('INVALID_REFERENCE')
      const node = await this.containedNode(context, ref)
      if ('ok' in node) return node
      if (node.objType !== 'docx') return failure('UNSUPPORTED_TYPE', `${FAILURE_REASONS.UNSUPPORTED_TYPE}（该节点类型：${node.objType}）`)
      if (!ownedByApp(node, context.botOpenId)) {
        return failure('NOT_OWNED', `${FAILURE_REASONS.NOT_OWNED}（该文档所有者：${node.owner ?? '未知'}）`)
      }
      const current = await context.api.documentRevision(node.objToken)
      if (current !== args.revision_id) {
        return { ...failure('REVISION_CONFLICT', `${FAILURE_REASONS.REVISION_CONFLICT}（读取时 ${args.revision_id}，当前 ${current}）`), revision_id: current }
      }
      const url = nodeUrl(context.roots, node)
      const denied = await this.consent(sessionId, context, 'edit', {
        title: node.title,
        url,
        location: await this.locationOf(context.api, node),
        details: operationLines(args.operations),
      }, exec.signal)
      if (denied !== undefined) return denied
      // The document may have changed while the card was open.
      if (await context.api.documentRevision(node.objToken) !== args.revision_id) {
        return failure('REVISION_CONFLICT', `${FAILURE_REASONS.REVISION_CONFLICT}（等待授权期间文档被修改）`)
      }
      const warnings: string[] = []
      // Each update names its base revision so a concurrent edit conflicts instead of landing on newer content.
      let revision = args.revision_id
      for (const [index, request] of requests.entries()) {
        if (exec.signal.aborted) return { ...failure('ABORTED', `已取消；前 ${index} 个操作已执行`), applied: index }
        let result
        try {
          result = await context.api.updateDocument(node.objToken, { ...request, revisionId: revision })
        } catch (error) {
          const reason = failureOf(error).reason
          return { ...failure('EDIT_FAILED', `第 ${index + 1} 个操作失败：${reason}；前 ${index} 个操作已执行`), applied: index }
        }
        warnings.push(...result.warnings)
        if (result.revisionId !== undefined) revision = result.revisionId
        if (result.result === 'failed') {
          return { ...failure('EDIT_FAILED', `第 ${index + 1} 个操作失败：${result.warnings.join('；') || '飞书返回 failed'}；前 ${index} 个操作已执行`), applied: index }
        }
        if (result.result === 'partial_success') {
          return { ...failure('EDIT_PARTIAL', `第 ${index + 1} 个操作只部分生效（${result.warnings.join('；') || '飞书返回 partial_success'}）；前 ${index} 个操作已执行，已停止后续操作；请用 feishu_wiki_read 读取核验后再继续`), applied: index, revision_id: revision }
        }
      }
      return {
        ok: true,
        title: node.title,
        node_token: node.nodeToken,
        url,
        applied: requests.length,
        revision_id: revision,
        warnings,
      }
    })
  }
}

// ---- Helpers ------------------------------------------------------------

/** Map one validated operation to a `docs_ai` update, or the reason it is incomplete. */
function updateRequestOf(operation: WikiEditOperation, format: WikiDocFormat): WikiUpdateRequest | string {
  switch (operation.command) {
    case 'append':
      return { command: 'block_insert_after', format, content: operation.content, blockId: '-1' }
    case 'insert_after':
      return { command: 'block_insert_after', format, content: operation.content, blockId: operation.block_id }
    case 'replace': {
      const range = rangeOf(operation)
      return typeof range === 'string' ? range : { command: 'block_replace', format, content: operation.content, ...range }
    }
    case 'delete': {
      const range = rangeOf(operation)
      return typeof range === 'string' ? range : { command: 'block_delete', format, ...range }
    }
    case 'str_replace':
      return { command: 'str_replace', format, pattern: operation.pattern, content: operation.content }
    case 'overwrite':
      return { command: 'overwrite', format, content: operation.content }
  }
}

/** `block_id` alone, or `start_block_id` + `end_block_id` together. */
function rangeOf(operation: { block_id?: string; start_block_id?: string; end_block_id?: string }):
  Pick<WikiUpdateRequest, 'blockId' | 'startBlockId' | 'endBlockId'> | string {
  const hasRange = operation.start_block_id !== undefined || operation.end_block_id !== undefined
  if (operation.block_id !== undefined && !hasRange) return { blockId: operation.block_id }
  if (operation.block_id === undefined && operation.start_block_id !== undefined && operation.end_block_id !== undefined) {
    return { startBlockId: operation.start_block_id, endBlockId: operation.end_block_id }
  }
  return '需要 block_id，或成对的 start_block_id 与 end_block_id（二者不能同时使用）'
}

/** The consent card's operation list. */
/** Consent-card details: a header, then one entry per operation so every operation stays visible. */
function operationLines(operations: readonly WikiEditOperation[]): string[] {
  const lines = operations.map((operation, index) => {
    const n = `${index + 1}.`
    switch (operation.command) {
      case 'append': return `${n} 在文末追加 ${operation.content.length} 字：${preview(operation.content)}`
      case 'insert_after': return `${n} 在块 \`${operation.block_id}\` 后插入 ${operation.content.length} 字：${preview(operation.content)}`
      case 'replace': return `${n} 替换${blockRangeLabel(operation)}为 ${operation.content.length} 字：${preview(operation.content)}`
      case 'delete': return `${n} 删除${blockRangeLabel(operation)}`
      case 'str_replace': return `${n} 把文本「${preview(operation.pattern)}」替换为「${preview(operation.content)}」`
      case 'overwrite': return `${n} ⚠️ 清空整篇并重写为 ${operation.content.length} 字：${preview(operation.content)}`
    }
  })
  return [`**将执行 ${operations.length} 个操作**`, ...lines]
}

function blockRangeLabel(operation: { block_id?: string; start_block_id?: string; end_block_id?: string }): string {
  return operation.block_id !== undefined
    ? `块 \`${operation.block_id}\``
    : `块 \`${operation.start_block_id ?? '?'}\` 到 \`${operation.end_block_id ?? '?'}\``
}


function isValue(value: unknown): value is WikiToolValue {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/**
 * Model-visible content of one call: a read returns its document content as
 * plain text after a short header; everything else is JSON.
 *
 * @param value The tool value.
 * @returns One text block.
 */
export function renderWikiResult(value: unknown): readonly ToolContentBlock[] {
  if (!isValue(value)) return [{ type: 'text', text: '知识库工具结果不可用' }]
  if (value.ok && 'content' in value) {
    const { content, ...meta } = value
    return [{ type: 'text', text: `${JSON.stringify(meta)}\n\n${content}` }]
  }
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * One-line result presentation.
 *
 * @param value The tool value.
 * @returns Display text.
 */
export function presentWikiResult(value: unknown): string {
  if (!isValue(value)) return '知识库工具结果不可用'
  if (!value.ok) return `失败（${value.code}）：${value.reason}`
  if ('items' in value) return `列出 ${value.items.length} 项`
  if ('records' in value && value.records !== undefined) return `已读取《${value.title}》（${value.records.length} 条记录）`
  if ('tables' in value) return `已读取《${value.title}》（${value.tables.length} 个数据表）`
  if ('content' in value) return `已读取《${value.title}》（${value.content.length} 字）`
  if ('applied' in value) return `已修改《${value.title}》（${value.applied} 个操作）`
  return `已新建《${value.title}》`
}

// ---- JSON Schemas advertised to the model --------------------------------

const REF_DESCRIPTION = '知识库节点链接 https://<租户>.feishu.cn/wiki/<node_token> 或 node_token'
const FORMAT_PROPERTY = { type: 'string', enum: ['markdown', 'xml'], description: '内容格式，默认 markdown；xml 读取时带 block id' }
const BLOCK_ID_PROPERTY = { type: 'string', description: '块 id（xml 读取结果中的 id 属性）' }

const LIST_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    parent: { type: 'string', description: `要列出子节点的位置：${REF_DESCRIPTION}，或知识空间链接 https://<租户>.feishu.cn/wiki/space/<space_id>；不传则列出可访问的根` },
    page_token: { type: 'string', description: '上一页返回的 page_token' },
  },
  additionalProperties: false,
}

const READ_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    format: FORMAT_PROPERTY,
    scope: { type: 'string', enum: ['full', 'outline', 'section', 'range', 'keyword'], description: '读取范围，默认 full' },
    start_block_id: { ...BLOCK_ID_PROPERTY, description: 'section 的标题块 id，或 range 的起点' },
    end_block_id: { ...BLOCK_ID_PROPERTY, description: 'range 的终点，-1 表示到文末' },
    keyword: { type: 'string', description: 'keyword 模式的关键词，多个用 | 分隔' },
    max_depth: { type: 'integer', description: 'outline：标题层级上限；其他：子树深度，-1 不限' },
  },
  required: ['doc'],
  additionalProperties: false,
}

const CREATE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    parent: { type: 'string', description: `父位置：${REF_DESCRIPTION}，或知识空间链接（建在空间顶层）` },
    title: { type: 'string', description: '标题' },
    type: { type: 'string', enum: ['docx', 'sheet', 'bitable'], description: '节点类型：docx 飞书文档（默认）、sheet 电子表格、bitable 多维表格' },
    content: { type: 'string', description: '文档正文（仅 docx，可选）' },
    format: FORMAT_PROPERTY,
  },
  required: ['parent', 'title'],
  additionalProperties: false,
}

const EDIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    revision_id: { type: 'integer', description: 'feishu_wiki_read 返回的 revision_id' },
    format: FORMAT_PROPERTY,
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: WIKI_EDIT_MAX_OPERATIONS,
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['append', 'insert_after', 'replace', 'delete', 'str_replace', 'overwrite'] },
          block_id: BLOCK_ID_PROPERTY,
          start_block_id: BLOCK_ID_PROPERTY,
          end_block_id: BLOCK_ID_PROPERTY,
          pattern: { type: 'string', description: 'str_replace 要查找的文本' },
          content: { type: 'string', description: '写入的内容' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  required: ['doc', 'revision_id', 'operations'],
  additionalProperties: false,
}
