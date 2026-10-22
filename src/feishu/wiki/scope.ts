/**
 * `wikiRoots` containment: decides whether a wiki node lies inside one of the
 * configured roots before any wiki tool touches it.
 *
 * A space root contains every node of that space. A node root contains
 * itself and its descendants; descent is checked by walking the node's
 * parent chain with `spaces/get_node`, bounded by {@link MAX_PARENT_DEPTH}.
 * A node whose chain cannot be read is treated as outside (fail closed).
 *
 * @module dsh-channels/feishu/wiki/scope
 */

import type { WikiApi, WikiNode } from './api.ts'
import type { WikiRoot } from './links.ts'

/**
 * Longest parent chain walked for a node root. Feishu limits wiki depth well
 * below this; a longer chain is treated as outside.
 */
const MAX_PARENT_DEPTH = 64

/** The root a node was found under. */
export interface WikiContainment {
  readonly root: WikiRoot
}

/**
 * Find the configured root containing `node`.
 *
 * @param api Wiki endpoints (for parent lookups).
 * @param roots Configured roots.
 * @param node The node to check.
 * @returns The containing root, or `undefined` when none contains it.
 */
export async function containingRoot(
  api: WikiApi,
  roots: readonly WikiRoot[],
  node: WikiNode,
): Promise<WikiContainment | undefined> {
  for (const root of roots) {
    if (root.kind === 'space' && root.spaceId === node.spaceId) return { root }
  }
  const nodeRoots = roots.filter((root): root is Extract<WikiRoot, { kind: 'node' }> => root.kind === 'node')
  if (nodeRoots.length === 0) return undefined
  const byToken = new Map(nodeRoots.map(root => [root.nodeToken, root]))
  let current: WikiNode = node
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth += 1) {
    const match = byToken.get(current.nodeToken)
    if (match !== undefined) return { root: match }
    if (current.parentNodeToken === undefined) return undefined
    current = await api.getNode(current.parentNodeToken, 'wiki')
  }
  return undefined
}

/**
 * Whether a whole space (its top level) is inside the roots: only a space
 * root covers a space's top level.
 *
 * @param roots Configured roots.
 * @param spaceId The space.
 * @returns True when a space root names it.
 */
export function spaceIsRoot(roots: readonly WikiRoot[], spaceId: string): boolean {
  return roots.some(root => root.kind === 'space' && root.spaceId === spaceId)
}
