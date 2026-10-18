/**
 * dsh-channels client half: 设置 →「飞书渠道」分区。
 *
 * 只依赖平台核心的 `slots` 服务与 react（bundle 里 react 走平台模块表，
 * 其余全部内联）。页面数据来自 Host 半侧的 `/dsh-channels/*` 路由，因此
 * 不需要 typert 契约，也不 import 任何 DSH 客户端包。
 *
 * @module dsh-channels/client
 */

import { PANEL_COPY } from '../settings/contract.ts'
import { FeishuChannelsSection } from './panel.tsx'
import { installStyles } from './styles.ts'

// 平台 client runtime 的最小结构声明：只声明本 bundle 用到的两个能力。
// 与安装的 DSH Web 版本（0.2.x）的 slots 运行时 API 一致。
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(
    declaration: {
      name: string
      id: string
      order?: number
      label: () => string
    },
    component: (props: { close?: () => void }) => unknown,
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

/** Section id and nav order (built-ins: account -10, general 0, models 10, plugins 15, agent-presets 20). */
export const SETTINGS_SECTION_ID = 'feishu-channels'
export const SETTINGS_SECTION_ORDER = 40

/**
 * Mount the settings section and its stylesheet.
 * @param ctx - client plugin context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => installStyles(), 'dsh-channels: settings styles')
  } else {
    installStyles()
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => PANEL_COPY.title,
  }, FeishuChannelsSection))
}
