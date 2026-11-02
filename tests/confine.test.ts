/**
 * Sandbox runner wrapper: argument parsing, where hides, fences, and exposes
 * land in the bwrap profile, and environment scrubbing.
 */

import { describe, expect, it } from 'vitest'
import { bwrapArgsOf, ConfineUsageError, confinedEnv, parseConfineArgs } from '../src/confine/runner.ts'

const ROOT = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const WRITE = (dir: string) => ['--tmpfs', '/tmp', '--bind', dir, dir]
const EXISTING = new Set(['/srv/dsh', '/srv/dsh/skills', '/srv/feishu', '/home/ops/.ssh'])
const host = (cwd: string) => ({ cwd, realDir: (dir: string) => (EXISTING.has(dir) ? dir : undefined) })

function argsOf(options: string[], profile: string[], cwd: string, command = ['sh', '-c', 'ls']): string[] {
  return bwrapArgsOf(parseConfineArgs([...options, '--bwrap', ...profile, '--', ...command]), host(cwd))
}

describe('confine runner', () => {
  it('hides secrets, fences other workspaces, re-exposes the own workspace, then applies the writable binds', () => {
    const ws = '/srv/feishu/p2p/u_alice'
    const args = argsOf(
      ['--hide', '/srv/dsh', '--hide', '/home/ops/.ssh', '--hide', '/missing', '--fence', '/srv/feishu', '--expose', '/srv/dsh/skills'],
      [...ROOT, ...WRITE(ws)],
      `${ws}/topics/t1`,
    )
    expect(args).toEqual([
      '--ro-bind', '/', '/',
      '--tmpfs', '/srv/dsh', '--tmpfs', '/home/ops/.ssh', '--tmpfs', '/srv/feishu',
      '--ro-bind', ws, ws,
      '--ro-bind', '/srv/dsh/skills', '/srv/dsh/skills',
      ...ROOT.slice(3), ...WRITE(ws),
      '--', 'sh', '-c', 'ls',
    ])
  })

  it('applies every fence in read-only mode, whatever the working directory', () => {
    expect(argsOf(['--fence', '/srv/feishu'], ROOT, '/tmp'))
      .toEqual(['--ro-bind', '/', '/', '--tmpfs', '/srv/feishu', ...ROOT.slice(3), '--', 'sh', '-c', 'ls'])
  })

  it('mounts a hide inside a writable root after the writable binds', () => {
    const args = argsOf(['--hide', '/home/ops/.ssh', '--expose', '/srv/dsh/skills'], [...ROOT, ...WRITE('/home/ops')], '/home/ops')
    expect(args).toEqual([
      '--ro-bind', '/', '/',
      '--ro-bind', '/srv/dsh/skills', '/srv/dsh/skills',
      ...ROOT.slice(3), ...WRITE('/home/ops'),
      '--tmpfs', '/home/ops/.ssh',
      '--', 'sh', '-c', 'ls',
    ])
    expect(() => argsOf(['--hide', '/home/ops/.ssh'], [...ROOT, ...WRITE('/home/ops')], '/home/ops/.ssh')).toThrow('is hidden')
  })

  it('leaves a fence alone when the call works outside it', () => {
    expect(argsOf(['--fence', '/srv/feishu'], [...ROOT, ...WRITE('/home/ops/project')], '/home/ops/project'))
      .toEqual([...ROOT, ...WRITE('/home/ops/project'), '--', 'sh', '-c', 'ls'])
  })

  it('never restores a working directory: one covered outside every writable root is refused', () => {
    const ws = '/srv/feishu/p2p/u_alice'
    expect(() => argsOf(['--fence', '/srv/feishu'], [...ROOT, ...WRITE(ws)], '/srv/feishu'))
      .toThrow('working directory /srv/feishu is hidden')
    expect(() => argsOf(['--hide', '/srv/dsh', '--fence', '/srv/feishu'], [...ROOT, ...WRITE(ws)], '/srv/dsh'))
      .toThrow(ConfineUsageError)
    expect(() => argsOf(['--fence', '/srv/feishu'], ROOT, '/srv/feishu/groups/oc_1/u_bob'))
      .toThrow('working directory /srv/feishu/groups/oc_1/u_bob is hidden')
  })

  it('re-exposes a workspace that lies inside a hidden directory', () => {
    const ws = '/srv/dsh/workspaces/u_alice'
    const args = argsOf(['--hide', '/srv/dsh'], [...ROOT, ...WRITE(ws)], ws)
    expect(args.slice(0, 8)).toEqual(['--ro-bind', '/', '/', '--tmpfs', '/srv/dsh', '--ro-bind', ws, ws])
  })

  it('removes named and matching environment variables', () => {
    const { options } = parseConfineArgs(['--unset-env', 'DEEPSEEK_BASE_URL', '--unset-env-matching', '(_KEY|_TOKEN|_SECRET)$', '--bwrap', ...ROOT, '--', 'true'])
    expect(confinedEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: 'u', GITLAB_TOKEN: 't', FEISHU_APP_SECRET: 's', HOME: '/root' }, options))
      .toEqual({ PATH: '/bin', HOME: '/root' })
  })

  it('uses the configured bwrap executable', () => {
    expect(parseConfineArgs(['--bwrap-path', '/usr/local/bin/bwrap', '--bwrap', ...ROOT, '--', 'true']).options.bwrap).toBe('/usr/local/bin/bwrap')
    expect(parseConfineArgs(['--bwrap', ...ROOT, '--', 'true']).options.bwrap).toBe('bwrap')
  })

  it.each([
    [['--bogus', 'x', '--bwrap', ...ROOT, '--', 'true'], 'unknown option --bogus'],
    [['--hide'], '--hide needs a value'],
    [['--hide', 'relative/dir', '--bwrap', ...ROOT, '--', 'true'], 'needs an absolute directory'],
    [['--unset-env-matching', '(', '--bwrap', ...ROOT, '--', 'true'], 'not a valid regular expression'],
    [[...ROOT, '--', 'true'], 'unknown option --ro-bind'],
    [['--hide', '/srv/dsh'], 'missing --bwrap'],
    [['--bwrap', ...ROOT, 'true'], 'missing -- between'],
    [['--bwrap', ...ROOT, '--'], 'missing command'],
  ])('rejects a malformed invocation %#', (argv, message) => {
    expect(() => parseConfineArgs(argv)).toThrow(ConfineUsageError)
    expect(() => parseConfineArgs(argv)).toThrow(message)
  })

  it('rejects a profile that does not start with the read-only root mount', () => {
    expect(() => argsOf([], ['--bind', '/', '/'], '/')).toThrow('must start with --ro-bind / /')
  })
})
