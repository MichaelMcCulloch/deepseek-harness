import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import DagService from '../src/index.ts'
import { DagNodeId } from '../src/ids.ts'
import { DagStateError, reduceDagState } from '../src/reducer.ts'
import type { DagNodeInput, DagNotice, DagState } from '../src/types.ts'

interface GatedEntry {
  readonly chunks: StreamChunk[]
  readonly gate?: Promise<undefined>
}

class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('DAG test adapter script exhausted')
    if (entry.gate !== undefined) await entry.gate
    for (const chunk of entry.chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

interface TestHarness {
  readonly ctx: Context
  readonly dispatcher: Agent
  readonly root: string
  readonly temporary: string
  readonly disposeDag: () => Promise<void>
}

const harnesses: TestHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.ctx.fiber.dispose()
    await rm(harness.temporary, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function setup(adapter: LlmAdapter): Promise<TestHarness> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-dag-service-'))
  const root = join(temporary, 'root')
  const home = join(temporary, 'home')
  const sessions = join(temporary, 'sessions')
  await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'dag@example.invalid')
  git(root, 'config', 'user.name', 'DAG Test')
  await writeFile(join(root, 'owned.txt'), 'base\n')
  git(root, 'add', 'owned.txt')
  git(root, 'commit', '-m', 'base')

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LocalSubprocessRuntime)
  const dagFiber = await ctx.plugin(DagService, { dshHome: home, subagentProvider: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const dispatcher = ctx.agentLoop.create(
    SessionId('dag-dispatcher'),
    { provider: 'mock', model: 'mock' },
    { cwd: root },
  )
  const harness = { ctx, dispatcher, root, temporary, disposeDag: dagFiber.dispose }
  harnesses.push(harness)
  return harness
}

async function resumeHarness(temporary: string, adapter: LlmAdapter): Promise<TestHarness> {
  const root = join(temporary, 'root')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(temporary, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LocalSubprocessRuntime)
  const dagFiber = await ctx.plugin(DagService, { dshHome: join(temporary, 'home'), subagentProvider: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.resume({
    resumeSessionId: SessionId('dag-dispatcher'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const harness = { ctx, dispatcher: handle.agent, root, temporary, disposeDag: dagFiber.dispose }
  harnesses.push(harness)
  return harness
}

function node(id = 'a'): DagNodeInput {
  return {
    id,
    content: `Implement ${id}`,
    brief: `Implement ${id}.\nVALIDATION: run the focused test.\nACCEPTANCE: commit clean work.`,
    deps: [],
    status: 'pending',
    files: ['owned.txt'],
  }
}

function appendUndeliveredFailure(harness: TestHarness, prefix: string): DagNotice {
  const declared = harness.ctx.dag.state(harness.dispatcher)
  if (declared === null) throw new Error('test DAG declaration is missing')
  const nodeId = DagNodeId('a')
  const dispatched = reduceDagState(declared, {
    type: 'dispatch',
    nodeIds: [nodeId],
    bindings: {
      a: {
        childSessionId: SessionId(`${prefix}-child`),
        branch: `dsh/dag/${prefix}/g1/a`,
        worktree: join(harness.temporary, 'home', 'dag', 'worktrees', 'v1', prefix, 'g1', 'a'),
      },
    },
  }).state
  const dispatchedNode = dispatched.nodes[0]
  const command = dispatchedNode?.commands[0]
  if (dispatchedNode?.waveId === undefined || command === undefined) throw new Error('test dispatch evidence is missing')
  const failed = reduceDagState(dispatched, {
    type: 'wave-probe-failed',
    waveId: dispatchedNode.waveId,
    fences: [{
      nodeId,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    }],
    reason: 'root probe failed',
  }).state
  const notice = failed.notices.find(row => row.kind === 'node-failed')
  if (notice === undefined) throw new Error('test failure notice is missing')
  harness.dispatcher.session.append('dag/state', { state: dispatched })
  harness.dispatcher.session.append('dag/state', { state: failed })
  return notice
}

function stateWhen(ctx: Context, dispatcher: Agent, predicate: (state: DagState) => boolean): Promise<DagState> {
  const current = ctx.dag.state(dispatcher)
  if (current !== null && predicate(current)) return Promise.resolve(current)
  return new Promise<DagState>((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== dispatcher.session || event.type !== 'dag/state' || !predicate(event.data.state)) return
      void dispose()
      resolve(event.data.state)
    }, { global: true })
  })
}

function childCreated(ctx: Context, dispatcher: Agent): Promise<Agent> {
  return new Promise<Agent>((resolve) => {
    const dispose = ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== dispatcher.id) return
      void dispose()
      resolve(agent)
    })
  })
}

function turnStarted(ctx: Context, agent: Agent, turn: number): Promise<void> {
  if (agent.session.events.some(event => event.type === 'turn/start' && event.data.turn === turn)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/start' || event.data.turn !== turn) return
      void dispose()
      resolve()
    }, { global: true })
  })
}

function agentDisposed(ctx: Context, agent: Agent): Promise<void> {
  if (ctx.agents.get(agent.id) !== agent) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed !== agent) return
      void dispose()
      resolve()
    })
  })
}

describe('native DAG service', () => {
  it('commits one complete snapshot and rejects a stale revision', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const commits: number[] = []
    ctx.on('dag/committed', ({ agent, committed }) => {
      expect(agent).toBe(dispatcher)
      expect(committed.snapshot.revision).toBe(committed.revision)
      expect(Object.isFrozen(committed.snapshot)).toBe(true)
      expect(Object.isFrozen(committed.snapshot.nodes)).toBe(true)
      commits.push(committed.revision)
    })

    const written = ctx.dag.write(dispatcher, { nodes: [node()] })

    expect(written.revision).toBe(1)
    expect(ctx.dag.state(dispatcher)?.revision).toBe(1)
    expect(dispatcher.session.events.filter(event => event.type === 'dag/state')).toHaveLength(1)
    await Promise.resolve()
    expect(commits).toEqual([1])
    expect(() => ctx.dag.write(dispatcher, { nodes: [node()], if_revision: 0 }))
      .toThrow(expect.objectContaining({ code: 'dag-revision-conflict' }))
    expect(() => ctx.dag.write(dispatcher, {
      nodes: [{ ...node(), brief: 'invalid' }],
      if_revision: 0,
    })).toThrow(expect.objectContaining({ code: 'dag-revision-conflict' }))
    expect(() => ctx.dag.reset(dispatcher, DagNodeId('a'), '', { if_revision: 0 }))
      .toThrow(expect.objectContaining({ code: 'dag-revision-conflict' }))
  })

  it('contains commit listener failures and still reaches later listeners', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const revisions: number[] = []
    ctx.on('dag/committed', () => { throw new Error('observer failed') })
    ctx.on('dag/committed', ({ committed }) => { revisions.push(committed.revision) })

    expect(() => ctx.dag.write(dispatcher, { nodes: [node()] })).not.toThrow()
    await Promise.resolve()

    expect(revisions).toEqual([1])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dag/committed'))
  })

  it('accepts only one pair of commands with the same revision guard', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const written = ctx.dag.write(dispatcher, { nodes: [node('a'), node('b')] })

    const first = ctx.dag.dispatch(dispatcher, [DagNodeId('a')], { if_revision: written.revision })
    expect(() => ctx.dag.dispatch(dispatcher, [DagNodeId('b')], { if_revision: written.revision }))
      .toThrow(expect.objectContaining({ code: 'dag-revision-conflict' }))

    expect(first.revision).toBe(written.revision + 1)
    expect(ctx.dag.state(dispatcher)?.nodes.map(row => [row.id, row.status])).toEqual([
      ['a', 'starting'],
      ['b', 'pending'],
    ])
  })

  it('rejects a nested append instead of waiting for a process lock', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    let failure: unknown
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== dispatcher.session || event.type !== 'dag/state' || event.data.state.revision !== 1) return
      try {
        ctx.dag.write(dispatcher, { nodes: [node()] })
      } catch (error) {
        failure = error
      }
    }, { global: true })

    ctx.dag.write(dispatcher, { nodes: [node()] })
    dispose()

    expect(failure).toBeInstanceOf(DagStateError)
    if (!(failure instanceof DagStateError)) throw new Error('nested append did not return a DAG state error')
    expect(failure.code).toBe('dag-revision-conflict')
    expect(failure.message).toContain('current revision is 1')
    expect(dispatcher.session.events.filter(event => event.type === 'dag/state')).toHaveLength(1)
  })

  it('permits one cancellable waiter for each dispatcher', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const written = ctx.dag.write(dispatcher, { nodes: [node()] })
    const firstController = new AbortController()
    const first = ctx.dag.wait(dispatcher, written.revision, firstController.signal)

    expect(() => ctx.dag.wait(dispatcher, written.revision, new AbortController().signal))
      .toThrow(expect.objectContaining({ code: 'dag-wait-active' }))
    const reason = new Error('wait cancelled')
    const rejected = expect(first).rejects.toBe(reason)
    firstController.abort(reason)
    await rejected
  })

  it('rejects invalid wait revisions before it registers a waiter', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    ctx.dag.write(dispatcher, { nodes: [node()] })

    expect(() => ctx.dag.wait(dispatcher, -1, new AbortController().signal))
      .toThrow(expect.objectContaining({ code: 'dag-invalid-revision' }))
    expect(() => ctx.dag.wait(dispatcher, Number.MAX_SAFE_INTEGER + 1, new AbortController().signal))
      .toThrow(expect.objectContaining({ code: 'dag-invalid-revision' }))
  })

  it('rejects an active waiter when the DAG service is disposed', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const written = ctx.dag.write(dispatcher, { nodes: [node()] })
    const waiting = ctx.dag.wait(dispatcher, written.revision, new AbortController().signal)
    const rejected = expect(waiting).rejects.toThrow('DAG service disposed')

    await ctx.fiber.dispose()

    await rejected
  })

  it('waits for a persistence-blocked node pump and starts no effect during disposal', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    let childCreations = 0
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession === dispatcher.id) childCreations++
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let released = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      const state = [...dispatcher.session.events].reverse().find(event => event.type === 'dag/state')?.data.state
      if (!released && state?.nodes[0]?.commands.some(command => command.state === 'running')) {
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    await entered.promise
    const before = [...dispatcher.session.events].reverse().find(event => event.type === 'dag/state')?.data.state
    if (before === undefined) throw new Error('test DAG state is missing')

    const disposed = ctx.fiber.dispose()
    await Promise.resolve()
    released = true
    release.resolve(undefined)
    await disposed
    const after = [...dispatcher.session.events].reverse().find(event => event.type === 'dag/state')?.data.state

    expect(after).toEqual(before)
    expect(after?.nodes[0]?.commands[0]?.state).toBe('running')
    expect(childCreations).toBe(0)
  })

  it('projects null before declaration and hides absolute worktree paths', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, dispatcher, temporary } = await setup(new GatedAdapter([{ chunks: textResponse('waiting'), gate: release.promise }]))
    expect(ctx.sessionProjections.snapshot(dispatcher.session).values.dag).toBeNull()

    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const projection = ctx.sessionProjections.snapshot(dispatcher.session).values.dag

    expect(projection).toMatchObject({ revision: 2, nodes: [{ id: 'a', status: 'starting' }] })
    expect(projection?.openWaves).toEqual([])
    expect(JSON.stringify(projection)).not.toContain(temporary)
    release.resolve(undefined)
  })

  it('does not create a wave when the root Git probe fails', async () => {
    const { ctx, dispatcher, root } = await setup(new GatedAdapter([]))
    await writeFile(join(root, 'dirty.txt'), 'untracked\n')
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const failed = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')

    const accepted = ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    expect(accepted.revision).toBe(2)
    expect(ctx.dag.state(dispatcher)?.waves).toEqual([])
    const state = await failed

    expect(state.waves).toEqual([])
    expect(state.nodes[0]?.settlement?.kind).toBe('failed')
    expect(state.nodes[0]?.settlement).toHaveProperty('reason', expect.stringContaining('clean root worktree'))
    expect(state.activeCommandIds).toEqual([])
  })

  it('does not start Git or child effects before the command state is durable', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const { ctx, dispatcher } = await setup(new GatedAdapter([
      { chunks: textResponse('waiting'), gate: releaseChild.promise },
    ]))
    const releaseFlush = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      await releaseFlush.promise
      return flush(session)
    })

    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.dag.state(dispatcher)?.nodes[0]?.commands.at(-1)?.state).toBe('accepted')
    expect(ctx.dag.state(dispatcher)?.waves).toEqual([])
    expect(ctx.agents.list().filter(agent => agent.session.header.parentSession === dispatcher.id)).toEqual([])

    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    releaseFlush.resolve(undefined)
    await running
    releaseChild.resolve(undefined)
  })

  it('pauses a node pump after a persistence failure instead of retrying in a loop', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const firstFailure = Promise.withResolvers<undefined>()
    let failures = 0
    let childCreations = 0
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession === dispatcher.id) childCreations++
    })
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => {
      const command = ctx.dag.state(dispatcher)?.nodes[0]?.commands[0]
      if (command?.state === 'running') {
        failures++
        firstFailure.resolve(undefined)
        throw new Error('disk unavailable')
      }
      return false
    })

    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    await firstFailure.promise
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const failuresAfterTurn = failures
    await Promise.resolve()

    expect(failures).toBe(failuresAfterTurn)
    expect(failures).toBeGreaterThan(0)
    expect(ctx.dag.state(dispatcher)?.nodes[0]?.commands[0]?.state).toBe('running')
    expect(ctx.dag.state(dispatcher)?.waves).toEqual([])
    expect(childCreations).toBe(0)
  })

  it('validates a local commit, injects the wave notice, and then resolves dag_wait', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child finished'), gate: release.promise }])
    const { ctx, dispatcher, root } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    const dispatched = ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const waited = ctx.dag.wait(dispatcher, dispatched.revision, new AbortController().signal)
    const worker = await child
    const active = await running
    const worktree = active.nodes[0]?.worktree
    if (worktree === undefined) throw new Error('test node has no worktree')
    await writeFile(join(worktree, 'owned.txt'), 'complete\n')
    git(worktree, 'add', 'owned.txt')
    git(worktree, 'commit', '-m', 'complete node')
    const completed = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'completed')

    ctx.dag.completeFrom(worker, 'Implemented and tested.')
    const final = await completed
    const notice = await waited

    expect(final.nodes[0]?.completedCommit).toBe(git(worktree, 'rev-parse', 'HEAD'))
    expect(final.nodes[0]?.completedCommit).not.toBe(git(root, 'rev-parse', 'HEAD'))
    expect(notice.notices.map(row => row.kind)).toContain('wave-settled')
    expect(dispatcher.session.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'dag-notice'))).toBe(true)
    expect(dispatcher.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toBe(false)

    release.resolve(undefined)
    await worker.whenIdle()
  })

  it('fails a child turn that ends without a final DAG report', async () => {
    const adapter = new GatedAdapter([{ chunks: textResponse('ordinary answer') }])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const failed = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')

    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const state = await failed

    expect(state.nodes[0]?.settlement).toMatchObject({ kind: 'failed' })
    expect(state.nodes[0]?.commands.every(command => command.state === 'settled')).toBe(true)
    expect(state.activeCommandIds).toEqual([])
    expect(state.notices.some(row => row.kind === 'node-failed')).toBe(true)
    expect(dispatcher.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toBe(false)
  })

  it('fails the ended owner turn and discards queued generic child work', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('ordinary answer'), gate: release.promise },
      { chunks: textResponse('must not run') },
    ])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    await running
    await ctx.subagents.followup(dispatcher, worker.id, [{ type: 'text', text: 'Queued generic work.' }], {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: dispatcher.id },
      signal: new AbortController().signal,
    })
    const failed = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')

    release.resolve(undefined)
    const final = await failed
    await worker.whenIdle()

    expect(final.nodes[0]?.settlement).toMatchObject({ kind: 'failed' })
    expect(adapter.requests.filter(request => request.sessionId === worker.id)).toHaveLength(1)
    expect(worker.inbox.nextTurn).toEqual([])
  })

  it('fails an owner activation that settles before a generic message opens a turn', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, dispatcher } = await setup(new GatedAdapter([
      { chunks: textResponse('initial work'), gate: release.promise },
    ]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    await running
    const failed = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')

    ctx.dag.settled({
      binding: { controller: 'dag', metadata: { version: 1, dispatcherSessionId: dispatcher.id, nodeId: 'a' } },
      childId: worker.id,
      parentSessionId: dispatcher.id,
      stopReason: 'error',
      messageId: MessageId('generic-message-that-did-not-open'),
      error: 'activation failed before its generic message opened a turn',
    })

    expect((await failed).nodes[0]?.settlement).toEqual({
      kind: 'failed',
      reason: 'activation failed before its generic message opened a turn',
    })
    release.resolve(undefined)
    await worker.whenIdle()
  })

  it('rejects owner controls whose live child does not match the durable node binding', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, dispatcher } = await setup(new GatedAdapter([
      { chunks: textResponse('working'), gate: release.promise },
    ]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    const before = await running
    const binding = { controller: 'dag', metadata: { version: 1, dispatcherSessionId: dispatcher.id, nodeId: 'a' } } as const
    const stop = vi.fn()
    const redirect = vi.fn()

    expect(() => {
      ctx.dag.stop({
        binding,
        child: dispatcher,
        authority: { kind: 'user', parentSessionId: dispatcher.id },
        stop,
      })
    }).toThrow(expect.objectContaining({ code: 'dag-stale-child-binding' }))
    expect(() => ctx.dag.redirect({
      binding,
      child: dispatcher,
      message: freezeMessage({
        id: MessageId('stale-owner-redirect'),
        role: 'user',
        content: [{ type: 'text', text: 'Replace work.' }],
        source: { kind: 'user' },
      }),
      redirect,
    })).toThrow(expect.objectContaining({ code: 'dag-stale-child-binding' }))
    expect(ctx.dag.state(dispatcher)).toBe(before)
    expect(stop).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()

    ctx.dag.stop(dispatcher, DagNodeId('a'))
    release.resolve(undefined)
    await worker.whenIdle()
  })

  it('flushes an owner steer before it delivers the replacement turn', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const { ctx, dispatcher } = await setup(new GatedAdapter([
      { chunks: textResponse('working'), gate: releaseChild.promise },
    ]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    await running
    const entered = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      const command = ctx.dag.state(dispatcher)?.nodes[0]?.commands.at(-1)
      if (command?.kind === 'steer' && command.state !== 'settled') {
        entered.resolve(undefined)
        await releaseFlush.promise
      }
      return flush(session)
    })
    const redirect = vi.fn()
    const binding = { controller: 'dag', metadata: { version: 1, dispatcherSessionId: dispatcher.id, nodeId: 'a' } } as const
    const delivered = ctx.dag.redirect({
      binding,
      child: worker,
      message: freezeMessage({
        id: MessageId('owner-steer-after-flush'),
        role: 'user',
        content: [{ type: 'text', text: 'Replace work after persistence.' }],
        source: { kind: 'user' },
      }),
      redirect,
    })

    await entered.promise
    expect(redirect).not.toHaveBeenCalled()
    expect(ctx.dag.state(dispatcher)?.nodes[0]?.commands.at(-1)).toMatchObject({ kind: 'steer', state: 'accepted' })

    releaseFlush.resolve(undefined)
    await delivered
    expect(redirect).toHaveBeenCalledOnce()
    const command = ctx.dag.state(dispatcher)?.nodes[0]?.commands.at(-1)
    expect(redirect).toHaveBeenCalledWith(expect.objectContaining({ id: MessageId(`${command?.id}-message`) }))
    expect(ctx.dag.state(dispatcher)?.nodes[0]?.commands.at(-1)).toMatchObject({
      kind: 'steer', state: 'settled', outcome: 'succeeded',
    })

    ctx.dag.stop(dispatcher, DagNodeId('a'))
    releaseChild.resolve(undefined)
    await worker.whenIdle()
  })

  it('uses one durable steer and one deterministic message for an owner-routed redirect', async () => {
    const releaseInitial = Promise.withResolvers<undefined>()
    const releaseReplacement = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('initial'), gate: releaseInitial.promise },
      { chunks: textResponse('replacement'), gate: releaseReplacement.promise },
    ])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    await running
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const replacementTurn = turnStarted(ctx, worker, 2)

    const acceptedId = await ctx.subagents.redirect(
      dispatcher,
      worker.id,
      [{ type: 'text', text: 'Owner-routed replacement.' }],
      {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: dispatcher.id },
        messageId: MessageId('external-owner-steer'),
        cause: { kind: 'parent' },
        signal: new AbortController().signal,
      },
    )
    await stateWhen(ctx, dispatcher, state => state.nodes[0]?.commands.at(-1)?.kind === 'steer'
      && state.nodes[0]?.commands.at(-1)?.state === 'settled')
    releaseInitial.resolve(undefined)
    await replacementTurn
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    const current = ctx.dag.state(dispatcher)
    const steerCommands = current?.nodes[0]?.commands.filter(command => command.kind === 'steer') ?? []
    const steerReceipts = current?.receipts.filter(receipt => receipt.cause === 'steer') ?? []
    expect(steerCommands).toHaveLength(1)
    expect(steerReceipts).toHaveLength(1)
    expect(acceptedId).toBe(MessageId(`${steerCommands[0]?.id}-message`))
    expect(worker.session.events.some(event => event.type === 'user/message' && event.data.id === acceptedId)).toBe(true)

    ctx.dag.stop(dispatcher, DagNodeId('a'), 'End the owner redirect test.')
    releaseReplacement.resolve(undefined)
    await worker.whenIdle()
  })

  it('uses one owner transition for steer, stop, resume, and block', async () => {
    const releaseInitial = Promise.withResolvers<undefined>()
    const releaseSteered = Promise.withResolvers<undefined>()
    const releaseResumed = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('initial'), gate: releaseInitial.promise },
      { chunks: textResponse('steered'), gate: releaseSteered.promise },
      { chunks: textResponse('resumed'), gate: releaseResumed.promise },
    ])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const initialChild = childCreated(ctx, dispatcher)
    const initialRunning = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await initialChild
    const first = await initialRunning
    const firstGeneration = first.nodes[0]?.generation ?? 0
    const secondTurn = turnStarted(ctx, worker, 2)
    const redirected = stateWhen(ctx, dispatcher, state => state.nodes[0]?.commands.at(-1)?.kind === 'steer'
      && state.nodes[0]?.commands.at(-1)?.state === 'settled')

    ctx.dag.steer(dispatcher, DagNodeId('a'), 'Replace the current work.')
    expect(ctx.dag.inspect(dispatcher, DagNodeId('a')).status).toBe('in_progress')
    expect(ctx.dag.inspect(dispatcher, DagNodeId('a')).generation).toBe(firstGeneration + 1)
    await redirected
    releaseInitial.resolve(undefined)
    await secondTurn
    const disposed = agentDisposed(ctx, worker)

    ctx.dag.stop(dispatcher, DagNodeId('a'), 'Stop before reset.')
    expect(ctx.dag.inspect(dispatcher, DagNodeId('a')).status).toBe('interrupted')
    releaseSteered.resolve(undefined)
    await disposed

    const resumedChild = childCreated(ctx, dispatcher)
    const resumedRunning = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.resume(dispatcher, DagNodeId('a'), 'Continue from the retained worktree.')
    const resumed = await resumedChild
    await resumedRunning
    const blocked = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'blocked')

    ctx.dag.blockFrom(resumed, 'A user decision is required.')
    const final = await blocked
    releaseResumed.resolve(undefined)
    await resumed.whenIdle()

    expect(final.nodes[0]?.settlement).toEqual({ kind: 'blocked', reason: 'A user decision is required.' })
    expect(final.notices.map(notice => notice.kind)).toEqual(expect.arrayContaining(['node-interrupted', 'node-blocked']))
    expect(final.nodes[0]?.status).not.toBe('failed')
  })

  it('rejects final reports from the turn invalidated by a settled steer', async () => {
    const releaseInitial = Promise.withResolvers<undefined>()
    const releaseSteered = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('initial'), gate: releaseInitial.promise },
      { chunks: textResponse('steered'), gate: releaseSteered.promise },
    ])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const worker = await child
    await running
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const steeredTurn = turnStarted(ctx, worker, 2)
    const redirected = stateWhen(ctx, dispatcher, state => state.nodes[0]?.commands.at(-1)?.kind === 'steer'
      && state.nodes[0]?.commands.at(-1)?.state === 'settled')

    ctx.dag.steer(dispatcher, DagNodeId('a'), 'Replace the current work.')
    const afterSteer = await redirected

    expect(() => ctx.dag.completeFrom(worker, 'Stale completion.'))
      .toThrow(expect.objectContaining({ code: 'dag-stale-child-turn' }))
    expect(() => ctx.dag.blockFrom(worker, 'Stale block.'))
      .toThrow(expect.objectContaining({ code: 'dag-stale-child-turn' }))
    expect(ctx.dag.state(dispatcher)).toBe(afterSteer)

    releaseInitial.resolve(undefined)
    await steeredTurn
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const blocked = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'blocked')
    ctx.dag.blockFrom(worker, 'Current steered work is blocked.')
    expect((await blocked).nodes[0]?.settlement).toEqual({
      kind: 'blocked',
      reason: 'Current steered work is blocked.',
    })
    releaseSteered.resolve(undefined)
    await worker.whenIdle()
  })

  it.each(['resume', 'steer'] as const)('reprepares and materializes %s after a stop before the first wave probe', async (operation) => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, dispatcher, root } = await setup(new GatedAdapter([
      { chunks: textResponse('resumed work'), gate: release.promise },
    ]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const firstWaveId = ctx.dag.inspect(dispatcher, DagNodeId('a')).waveId
    ctx.dag.stop(dispatcher, DagNodeId('a'), 'Stop before the root probe.')
    const child = childCreated(ctx, dispatcher)
    const running = stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')

    if (operation === 'resume') ctx.dag.resume(dispatcher, DagNodeId('a'), 'Resume from the stopped start.')
    else ctx.dag.steer(dispatcher, DagNodeId('a'), 'Replace the stopped start.')
    const worker = await child
    const state = await running
    const resumed = state.nodes[0]!

    expect(resumed.waveId).not.toBe(firstWaveId)
    expect(resumed.frozenWaveBase).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(resumed.preparedHead).toBe(resumed.frozenWaveBase)
    expect(state.waves.find(wave => wave.id === resumed.waveId)).toMatchObject({ status: 'open', pendingNodeIds: ['a'] })

    ctx.dag.stop(dispatcher, DagNodeId('a'), 'End the test child.')
    release.resolve(undefined)
    await worker.whenIdle()
  })

  it('probes a new wave when a failed node is redispatched', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, dispatcher, root } = await setup(new GatedAdapter([
      { chunks: textResponse('First turn ended without a DAG report.') },
      { chunks: textResponse('Retry is active.'), gate: release.promise },
    ]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const failed = await stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')
    const firstWaveId = failed.nodes[0]?.waveId

    ctx.dag.redispatch(dispatcher, DagNodeId('a'))
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const retried = await stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'in_progress')
    const retriedNode = retried.nodes[0]!

    expect(retriedNode.waveId).not.toBe(firstWaveId)
    expect(retriedNode.frozenWaveBase).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(retried.waves.find(wave => wave.id === retriedNode.waveId)).toMatchObject({
      status: 'open',
      pendingNodeIds: ['a'],
    })

    ctx.dag.stop(dispatcher, DagNodeId('a'), 'End the retry test.')
    release.resolve(undefined)
  })

  it('reconciles a running durable command after a process restart', async () => {
    const first = await setup(new GatedAdapter([]))
    first.ctx.dag.write(first.dispatcher, { nodes: [node()] })
    const declared = first.ctx.dag.state(first.dispatcher)
    if (declared === null) throw new Error('test DAG declaration is missing')
    const nodeId = DagNodeId('a')
    const dispatched = reduceDagState(declared, {
      type: 'dispatch',
      nodeIds: [nodeId],
      bindings: {
        a: {
          childSessionId: SessionId('restart-child'),
          branch: 'dsh/dag/restart/g1/a',
          worktree: join(first.temporary, 'home', 'dag', 'worktrees', 'v1', 'restart', 'g1', 'a'),
        },
      },
    }).state
    first.dispatcher.session.append('dag/state', { state: dispatched })
    const command = dispatched.nodes[0]?.commands[0]
    if (command === undefined) throw new Error('test dispatch command is missing')
    const running = reduceDagState(dispatched, {
      type: 'command-running',
      nodeId,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    }).state
    first.dispatcher.session.append('dag/state', { state: running })
    await first.ctx.sessions.flush(first.dispatcher.session)
    await first.ctx.fiber.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const release = Promise.withResolvers<undefined>()
    const second = await resumeHarness(first.temporary, new GatedAdapter([
      { chunks: textResponse('recovered'), gate: release.promise },
    ]))
    const recovered = await stateWhen(second.ctx, second.dispatcher, state => state.nodes[0]?.status === 'in_progress')

    expect(recovered.nodes[0]?.childSessionId).toBe(SessionId('restart-child'))
    expect(recovered.nodes[0]?.commands[0]?.state).toBe('settled')
    expect(recovered.nodes[0]?.preparedHead).toBe(git(second.root, 'rev-parse', 'HEAD'))
    release.resolve(undefined)
  })

  it('reconciles an accepted command when the DAG plugin loads over a live dispatcher', async () => {
    const release = Promise.withResolvers<undefined>()
    const harness = await setup(new GatedAdapter([
      { chunks: textResponse('reloaded'), gate: release.promise },
    ]))
    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    const declared = harness.ctx.dag.state(harness.dispatcher)
    if (declared === null) throw new Error('test DAG declaration is missing')
    await harness.disposeDag()
    const dispatched = reduceDagState(declared, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: {
        a: {
          childSessionId: SessionId('reload-child'),
          branch: 'dsh/dag/reload/g1/a',
          worktree: join(harness.temporary, 'home', 'dag', 'worktrees', 'v1', 'reload', 'g1', 'a'),
        },
      },
    }).state
    harness.dispatcher.session.append('dag/state', { state: dispatched })
    const child = childCreated(harness.ctx, harness.dispatcher)

    await harness.ctx.plugin(DagService, {
      dshHome: join(harness.temporary, 'home'),
      subagentProvider: 'spawn',
    })
    const recovered = await stateWhen(
      harness.ctx,
      harness.dispatcher,
      state => state.nodes[0]?.status === 'in_progress',
    )
    const worker = await child

    expect(worker.id).toBe(SessionId('reload-child'))
    expect(recovered.nodes[0]?.commands[0]).toMatchObject({ state: 'settled', outcome: 'succeeded' })
    release.resolve(undefined)
  })

  it('does not inject a duplicate notice after restart when the claimed message is durable', async () => {
    const first = await setup(new GatedAdapter([{ chunks: textResponse('notice claimed') }]))
    first.ctx.dag.write(first.dispatcher, { nodes: [node()] })
    await first.ctx.sessions.flush(first.dispatcher.session)
    await Promise.resolve()
    const notice = appendUndeliveredFailure(first, 'notice')
    first.dispatcher.inject(freezeMessage({
      id: MessageId(`dag-notice-${notice.id}`),
      role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: 'dag-notice', form: 'notice', noticeId: notice.id, summary: notice.text },
    }))
    first.dispatcher.followup(freezeMessage({
      id: MessageId('claim-notice-turn'),
      role: 'user',
      content: [{ type: 'text', text: 'Read the pending notice.' }],
      source: { kind: 'user' },
    }))
    await first.dispatcher.whenIdle()
    await first.ctx.sessions.flush(first.dispatcher.session)
    await first.ctx.fiber.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await resumeHarness(first.temporary, new GatedAdapter([]))
    const delivered = await stateWhen(second.ctx, second.dispatcher,
      state => state.notices.some(row => row.id === notice.id && row.delivered))
    const inserted = second.dispatcher.session.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)
      : [])

    expect(delivered.notices.find(row => row.id === notice.id)?.delivered).toBe(true)
    expect(inserted).toHaveLength(1)
  })

  it('does not inject a duplicate notice while its first inbox entry remains pending', async () => {
    const harness = await setup(new GatedAdapter([]))
    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    await harness.ctx.sessions.flush(harness.dispatcher.session)
    await Promise.resolve()
    const notice = appendUndeliveredFailure(harness, 'pending-notice')
    const messageId = MessageId(`dag-notice-${notice.id}`)
    harness.dispatcher.inject(freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: 'dag-notice', form: 'notice', noticeId: notice.id, summary: notice.text },
    }))
    const delivered = stateWhen(harness.ctx, harness.dispatcher, state => state.notices.some(row => row.id === notice.id && row.delivered))

    harness.ctx.dag.write(harness.dispatcher, { nodes: [{ ...node(), status: 'failed' }] })
    await delivered
    const inserted = harness.dispatcher.session.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)
      : [])

    expect(inserted).toHaveLength(1)
    expect([...harness.dispatcher.inbox.nextTurn, ...harness.dispatcher.inbox.nextStep]
      .filter(message => message.id === messageId)).toHaveLength(1)
  })

  it('resolves a waiter when an existing notice becomes actionable after the requested revision', async () => {
    const harness = await setup(new GatedAdapter([]))
    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    await harness.ctx.sessions.flush(harness.dispatcher.session)
    await Promise.resolve()
    const notice = appendUndeliveredFailure(harness, 'late-delivery')
    const waiting = harness.ctx.dag.wait(
      harness.dispatcher,
      notice.revision,
      new AbortController().signal,
    )

    harness.ctx.dag.write(harness.dispatcher, { nodes: [{ ...node(), status: 'failed' }] })
    const result = await waiting
    const delivered = result.notices.find(row => row.id === notice.id)

    expect(delivered?.deliveredRevision).toBeGreaterThan(notice.revision)
    expect(reduceDagState(harness.ctx.dag.state(harness.dispatcher), {
      type: 'notice-delivered',
      noticeId: notice.id,
    }).state).toBe(harness.ctx.dag.state(harness.dispatcher))
  })

  it('reinjects a notice after restart when its earlier inbox entry was cancelled', async () => {
    const first = await setup(new GatedAdapter([]))
    first.ctx.dag.write(first.dispatcher, { nodes: [node()] })
    await first.ctx.sessions.flush(first.dispatcher.session)
    await Promise.resolve()
    const notice = appendUndeliveredFailure(first, 'cancelled-notice')
    const messageId = MessageId(`dag-notice-${notice.id}`)
    first.dispatcher.inject(freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: 'dag-notice', form: 'notice', noticeId: notice.id, summary: notice.text },
    }))
    expect(first.dispatcher.inbox.remove(messageId)).toBe(true)
    await first.ctx.sessions.flush(first.dispatcher.session)
    await first.ctx.fiber.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await resumeHarness(first.temporary, new GatedAdapter([]))
    await stateWhen(second.ctx, second.dispatcher, state => state.notices.some(row => row.id === notice.id && row.delivered))
    const inserted = second.dispatcher.session.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)
      : [])

    expect(inserted).toHaveLength(2)
    expect([...second.dispatcher.inbox.nextTurn, ...second.dispatcher.inbox.nextStep]
      .filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)).toHaveLength(1)
  })
})
