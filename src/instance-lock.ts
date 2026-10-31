/**
 * Machine-wide single-owner lock for one Feishu application.
 *
 * Feishu delivers each long-connection event to one randomly chosen client of
 * an application. Two dsh processes on one machine (two profiles, or the Web
 * host next to the desktop app) holding connections for the same bot would
 * each receive part of the traffic while keeping separate route stores, so a
 * topic's follow-up messages and card buttons could land in the process that
 * does not know the topic. The lock lets exactly one process per application
 * open the long connection.
 *
 * The lock is a local IPC endpoint (a Unix domain socket under the OS temp
 * directory, or a Windows named pipe) whose address is derived from the App
 * ID, so it covers every profile and every `$DSH_HOME` of the current OS user.
 * The OS frees the endpoint when the owning process exits, crashes, or is
 * killed: no heartbeat, PID file, or PID-reuse check is involved. A stale Unix
 * socket file left by a dead owner refuses connections and is removed before
 * the next attempt.
 *
 * The endpoint answers two newline-delimited JSON requests:
 * - `hello` returns the owner's {@link LockHolderInfo} for the settings panel;
 * - `yield` asks the owner to close its connection and release the lock (the
 *   panel's takeover action). The owner answers before tearing down, so the
 *   requester polls until the address is free.
 *
 * @module dsh-channels/instance-lock
 */

import { createHash } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Identity of the process holding (or requesting) the lock. */
export interface LockHolderInfo {
  /** OS process id. */
  pid: number
  /** `$DSH_HOME` of that process. */
  home: string
  /** dsh-channels package version. */
  version: string
  /** Epoch ms when the process acquired the lock (or sent the request). */
  startedAt: number
}

/** A held lock; `release()` frees the address. */
export interface InstanceLock {
  /** Stop answering and free the address. Idempotent; never throws. */
  release(): Promise<void>
}

/** Outcome of one acquisition. */
export type AcquireResult =
  | { ok: true; lock: InstanceLock }
  /** Another live process owns the address; `holder` is undefined when it did not answer `hello`. */
  | { ok: false; holder: LockHolderInfo | undefined }

/** Inputs of one acquisition. */
export interface AcquireOptions {
  /** Endpoint address from {@link lockAddress}. */
  address: string
  /** Identity answered to `hello`. */
  self: LockHolderInfo
  /**
   * Called after a `yield` request was accepted and answered. The owner must
   * close its Feishu connection and release the lock.
   */
  onYield(from: LockHolderInfo): void
  /**
   * Whether the owner can yield right now (false while it is connecting or
   * restarting). A refused `yield` is answered with `busy`.
   */
  canYield(): boolean
  /**
   * Keep retrying until this epoch ms while the address stays taken. The
   * takeover path uses it to wait for the previous owner's teardown. Without
   * it, only a holder in this same process (a plugin reload whose previous
   * instance has not been disposed yet) is waited for, up to the provider's
   * same-process wait.
   */
  waitUntil?: number
}

/** The narrow lock operations {@link FeishuService} depends on. */
export interface InstanceLockProvider {
  /** Endpoint address for one App ID. */
  address(appId: string): string
  /** Try to become the owner of `options.address`. */
  acquire(options: AcquireOptions): Promise<AcquireResult>
  /**
   * Ask the current owner to yield.
   * @returns `yielding` once accepted, `busy` when the owner refused, `absent` when nobody owns the address.
   */
  requestYield(address: string, self: LockHolderInfo): Promise<YieldOutcome>
}

/** Answer to a `yield` request. */
export type YieldOutcome = 'yielding' | 'busy' | 'absent'

/** How long a holder in this same process is waited for. */
export const SAME_PROCESS_WAIT_MS = 5_000
/** Delay between acquisition retries. */
const RETRY_DELAY_MS = 200
/** Upper bound for one request round trip. */
const REQUEST_TIMEOUT_MS = 2_000
/** Upper bound for one request or response line. */
const MAX_LINE_BYTES = 4_096

/**
 * Endpoint address for one App ID: a named pipe on Windows, otherwise a socket
 * file in the OS temp directory. The App ID is hashed so the address stays
 * short and reveals nothing.
 * @param appId - resolved Feishu App ID.
 * @param platform - platform seam (tests).
 * @param dir - temp directory seam (tests).
 * @returns the address to listen on / connect to.
 */
export function lockAddress(appId: string, platform: NodeJS.Platform = process.platform, dir: string = tmpdir()): string {
  const hash = createHash('sha256').update(appId).digest('hex').slice(0, 16)
  return platform === 'win32' ? `\\\\.\\pipe\\dsh-channels-${hash}` : join(dir, `dsh-channels-${hash}.sock`)
}

type Request = { op: 'hello' } | { op: 'yield'; from: LockHolderInfo }
type Response =
  | { ok: true; holder: LockHolderInfo }
  | { ok: true; yielding: true }
  | { ok: false; error: 'busy' | 'bad-request' }

function isHolderInfo(value: unknown): value is LockHolderInfo {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.pid === 'number' && Number.isInteger(record.pid)
    && typeof record.home === 'string' && record.home.length <= 1_024
    && typeof record.version === 'string' && record.version.length <= 64
    && typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
}

function parseRequest(line: string): Request | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // Not JSON: answered as a bad request by the caller.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.op === 'hello') return { op: 'hello' }
  if (record.op === 'yield' && isHolderInfo(record.from)) return { op: 'yield', from: record.from }
  return undefined
}

/**
 * Read the first newline-terminated line of a socket, bounded in size.
 * Resolves undefined when the peer closes or exceeds the bound first.
 */
function readLine(socket: Socket, onLine: (line: string | undefined) => void): void {
  let buffer = ''
  let done = false
  const finish = (line: string | undefined): void => {
    if (done) return
    done = true
    socket.off('data', onData)
    onLine(line)
  }
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString()
    const end = buffer.indexOf('\n')
    if (end >= 0) finish(buffer.slice(0, end))
    else if (buffer.length > MAX_LINE_BYTES) finish(undefined)
  }
  socket.setEncoding('utf8')
  socket.on('data', onData)
  socket.once('end', () => finish(undefined))
  socket.once('close', () => finish(undefined))
  socket.once('error', () => finish(undefined))
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function listen(address: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const onError = (error: Error): void => {
      server.close()
      reject(error)
    }
    server.once('error', onError)
    server.listen(address, () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

/**
 * One request round trip. Resolves `refused` when nobody listens (no address,
 * or a stale socket file), `undefined` when the peer did not answer validly.
 */
function roundTrip(address: string, request: Request): Promise<Response | 'refused' | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(address)
    let settled = false
    const settle = (value: Response | 'refused' | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => settle(undefined), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    socket.once('error', (error) => {
      const code = errorCode(error)
      settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'refused' : undefined)
    })
    socket.once('connect', () => {
      readLine(socket, (line) => {
        if (line === undefined) {
          settle(undefined)
          return
        }
        try {
          settle(JSON.parse(line) as Response)
        } catch {
          // A non-JSON answer is not a dsh-channels lock owner.
          settle(undefined)
        }
      })
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class HeldLock implements InstanceLock {
  private readonly sockets = new Set<Socket>()
  private released: Promise<void> | undefined

  constructor(private readonly server: Server, private readonly options: AcquireOptions) {
    server.on('connection', socket => this.serve(socket))
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => {
      // A peer that vanished mid-request needs no answer.
    })
    readLine(socket, (line) => {
      const request = line === undefined ? undefined : parseRequest(line)
      const reply = (response: Response): void => {
        socket.end(`${JSON.stringify(response)}\n`)
      }
      if (request === undefined) {
        reply({ ok: false, error: 'bad-request' })
        return
      }
      if (request.op === 'hello') {
        reply({ ok: true, holder: this.options.self })
        return
      }
      if (this.released !== undefined || !this.options.canYield()) {
        reply({ ok: false, error: 'busy' })
        return
      }
      reply({ ok: true, yielding: true })
      this.options.onYield(request.from)
    })
  }

  release(): Promise<void> {
    this.released ??= new Promise((resolve) => {
      // `close()` stops accepting; its callback waits for open sockets, so
      // they are destroyed explicitly. Node unlinks a Unix socket file on close.
      this.server.close(() => resolve())
      for (const socket of this.sockets) socket.destroy()
    })
    return this.released
  }
}

/** Seams of {@link createInstanceLockProvider}. */
export interface InstanceLockProviderOptions {
  /** Directory of Unix socket files (default: the OS temp directory). */
  dir?: string
  /** How long a holder in this same process is waited for (default {@link SAME_PROCESS_WAIT_MS}). */
  sameProcessWaitMs?: number
}

/**
 * Build a provider over real IPC endpoints.
 * @param options - address directory and same-process wait.
 * @returns the provider.
 */
export function createInstanceLockProvider(providerOptions: InstanceLockProviderOptions = {}): InstanceLockProvider {
  const dir = providerOptions.dir ?? tmpdir()
  const sameProcessWaitMs = providerOptions.sameProcessWaitMs ?? SAME_PROCESS_WAIT_MS
  return {
    address: appId => lockAddress(appId, process.platform, dir),

    async acquire(options: AcquireOptions): Promise<AcquireResult> {
      const sameProcessDeadline = Date.now() + sameProcessWaitMs
      let staleRemovals = 0
      for (;;) {
        try {
          const server = await listen(options.address)
          return { ok: true, lock: new HeldLock(server, options) }
        } catch (error) {
          if (errorCode(error) !== 'EADDRINUSE') throw error
        }
        const answer = await roundTrip(options.address, { op: 'hello' })
        if (answer === 'refused') {
          // Nobody listens: a socket file left by a dead owner (Unix only; a
          // Windows pipe disappears with its owner). Remove it and retry, a few
          // times at most so an address that keeps failing cannot spin forever.
          if (++staleRemovals > 3) return { ok: false, holder: undefined }
          if (process.platform !== 'win32') {
            await unlink(options.address).catch((error: unknown) => {
              // Another process removed or replaced it first; the retry decides.
              if (errorCode(error) !== 'ENOENT') throw error
            })
          }
          continue
        }
        const holder = answer !== undefined && answer.ok && 'holder' in answer && isHolderInfo(answer.holder)
          ? answer.holder
          : undefined
        const deadline = Math.max(
          options.waitUntil ?? 0,
          holder?.pid === process.pid ? sameProcessDeadline : 0,
        )
        if (Date.now() >= deadline) return { ok: false, holder }
        await delay(RETRY_DELAY_MS)
      }
    },

    async requestYield(address: string, self: LockHolderInfo): Promise<YieldOutcome> {
      const answer = await roundTrip(address, { op: 'yield', from: self })
      if (answer === 'refused') return 'absent'
      if (answer !== undefined && answer.ok && 'yielding' in answer) return 'yielding'
      return 'busy'
    },
  }
}

/** The production provider: endpoints under the OS temp directory. */
export const SYSTEM_INSTANCE_LOCK: InstanceLockProvider = createInstanceLockProvider()
