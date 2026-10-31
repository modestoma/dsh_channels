/**
 * Bridge from the panel to the DSH Web shell's Session navigation: the client
 * half stores the `uiWorkspace` service while it is available, and the
 * 「会话记录」 tab opens Sessions through it.
 *
 * @module dsh-channels/client/navigation
 */

import { useSyncExternalStore } from 'react'

/** The slice of the shell's `uiWorkspace` service the panel calls. */
export interface SessionNavigator {
  /** Select a Session and show its conversation in the main view. */
  openSession(sessionId: string): void
}

let current: SessionNavigator | undefined
const listeners = new Set<() => void>()

/**
 * Publish the navigator (or its removal) to every subscribed panel.
 * @param navigator - the shell service, or undefined once it is disposed.
 */
export function setSessionNavigator(navigator: SessionNavigator | undefined): void {
  current = navigator
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The current navigator; undefined while the shell provides none.
 * @returns the navigator, re-rendering when it appears or goes away.
 */
export function useSessionNavigator(): SessionNavigator | undefined {
  return useSyncExternalStore(subscribe, () => current, () => current)
}
