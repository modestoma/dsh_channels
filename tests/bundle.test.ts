/**
 * Package-level DSH bundle contract: installation contributes exactly one
 * stable Loader row, while the profile remains responsible for its config.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name: string
  files?: string[]
  dsh?: {
    bundle?: {
      patch?: string
    }
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

describe('DSH bundle manifest', () => {
  it('publishes the declared Cordis patch', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('inserts one stable package-owned Loader row', () => {
    expect(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toBe([
      '- insert:',
      '    - id: dsh-channels',
      `      name: '${manifest.name}'`,
      '',
    ].join('\n'))
  })
})
