/**
 * Executable entry of the sandbox runner wrapper (`lib/confine.js`); see
 * `./runner.ts` for what it adds to DSH's bwrap profile.
 *
 * It starts bwrap with the rewritten arguments and inherited stdio, forwards
 * SIGINT/SIGTERM/SIGHUP, and exits with bwrap's status (or re-raises its
 * signal). A usage error or a failure to start bwrap prints one line starting
 * with `dsh-channels-confine:` to stderr and exits 125; list that prefix in
 * `runnerFailureSignatures` so DSH reports a runner failure instead of a
 * command failure.
 *
 * @module dsh-channels/confine/main
 */

import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import process from 'node:process'
import { bwrapArgsOf, confinedEnv, parseConfineArgs } from './runner.ts'

/** Exit status of a wrapper failure (bwrap never started). */
const RUNNER_FAILURE_EXIT = 125

function fail(message: string): never {
  process.stderr.write(`dsh-channels-confine: ${message}\n`)
  process.exit(RUNNER_FAILURE_EXIT)
}

function realDir(dir: string): string | undefined {
  try {
    const real = realpathSync(dir)
    return statSync(real).isDirectory() ? real : undefined
  } catch (error) {
    // A missing directory has nothing to hide or expose; other errors are reported.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    fail(`cannot inspect ${dir}: ${String(error)}`)
  }
}

let args: string[]
let env: NodeJS.ProcessEnv
let bwrap: string
try {
  const invocation = parseConfineArgs(process.argv.slice(2))
  args = bwrapArgsOf(invocation, { cwd: realpathSync(process.cwd()), realDir })
  env = confinedEnv(process.env, invocation.options)
  bwrap = invocation.options.bwrap
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

const child = spawn(bwrap, args, { stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => { child.kill(signal) })
}
child.on('error', error => fail(`cannot start ${bwrap}: ${error.message}`))
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? RUNNER_FAILURE_EXIT)
})
