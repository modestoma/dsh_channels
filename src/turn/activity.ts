/**
 * The two transient lines a streaming card renders from a {@link TurnState}:
 * the headline (what the turn is doing, or its settled outcome) and the
 * delegation status line (workflow and subagent progress). Pure functions of
 * the state and the current time.
 *
 * @module dsh-channels/turn/activity
 */

import type { TurnState, WorkflowRun } from './state.ts'

/** Hard cap on the activity line so it can never threaten the card budget. */
const ACTIVITY_MAX_CHARS = 64

/** Trim an activity line to `ACTIVITY_MAX_CHARS` (ellipsis counts as one char). */
function clipActivity(line: string): string {
  return line.length <= ACTIVITY_MAX_CHARS ? line : `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…`
}

/** `已运行 45s` / `已运行 2分5s` — the activity line's elapsed counter. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `已运行 ${total}s`
  return `已运行 ${Math.floor(total / 60)}分${total % 60}s`
}

/** `用时 45s` / `用时 2分5s` — a settled turn's total time. */
function fmtDuration(ms: number): string {
  return fmtElapsed(ms).replace('已运行', '用时')
}

/** `🤖 子代理执行中：a (tool)` / `🤖 3 个子代理执行中：a、b、…` for running children. */
function childrenHead(state: TurnState): string | undefined {
  const children = [...state.children.values()]
  if (children.length === 0) return undefined
  const listed = children.slice(0, 2).map(child => `${child.label}${child.tool === undefined ? '' : ` (${child.tool})`}`)
  return children.length === 1
    ? `🤖 子代理执行中：${listed[0]}`
    : `🤖 ${children.length} 个子代理执行中：${listed.join('、')}${children.length > 2 ? '、…' : ''}`
}

/**
 * The delegation status line, by priority:
 *  1. the most recently started live workflow run (member progress + phase);
 *  2. running subagent children (label + current tool + elapsed);
 *  3. the last settled workflow run's outcome — it persists across later
 *     tool calls and text streaming (only a new run-start replaces it), so
 *     the workflow conclusion stays visible.
 * Liveness (the elapsed counter) belongs to the headline.
 * Once the turn is finalized, the line switches to the SETTLED form
 * (workflow conclusion + finished-subagent summary) — the final card keeps
 * the delegation status; only the tool line disappears. A failed turn shows
 * its diagnostic once, in the body: the status line never repeats it.
 * @param state - the turn.
 * @param now - the render time.
 * @returns the line, empty when the turn delegated nothing.
 */
export function delegationLine(state: TurnState, now: number): string {
  if (state.finalized) return settledLine(state)

  let latest: WorkflowRun | undefined
  for (const run of state.workflowRuns.values()) {
    if (latest === undefined || run.startedAt > latest.startedAt) latest = run
  }
  if (latest !== undefined) {
    let line = `🧵 工作流 ${latest.name} · ${latest.ended}/${latest.started} 子代理完成`
    if (latest.phase !== undefined) line += ` · 阶段 ${latest.phase}`
    const labels = latest.active.slice(0, 3).map(member => member.label)
    if (labels.length > 0) line += ` · ${labels.join('、')}`
    line += ` · ${fmtElapsed(now - latest.startedAt)}`
    return clipActivity(line)
  }

  const head = childrenHead(state)
  if (head !== undefined) {
    const oldest = Math.min(...[...state.children.values()].map(child => child.since))
    return clipActivity(`${head} · ${fmtElapsed(now - oldest)}`)
  }

  if (state.workflowEndStatus !== undefined) {
    const { name, stopReason } = state.workflowEndStatus
    return clipActivity(`🧵 工作流 ${name} 结束（${stopReason}）`)
  }
  return ''
}

/**
 * The settled-card form of the delegation status line: the workflow
 * conclusion and/or the finished-subagent summary, without elapsed counters.
 * Still-running (background) children are noted factually. Empty when the
 * turn delegated nothing.
 */
function settledLine(state: TurnState): string {
  const parts: string[] = []
  if (state.workflowEndStatus !== undefined) {
    const { name, stopReason } = state.workflowEndStatus
    parts.push(`🧵 工作流 ${name} 结束（${stopReason}）`)
  }
  if (state.settled.length > 0) {
    parts.push(`🤖 子代理完成：${state.settled.join('、')}`)
  }
  if (parts.length > 0) return clipActivity(parts.join(' · '))
  const head = childrenHead(state)
  return head === undefined ? '' : clipActivity(head)
}

/**
 * The headline: what the turn is doing right now, in the vocabulary of the
 * DSH session status, by priority — waiting on a human (approval, then
 * question), compacting the context, retrying a model request, running a
 * tool, then the current stream attempt's output (thinking / writing), and
 * otherwise in progress. Running headlines carry the turn's elapsed time;
 * a settled turn shows its outcome and total time.
 * @param state - the turn.
 * @param now - the render time.
 * @returns the headline.
 */
export function headlineOf(state: TurnState, now: number): string {
  if (state.finalized) {
    const took = fmtDuration((state.endedAt ?? now) - state.turnStartedAt)
    switch (state.phase) {
      case 'error': return `❌ 失败 · ${took}`
      case 'stopped': return `⏹ 已停止 · ${took}`
      default: return `✅ 已完成 · ${took}`
    }
  }
  const elapsed = fmtElapsed(now - state.turnStartedAt)
  if (state.awaitingApproval.length > 0) {
    return clipActivity(`✋ 等待审批：${[...new Set(state.awaitingApproval)].join('、')}`)
  }
  if (state.awaitingAnswer) return '❓ 等待回答'
  if (state.compacting) return `🗜 正在压缩上下文 · ${elapsed}`
  const retry = state.retry
  if (retry !== undefined) {
    const count = retry.maxRetries === undefined ? `${retry.retry}` : `${retry.retry}/${retry.maxRetries}`
    if (retry.started) return clipActivity(`🔁 模型请求重试中（第 ${count} 次）`)
    const wait = Math.max(0, Math.ceil((retry.until - now) / 1_000))
    return clipActivity(`⚠️ 模型请求失败（${retry.code}），${wait} 秒后第 ${count} 次重试`)
  }
  const tool = state.toolActivity
  if (tool !== undefined) {
    const prefix = tool.name === 'subagent'
      ? '🤖 调用子代理：'
      : tool.name === 'workflow'
        ? '🧵 调用工作流：'
        : '🔧 调用工具：'
    return clipActivity(`${prefix}${tool.label} · ${fmtElapsed(now - tool.since)}`)
  }
  if (state.output === 'text') return `✍️ 输出中 · ${elapsed}`
  if (state.output === 'reasoning') return `🧠 思考中 · ${elapsed}`
  return `⚙️ 进行中 · ${elapsed}`
}

/**
 * The kind of an activity line: its first `·` segment, stable across elapsed
 * and count ticks. Used to log transitions only.
 * @param line - a rendered headline or delegation line.
 * @returns the kind, empty for an empty line.
 */
export function activityKind(line: string): string {
  return line === '' ? '' : (line.split('·')[0] ?? '').trim()
}
