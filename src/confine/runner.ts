/**
 * Sandbox runner wrapper: turns the bwrap profile DSH's local sandbox hands a
 * custom runner (`sandbox-local` `runnerCommand`) into one that also hides
 * secrets and other users' workspaces from every confined process.
 *
 * DSH's profile mounts `/` read-only and binds the writable roots, so reads
 * are otherwise unconfined. This wrapper inserts, right after that root
 * mount and before the writable binds:
 *
 * 1. `--tmpfs` over each `--hide` directory (credentials, Session logs, keys);
 * 2. `--tmpfs` over each `--fence` directory that contains a writable root
 *    or the working directory of the call, so one Feishu user's command
 *    cannot list or read another user's workspace under the channel's base
 *    directory;
 * 3. a read-only bind of each writable root a hide or fence covered, so the
 *    call still sees its own workspace (the profile's later writable bind
 *    makes it writable again);
 * 4. a read-only bind of each `--expose` directory (shared skills).
 *
 * Only the profile's writable roots are restored: they are the workspace DSH
 * authorized for the call. The working directory is not an authorization (a
 * Session can move it anywhere), so a call whose working directory a hide or
 * fence covers outside every writable root is refused, which also refuses
 * read-only calls inside a fenced or hidden directory.
 *
 * Environment variables named by `--unset-env` or matching
 * `--unset-env-matching` are removed before bwrap starts.
 *
 * Argument vector: `[options…] --bwrap <profile…> -- <command…>`; DSH appends
 * everything from the profile on. Directories that do not exist are skipped
 * on each call, so a directory created later is hidden from the next call.
 *
 * @module dsh-channels/confine/runner
 */

import path from 'node:path'

/** Options the deployment puts in `runnerCommand` before `--bwrap`. */
export interface ConfineOptions {
  /** bwrap executable. */
  readonly bwrap: string
  readonly hide: readonly string[]
  readonly fence: readonly string[]
  readonly expose: readonly string[]
  readonly unsetEnv: readonly string[]
  readonly unsetEnvMatching: readonly RegExp[]
}

/** One parsed wrapper invocation. */
export interface ConfineInvocation {
  readonly options: ConfineOptions
  /** The bwrap profile arguments DSH appended (before `--`). */
  readonly profile: readonly string[]
  /** The confined command (after `--`). */
  readonly command: readonly string[]
}

/** A wrapper invocation the deployment or DSH formed incorrectly. */
export class ConfineUsageError extends Error {
  override readonly name = 'ConfineUsageError'
}

const VALUE_OPTIONS = new Set(['--bwrap-path', '--hide', '--fence', '--expose', '--unset-env', '--unset-env-matching'])

/**
 * Parse the wrapper's argument vector.
 * @param argv - arguments after the script path.
 * @returns the options, profile, and command.
 * @throws ConfineUsageError for an unknown option, a missing value, a relative
 *   directory, an invalid pattern, or a missing `--bwrap` / `--` / command.
 */
export function parseConfineArgs(argv: readonly string[]): ConfineInvocation {
  let bwrap = 'bwrap'
  const hide: string[] = []
  const fence: string[] = []
  const expose: string[] = []
  const unsetEnv: string[] = []
  const unsetEnvMatching: RegExp[] = []
  let index = 0
  for (; index < argv.length && argv[index] !== '--bwrap'; index++) {
    const option = argv[index]!
    if (!VALUE_OPTIONS.has(option)) throw new ConfineUsageError(`unknown option ${option}`)
    const value = argv[++index]
    if (value === undefined || value === '') throw new ConfineUsageError(`${option} needs a value`)
    switch (option) {
      case '--bwrap-path': bwrap = value; break
      case '--hide': hide.push(absoluteDir(option, value)); break
      case '--fence': fence.push(absoluteDir(option, value)); break
      case '--expose': expose.push(absoluteDir(option, value)); break
      case '--unset-env': unsetEnv.push(value); break
      case '--unset-env-matching': unsetEnvMatching.push(patternOf(value)); break
    }
  }
  if (index >= argv.length) throw new ConfineUsageError('missing --bwrap before the sandbox profile')
  const rest = argv.slice(index + 1)
  const separator = rest.indexOf('--')
  if (separator === -1) throw new ConfineUsageError('missing -- between the sandbox profile and the command')
  const command = rest.slice(separator + 1)
  if (command.length === 0) throw new ConfineUsageError('missing command after --')
  return {
    options: { bwrap, hide, fence, expose, unsetEnv, unsetEnvMatching },
    profile: rest.slice(0, separator),
    command,
  }
}

/** Filesystem facts one call needs, injected for tests. */
export interface ConfineHost {
  /** The working directory the command runs in (canonical). */
  readonly cwd: string
  /** The canonical path of an existing directory, or undefined when it does not exist. */
  realDir(dir: string): string | undefined
}

/**
 * Build the bwrap argument vector for one call.
 * @param invocation - the parsed wrapper invocation.
 * @param host - filesystem facts of this call.
 * @returns bwrap's arguments, ending with `--` and the command.
 * @throws ConfineUsageError when the profile does not start with DSH's read-only
 *   root mount, or the working directory is covered outside every writable root.
 */
export function bwrapArgsOf(invocation: ConfineInvocation, host: ConfineHost): string[] {
  const { options, profile, command } = invocation
  if (profile[0] !== '--ro-bind' || profile[1] !== '/' || profile[2] !== '/') {
    throw new ConfineUsageError('the sandbox profile must start with --ro-bind / / (DSH sandbox-local bwrap profile)')
  }
  const writable = unique(writableRootsOf(profile))
  const triggers = [...writable, host.cwd]
  const masked: string[] = []
  for (const dir of options.hide) {
    const real = host.realDir(dir)
    if (real !== undefined) masked.push(real)
  }
  for (const dir of options.fence) {
    const real = host.realDir(dir)
    if (real !== undefined && triggers.some(trigger => isInside(trigger, real))) masked.push(real)
  }
  if (masked.some(dir => isInside(host.cwd, dir)) && !writable.some(root => isInside(host.cwd, root))) {
    throw new ConfineUsageError(`working directory ${host.cwd} is hidden by the confinement and is not inside a writable root of this call`)
  }
  const inserted = unique(masked).flatMap(dir => ['--tmpfs', dir])
  for (const root of writable) {
    if (masked.some(dir => isInside(root, dir))) inserted.push('--ro-bind', root, root)
  }
  for (const dir of options.expose) {
    const real = host.realDir(dir)
    if (real !== undefined) inserted.push('--ro-bind', real, real)
  }
  return [...profile.slice(0, 3), ...inserted, ...profile.slice(3), '--', ...command]
}

/**
 * The environment the confined command starts with.
 * @param env - the wrapper's own environment.
 * @param options - the parsed options.
 * @returns a copy without the removed variables.
 */
export function confinedEnv(env: NodeJS.ProcessEnv, options: ConfineOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (options.unsetEnv.includes(name) || options.unsetEnvMatching.some(pattern => pattern.test(name))) continue
    result[name] = value
  }
  return result
}

/** The roots the profile binds writable (`--bind <src> <dest>` with equal paths). */
function writableRootsOf(profile: readonly string[]): string[] {
  const roots: string[] = []
  for (let index = 0; index < profile.length - 2; index++) {
    if (profile[index] === '--bind' && profile[index + 1] === profile[index + 2]) roots.push(profile[index + 1]!)
  }
  return roots
}

function absoluteDir(option: string, value: string): string {
  if (!path.isAbsolute(value)) throw new ConfineUsageError(`${option} needs an absolute directory, got ${value}`)
  return path.resolve(value)
}

function patternOf(value: string): RegExp {
  try {
    return new RegExp(value, 'u')
  } catch (error) {
    throw new ConfineUsageError(`--unset-env-matching ${value} is not a valid regular expression: ${String(error)}`)
  }
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
