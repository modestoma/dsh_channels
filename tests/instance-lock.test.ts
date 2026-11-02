/**
 * Machine-wide instance lock: the real IPC endpoint (acquire, refusal with the
 * owner's identity, release, stale socket recovery, yield) and the service
 * using it (refused connect, takeover).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuConfig } from '../src/config.ts'
import { createInstanceLockProvider, lockAddress } from '../src/instance-lock.ts'
import type { AcquireOptions, InstanceLock, LockHolderInfo } from '../src/instance-lock.ts'
import { InstanceLockHeldError } from '../src/service.ts'
import { makeAccessConfig } from './access-fixtures.ts'
import {
  makeChannel, makeHostContext, makeInstanceLocks, makeTempBaseDir, TestFeishuService,
} from './helpers.ts'

const describeUnix = process.platform === 'win32' ? describe.skip : describe

function identity(pid: number, home = '/home/a/.dsh'): LockHolderInfo {
  return { pid, home, version: '0.0.0-test', startedAt: 1 }
}

function options(address: string, self: LockHolderInfo, overrides: Partial<AcquireOptions> = {}): AcquireOptions {
  return { address, self, onYield: () => {}, canYield: () => true, ...overrides }
}

const held: InstanceLock[] = []
afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release()
})

describe('lockAddress', () => {
  it('derives a short, App-ID-free address per platform', () => {
    const unix = lockAddress('cli_secret_app', 'darwin', '/tmp')
    expect(unix).toMatch(/^\/tmp\/dsh-channels-[0-9a-f]{16}\.sock$/)
    expect(unix).not.toContain('cli_secret_app')
    expect(lockAddress('cli_secret_app', 'win32')).toMatch(/^\\\\\.\\pipe\\dsh-channels-[0-9a-f]{16}$/)
    expect(lockAddress('cli_secret_app', 'linux', '/tmp')).toMatch(/^\0dsh-channels-[0-9a-f]{16}$/)
    expect(lockAddress('cli_other', 'darwin', '/tmp')).not.toBe(unix)
  })
})

describeUnix('createInstanceLockProvider (socket file)', () => {
  // The socket-file endpoint of macOS, exercised on any Unix host.
  const provider = () => createInstanceLockProvider({ dir: mkdtempSync(path.join(tmpdir(), 'dsh-lock-')), platform: 'darwin', sameProcessWaitMs: 0 })

  it('grants the first owner and refuses the next with the owner identity', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    const first = await locks.acquire(options(address, identity(process.pid)))
    expect(first.ok).toBe(true)
    if (first.ok) held.push(first.lock)

    const second = await locks.acquire(options(address, identity(process.pid, '/home/b/.dsh')))
    expect(second).toEqual({ ok: false, holder: identity(process.pid) })
  })

  it('frees the address on release', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    const first = await locks.acquire(options(address, identity(process.pid)))
    if (!first.ok) throw new Error('first acquisition refused')
    await first.lock.release()
    await first.lock.release()
    expect(existsSync(address)).toBe(false)

    const again = await locks.acquire(options(address, identity(process.pid)))
    expect(again.ok).toBe(true)
    if (again.ok) held.push(again.lock)
  })

  it('waits for a holder in this same process to release', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-lock-'))
    const locks = createInstanceLockProvider({ dir, platform: 'darwin', sameProcessWaitMs: 2_000 })
    const address = locks.address('cli_a')
    const first = await locks.acquire(options(address, identity(process.pid)))
    if (!first.ok) throw new Error('first acquisition refused')
    setTimeout(() => { void first.lock.release() }, 300)

    const second = await locks.acquire(options(address, identity(process.pid)))
    expect(second.ok).toBe(true)
    if (second.ok) held.push(second.lock)
  })

  it('reports an unidentified owner and recovers the address once that process is killed', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    // A foreign process listening on the address without speaking the protocol.
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(address)}, () => console.log('ready'))`])
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
    })

    const refused = await locks.acquire(options(address, identity(process.pid)))
    expect(refused).toEqual({ ok: false, holder: undefined })

    // SIGKILL leaves the socket file behind; it refuses connections.
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(existsSync(address)).toBe(true)

    const recovered = await locks.acquire(options(address, identity(process.pid)))
    expect(recovered.ok).toBe(true)
    if (recovered.ok) held.push(recovered.lock)
  })

  /** Leave a socket file whose owner was SIGKILLed: it refuses connections. */
  async function staleSocket(address: string): Promise<void> {
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(address)}, () => console.log('ready'))`])
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
    })
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    expect(existsSync(address)).toBe(true)
  }

  it('grants a stale address to exactly one of several concurrent contenders', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    await staleSocket(address)

    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(n =>
      locks.acquire(options(address, identity(process.pid, `/home/${n}/.dsh`)))))
    const winners = results.filter(result => result.ok)
    expect(winners).toHaveLength(1)
    for (const result of results) if (result.ok) held.push(result.lock)
    const holders = results.flatMap(result => result.ok ? [] : [result.holder?.home])
    expect(new Set(holders).size).toBe(1)
    expect(holders[0]).toMatch(/^\/home\/\d\/\.dsh$/)
    expect(existsSync(`${address}.recover`)).toBe(false)
  })

  it('never unlinks the socket another process bound while it recovered the address', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    await staleSocket(address)
    // Another process is mid-recovery: it holds the recovery directory.
    mkdirSync(`${address}.recover`)
    const contender = locks.acquire(options(address, identity(process.pid, '/home/b/.dsh')))
    await new Promise(resolve => setTimeout(resolve, 300))
    // That process finishes: it replaces the stale file with its live socket.
    rmSync(address)
    const owner = await locks.acquire(options(address, identity(process.pid, '/home/a/.dsh')))
    if (!owner.ok) throw new Error('owner acquisition refused')
    held.push(owner.lock)
    rmdirSync(`${address}.recover`)

    // The contender's earlier probe saw a refusing socket; it must not remove the live one.
    await expect(contender).resolves.toEqual({ ok: false, holder: identity(process.pid, '/home/a/.dsh') })
    const again = await locks.acquire(options(address, identity(process.pid, '/home/c/.dsh')))
    expect(again).toEqual({ ok: false, holder: identity(process.pid, '/home/a/.dsh') })
  })

  it('removes a recovery directory abandoned by a crashed process', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    await staleSocket(address)
    mkdirSync(`${address}.recover`)
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(`${address}.recover`, longAgo, longAgo)

    const result = await locks.acquire(options(address, identity(process.pid)))
    expect(result.ok).toBe(true)
    if (result.ok) held.push(result.lock)
  })

  it('answers a yield request, then lets the requester acquire once the owner released', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    const yieldedTo: LockHolderInfo[] = []
    let owner: InstanceLock | undefined
    const first = await locks.acquire(options(address, identity(process.pid), {
      onYield: (from) => {
        yieldedTo.push(from)
        setTimeout(() => { void owner?.release() }, 100)
      },
    }))
    if (!first.ok) throw new Error('first acquisition refused')
    owner = first.lock

    const requester = identity(process.pid, '/home/b/.dsh')
    await expect(locks.requestYield(address, requester)).resolves.toBe('yielding')
    expect(yieldedTo).toEqual([requester])

    const taken = await locks.acquire(options(address, requester, { waitUntil: Date.now() + 3_000 }))
    expect(taken.ok).toBe(true)
    if (taken.ok) held.push(taken.lock)
  })

  it('refuses a yield while the owner is busy and reports an absent owner', async () => {
    const locks = provider()
    const address = locks.address('cli_a')
    await expect(locks.requestYield(address, identity(1))).resolves.toBe('absent')

    let yielded = false
    const first = await locks.acquire(options(address, identity(process.pid), {
      canYield: () => false,
      onYield: () => { yielded = true },
    }))
    if (!first.ok) throw new Error('first acquisition refused')
    held.push(first.lock)
    await expect(locks.requestYield(address, identity(1))).resolves.toBe('busy')
    expect(yielded).toBe(false)
  })
})

describe('FeishuService instance lock', () => {
  function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
    return makeAccessConfig({ baseDir: makeTempBaseDir(), statusRefreshMs: 60_000, routeTtlMs: 0, welcomeOnboarding: false, ...partial })
  }

  it('stays disconnected while another instance owns the bot, then takes the connection over', async () => {
    const locks = makeInstanceLocks()
    const first = new TestFeishuService(makeHostContext().ctx, makeConfig(), () => makeChannel(), undefined, undefined, locks)
    await first.connect()
    expect(first.isRunning()).toBe(true)

    const secondChannel = makeChannel()
    const second = new TestFeishuService(makeHostContext().ctx, makeConfig(), () => secondChannel, undefined, undefined, locks)
    const refused = second.connect()
    await expect(refused).rejects.toBeInstanceOf(InstanceLockHeldError)
    await expect(refused).rejects.toThrow(/本机另一个 dsh 实例占用/)
    expect(second.isRunning()).toBe(false)
    expect(second.occupiedBy()?.holder?.pid).toBe(process.pid)
    expect(secondChannel.connect).not.toHaveBeenCalled()

    await second.takeover()
    expect(second.isRunning()).toBe(true)
    expect(second.occupiedBy()).toBeUndefined()
    await vi.waitFor(() => expect(first.isRunning()).toBe(false))
    expect(first.occupiedBy()?.holder).toBeDefined()
    expect(first.startError()).toMatch(/已被本机另一个 dsh 实例接管/)

    await second.shutdown()
    expect(locks.owners.size).toBe(0)
  })
})

const describeLinux = process.platform === 'linux' ? describe : describe.skip

describeLinux('createInstanceLockProvider (Linux abstract socket)', () => {
  // A unique App ID per test keeps the machine-wide abstract names apart.
  const appId = () => `cli_test_${process.pid}_${Math.random().toString(36).slice(2)}`

  it('leaves no file behind and frees the address on release', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-lock-'))
    const locks = createInstanceLockProvider({ dir, sameProcessWaitMs: 0 })
    const address = locks.address(appId())
    expect(address.startsWith('\0')).toBe(true)
    const first = await locks.acquire(options(address, identity(process.pid)))
    if (!first.ok) throw new Error('first acquisition refused')
    expect(readdirSync(dir)).toEqual([])
    expect(await locks.acquire(options(address, identity(process.pid, '/home/b/.dsh')))).toEqual({ ok: false, holder: identity(process.pid) })

    await first.lock.release()
    const again = await locks.acquire(options(address, identity(process.pid, '/home/b/.dsh')))
    expect(again.ok).toBe(true)
    if (again.ok) held.push(again.lock)
  })

  it('frees the address the moment its owner is killed', async () => {
    const locks = createInstanceLockProvider({ sameProcessWaitMs: 0 })
    const address = locks.address(appId())
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(address)}, () => console.log('ready'))`])
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
    })
    expect(await locks.acquire(options(address, identity(process.pid)))).toEqual({ ok: false, holder: undefined })

    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const recovered = await locks.acquire(options(address, identity(process.pid)))
    expect(recovered.ok).toBe(true)
    if (recovered.ok) held.push(recovered.lock)
  })
})
