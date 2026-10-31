/**
 * Line icons for the 「会话记录」 tab (16 px grid, `currentColor` strokes).
 * All are decorative: their buttons and rows carry the accessible names.
 *
 * @module dsh-channels/client/panel/records-icons
 */

import type { ReactNode } from 'react'
import type { FileKind } from './records-format.ts'

function Icon(props: { size?: number; className?: string; children: ReactNode }): JSX.Element {
  const { size = 16, className, children } = props
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Disclosure chevron; rotated by CSS while expanded. */
export function ChevronIcon(props: { className?: string }): JSX.Element {
  return <Icon size={14} className={props.className}><path d="M6 4l4 4-4 4" /></Icon>
}

export function SearchIcon(): JSX.Element {
  return <Icon><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25 13.5 13.5" /></Icon>
}

export function RefreshIcon(props: { className?: string }): JSX.Element {
  return <Icon className={props.className}><path d="M13 8a5 5 0 1 1-1.5-3.55" /><path d="M13 2.5v2.5h-2.5" /></Icon>
}

export function BackIcon(): JSX.Element {
  return <Icon><path d="M10 3.5 5.5 8l4.5 4.5" /></Icon>
}

export function OpenIcon(): JSX.Element {
  return <Icon size={14}><path d="M6 3.5h6.5V10" /><path d="M12.5 3.5 4 12" /></Icon>
}

export function DownloadIcon(): JSX.Element {
  return <Icon><path d="M8 2.5v8" /><path d="M4.75 7.5 8 10.75l3.25-3.25" /><path d="M3 13.5h10" /></Icon>
}

/** Folder glyph used on the user rows' files button. */
export function FolderIcon(props: { className?: string }): JSX.Element {
  return (
    <Icon className={props.className}>
      <path d="M2 4.5c0-.55.45-1 1-1h3.1l1.4 1.5H13c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" />
    </Icon>
  )
}

/**
 * Entry icon by file family; folders and images are tinted through CSS
 * modifier classes.
 */
export function FileKindIcon(props: { kind: FileKind }): JSX.Element {
  const className = `dsh-channels-rec__icon dsh-channels-rec__icon--${props.kind}`
  switch (props.kind) {
    case 'dir':
      return (
        <svg className={className} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 4.25c0-.69.56-1.25 1.25-1.25h3.3l1.45 1.5h5.75c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25z" fill="currentColor" />
        </svg>
      )
    case 'image':
      return (
        <Icon className={className}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          <circle cx="6" cy="6" r="1.1" />
          <path d="m3 12 3.5-3.5 2.5 2.5 1.75-1.75L13 11.5" />
        </Icon>
      )
    case 'code':
      return <Icon className={className}><path d="M5.5 5 2.5 8l3 3" /><path d="M10.5 5l3 3-3 3" /><path d="M9 3.5 7 12.5" /></Icon>
    case 'text':
      return (
        <Icon className={className}>
          <path d="M4 1.75h5.25L12.5 5v8.75c0 .28-.22.5-.5.5H4a.5.5 0 0 1-.5-.5V2.25c0-.28.22-.5.5-.5z" />
          <path d="M5.75 8h4.5M5.75 10.5h4.5M5.75 5.5h2" />
        </Icon>
      )
    case 'archive':
      return (
        <Icon className={className}>
          <path d="M4 1.75h8c.28 0 .5.22.5.5v11.5c0 .28-.22.5-.5.5H4a.5.5 0 0 1-.5-.5V2.25c0-.28.22-.5.5-.5z" />
          <path d="M8 2v1.5M8 4.5V6M8 7v1.5" />
          <rect x="6.75" y="9" width="2.5" height="2.5" rx=".5" />
        </Icon>
      )
    case 'file':
      return (
        <Icon className={className}>
          <path d="M4 1.75h5.25L12.5 5v8.75c0 .28-.22.5-.5.5H4a.5.5 0 0 1-.5-.5V2.25c0-.28.22-.5.5-.5z" />
          <path d="M9.25 1.75V5h3.25" />
        </Icon>
      )
  }
}
