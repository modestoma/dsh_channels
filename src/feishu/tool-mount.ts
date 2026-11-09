/**
 * Registering channel tools inside each Agent scope. `inject(['tools'])` is
 * the registration path; the callback re-checks the service because a host
 * may resolve the injection with a partially mounted scope. A missing or slow
 * `tools` service never blocks session creation: the wait is bounded, the
 * pending injection still registers the tools if the service appears later,
 * and each kind of failure is warned once.
 *
 * @module dsh-channels/feishu/tool-mount
 */

import type { AgentContext, ToolDefinition } from '../host/index.ts'

/**
 * Maximum time agent setup waits for the host `tools` service
 * before degrading to "tool not mounted". A deployment without those services
 * must not block session creation; if they appear later the pending injection
 * still registers the tool.
 */
export const MOUNT_INJECT_WAIT_MS = 2_000

/** Retry wait for later sessions once the first mount timed out (fast-fail). */
export const MOUNT_INJECT_RETRY_WAIT_MS = 250

/**
 * Wait for one cordis injection to settle, but never longer than `timeoutMs`:
 * a hard dependency on a service a deployment does not mount would otherwise
 * block agent creation forever.
 * @param task - the injection.
 * @param timeoutMs - longest wait.
 * @returns how the wait ended.
 */
export function waitForAvailability(
  task: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<'ready' | 'failed' | 'timeout'> {
  return new Promise<'ready' | 'failed' | 'timeout'>((resolve) => {
    let settled = false
    const finish = (outcome: 'ready' | 'failed' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    timer.unref?.()
    Promise.resolve(task).then(
      () => finish('ready'),
      () => finish('failed'),
    )
  })
}

export interface AgentToolMountOptions {
  /** Names the tools in warnings. */
  label: string
  /** Whether any tool is mounted at all under the live configuration. */
  enabled(): boolean
  /** The tools to register for one Session, read when the scope is injected. */
  definitions(sessionId: string): ToolDefinition[]
  /** Text of a registration error. */
  describeError(error: unknown): string
  warn(message: string, ...args: unknown[]): void
}

/** One family of channel tools mounted per Agent scope. */
export class AgentToolMount {
  /** One attempt per outer Agent scope. */
  private readonly attempts = new WeakMap<AgentContext, Promise<void>>()
  private warnedUnavailable = false
  private warnedMissingTools = false
  private warnedMountFailure = false

  constructor(private readonly options: AgentToolMountOptions) {}

  /**
   * Register the tools inside one Agent scope.
   * @param agentCtx - the Agent scope.
   * @param sessionId - the Session the tools act for.
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    if (!this.options.enabled()) return
    // Cordis hands the inject callback a DIFFERENT context object than the
    // agent ctx, so dedupe on the outer scope and reuse its single attempt.
    const existing = this.attempts.get(agentCtx)
    if (existing !== undefined) return await existing
    const attempt = this.attempt(agentCtx, sessionId)
    this.attempts.set(agentCtx, attempt)
    await attempt
  }

  private async attempt(agentCtx: AgentContext, sessionId: string): Promise<void> {
    let injected = false
    const outcome = await waitForAvailability(
      Promise.resolve(agentCtx.inject(['tools'], (ctx) => {
        injected = true
        this.register(ctx, sessionId)
      })),
      // A deployment that already timed out once is unlikely to gain the
      // services a moment later: fail fast on later sessions while the pending
      // injection can still backfill registration if they do appear.
      this.warnedUnavailable ? MOUNT_INJECT_RETRY_WAIT_MS : MOUNT_INJECT_WAIT_MS,
    )
    if (outcome === 'failed') {
      this.warnMountFailure(`dsh-channels: mounting ${this.options.label} failed`)
      return
    }
    // Real cordis settles an injection whose dependencies never appear WITHOUT
    // calling the callback; treat "settled but never injected" as unavailable.
    // The fiber stays pending so a late service still backfills registration.
    if (!injected && !this.warnedUnavailable) {
      this.warnedUnavailable = true
      this.options.warn('dsh-channels: %s 未挂载：宿主 tools 服务不可用（会话继续）', this.options.label)
    }
  }

  private register(agentCtx: AgentContext, sessionId: string): void {
    // No per-callback-context dedupe: when a host service unloads/reloads,
    // cordis disposes the injection fiber's effects (including our
    // `tools.register`) and invokes this callback again with the same ctx
    // object. Skipping the re-registration would silently lose the tools; a
    // genuinely duplicated registration is caught below as a warning.
    const tools = agentCtx.tools
    if (tools === undefined || typeof tools.register !== 'function') {
      if (!this.warnedMissingTools) {
        this.warnedMissingTools = true
        this.options.warn('dsh-channels: %s 未注册：宿主 tools 服务不可用', this.options.label)
      }
      return
    }
    for (const definition of this.options.definitions(sessionId)) {
      try {
        tools.register(definition)
      } catch (error) {
        this.warnMountFailure(`dsh-channels: registering ${definition.name} failed: ${this.options.describeError(error)}`)
      }
    }
  }

  private warnMountFailure(message: string): void {
    if (this.warnedMountFailure) return
    this.warnedMountFailure = true
    this.options.warn(message)
  }
}
