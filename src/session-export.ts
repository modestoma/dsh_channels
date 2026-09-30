/**
 * Logical Session export format and in-memory gzip packaging.
 *
 * This is deliberately a projection of the live logical Session surface. It
 * does not walk descendant Sessions, fetch attachments, or copy persistence
 * backend artifacts.
 *
 * @module dsh-channels/session-export
 */

import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { Session } from './dsh-types.ts'

interface PackageMetadata {
  version?: unknown
}

function packageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata
  if (typeof metadata.version !== 'string' || metadata.version === '') {
    throw new Error('dsh-channels: package version is unavailable')
  }
  return metadata.version
}

export const LOGICAL_EXPORT_FORMAT = 'dsh-logical-session-jsonl'
export const LOGICAL_EXPORT_FORMAT_VERSION = 1
export const DSH_CHANNELS_VERSION = packageVersion()

export interface LogicalExportManifest {
  format: typeof LOGICAL_EXPORT_FORMAT
  formatVersion: typeof LOGICAL_EXPORT_FORMAT_VERSION
  logical: true
  exportedAt: string
  plugin: {
    name: 'dsh-channels'
    version: string
  }
  includes: {
    descendants: false
    attachments: false
    rawArtifacts: false
  }
  session: {
    id: string
    header: Session['header']
  }
}

export interface LogicalSessionExportFile {
  fileName: string
  source: Buffer
}

export type SessionExportBuilder = (session: Session) => Promise<LogicalSessionExportFile>

export interface LogicalSessionExportOptions {
  /** Deterministic clock seam for format tests. */
  exportedAt?: Date
  /** Explicit package-version seam for format tests. */
  pluginVersion?: string
  /** Compression seam used to verify gzip failures without filesystem I/O. */
  compress?: (source: Buffer) => Promise<Buffer>
}

const gzipBuffer = promisify(gzip)

/** Build one immutable UTF-8 JSONL snapshot before any asynchronous work. */
export function serializeLogicalSession(
  session: Session,
  options: Pick<LogicalSessionExportOptions, 'exportedAt' | 'pluginVersion'> = {},
): Buffer {
  const manifest: LogicalExportManifest = {
    format: LOGICAL_EXPORT_FORMAT,
    formatVersion: LOGICAL_EXPORT_FORMAT_VERSION,
    logical: true,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    plugin: {
      name: 'dsh-channels',
      version: options.pluginVersion ?? DSH_CHANNELS_VERSION,
    },
    includes: {
      descendants: false,
      attachments: false,
      rawArtifacts: false,
    },
    session: {
      id: session.id,
      header: session.header,
    },
  }
  const lines = [JSON.stringify(manifest)]
  for (const event of session.snapshotEvents()) lines.push(JSON.stringify(event))
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

/** Serialize the logical snapshot, then gzip it entirely in memory. */
export async function createLogicalSessionExport(
  session: Session,
  options: LogicalSessionExportOptions = {},
): Promise<LogicalSessionExportFile> {
  const snapshot = serializeLogicalSession(session, options)
  const source = await (options.compress ?? gzipBuffer)(snapshot)
  return {
    fileName: `dsh-session-${session.id}.logical.jsonl.gz`,
    source,
  }
}
