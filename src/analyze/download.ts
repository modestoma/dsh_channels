/**
 * Log package download for analyze requests.
 *
 * Packages are fetched in request order into `<sessionDir>/logs/`, streamed to
 * disk under one whole-download deadline, and cancelled as a whole when the
 * caller's signal aborts. Sizes are not limited. The files
 * are stored as received: unpacking belongs to the analysis skill, which runs
 * inside the Session sandbox.
 *
 * @module dsh-channels/analyze/download
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** Directory below the topic directory that receives the packages. */
export const ANALYZE_LOG_DIR = 'logs'

/** One downloaded package. */
export interface DownloadedLog {
  /** Path relative to the topic directory (`logs/01-name.zip`). */
  readonly relativePath: string
  /** Bytes written. */
  readonly bytes: number
}

/** Why a download failed (readable, names the package). */
export class LogDownloadError extends Error {}

/** The fetch seam (tests substitute a local stub). */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>

/**
 * File name for the package at `index`: the URL's last path segment reduced to
 * safe characters and prefixed with its 1-based position, so names never
 * collide and keep request order.
 * @param url - the package URL.
 * @param index - 0-based position in the request.
 * @returns the file name.
 */
export function logFileName(url: string, index: number): string {
  const position = String(index + 1).padStart(2, '0')
  let base = ''
  try {
    base = decodeURIComponent(path.posix.basename(new URL(url).pathname))
  } catch {
    base = ''
  }
  const safe = base.replace(/[^A-Za-z0-9._-]/gu, '_').replace(/^\.+/u, '').slice(0, 120)
  return safe === '' ? `${position}-log.zip` : `${position}-${safe}`
}

/** Redact query strings (signed URLs carry credentials) from a URL for messages. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

/**
 * Download every package into `<sessionDir>/logs/`.
 * @param urls - package URLs in request order.
 * @param sessionDir - the topic directory.
 * @param timeoutMs - whole-download deadline in milliseconds.
 * @param fetchImpl - fetch seam (defaults to the global fetch).
 * @param signal - cancels the whole download (service shutdown).
 * @returns the downloaded files; rejects with {@link LogDownloadError}.
 */
export async function downloadLogs(
  urls: readonly string[],
  sessionDir: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<DownloadedLog[]> {
  const directory = path.join(sessionDir, ANALYZE_LOG_DIR)
  await mkdir(directory, { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new LogDownloadError(`日志包下载超时（${timeoutMs} ms）`))
  }, timeoutMs)
  const onCancel = (): void => {
    controller.abort(new LogDownloadError('日志包下载已取消（飞书渠道已断开）'))
  }
  if (signal?.aborted === true) onCancel()
  else signal?.addEventListener('abort', onCancel, { once: true })
  const downloaded: DownloadedLog[] = []
  try {
    for (const [index, url] of urls.entries()) {
      const name = logFileName(url, index)
      const target = path.join(directory, name)
      const label = displayUrl(url)
      let response: Response
      try {
        response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
      } catch (error) {
        throw failure(controller, `下载 ${label} 失败：${messageOf(error)}`)
      }
      if (!response.ok || response.body === null) {
        throw new LogDownloadError(`下载 ${label} 失败：HTTP ${response.status}`)
      }
      let written = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length
          callback(null, chunk)
        },
      })
      try {
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          counter,
          createWriteStream(target),
          { signal: controller.signal },
        )
      } catch (error) {
        await rm(target, { force: true }).catch(() => undefined)
        throw failure(controller, `下载 ${label} 失败：${messageOf(error)}`)
      }
      downloaded.push({ relativePath: path.posix.join(ANALYZE_LOG_DIR, name), bytes: written })
    }
    return downloaded
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCancel)
  }
}

/** The deadline's or cancellation's own error when the shared signal fired, otherwise `fallback`. */
function failure(controller: AbortController, fallback: string): LogDownloadError {
  const reason: unknown = controller.signal.reason
  return controller.signal.aborted && reason instanceof LogDownloadError ? reason : new LogDownloadError(fallback)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
