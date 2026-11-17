/**
 * Read fence: which calls it inspects, how paths resolve (relative, `~`,
 * symlinks, glob patterns), and how subagent Sessions inherit their routed
 * ancestor's workspace.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLineage } from '../src/access/lineage.ts'
import { ReadFence } from '../src/access/read-fence.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { Agent, PreToolExecution } from '../src/host/index.ts'

type FenceConfig = FeishuConfig['readFence']

/** Two users' workspaces under one base directory, a shared skills directory, and a secret outside both. */
function setup(overrides: Partial<FenceConfig> = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-channels-fence-'))
  const alice = path.join(base, 'p2p', 'u_alice')
  const bob = path.join(base, 'p2p', 'u_bob')
  const skills = path.join(base, 'skills')
  const secret = path.join(base, 'secret')
  for (const dir of [alice, bob, skills, secret]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(bob, 'notes.md'), 'bob')
  writeFileSync(path.join(secret, 'token'), 'x')
  const config: FenceConfig = {
    enabled: true,
    readableRoots: [skills],
    tools: { read: ['file_path'], grep: ['path'], glob: ['path', 'pattern'] },
    pathArguments: ['path', 'file_path', 'paths'],
    uncheckedTools: [],
    ...overrides,
  }
  const routes = new Map<string, RouteRecord>([['s_alice', { workspacePath: alice } as RouteRecord]])
  const cwd = new Map<string, string>()
  const lineage = new SessionLineage(sessionId => routes.get(sessionId))
  const fence = new ReadFence({
    config: () => ({ readFence: config }),
    routeOf: sessionId => routes.get(sessionId),
    lineage,
    workingDirectory: session => cwd.get(session.id),
  })
  return { fence, lineage, config, routes, cwd, base, alice, bob, skills, secret }
}

/** One pending call by the agent of `sessionId`. */
function call(name: string, args: Record<string, unknown>, sessionId = 's_alice', parentSession?: string, headerCwd?: string): PreToolExecution {
  const agent = { session: { id: sessionId, header: { parentSession, cwd: headerCwd } } } as unknown as Agent
  return { name, arguments: args, agent }
}

const denied = { kind: 'deny', reason: expect.stringContaining('飞书会话只能读取自己的工作区') }

describe('ReadFence', () => {
  it('allows the topic directory and the shared roots; denies everything else', async () => {
    const { fence, alice, bob, skills, secret } = setup()
    expect(await fence.decide(call('read', { file_path: path.join(alice, 'a.md') }))).toBeUndefined()
    expect(await fence.decide(call('read', { file_path: path.join(skills, 'x', 'SKILL.md') }))).toBeUndefined()
    const decision = await fence.decide(call('read', { file_path: path.join(bob, 'notes.md') }))
    expect(decision).toMatchObject(denied)
    expect(decision && 'reason' in decision ? decision.reason : '').toContain(alice)
    expect(await fence.decide(call('read', { file_path: path.join(secret, 'token') }))).toMatchObject(denied)
    expect(await fence.decide(call('read', { file_path: path.join(alice, '..', 'u_bob', 'notes.md') }))).toMatchObject(denied)
  })

  it('resolves relative paths against the effective working directory, then the header cwd, then the workspace', async () => {
    const { fence, cwd, alice, base } = setup()
    expect(await fence.decide(call('read', { file_path: 'a.md' }))).toBeUndefined()
    expect(await fence.decide(call('read', { file_path: '../u_bob/notes.md' }))).toMatchObject(denied)
    expect(await fence.decide(call('read', { file_path: 'a.md' }, 's_alice', undefined, base))).toMatchObject(denied)
    cwd.set('s_alice', path.join(alice, 'sub'))
    expect(await fence.decide(call('read', { file_path: '../a.md' }, 's_alice', undefined, base))).toBeUndefined()
    expect(await fence.decide(call('read', { file_path: '~/.ssh/id_rsa' }))).toMatchObject(denied)
    expect(path.relative(homedir(), alice).startsWith('..')).toBe(true)
  })

  it('follows symlinks planted inside the workspace', async () => {
    const { fence, alice, secret } = setup()
    symlinkSync(secret, path.join(alice, 'link'))
    expect(await fence.decide(call('read', { file_path: path.join(alice, 'link', 'token') }))).toMatchObject(denied)
    expect(await fence.decide(call('read', { file_path: path.join(alice, 'link', 'missing', 'file') }))).toMatchObject(denied)
  })

  it('checks glob patterns by their leading directories and rejects `..` segments', async () => {
    const { fence, alice, bob } = setup()
    expect(await fence.decide(call('glob', { pattern: '**/*.ts' }))).toBeUndefined()
    expect(await fence.decide(call('glob', { pattern: 'src/**/*.ts', path: alice }))).toBeUndefined()
    expect(await fence.decide(call('glob', { pattern: 'notes.md', path: bob }))).toMatchObject(denied)
    expect(await fence.decide(call('glob', { pattern: `${bob}/**` }))).toMatchObject(denied)
    expect(await fence.decide(call('glob', { pattern: '/etc/passwd' }))).toMatchObject(denied)
    expect(await fence.decide(call('glob', { pattern: '**/../../u_bob/*' }))).toMatchObject(denied)
    expect(await fence.decide(call('grep', { pattern: 'token', path: bob }))).toMatchObject(denied)
    // An omitted path defaults to the workspace inside the tool.
    expect(await fence.decide(call('grep', { pattern: 'token' }))).toBeUndefined()
  })

  it('grants nothing through a topic directory replaced by a symlink', async () => {
    const { fence, routes, base, secret } = setup()
    const outside = path.join(base, 'topics-outside')
    mkdirSync(outside, { recursive: true })
    const linked = path.join(outside, 't1')
    symlinkSync(secret, linked)
    routes.set('s_alice', { workspacePath: linked } as RouteRecord)
    expect(await fence.decide(call('read', { file_path: path.join(secret, 'token') }))).toMatchObject(denied)
  })

  it('checks an omitted path argument as the effective working directory', async () => {
    const { fence, cwd, alice, secret } = setup()
    cwd.set('s_alice', path.join(alice, 'sub'))
    expect(await fence.decide(call('grep', { pattern: 'token' }))).toBeUndefined()
    cwd.set('s_alice', secret)
    expect(await fence.decide(call('grep', { pattern: 'token' }))).toMatchObject(denied)
    expect(await fence.decide(call('glob', { pattern: '*' }))).toMatchObject(denied)
    expect(await fence.decide(call('grep', { pattern: 'token', path: alice }))).toBeUndefined()
  })

  it('fences subagents of a routed Session, including nested ones, and ignores Sessions it does not route', async () => {
    const { fence, lineage, bob } = setup()
    const outside = { file_path: path.join(bob, 'notes.md') }
    expect(await fence.decide(call('read', outside, 's_child', 's_alice'))).toMatchObject(denied)
    expect(await fence.decide(call('read', outside, 's_grandchild', 's_child'))).toMatchObject(denied)
    expect(await fence.decide(call('read', outside, 's_web'))).toBeUndefined()
    expect(await fence.decide(call('read', outside, 's_web_child', 's_web'))).toBeUndefined()
    lineage.clear()
    expect(await fence.decide(call('read', outside, 's_grandchild', 's_child'))).toBeUndefined()
  })

  it('ignores unlisted tools, calls without an agent, non-string arguments, and a disabled fence; reads the config live', async () => {
    const { fence, config, bob } = setup()
    const outside = { file_path: path.join(bob, 'notes.md') }
    expect(await fence.decide(call('write', outside))).toBeUndefined()
    expect(await fence.decide({ name: 'read', arguments: outside })).toBeUndefined()
    expect(await fence.decide(call('read', { file_path: 42 }))).toBeUndefined()
    expect(await fence.decide({ ...call('read', {}), arguments: 'not an object' })).toBeUndefined()
    expect(await fence.decide(call('toString', outside))).toBeUndefined()
    config.enabled = false
    expect(await fence.decide(call('read', outside))).toBeUndefined()
    config.enabled = true
    config.tools = { ...config.tools, write: ['file_path'] }
    expect(await fence.decide(call('write', outside))).toMatchObject(denied)
  })

  describe('projects-mode private-chat Sessions', () => {
    /** Alice's projects-mode directory with a main Session, two topics, and shared files. */
    function projects() {
      const fixture = setup()
      const { alice, routes } = fixture
      const main = path.join(alice, 'main')
      const mine = path.join(alice, 'topics', 'omt_1')
      const sibling = path.join(alice, 'topics', 'omt_2')
      const shared = path.join(alice, 'shared')
      for (const dir of [main, mine, sibling, shared]) mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(sibling, 'draft.md'), 'other topic')
      routes.set('s_alice', { workspacePath: alice, dmRole: 'topic', currentDir: mine } as RouteRecord)
      routes.set('s_main', { workspacePath: alice, dmRole: 'main', currentDir: main } as RouteRecord)
      fixture.cwd.set('s_alice', mine)
      fixture.cwd.set('s_main', main)
      return { ...fixture, main, mine, sibling, shared }
    }

    const projectDenied = { kind: 'deny', reason: expect.stringContaining('这个会话只能访问自己的目录') }

    it('lets a topic read its own directory and shared/, not sibling topics, the main directory, or the person root', async () => {
      const { fence, alice, main, mine, sibling, shared, skills } = projects()
      expect(await fence.decide(call('read', { file_path: 'notes.md' }))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: path.join(mine, 'a.md') }))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: path.join(shared, 'report.md') }))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: path.join(skills, 'SKILL.md') }))).toBeUndefined()
      const decision = await fence.decide(call('read', { file_path: '../omt_2/draft.md' }))
      expect(decision).toMatchObject(projectDenied)
      expect(decision && 'reason' in decision ? decision.reason : '').toContain(shared)
      expect(await fence.decide(call('read', { file_path: path.join(sibling, 'draft.md') }))).toMatchObject(projectDenied)
      expect(await fence.decide(call('read', { file_path: path.join(main, 'x.md') }))).toMatchObject(projectDenied)
      expect(await fence.decide(call('grep', { pattern: 'x', path: alice }))).toMatchObject(projectDenied)
    })

    it('lets the main Session read main/ and shared/ only', async () => {
      const { fence, main, mine, shared } = projects()
      expect(await fence.decide(call('read', { file_path: path.join(main, 'a.md') }, 's_main'))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: '../shared/report.md' }, 's_main'))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: path.join(shared, 'r.md') }, 's_main'))).toBeUndefined()
      expect(await fence.decide(call('read', { file_path: path.join(mine, 'a.md') }, 's_main'))).toMatchObject(projectDenied)
    })

    it('checks unlisted tools through their path arguments, including string arrays, unless exempted', async () => {
      const { fence, config, mine, sibling, shared } = projects()
      expect(await fence.decide(call('write', { file_path: path.join(mine, 'out.md'), content: 'x' }))).toBeUndefined()
      expect(await fence.decide(call('write', { file_path: path.join(shared, 'out.md') }))).toBeUndefined()
      expect(await fence.decide(call('write', { file_path: path.join(sibling, 'draft.md') }))).toMatchObject(projectDenied)
      expect(await fence.decide(call('bundle', { paths: [path.join(mine, 'a'), path.join(sibling, 'b')] }))).toMatchObject(projectDenied)
      expect(await fence.decide(call('bundle', { paths: [path.join(mine, 'a'), 7, ''] }))).toBeUndefined()
      // No path argument: nothing to check, and an omitted one is not read as the working directory.
      expect(await fence.decide(call('web_search', { query: 'x' }))).toBeUndefined()
      config.uncheckedTools = ['write']
      expect(await fence.decide(call('write', { file_path: path.join(sibling, 'draft.md') }))).toBeUndefined()
    })

    it('leaves unlisted tools of topic-mode and group Sessions alone', async () => {
      const { fence, routes, alice, bob } = projects()
      routes.set('s_alice', { workspacePath: alice } as RouteRecord)
      expect(await fence.decide(call('write', { file_path: path.join(bob, 'notes.md') }))).toBeUndefined()
    })
  })
})
