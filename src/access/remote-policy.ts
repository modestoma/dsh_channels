/**
 * Access policy of this channel's principals, registered with the host's
 * `remoteAccess` service: which Sessions a Feishu user (private chat) or a
 * group member may prompt through `session/prompt`.
 *
 * The bindings are derived from the route table at every decision, with the
 * same rule the channel plane applies (`AccessController.mayActOnRoute`): a
 * private-chat principal may prompt the Sessions of the private-chat routes
 * it owns; a group principal may prompt the Sessions of that group's routes
 * the admission matrix admits its user to. A group principal without a
 * speaker (the first turn of a topic launched for an external requester) may
 * prompt that group's routes opened without an initiator. No binding means the Gateway refuses the call with
 * `remote-access/denied`, which the submitter turns into a card notice.
 *
 * @module dsh-channels/access/remote-policy
 */

import { isGroupRoute } from '../domain.ts'
import type { RouteRecord } from '../domain.ts'
import type { RemoteAccess, RemoteAccessBinding, RemoteAccessRole } from '../host/remote.ts'
import {
  FEISHU_GROUP_PRINCIPAL_KIND, FEISHU_USER_PRINCIPAL_KIND,
  type ChannelPrincipal, type FeishuGroupPrincipal, type FeishuUserPrincipal,
} from './principal.ts'

/** Prompting a Session this channel routes. */
export const CHANNEL_PROMPT_ROLE: RemoteAccessRole = {
  name: 'dsh-channels:prompt',
  resource: 'session',
  actions: ['session/prompt'],
}

/** Reason a refused prompt reports. */
export const ROUTE_NOT_PERMITTED = 'feishu-route-not-permitted'

export interface ChannelAccessPolicyDeps {
  /** Every active route. */
  routes(): Iterable<RouteRecord>
  /** The channel-plane rule: may `userId`, acting in `chatId`, continue the route. */
  mayActOnRoute(userId: string, chatId: string, record: RouteRecord): boolean
}

/**
 * The Sessions a principal may prompt now.
 * @param deps - route table and the channel-plane rule.
 * @param principal - the caller.
 * @returns one binding per permitted route.
 */
export function channelAccessBindings(deps: ChannelAccessPolicyDeps, principal: ChannelPrincipal): RemoteAccessBinding[] {
  const bindings: RemoteAccessBinding[] = []
  for (const record of deps.routes()) {
    if (!routePermits(deps, principal, record)) continue
    bindings.push({ role: CHANNEL_PROMPT_ROLE, resource: { kind: 'session', id: record.sessionId } })
  }
  return bindings
}

function routePermits(deps: ChannelAccessPolicyDeps, principal: ChannelPrincipal, record: RouteRecord): boolean {
  switch (principal.kind) {
    case FEISHU_USER_PRINCIPAL_KIND:
      return !isGroupRoute(record) && deps.mayActOnRoute(principal.userId, record.chatId, record)
    case FEISHU_GROUP_PRINCIPAL_KIND:
      if (!isGroupRoute(record) || record.chatId !== principal.chatId) return false
      return principal.userId === undefined
        ? record.senderUserId === undefined
        : deps.mayActOnRoute(principal.userId, principal.chatId, record)
    default:
      return assertNever(principal)
  }
}

/**
 * Register the policies of both principal kinds.
 * @param remoteAccess - the host service.
 * @param deps - route table and the channel-plane rule.
 * @returns the disposer removing both policies.
 */
export function registerChannelAccessPolicies(remoteAccess: RemoteAccess, deps: ChannelAccessPolicyDeps): () => void {
  const disposers = [
    remoteAccess.registerPolicy<FeishuUserPrincipal>(FEISHU_USER_PRINCIPAL_KIND, {
      bindings: principal => channelAccessBindings(deps, principal),
      explain: () => ROUTE_NOT_PERMITTED,
    }),
    remoteAccess.registerPolicy<FeishuGroupPrincipal>(FEISHU_GROUP_PRINCIPAL_KIND, {
      bindings: principal => channelAccessBindings(deps, principal),
      explain: () => ROUTE_NOT_PERMITTED,
    }),
  ]
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected principal: ${JSON.stringify(value)}`)
}
