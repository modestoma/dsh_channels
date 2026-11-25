/**
 * Turn-end automatic sending of the files a Feishu turn delivered.
 *
 * A person reads a Feishu Session only in the chat, so a reply that names a
 * report's path delivers nothing. After a turn completes (`done`), this
 * module sends, through `feishu_send_file`'s delivery
 * ({@link SendFileToolRuntime.send}), in this order and at most
 * `feishuTools.autoSendMaxFiles` files:
 *
 * 1. the files the turn declared with the host `present` tool
 *    (`deliverables/presented` events of that turn);
 * 2. with `feishuTools.autoSendFiles: mentioned`, the files its final reply
 *    names ({@link mentionedPaths}) that are in the person's `shared/`
 *    directory, or in the Session's own directory with a name ending in one
 *    of `feishuTools.autoSendExtensions` and modified since the turn started.
 *
 * A file the Session already sent (by the tool or here) with the same
 * modification time and size is skipped. Nothing is sent while
 * `feishuTools.sendFile` is off, for a stopped or failed turn, or for a
 * Session without a route. Each send stays inside the Session's readable
 * directories (`loadWorkspaceFile`). Failures are logged and never affect the
 * turn, which has already ended.
 *
 * The sent-file ledger lives in memory: after a restart a file may be sent
 * once more.
 *
 * @module dsh-channels/deliverables/auto-send
 */

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { FeishuConfig } from '../config.ts'
import type { SendFileArgs, SendFileTarget, SendFileValue, SentFile } from '../feishu/send-file.ts'
import type { DeliverablesPresentedEvent, Session, SessionEvent } from '../host/core.ts'
import type { SettledTurn } from '../turn/streamer.ts'

/** Session event the host `present` tool appends for each successful call. */
export const PRESENTED_EVENT = 'deliverables/presented' satisfies DeliverablesPresentedEvent['type']

/** `deliverables/presented` data, validated: it comes from another plugin through the Session log. */
const presentedSchema = z.object({
  turn: z.number().int(),
  files: z.array(z.object({ path: z.string().min(1) }).loose()),
}).loose()

/**
 * Tolerance subtracted from a turn's start before comparing file modification
 * times, for filesystems that store coarse timestamps.
 */
const MTIME_TOLERANCE_MS = 2_000

/** Most candidate paths read from one reply; bounds the filesystem checks. */
const MAX_MENTIONED_CANDIDATES = 50

/** Most files remembered per Session in the sent-file ledger. */
const MAX_LEDGER_ENTRIES = 200

/** Characters that end a path token in reply text (whitespace, quotes, brackets, CJK punctuation). */
const PATH_TOKEN = /[^\s`'"<>()（）[\]{}，。、；：！？「」『』《》|*]+/gu

/** A token ending in a file-name extension. */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/u

/** Trailing ASCII punctuation that ends a sentence rather than a path. */
const TRAILING_PUNCTUATION = /[.,:;!?]+$/u

export interface AutoSendDeps {
  /** Live plugin configuration. */
  config(): FeishuConfig
  /** Where a Session's files go and may come from; undefined for a Session without a route. */
  targetOfSession(sessionId: string): SendFileTarget | undefined
  /** `feishu_send_file`'s delivery. */
  send(sessionId: string, args: SendFileArgs, signal: AbortSignal): Promise<SendFileValue>
  /** Clock (epoch ms). */
  now?(): number
  /** Structured warning sink. */
  warn(message: string, ...args: unknown[]): void
}

/** One turn's start and the files it presented. */
interface TurnRecord {
  readonly turn: number
  readonly startedAt: number | undefined
  readonly presented: string[]
}

/**
 * The paths a reply names: tokens ending in a file-name extension, plus, for
 * a token whose path starts after other text (`目录/data/x.md`), the part
 * from its first `/`. URLs are skipped. Order of first appearance, unique,
 * at most {@link MAX_MENTIONED_CANDIDATES}.
 * @param text - the reply text.
 * @returns candidate paths, absolute or relative.
 */
export function mentionedPaths(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(PATH_TOKEN)) {
    let token = match[0].replace(TRAILING_PUNCTUATION, '')
    if (token.startsWith('file://')) token = token.slice('file://'.length)
    if (token.includes('://') || !HAS_EXTENSION.test(token)) continue
    found.add(token)
    const slash = token.indexOf('/')
    if (slash > 0) found.add(token.slice(slash))
    if (found.size >= MAX_MENTIONED_CANDIDATES) break
  }
  return [...found].slice(0, MAX_MENTIONED_CANDIDATES)
}

/** Whether `candidate` is `root` itself or below it. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Whether a file name ends in one of `extensions` (lower case, without the dot). */
function hasListedExtension(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase()
  return extensions.some(extension => lower.endsWith(`.${extension}`))
}

/**
 * Sends the files a completed Feishu turn delivered. Feed it the host's
 * inbox claims and Session events, and each finalized turn.
 */
export class DeliverableAutoSend {
  private readonly turns = new Map<string, TurnRecord>()
  /** Per Session: resolved path → `mtimeMs:bytes` of the last send. */
  private readonly ledger = new Map<string, Map<string, string>>()

  constructor(private readonly deps: AutoSendDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Record that a turn started (its first inbox message was claimed).
   * @param sessionId - the Session.
   * @param turn - the turn the claim opened.
   */
  onInboxClaimed(sessionId: string, turn: number): void {
    const current = this.turns.get(sessionId)
    if (current?.turn === turn) return
    this.turns.set(sessionId, { turn, startedAt: this.now(), presented: [] })
  }

  /**
   * Collect the files a turn presents.
   * @param session - the Session the event was appended to.
   * @param event - the appended event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== PRESENTED_EVENT) return
    // Written by another plugin and read back from the Session log: validated, not trusted.
    const parsed = presentedSchema.safeParse(event.data)
    if (!parsed.success) {
      this.deps.warn('dsh-channels: ignoring malformed %s event in session %s', PRESENTED_EVENT, session.id)
      return
    }
    const { turn, files } = parsed.data
    let record = this.turns.get(session.id)
    if (record?.turn !== turn) {
      record = { turn, startedAt: undefined, presented: [] }
      this.turns.set(session.id, record)
    }
    record.presented.push(...files.map(file => file.path))
  }

  /**
   * Remember a file a Session sent, so the turn end does not send it again unchanged.
   * @param sessionId - the Session.
   * @param file - the file as sent.
   */
  noteSent(sessionId: string, file: SentFile): void {
    let sent = this.ledger.get(sessionId)
    if (sent === undefined) {
      sent = new Map()
      this.ledger.set(sessionId, sent)
    }
    sent.delete(file.realPath)
    sent.set(file.realPath, `${file.mtimeMs}:${file.bytes}`)
    while (sent.size > MAX_LEDGER_ENTRIES) sent.delete(sent.keys().next().value!)
  }

  /**
   * Drop what is kept for a Session that went away.
   * @param sessionId - the Session.
   */
  forget(sessionId: string): void {
    this.turns.delete(sessionId)
    this.ledger.delete(sessionId)
  }

  /**
   * Send the files one finalized turn delivered. Never rejects.
   * @param sessionId - the Session.
   * @param turn - the finalized turn.
   * @param settled - its outcome and reply text.
   */
  async onTurnFinalized(sessionId: string, turn: number, settled: SettledTurn): Promise<void> {
    const record = this.turns.get(sessionId)
    const ownRecord = record?.turn === turn ? record : undefined
    if (ownRecord !== undefined) this.turns.delete(sessionId)
    try {
      await this.deliver(sessionId, settled, ownRecord)
    } catch (error) {
      this.deps.warn('dsh-channels: automatic file sending for session %s failed: %s', sessionId, String(error))
    }
  }

  private async deliver(sessionId: string, settled: SettledTurn, record: TurnRecord | undefined): Promise<void> {
    const tools = this.deps.config().feishuTools
    if (!tools.sendFile || tools.autoSendFiles === 'off' || settled.outcome !== 'done') return
    const target = this.deps.targetOfSession(sessionId)
    if (target === undefined) return
    const files = [...await this.presentedFiles(record), ...tools.autoSendFiles === 'mentioned'
      ? await this.mentionedFiles(target, settled.reply, record?.startedAt, tools.autoSendExtensions)
      : []]
    const chosen: string[] = []
    for (const file of files) {
      if (chosen.length >= tools.autoSendMaxFiles) break
      if (chosen.includes(file) || await this.alreadySent(sessionId, file)) continue
      chosen.push(file)
    }
    for (const file of chosen) {
      const result = await this.deps.send(sessionId, { path: file }, new AbortController().signal)
      if (!result.ok) this.deps.warn('dsh-channels: automatic sending of %s failed (%s): %s', file, result.code, result.reason)
    }
  }

  /** Resolved paths of the files a turn presented; missing files are left out. */
  private async presentedFiles(record: TurnRecord | undefined): Promise<string[]> {
    const resolved = await Promise.all((record?.presented ?? []).map(async file => await realpath(file).catch(() => undefined)))
    return resolved.filter((file): file is string => file !== undefined)
  }

  /** Resolved paths of the files a reply names that qualify for sending. */
  private async mentionedFiles(target: SendFileTarget, reply: string, startedAt: number | undefined, extensions: readonly string[]): Promise<string[]> {
    const own = await realpath(target.rootDir).catch(() => undefined)
    const shared = (await Promise.all((target.otherRoots ?? []).map(async dir => await realpath(dir).catch(() => undefined))))
      .filter((dir): dir is string => dir !== undefined)
    const bases = [target.rootDir, ...target.otherRoots ?? []]
    const files: string[] = []
    for (const candidate of mentionedPaths(reply)) {
      const tries = path.isAbsolute(candidate) ? [candidate] : bases.map(base => path.resolve(base, candidate))
      for (const attempt of tries) {
        const real = await realpath(attempt).catch(() => undefined)
        if (real === undefined || files.includes(real)) continue
        const info = await stat(real).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        const inShared = shared.some(dir => isInside(dir, real))
        const changedHere = own !== undefined && isInside(own, real) && startedAt !== undefined
          && info.mtimeMs >= startedAt - MTIME_TOLERANCE_MS && hasListedExtension(real, extensions)
        if (inShared || changedHere) {
          files.push(real)
          break
        }
      }
    }
    return files
  }

  /** Whether the Session already sent this file with its current modification time and size. */
  private async alreadySent(sessionId: string, file: string): Promise<boolean> {
    const previous = this.ledger.get(sessionId)?.get(file)
    if (previous === undefined) return false
    const info = await stat(file).catch(() => undefined)
    return info !== undefined && previous === `${info.mtimeMs}:${info.size}`
  }
}
