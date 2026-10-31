/**
 * Read-only workspace file access for the 「会话记录」 tab: path containment,
 * listings, previews and downloads.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  listWorkspaceDirectory,
  MAX_TEXT_PREVIEW_BYTES,
  normalizeRelativePath,
  previewWorkspaceFile,
  readWorkspaceFile,
} from '../src/workspace-files.ts'

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-channels-wsfiles-'))
}

describe('normalizeRelativePath', () => {
  it('normalizes separators and dot segments, and treats an absent path as the root', () => {
    expect(normalizeRelativePath(undefined)).toBe('')
    expect(normalizeRelativePath('')).toBe('')
    expect(normalizeRelativePath('topics//t1/./a.txt')).toBe('topics/t1/a.txt')
    expect(normalizeRelativePath('topics\\t1')).toBe('topics/t1')
  })

  it.each(['/etc/passwd', '\\share', 'C:/x', 'a/../../b', '..', 'a\0b'])('refuses %j with 400', (raw) => {
    expect(() => normalizeRelativePath(raw)).toThrow(expect.objectContaining({ status: 400 }))
  })
})

describe('listWorkspaceDirectory', () => {
  it('lists directories first, then files with size and mtime, and reports symlinks without following them', async () => {
    const root = makeRoot()
    mkdirSync(path.join(root, 'topics'))
    writeFileSync(path.join(root, 'b.txt'), 'hello')
    writeFileSync(path.join(root, 'a.txt'), '')
    symlinkSync(path.join(root, 'b.txt'), path.join(root, 'link'))
    const listing = await listWorkspaceDirectory(root, '')
    expect(listing.path).toBe('')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['topics', 'dir'], ['a.txt', 'file'], ['b.txt', 'file'], ['link', 'symlink'],
    ])
    expect(listing.entries[2]).toMatchObject({ size: 5, mtimeMs: expect.any(Number) })
  })

  it('refuses a symlinked directory that leaves the workspace and a path that is not a directory', async () => {
    const root = makeRoot()
    const outside = makeRoot()
    symlinkSync(outside, path.join(root, 'escape'))
    writeFileSync(path.join(root, 'file.txt'), 'x')
    await expect(listWorkspaceDirectory(root, 'escape')).rejects.toMatchObject({ status: 403 })
    await expect(listWorkspaceDirectory(root, 'file.txt')).rejects.toMatchObject({ status: 400 })
    await expect(listWorkspaceDirectory(root, 'missing')).rejects.toMatchObject({ status: 404 })
    await expect(listWorkspaceDirectory(path.join(root, 'gone'), '')).rejects.toMatchObject({ status: 404 })
  })
})

describe('previewWorkspaceFile', () => {
  it('returns UTF-8 text, cutting long files at the preview limit', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'short.md'), '# 标题')
    writeFileSync(path.join(root, 'long.log'), 'a'.repeat(MAX_TEXT_PREVIEW_BYTES + 10))
    expect(await previewWorkspaceFile(root, 'short.md')).toMatchObject({ kind: 'text', content: '# 标题', truncated: false, size: 8 })
    const long = await previewWorkspaceFile(root, 'long.log')
    expect(long).toMatchObject({ kind: 'text', truncated: true })
    expect(long.kind === 'text' ? long.content.length : 0).toBe(MAX_TEXT_PREVIEW_BYTES)
  })

  it('inlines known images and reports other binary content without its bytes', async () => {
    const root = makeRoot()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(path.join(root, 'shot.PNG'), png)
    writeFileSync(path.join(root, 'data.bin'), Buffer.from([1, 0, 2, 3]))
    expect(await previewWorkspaceFile(root, 'shot.PNG')).toMatchObject({
      kind: 'image', mime: 'image/png', dataBase64: png.toString('base64'),
    })
    expect(await previewWorkspaceFile(root, 'data.bin')).toEqual({
      kind: 'binary', path: 'data.bin', size: 4, mtimeMs: expect.any(Number),
    })
  })

  it('refuses the root, directories, and files reached through an escaping symlink', async () => {
    const root = makeRoot()
    const outside = makeRoot()
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'))
    mkdirSync(path.join(root, 'dir'))
    await expect(previewWorkspaceFile(root, '')).rejects.toMatchObject({ status: 400 })
    await expect(previewWorkspaceFile(root, 'dir')).rejects.toMatchObject({ status: 400 })
    await expect(previewWorkspaceFile(root, 'secret.txt')).rejects.toMatchObject({ status: 403 })
  })
})

describe('readWorkspaceFile', () => {
  it('returns the whole file with its base name', async () => {
    const root = makeRoot()
    mkdirSync(path.join(root, 'topics'))
    writeFileSync(path.join(root, 'topics', '报告.csv'), 'a,b\n1,2\n')
    const file = await readWorkspaceFile(root, 'topics/报告.csv')
    expect(file.name).toBe('报告.csv')
    expect(file.size).toBe(8)
    expect(Buffer.from(file.bytes).toString()).toBe('a,b\n1,2\n')
  })
})
