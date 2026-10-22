/**
 * Wiki tools: root containment, the wiki whitelist gate, topic-owner consent
 * cards, app ownership and revision checks, and the OpenAPI request bodies.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ToolDefinition, ToolRuntime } from '../src/host/agent.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { CardActionEvent } from '../src/feishu-channel.ts'
import { createWikiApi } from '../src/feishu/wiki/api.ts'
import type { WikiApi, WikiNode, WikiRawRequest, WikiUpdateRequest, WikiUpdateResult } from '../src/feishu/wiki/api.ts'
import { WikiConsent } from '../src/feishu/wiki/consent.ts'
import { parseWikiRef, parseWikiRootLink } from '../src/feishu/wiki/links.ts'
import {
  WIKI_CREATE_TOOL_NAME, WIKI_EDIT_TOOL_NAME, WIKI_LIST_TOOL_NAME, WIKI_READ_TOOL_NAME, WikiToolRuntime,
  renderWikiResult,
} from '../src/feishu/wiki/tools.ts'
import { makeAgentContext, makeChannel } from './helpers.ts'

const SPACE_LINK = 'https://mi.feishu.cn/wiki/space/7160145948494381236'
const NODE_LINK = 'https://mi.feishu.cn/wiki/wikcnRootNode0001'

function node(partial: Partial<WikiNode> & Pick<WikiNode, 'nodeToken'>): WikiNode {
  return {
    spaceId: '7160145948494381236',
    objToken: `doc_${partial.nodeToken}`,
    objType: 'docx',
    nodeType: 'origin',
    title: partial.nodeToken,
    hasChild: false,
    ...partial,
  }
}

/** A small tree: space A holds root → child → grandchild; space B holds other. */
function fakeApi() {
  const nodes = new Map<string, WikiNode>([
    ['wikcnRootNode0001', node({ nodeToken: 'wikcnRootNode0001', title: '团队空间根', hasChild: true })],
    ['wikcnChildNode001', node({ nodeToken: 'wikcnChildNode001', parentNodeToken: 'wikcnRootNode0001', title: '子页面', owner: 'bot-open-id' })],
    ['wikcnHumanDoc0001', node({ nodeToken: 'wikcnHumanDoc0001', parentNodeToken: 'wikcnRootNode0001', title: '人写的', owner: 'ou_human' })],
    ['wikcnSheetNode001', node({ nodeToken: 'wikcnSheetNode001', parentNodeToken: 'wikcnRootNode0001', objType: 'sheet' })],
    ['wikcnOtherSpace01', node({ nodeToken: 'wikcnOtherSpace01', spaceId: '999', title: '别的空间' })],
  ])
  const api = {
    updates: [] as Array<{ documentId: string; request: WikiUpdateRequest }>,
    revision: 7,
    getNode: vi.fn(async (token: string) => {
      const found = nodes.get(token)
      if (found === undefined) throw new FeishuApiError('code=131005 not found', 131005)
      return found
    }),
    spaceName: vi.fn(async () => '研发知识库'),
    listChildren: vi.fn(async (_spaceId: string, parent: string | undefined) => ({
      items: [...nodes.values()].filter(item => item.parentNodeToken === parent && item.spaceId === '7160145948494381236'),
    })),
    createDocxNode: vi.fn(async (spaceId: string, parent: string | undefined, title: string) => {
      const created = node({ nodeToken: 'wikcnCreated00001', spaceId, ...(parent === undefined ? {} : { parentNodeToken: parent }), title, owner: 'bot-open-id' })
      nodes.set(created.nodeToken, created)
      return created
    }),
    documentRevision: vi.fn(async () => api.revision),
    fetchDocument: vi.fn(async () => ({ revisionId: api.revision, content: '# 标题\n正文' })),
    updateDocument: vi.fn(async (documentId: string, request: WikiUpdateRequest): Promise<WikiUpdateResult> => {
      api.updates.push({ documentId, request })
      api.revision += 1
      return { result: 'success', revisionId: api.revision, warnings: [] }
    }),
  }
  return api satisfies WikiApi
}

interface Harness {
  channel: ReturnType<typeof makeChannel>
  api: ReturnType<typeof fakeApi>
  consent: WikiConsent
  definitions: Map<string, ToolDefinition>
  run(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  /** Wait for the newest consent card and click it. */
  click(decision: 'allow' | 'deny', userId?: string): Promise<void>
}

async function setup(options: {
  roots?: string[]
  read?: boolean
  write?: boolean
  allowed?: boolean
} = {}): Promise<Harness> {
  const config = resolveConfig({
    wikiRoots: options.roots ?? [NODE_LINK],
    feishuTools: { wikiRead: options.read ?? true, wikiWrite: options.write ?? true },
  })
  const api = fakeApi()
  const base = makeChannel()
  const channel = Object.assign(base, { wiki: api })
  const consent = new WikiConsent({ channel: () => channel, timeoutMs: () => 60_000, onError: () => {} })
  const runtime = new WikiToolRuntime({
    config: () => config,
    channel: () => channel,
    routeOfSession: id => (id === 's1' ? { chatId: 'oc_1', cardMessageId: 'om_card', inThread: true, senderUserId: 'u_owner' } : undefined),
    mayUseWiki: () => options.allowed ?? true,
    consent,
    warn: vi.fn(),
  })
  const definitions = new Map<string, ToolDefinition>()
  const ctx = makeAgentContext()
  ctx.tools = { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) } } as unknown as ToolRuntime
  await runtime.mount(ctx, 's1')
  return {
    channel, api, consent, definitions,
    async run(tool, args, signal) {
      const definition = definitions.get(tool)
      if (definition === undefined) throw new Error(`${tool} not mounted`)
      return await definition.execute(args, { signal: signal ?? new AbortController().signal }) as Record<string, unknown>
    },
    async click(decision, userId = 'u_owner') {
      await vi.waitFor(() => expect(consent.pendingCount()).toBeGreaterThan(0))
      await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0))
      const event: CardActionEvent = {
        messageId: `om_${channel.sent.length}`,
        chatId: 'oc_1',
        operator: { openId: 'ou_x', userId },
        action: { value: { decision }, tag: 'button' },
      }
      consent.onCardAction(event)
    },
  }
}

describe('wiki links', () => {
  it('accepts space and node links and rejects everything else', () => {
    expect(parseWikiRootLink(SPACE_LINK)).toEqual({ ok: true, root: { kind: 'space', spaceId: '7160145948494381236', link: SPACE_LINK } })
    expect(parseWikiRootLink(` ${NODE_LINK} `)).toEqual({ ok: true, root: { kind: 'node', nodeToken: 'wikcnRootNode0001', link: NODE_LINK } })
    expect(parseWikiRootLink('http://mi.feishu.cn/wiki/space/1')).toEqual({ ok: false, error: 'not-https' })
    expect(parseWikiRootLink('https://mi.feishu.cn/docx/abcdefgh123')).toEqual({ ok: false, error: 'not-a-wiki-link' })
    expect(parseWikiRootLink('not a url')).toEqual({ ok: false, error: 'not-a-url' })
    expect(() => resolveConfig({ wikiRoots: ['https://mi.feishu.cn/drive/folder/x'] })).toThrow(/wikiRoots/)
  })

  it('parses tool references', () => {
    expect(parseWikiRef('wikcnChildNode001')).toEqual({ kind: 'node', token: 'wikcnChildNode001' })
    expect(parseWikiRef('https://mi.feishu.cn/docx/doxcnAbcdefgh12?from=x')).toEqual({ kind: 'docx', token: 'doxcnAbcdefgh12' })
    expect(parseWikiRef(SPACE_LINK)).toEqual({ kind: 'space', spaceId: '7160145948494381236' })
    expect(parseWikiRef('../etc')).toBeUndefined()
  })
})

describe('wiki tool mounting and gates', () => {
  it('mounts nothing without roots and only the enabled tool sets otherwise', async () => {
    expect([...(await setup({ roots: [] })).definitions.keys()]).toEqual([])
    expect([...(await setup({ write: false })).definitions.keys()]).toEqual([WIKI_LIST_TOOL_NAME, WIKI_READ_TOOL_NAME])
    expect([...(await setup({ read: false })).definitions.keys()]).toEqual([WIKI_CREATE_TOOL_NAME, WIKI_EDIT_TOOL_NAME])
  })

  it('refuses topic owners outside the wiki whitelist', async () => {
    const h = await setup({ allowed: false })
    expect(await h.run(WIKI_LIST_TOOL_NAME, {})).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
  })

  it('lists roots and children without a card, and rejects nodes outside the roots', async () => {
    const h = await setup()
    expect(await h.run(WIKI_LIST_TOOL_NAME, {})).toMatchObject({
      ok: true, kind: 'roots', items: [{ root: 'node', title: '团队空间根', node_token: 'wikcnRootNode0001' }],
    })
    const children = await h.run(WIKI_LIST_TOOL_NAME, { parent: NODE_LINK })
    expect(children).toMatchObject({ ok: true, kind: 'children' })
    expect((children.items as Array<{ node_token: string; owned_by_app: boolean }>).map(item => [item.node_token, item.owned_by_app]))
      .toEqual([['wikcnChildNode001', true], ['wikcnHumanDoc0001', false], ['wikcnSheetNode001', false]])
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnOtherSpace01' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: SPACE_LINK })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnMissing00001' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(h.channel.sent).toEqual([])
  })

  it('treats a space root as covering the whole space', async () => {
    const h = await setup({ roots: [SPACE_LINK] })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: SPACE_LINK })).toMatchObject({ ok: true, kind: 'children' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnOtherSpace01' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
  })
})

describe('feishu_wiki_read', () => {
  it('asks the topic owner once per document, ignores other clickers, then reads without a card', async () => {
    const h = await setup()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001', format: 'xml', scope: 'outline' })
    await h.click('allow', 'u_stranger')
    expect(h.consent.pendingCount()).toBe(1)
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, title: '子页面', revision_id: 7, format: 'xml', editable: true, content: '# 标题\n正文' })
    expect(h.api.fetchDocument).toHaveBeenCalledWith('doc_wikcnChildNode001', { format: 'xml', withBlockIds: true, scope: 'outline' })
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('读取文档')
    expect(card).toContain('研发知识库 / 团队空间根')
    expect(h.channel.sent[0]?.options).toEqual({ replyTo: 'om_card', replyInThread: true })
    expect(JSON.stringify(h.channel.updated.map(update => update.card))).toContain('仅发起该话题的用户可操作此卡片')

    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001' })).toMatchObject({ ok: true })
    expect(h.channel.sent).toHaveLength(1)
  })

  it('reports a denial and rejects non-docx nodes before asking', async () => {
    const h = await setup()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnHumanDoc0001' })
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
    expect(h.api.fetchDocument).not.toHaveBeenCalled()
    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnSheetNode001' })).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' })
  })

  it('withdraws the card when the call is aborted', async () => {
    const h = await setup()
    const controller = new AbortController()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001' }, controller.signal)
    await vi.waitFor(() => expect(h.consent.pendingCount()).toBe(1))
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'ABORTED' })
  })

  it('renders the document content after a JSON header', () => {
    const [block] = renderWikiResult({ ok: true, title: 't', node_token: 'n', url: 'u', revision_id: 1, format: 'markdown', editable: false, content: 'body' })
    expect(block).toEqual({ type: 'text', text: '{"ok":true,"title":"t","node_token":"n","url":"u","revision_id":1,"format":"markdown","editable":false}\n\nbody' })
  })
})

describe('feishu_wiki_create', () => {
  it('creates under a contained parent after consent and writes the content at the end', async () => {
    const h = await setup()
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '周报', content: '## 本周\n- 完成' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, title: '周报', node_token: 'wikcnCreated00001', revision_id: 8 })
    expect(h.api.createDocxNode).toHaveBeenCalledWith('7160145948494381236', 'wikcnRootNode0001', '周报')
    expect(h.api.updates).toEqual([{
      documentId: 'doc_wikcnCreated00001',
      request: { command: 'block_insert_after', format: 'markdown', content: '## 本周\n- 完成', blockId: '-1' },
    }])
    expect(JSON.stringify(h.channel.sent[0]?.input)).toContain('新建文档')
    // The approved document reads back without another card.
    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnCreated00001' })).toMatchObject({ ok: true })
    expect(h.channel.sent).toHaveLength(1)
  })

  it('asks every time and keeps the space top level to space roots', async () => {
    const h = await setup()
    expect(await h.run(WIKI_CREATE_TOOL_NAME, { parent: SPACE_LINK, title: 'x' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: 'wikcnChildNode001', title: '空文档' })
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
    expect(h.api.createDocxNode).not.toHaveBeenCalled()
  })

  it('reports the created document when writing its content fails', async () => {
    const h = await setup()
    h.api.updateDocument.mockRejectedValueOnce(new FeishuApiError('code=1 bad markdown', 1))
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '坏内容', content: 'x' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'CONTENT_FAILED', node_token: 'wikcnCreated00001' })
  })
})

describe('feishu_wiki_edit', () => {
  it('edits an app-owned document at the read revision after consent', async () => {
    const h = await setup()
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001',
      revision_id: 7,
      format: 'xml',
      operations: [
        { command: 'append', content: '<p>尾部</p>' },
        { command: 'replace', start_block_id: 'blkA', end_block_id: 'blkB', content: '<p>新</p>' },
        { command: 'delete', block_id: 'blkC' },
        { command: 'str_replace', pattern: '旧词', content: '' },
      ],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, applied: 4, revision_id: 11 })
    expect(h.api.updates.map(update => update.request)).toEqual([
      { command: 'block_insert_after', format: 'xml', content: '<p>尾部</p>', blockId: '-1', revisionId: 7 },
      { command: 'block_replace', format: 'xml', content: '<p>新</p>', startBlockId: 'blkA', endBlockId: 'blkB', revisionId: 8 },
      { command: 'block_delete', format: 'xml', blockId: 'blkC', revisionId: 9 },
      { command: 'str_replace', format: 'xml', pattern: '旧词', content: '', revisionId: 10 },
    ])
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('将执行 4 个操作')
  })

  it('keeps every operation on the consent card', async () => {
    const h = await setup()
    const long = 'x'.repeat(500)
    const operations = [
      ...Array.from({ length: 19 }, () => ({ command: 'append', content: long })),
      { command: 'overwrite', content: '全新内容' },
    ]
    const pending = h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 7, operations })
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1))
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('20. ⚠️ 清空整篇并重写')
    expect(card).not.toContain('已截断')
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
  })

  it('refuses documents the app does not own and stale revisions without a card', async () => {
    const h = await setup()
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnHumanDoc0001', revision_id: 7, operations: [{ command: 'append', content: 'x' }] }))
      .toMatchObject({ ok: false, code: 'NOT_OWNED' })
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 3, operations: [{ command: 'append', content: 'x' }] }))
      .toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision_id: 7 })
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 7, operations: [{ command: 'delete' }] }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    expect(h.channel.sent).toEqual([])
  })

  it('stops at the first failed operation and reports how many were applied', async () => {
    const h = await setup()
    h.api.updateDocument
      .mockImplementationOnce(async () => ({ result: 'success', revisionId: 8, warnings: [] }))
      .mockImplementationOnce(async () => ({ result: 'failed', warnings: ['block not found'] }))
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001', revision_id: 7,
      operations: [{ command: 'append', content: 'a' }, { command: 'insert_after', block_id: 'blkX', content: 'b' }, { command: 'append', content: 'c' }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'EDIT_FAILED', applied: 1 })
    expect(h.api.updateDocument).toHaveBeenCalledTimes(2)
  })

  it('stops at a partially applied operation and asks for verification', async () => {
    const h = await setup()
    h.api.updateDocument.mockImplementationOnce(async () => ({ result: 'partial_success', revisionId: 8, warnings: ['some blocks skipped'] }))
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001', revision_id: 7,
      operations: [{ command: 'overwrite', content: 'a' }, { command: 'append', content: 'b' }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'EDIT_PARTIAL', applied: 0, revision_id: 8 })
    expect(h.api.updateDocument).toHaveBeenCalledTimes(1)
  })
})

describe('createWikiApi', () => {
  it('sends the wiki and docs_ai requests and maps Feishu errors', async () => {
    const calls: Array<Parameters<WikiRawRequest>[0]> = []
    const responses: unknown[] = [
      { code: 0, data: { node: { space_id: '1', node_token: 'n', obj_token: 'd', obj_type: 'docx', node_type: 'origin', title: 'T', owner: 'ou_b', parent_node_token: '' } } },
      { code: 0, data: { document: { revision_id: 3, content: '<p id="b1">x</p>' } } },
      { code: 0, data: { result: 'partial_success', warnings: ['w', 1], document: { revision_id: 4 } } },
      { code: 131006, msg: 'no permission' },
    ]
    const request = (async (input: Parameters<WikiRawRequest>[0]) => {
      calls.push(input)
      return responses.shift()
    }) as WikiRawRequest
    const api = createWikiApi(request)
    expect(await api.getNode('n', 'wiki')).toEqual({
      spaceId: '1', nodeToken: 'n', objToken: 'd', objType: 'docx', nodeType: 'origin', title: 'T', hasChild: false, owner: 'ou_b',
    })
    expect(await api.fetchDocument('d', { format: 'xml', withBlockIds: true, scope: 'keyword', keyword: 'a|b' }))
      .toEqual({ revisionId: 3, content: '<p id="b1">x</p>' })
    expect(await api.updateDocument('d', { command: 'block_delete', format: 'markdown', blockId: 'b1', revisionId: 3 }))
      .toEqual({ result: 'partial_success', revisionId: 4, warnings: ['w'] })
    await expect(api.spaceName('1')).rejects.toMatchObject({ code: 131006 })
    expect(calls).toEqual([
      { method: 'GET', url: '/open-apis/wiki/v2/spaces/get_node', params: { token: 'n', obj_type: 'wiki' } },
      {
        method: 'POST',
        url: '/open-apis/docs_ai/v1/documents/d/fetch',
        data: {
          format: 'xml',
          export_option: { export_block_id: true, export_style_attrs: false, export_cite_extra_data: false },
          read_option: { read_mode: 'keyword', keyword: 'a|b' },
        },
      },
      { method: 'PUT', url: '/open-apis/docs_ai/v1/documents/d', data: { format: 'markdown', command: 'block_delete', block_id: 'b1', revision_id: 3 } },
      { method: 'GET', url: '/open-apis/wiki/v2/spaces/1' },
    ])
  })
})
