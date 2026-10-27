/**
 * 左侧栏「飞书渠道」行的装饰图标；行本身负责可访问名称（列表注册的 label）。
 *
 * @module dsh-channels/client/icon
 */

/** Owner share of `sidebar.panellist`: requested square edge and selection state. */
export interface FeishuChannelsIconProps {
  size: number
  active: boolean
}

/**
 * Paper-plane glyph drawn in `currentColor`, so it follows the row's text color.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function FeishuChannelsIcon({ size }: FeishuChannelsIconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 3 3.5 10.2a.6.6 0 0 0 0 1.1l6.6 2.6 2.6 6.6a.6.6 0 0 0 1.1 0L21 3Z" />
      <path d="m10.1 13.9 4.4-4.4" />
    </svg>
  )
}
