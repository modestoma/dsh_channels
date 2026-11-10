/**
 * One in-process Peer per principal. A Peer's principal is fixed at creation,
 * so every `(kind, ids)` value gets its own Peer; Peers are created on first
 * use through `ctx.connection` (owned by the plugin's Context) and disposed
 * when the channel stops. A Peer grants nothing by itself: every call through
 * it is decided by the access policy (`./remote-policy.ts`) against the
 * route table at call time.
 *
 * @module dsh-channels/access/peers
 */

import type { HostConnection, PeerScope } from '../host/remote.ts'
import { principalKey, type ChannelPrincipal } from './principal.ts'

export interface PeerRegistryDeps {
  /** The host Connection service (read when the first Peer is needed). */
  connection(): HostConnection
  warn(message: string, ...args: unknown[]): void
}

export class PeerRegistry {
  private readonly peers = new Map<string, PeerScope>()

  constructor(private readonly deps: PeerRegistryDeps) {}

  /**
   * The Peer of a principal, created on first use.
   * @param principal - the caller identity.
   * @returns a live Peer whose `principal` equals the argument.
   */
  peerFor(principal: ChannelPrincipal): PeerScope {
    const key = principalKey(principal)
    const existing = this.peers.get(key)
    if (existing !== undefined && !existing.signal.aborted) return existing
    const peer = this.deps.connection().createPeer({ principal, interactions: 'none' })
    this.peers.set(key, peer)
    return peer
  }

  /** Number of live Peers (diagnostics). */
  size(): number {
    return this.peers.size
  }

  /** Dispose every Peer (channel stop). Never throws. */
  async clear(): Promise<void> {
    const peers = [...this.peers.values()]
    this.peers.clear()
    for (const peer of peers) {
      try {
        await peer.dispose()
      } catch (error) {
        this.deps.warn('dsh-channels: disposing Peer %s failed: %s', peer.id, String(error))
      }
    }
  }
}
