/**
 * Read-only file access to Feishu workspaces for the Web panel's
 * 「会话记录」 tab: directory listings, previews, and downloads.
 *
 * Every request names a workspace root and a path relative to it. The caller
 * decides which roots are browsable (only roots of Feishu-routed Sessions);
 * this module guarantees that a resolved target, after following symlinks,
 * stays inside its root. Nothing here writes, renames, or deletes.
 *
 * @module dsh-channels/workspace-files
 */

import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceEntryWire, WorkspaceListingWire, WorkspacePreviewWire } from './settings/contract.ts'

/** Most entries one directory listing returns; larger directories are cut and flagged. */
export const MAX_DIRECTORY_ENTRIES = 2000
/** Largest text excerpt a preview returns; longer files are cut and flagged. */
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
/** Largest image a preview inlines. */
export const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024
/** Largest file one download serves. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
/** Leading bytes inspected to tell text from binary content. */
const SNIFF_BYTES = 8192

/** Image types the panel previews inline, by lowercase extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** A refused or failed workspace file request with an HTTP status and a user-facing message. */
export class WorkspaceFileError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413, message: string) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

/** One file's bytes for download. */
export interface WorkspaceDownload {
  name: string
  size: number
  bytes: Uint8Array
}

/**
 * Normalize an untrusted relative path. Absolute paths, NUL bytes and `..`
 * segments are refused; separators are normalized to `/`.
 * @param raw - client-supplied path; empty or absent means the root.
 * @returns the normalized relative path (`''` = root).
 * @throws {WorkspaceFileError} 400 for an unacceptable path.
 */
export function normalizeRelativePath(raw: string | undefined): string {
  if (raw === undefined) return ''
  if (raw.includes('\0')) throw new WorkspaceFileError(400, '路径包含非法字符')
  const segments = raw.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
  if (/^([\\/]|[A-Za-z]:)/.test(raw)) throw new WorkspaceFileError(400, '路径必须是工作区内的相对路径')
  if (segments.includes('..')) throw new WorkspaceFileError(400, '路径不能包含 ..')
  return segments.join('/')
}

/**
 * Resolve one relative path inside a root, following symlinks, and refuse
 * targets that leave the root.
 * @returns the real target path.
 * @throws {WorkspaceFileError} 404 when the root or target is missing, 403 when it escapes.
 */
async function resolveInside(root: string, relative: string): Promise<string> {
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    throw new WorkspaceFileError(404, '工作区目录不存在')
  }
  let target: string
  try {
    target = await realpath(path.join(realRoot, relative))
  } catch {
    throw new WorkspaceFileError(404, '文件或目录不存在')
  }
  const offset = path.relative(realRoot, target)
  if (offset.startsWith('..') || path.isAbsolute(offset)) {
    throw new WorkspaceFileError(403, '目标位于工作区之外')
  }
  return target
}

/**
 * List one directory inside a workspace.
 * @param root - absolute workspace root the caller allowed.
 * @param rawPath - untrusted relative directory path.
 * @returns the listing.
 * @throws {WorkspaceFileError} for a refused, missing, or non-directory path.
 */
export async function listWorkspaceDirectory(root: string, rawPath: string | undefined): Promise<WorkspaceListingWire> {
  const relative = normalizeRelativePath(rawPath)
  const target = await resolveInside(root, relative)
  if (!(await stat(target)).isDirectory()) throw new WorkspaceFileError(400, '目标不是目录')
  const dirents = await readdir(target, { withFileTypes: true })
  const truncated = dirents.length > MAX_DIRECTORY_ENTRIES
  const entries = await Promise.all(dirents.slice(0, MAX_DIRECTORY_ENTRIES).map(async (dirent): Promise<WorkspaceEntryWire> => {
    if (dirent.isDirectory()) return { name: dirent.name, kind: 'dir' }
    if (dirent.isSymbolicLink()) return { name: dirent.name, kind: 'symlink' }
    if (!dirent.isFile()) return { name: dirent.name, kind: 'other' }
    try {
      const info = await stat(path.join(target, dirent.name))
      return { name: dirent.name, kind: 'file', size: info.size, mtimeMs: Math.round(info.mtimeMs) }
    } catch {
      // Removed between readdir and stat: still listed, without size facts.
      return { name: dirent.name, kind: 'file' }
    }
  }))
  const rank = (entry: WorkspaceEntryWire): number => (entry.kind === 'dir' ? 0 : 1)
  entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return { path: relative, entries, truncated }
}

/** Whether the leading bytes look like text: no NUL byte and valid UTF-8 up to a cut sequence. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

/** Read at most `limit` leading bytes of one file. */
async function readHead(file: string, limit: number): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Resolve one regular file inside a workspace, with its size and mtime. */
async function resolveFile(root: string, rawPath: string | undefined): Promise<{ relative: string; target: string; size: number; mtimeMs: number }> {
  const relative = normalizeRelativePath(rawPath)
  if (relative === '') throw new WorkspaceFileError(400, '缺少文件路径')
  const target = await resolveInside(root, relative)
  const info = await stat(target)
  if (!info.isFile()) throw new WorkspaceFileError(400, '目标不是文件')
  return { relative, target, size: info.size, mtimeMs: Math.round(info.mtimeMs) }
}

/**
 * Preview one file: UTF-8 text up to {@link MAX_TEXT_PREVIEW_BYTES}, known
 * image types up to {@link MAX_IMAGE_PREVIEW_BYTES}, otherwise binary facts.
 * @param root - absolute workspace root the caller allowed.
 * @param rawPath - untrusted relative file path.
 * @returns the preview.
 * @throws {WorkspaceFileError} for a refused, missing, or non-file path.
 */
export async function previewWorkspaceFile(root: string, rawPath: string | undefined): Promise<WorkspacePreviewWire> {
  const { relative, target, size, mtimeMs } = await resolveFile(root, rawPath)
  const mime = IMAGE_TYPES[path.extname(target).toLowerCase()]
  if (mime !== undefined) {
    if (size > MAX_IMAGE_PREVIEW_BYTES) return { kind: 'binary', path: relative, size, mtimeMs }
    const bytes = await readHead(target, size)
    return { kind: 'image', path: relative, size, mtimeMs, mime, dataBase64: Buffer.from(bytes).toString('base64') }
  }
  const head = await readHead(target, Math.min(size, MAX_TEXT_PREVIEW_BYTES))
  if (!looksLikeText(head.subarray(0, SNIFF_BYTES))) return { kind: 'binary', path: relative, size, mtimeMs }
  return {
    kind: 'text',
    path: relative,
    size,
    mtimeMs,
    // A multi-byte character cut at the excerpt end decodes as U+FFFD.
    content: new TextDecoder('utf-8').decode(head),
    truncated: size > head.length,
  }
}

/**
 * Read one whole file for download.
 * @param root - absolute workspace root the caller allowed.
 * @param rawPath - untrusted relative file path.
 * @returns the file name and bytes.
 * @throws {WorkspaceFileError} for a refused, missing, non-file, or oversized path.
 */
export async function readWorkspaceFile(root: string, rawPath: string | undefined): Promise<WorkspaceDownload> {
  const { target, size } = await resolveFile(root, rawPath)
  if (size > MAX_DOWNLOAD_BYTES) {
    throw new WorkspaceFileError(413, `文件超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB，无法通过面板下载`)
  }
  const bytes = await readHead(target, size)
  return { name: path.basename(target), size: bytes.length, bytes }
}
