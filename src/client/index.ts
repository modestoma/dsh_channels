/**
 * dsh-channels client half: 左侧栏全局入口「飞书渠道」+ 主区整页设置面板，
 * 以及对话内的「飞书来源」（会话头部入口 + 右侧栏标签页）。
 *
 * 只依赖平台核心的 `slots` 服务与 react（bundle 里 react 走平台模块表，
 * 其余全部内联）；右侧栏服务存在时才注册来源标签页。页面数据来自 Host
 * 半侧的 `/dsh-channels/*` 路由，因此不需要 typert 契约，也不 import 任何
 * DSH 客户端包。
 *
 * @module dsh-channels/client
 */

import { PANEL_COPY } from '../settings/contract.ts'
import { FeishuChannelsIcon } from './icon.tsx'
import { ORIGIN_TAB_ID, ORIGIN_TAB_KIND, ORIGIN_TAB_TITLE, OriginHeaderAction, OriginTab } from './origin.tsx'
import { FeishuChannelsPage } from './panel/index.tsx'
import { installStyles } from './styles.ts'

// 平台 client runtime 的最小结构声明：只声明本 bundle 用到的能力。
// 与安装的 DSH Web 版本（0.2.x）的 slots 运行时 API 一致：list 槽按 `id`
// 注册，keyed 槽按 `key` 注册；`inject` 回调按会话作用域槽收到 sessionId。
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(
    declaration:
      | { name: string; id: string; order?: number; label?: () => string; inject?: (sessionId: string) => object }
      | { name: string; key: string },
    component: (props: never) => unknown,
  ): () => void
}

/** Static right-sidebar tab type (`ctx.sidebarRightTabs.register`). */
export interface SidebarRightTabDefinition {
  id: string
  kind: string
  title: (address: string) => string
}

/** Right-sidebar services the origin tab needs. */
export interface SidebarRightScope extends ClientContext {
  sidebarRightTabs: { register(definition: SidebarRightTabDefinition): () => void }
  sidebarRight: { openTab(kind: string): void }
}

export interface ClientContext {
  slots: ClientSlots
  effect?(callback: () => void | (() => void), label?: string): void
  /** Run `callback` in a child scope while every named service is available. */
  inject?(deps: string[], callback: (scope: SidebarRightScope) => void): void
}

/** Cordis client plugin name. */
export const name = 'dsh-channels'

/** Required client services: the Slots registry is part of the web shell core. */
export const inject = ['slots']

/**
 * Main panel id: the `sidebar.panellist` row id and the matching `main` slot key.
 * Must not change once released: DSH keys navigation state by it.
 */
export const PANEL_ID = 'feishu-channels'
/** Left-sidebar row order (built-ins: tasks 10; Plugins is pinned last by the sidebar). */
export const PANEL_ORDER = 40
/** Session header action order (after the preset label -10 and subagents 10). */
export const ORIGIN_ACTION_ORDER = 30

/**
 * Mount the left-sidebar entry, its main-column page, the stylesheet, and —
 * while the right sidebar is present — the Feishu origin header entry and tab.
 * @param ctx - client plugin context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => installStyles(), 'dsh-channels: panel styles')
  } else {
    installStyles()
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, FeishuChannelsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => PANEL_COPY.title,
  }, FeishuChannelsIcon))
  ctx.inject?.(['sidebarRightTabs', 'sidebarRight'], mountOrigin)
}

/**
 * Register the origin tab type, its body and title, and the header entry that
 * opens it. Everything lives as long as the right-sidebar services do.
 * @param scope - child context holding the right-sidebar services.
 */
export function mountOrigin(scope: SidebarRightScope): void {
  const definition: SidebarRightTabDefinition = {
    id: ORIGIN_TAB_ID,
    kind: ORIGIN_TAB_KIND,
    title: () => ORIGIN_TAB_TITLE,
  }
  scope.effect?.(() => scope.sidebarRightTabs.register(definition), 'dsh-channels: origin tab type')
  scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ORIGIN_TAB_ID,
  }, OriginTab))
  scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
    name: 'conversation.session.header.actions',
    id: 'dsh-channels-origin',
    order: ORIGIN_ACTION_ORDER,
    inject: () => ({
      openOrigin: () => { scope.sidebarRight.openTab(ORIGIN_TAB_KIND) },
    }),
  }, OriginHeaderAction))
}
