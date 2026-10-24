/**
 * dsh-channels client half: 左侧栏全局入口「飞书渠道」+ 主区整页设置面板。
 *
 * 只依赖平台核心的 `slots` 服务与 react（bundle 里 react 走平台模块表，
 * 其余全部内联）。页面数据来自 Host 半侧的 `/dsh-channels/*` 路由，因此
 * 不需要 typert 契约，也不 import 任何 DSH 客户端包。
 *
 * @module dsh-channels/client
 */

import { PANEL_COPY } from '../settings/contract.ts'
import { FeishuChannelsIcon } from './icon.tsx'
import { FeishuChannelsPage } from './panel/index.tsx'
import { installStyles } from './styles.ts'

// 平台 client runtime 的最小结构声明：只声明本 bundle 用到的两个能力。
// 与安装的 DSH Web 版本（0.2.x）的 slots 运行时 API 一致：list 槽按 `id`
// 注册，keyed 槽按 `key` 注册。
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(
    declaration:
      | { name: string; id: string; order?: number; label: () => string }
      | { name: string; key: string },
    component: (props: never) => unknown,
  ): () => void
}

export interface ClientContext {
  slots: ClientSlots
  effect?(callback: () => void | (() => void), label?: string): void
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

/**
 * Mount the left-sidebar entry, its main-column page, and the stylesheet.
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
}
