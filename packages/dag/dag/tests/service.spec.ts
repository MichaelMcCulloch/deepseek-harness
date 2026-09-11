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
import SubagentRuntime, { SubagentError } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import DagService from '../src/index.ts'
import { DagCommandId, DagNodeId, DagOperationId } from '../src/ids.ts'
import { DagStateError, reduceDagState } from '../src/reducer.ts'
import { validateDagDeclaration } from '../src/validation.ts'
import type { DagNodeInput, DagNodeSnapshot, DagNotice, DagState } from '../src/types.ts'

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
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LocalSubprocessRuntime)
  const dagFiber = await ctx.plugin(DagService, { dshHome: home, subagentProvider: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const dispatcher = await ctx.agentLoop.create(
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

function userMessageForTest(id: string) {
  return freezeMessage({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text: id }],
    source: { kind: 'user' },
  })
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

/**
 * Drain the post-commit flush and notice-delivery pass a write scheduled, so a
 * test that injects a notice itself does not race that pass into a second copy.
 */
async function settleServiceDelivery(harness: TestHarness): Promise<void> {
  await harness.ctx.sessions.flush(harness.dispatcher.session)
  await Promise.resolve()
  await Promise.allSettled([...serviceField<Set<Promise<void>>>(harness.ctx.dag, 'flushTasks')])
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
  if (agent.session.snapshotEvents().some(event => event.type === 'turn/start' && event.data.turn === turn)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/start' || event.data.turn !== turn) return
      void dispose()
      resolve()
    }, { global: true })
  })
}

/**
 * Wait until one admitted child prompt is a durable user message, which is when
 * the child's active turn can report completion or a block.
 */
function turnPromptDelivered(ctx: Context, agent: Agent, messageId: MessageId): Promise<void> {
  const logged = (): boolean => agent.session.snapshotEvents()
    .some(event => event.type === 'user/message' && event.data.id === messageId)
  if (logged()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'user/message' || event.data.id !== messageId) return
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

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Reflective test access preserves each private method signature.
function serviceMethod<Args extends readonly unknown[], Result>(
  service: DagService,
  name: string,
): (...args: Args) => Result {
  const method: unknown = Reflect.get(service, name)
  if (typeof method !== 'function') throw new Error(`DAG service method ${name} is missing`)
  return (...args: Args) => Reflect.apply(method, service, args) as Result
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Reflective test access preserves each private field type.
function serviceField<T>(service: DagService, name: string): T {
  return Reflect.get(service, name) as T
}

function appendStartingOwner(harness: TestHarness, childId = SessionId('owner-child')): {
  readonly state: DagState
  readonly node: DagNodeSnapshot
  readonly binding: { readonly controller: 'dag'; readonly metadata: { readonly version: 1; readonly dispatcherSessionId: SessionId; readonly nodeId: ReturnType<typeof DagNodeId> } }
} {
  harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
  const declared = harness.ctx.dag.state(harness.dispatcher)
  if (declared === null) throw new Error('test DAG declaration is missing')
  const state = reduceDagState(declared, {
    type: 'dispatch',
    nodeIds: [DagNodeId('a')],
    bindings: {
      a: {
        childSessionId: childId,
        branch: 'dsh/dag/owner/g1/a',
        worktree: join(harness.temporary, 'home', 'dag', 'worktrees', 'v1', 'owner', 'g1', 'a'),
      },
    },
  }).state
  harness.dispatcher.session.append('dag/state', { state })
  return {
    state,
    node: state.nodes[0]!,
    binding: {
      controller: 'dag',
      metadata: { version: 1, dispatcherSessionId: harness.dispatcher.id, nodeId: DagNodeId('a') },
    },
  }
}

function appendOwnerPrepared(harness: TestHarness, owner: ReturnType<typeof appendStartingOwner>): DagState {
  const command = owner.node.commands[0]!
  const fence = {
    nodeId: owner.node.id,
    commandId: command.id,
    generation: command.generation,
    bindingGeneration: command.bindingGeneration,
    operationId: command.operationId,
  }
  const probed = reduceDagState(owner.state, {
    type: 'wave-probed', waveId: owner.node.waveId!, fences: [fence], branch: 'main', head: '1'.repeat(40),
  }).state
  harness.dispatcher.session.append('dag/state', { state: probed })
  const evidence = {
    branch: owner.node.branch!,
    worktree: owner.node.worktree!,
    frozenWaveBase: '1'.repeat(40),
    preparedFrom: '1'.repeat(40),
    preparedHead: '1'.repeat(40),
    dependencyCommits: [],
    conflictedFiles: [],
    childSessionId: owner.node.childSessionId!,
  }
  const prepared = reduceDagState(probed, { type: 'git-prepared', ...fence, evidence }).state
  harness.dispatcher.session.append('dag/state', { state: prepared })
  return prepared
}

function appendOwnerInProgress(harness: TestHarness, owner: ReturnType<typeof appendStartingOwner>): DagState {
  const prepared = appendOwnerPrepared(harness, owner)
  const command = owner.node.commands[0]!
  const fence = {
    nodeId: owner.node.id,
    commandId: command.id,
    generation: command.generation,
    bindingGeneration: command.bindingGeneration,
    operationId: command.operationId,
  }
  const evidence = {
    branch: owner.node.branch!,
    worktree: owner.node.worktree!,
    frozenWaveBase: '1'.repeat(40),
    preparedFrom: '1'.repeat(40),
    preparedHead: '1'.repeat(40),
    dependencyCommits: [],
    conflictedFiles: [],
    childSessionId: owner.node.childSessionId!,
  }
  const started = reduceDagState(prepared, { type: 'start-succeeded', ...fence, evidence }).state
  harness.dispatcher.session.append('dag/state', { state: started })
  return started
}

// Local Git runs through ctx.subprocess; each spawned command costs a full
// process-scope launch, so the suite needs headroom over the default timeout.
describe('native DAG service', { timeout: 60_000 }, () => {
  it('reports an empty board and rejects missing nodes and stale agent objects', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    expect(ctx.dag.status(dispatcher)).toBeNull()
    expect(() => ctx.dag.inspect(dispatcher, DagNodeId('a')))
      .toThrow(expect.objectContaining({ code: 'dag-not-declared' }))

    ctx.dag.write(dispatcher, { nodes: [node()] })
    expect(ctx.dag.status(dispatcher)).toMatchObject({ revision: 1, nodes: [{ id: 'a' }] })
    expect(() => ctx.dag.inspect(dispatcher, DagNodeId('missing')))
      .toThrow(expect.objectContaining({ code: 'dag-node-not-found' }))

    const stale = { id: dispatcher.id, session: dispatcher.session } as unknown as Agent
    expect(() => ctx.dag.state(stale)).toThrow(expect.objectContaining({ code: 'dag-agent-not-live' }))
  })

  it('validates immediate wait cancellation, empty public text, and the stop overload', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const aborted = new AbortController()
    const reason = new Error('already aborted')
    aborted.abort(reason)
    expect(() => ctx.dag.wait(dispatcher, 0, aborted.signal)).toThrow(reason)

    ctx.dag.write(dispatcher, { nodes: [node()] })
    expect(() => ctx.dag.reset(dispatcher, DagNodeId('a'), ' ')).toThrow(/reset target must be non-empty/)
    const stopWithoutNode = ctx.dag.stop.bind(ctx.dag) as unknown as (agent: Agent) => unknown
    expect(() => stopWithoutNode(dispatcher)).toThrow(expect.objectContaining({ code: 'dag-node-not-found' }))
  })

  it('returns already delivered notices without registering a waiter', async () => {
    const harness = await setup(new GatedAdapter([]))
    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    const notice = appendUndeliveredFailure(harness, 'immediate-wait')
    const state = harness.ctx.dag.state(harness.dispatcher)
    if (state === null) throw new Error('test DAG state is missing')
    const delivered = reduceDagState(state, { type: 'notice-delivered', noticeId: notice.id }).state
    harness.dispatcher.session.append('dag/state', { state: delivered })

    const result = await harness.ctx.dag.wait(harness.dispatcher, 0, new AbortController().signal)
    expect(result.notices).toEqual([expect.objectContaining({ id: notice.id, delivered: true })])
  })

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
    expect(dispatcher.session.snapshotEvents().filter(event => event.type === 'dag/state')).toHaveLength(1)
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

  it('fixes the notice namespace on the first declaration', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))

    ctx.dag.write(dispatcher, { nodes: [node()] })

    expect(ctx.dag.state(dispatcher)?.noticeNamespace).toBe(dispatcher.id)
  })

  it('keeps the inherited namespace when a seeded session amends the graph', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const declared = validateDagDeclaration([node()])
    const inherited = reduceDagState(null, {
      type: 'write',
      noticeNamespace: 'origin-dispatcher',
      nodes: declared.definitions.map(definition => ({ definition, status: 'pending' as const })),
      topologicalOrder: declared.topologicalOrder,
    }).state
    dispatcher.session.append('dag/state', { state: inherited })

    const written = ctx.dag.write(dispatcher, { nodes: [node()] })

    expect(written.revision).toBe(inherited.revision + 1)
    expect(ctx.dag.state(dispatcher)?.noticeNamespace).toBe('origin-dispatcher')
  })

  it('corrects every declared field of one node and rewires a dependent that loses an omitted dependency', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    const correctedBrief = 'Corrected b.\nVALIDATION: rerun the focused test.\nACCEPTANCE: commit clean work.'
    const leaf = (overrides: Partial<DagNodeInput> = {}): DagNodeInput => ({
      ...node('b'), deps: ['a'], files: ['leaf.txt'], ...overrides,
    })
    const declared = ctx.dag.write(dispatcher, { nodes: [node('a'), leaf()] })
    expect(declared.amended).toEqual([])
    expect(declared.rewired).toEqual([])

    ctx.dag.amend(dispatcher, DagNodeId('b'), {
      content: 'Corrected b',
      brief: correctedBrief,
      deps: [],
      kind: 'integration',
      policy: 'ours',
      files: ['src/b.ts'],
      if_revision: declared.revision,
    })
    expect(ctx.dag.inspect(dispatcher, DagNodeId('b'))).toMatchObject({
      content: 'Corrected b',
      brief: correctedBrief,
      deps: [],
      kind: 'integration',
      policy: 'ours',
      files: ['src/b.ts'],
      status: 'pending',
      generation: 0,
    })

    ctx.dag.amend(dispatcher, DagNodeId('b'), { content: 'Corrected again' })
    ctx.dag.amend(dispatcher, DagNodeId('a'), { content: 'Corrected a' })
    expect(ctx.dag.inspect(dispatcher, DagNodeId('b'))).toMatchObject({
      content: 'Corrected again',
      kind: 'integration',
      policy: 'ours',
    })

    const restored = ctx.dag.amend(dispatcher, DagNodeId('b'), { deps: ['a'], kind: 'task' })
    expect(restored.accepted).toBe(true)
    expect(ctx.dag.inspect(dispatcher, DagNodeId('b'))).toMatchObject({ deps: ['a'], kind: 'task', policy: 'delegate' })

    const rewritten = ctx.dag.write(dispatcher, {
      nodes: [leaf({ content: 'Corrected again', brief: correctedBrief, files: ['src/b.ts'] })],
    })
    expect(rewritten.dropped).toEqual([{ id: 'a' }])
    expect(rewritten.rewired).toEqual([{ id: 'b', removedDeps: ['a'] }])
    expect(rewritten.amended).toEqual([{ id: 'b', fields: ['deps'] }])
    expect(ctx.dag.inspect(dispatcher, DagNodeId('b'))).toMatchObject({ deps: [], status: 'pending' })
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
    expect(dispatcher.session.snapshotEvents().filter(event => event.type === 'dag/state')).toHaveLength(1)
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
      const state = [...dispatcher.session.snapshotEvents()].reverse().find(event => event.type === 'dag/state')?.data.state
      if (!released && state?.nodes[0]?.commands.some(command => command.state === 'running')) {
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    await entered.promise
    const before = [...dispatcher.session.snapshotEvents()].reverse().find(event => event.type === 'dag/state')?.data.state
    if (before === undefined) throw new Error('test DAG state is missing')

    const disposed = ctx.fiber.dispose()
    await Promise.resolve()
    released = true
    release.resolve(undefined)
    await disposed
    const after = [...dispatcher.session.snapshotEvents()].reverse().find(event => event.type === 'dag/state')?.data.state

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
    expect(ctx.dag.statusFrom(worker)).toMatchObject({
      revision: active.revision,
      topology: [{ id: 'a', deps: [], status: 'in_progress' }],
      own: { id: 'a', status: 'in_progress' },
    })
    const admitted = active.nodes[0]?.commands.at(-1)
    if (admitted === undefined) throw new Error('test node has no admitted command')
    await turnPromptDelivered(ctx, worker, MessageId(`${admitted.id}-message`))
    expect(() => ctx.dag.completeFrom(worker, ' ')).toThrow(/completion summary must be non-empty/)
    expect(() => ctx.dag.blockFrom(worker, ' ')).toThrow(/block reason must be non-empty/)
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
    expect(dispatcher.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'dag-notice'))).toBe(true)
    expect(dispatcher.session.snapshotEvents().some(event => event.type === 'user/message'
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
    expect(dispatcher.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toBe(false)
  })

  it('resets a failed prepared worktree and reports preserved untracked dirt', async () => {
    const adapter = new GatedAdapter([{ chunks: textResponse('ordinary answer') }])
    const { ctx, dispatcher } = await setup(adapter)
    ctx.dag.write(dispatcher, { nodes: [node()] })
    ctx.dag.dispatch(dispatcher, [DagNodeId('a')])
    const failed = await stateWhen(ctx, dispatcher, state => state.nodes[0]?.status === 'failed')
    const failedNode = failed.nodes[0]!
    if (failedNode.worktree === undefined || failedNode.frozenWaveBase === undefined) {
      throw new Error('failed node has no prepared worktree')
    }

    ctx.dag.reset(dispatcher, failedNode.id, failedNode.frozenWaveBase)
    const clean = await stateWhen(ctx, dispatcher, state => state.nodes[0]?.commands.at(-1)?.kind === 'reset'
      && state.nodes[0]?.commands.at(-1)?.state === 'settled')
    expect(clean.nodes[0]?.commands.at(-1)?.detail).toContain('worktree is clean')

    await writeFile(join(failedNode.worktree, 'untracked.txt'), 'preserve\n')
    ctx.dag.reset(dispatcher, failedNode.id, failedNode.frozenWaveBase)
    const dirty = await stateWhen(ctx, dispatcher, state => state.nodes[0]?.commands.filter(command => command.kind === 'reset').length === 2
      && state.nodes[0]?.commands.at(-1)?.state === 'settled')
    expect(dirty.nodes[0]?.commands.at(-1)?.detail).toContain('preserved remaining dirt: ? untracked.txt')
  })

  it('rejects malformed durable command payloads and settles a stop without a child', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const execute = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      DagNodeSnapshot['commands'][number],
      AbortSignal,
    ], Promise<void>>(harness.ctx.dag, 'executeCommand')
    const signal = new AbortController().signal
    const command = owner.node.commands[0]!
    const { childSessionId: _missingChild, ...nodeWithoutChild } = owner.node

    await expect(execute(
      harness.dispatcher,
      { ...nodeWithoutChild, status: 'in_progress' },
      { ...command, kind: 'steer', message: 'replace' },
      signal,
    )).rejects.toThrow('steer requires an existing child')
    await expect(execute(
      harness.dispatcher,
      { ...owner.node, status: 'in_progress' },
      { ...command, kind: 'steer' },
      signal,
    )).rejects.toThrow('steer requires a replacement message')
    await expect(execute(
      harness.dispatcher,
      owner.node,
      { ...command, kind: 'reset' },
      signal,
    )).rejects.toThrow('reset requires a target')

    const interrupted = reduceDagState(owner.state, {
      type: 'stop', nodeId: owner.node.id, reason: 'No child remains.',
    }).state
    harness.dispatcher.session.append('dag/state', { state: interrupted })
    const stopCommand = interrupted.nodes[0]!.commands.at(-1)!
    const { childSessionId: _stoppedChild, ...stoppedWithoutChild } = interrupted.nodes[0]!
    await execute(
      harness.dispatcher,
      stoppedWithoutChild,
      stopCommand,
      signal,
    )
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]?.commands.at(-1))
      .toMatchObject({ kind: 'stop', state: 'settled', outcome: 'succeeded' })
  })

  it('settles both direct and owner-completed steer effects', async () => {
    const directHarness = await setup(new GatedAdapter([]))
    const directOwner = appendStartingOwner(directHarness, SessionId('direct-steer-child'))
    const directStarted = appendOwnerInProgress(directHarness, directOwner)
    const directSteered = reduceDagState(directStarted, {
      type: 'steer', nodeId: DagNodeId('a'), message: 'Direct replacement.',
    }).state
    // A snapshot recorded before pre-preparation evidence existed carries no
    // preparedFrom, so the direct steer must fall back to the frozen wave base.
    const { preparedFrom: _legacyPreparedFrom, ...legacyNode } = directSteered.nodes[0]!
    directHarness.dispatcher.session.append('dag/state', { state: { ...directSteered, nodes: [legacyNode] } })
    const directNode = directSteered.nodes[0]!
    const directCommand = directNode.commands.at(-1)!
    serviceField<WeakMap<typeof directHarness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      directHarness.ctx.dag,
      'pumps',
    ).set(directHarness.dispatcher.session, new Set([directNode.id]))
    const directRedirect = vi.spyOn(directHarness.ctx.subagents, 'redirect')
      .mockResolvedValue(MessageId(`${directCommand.id}-message`))
    const directExecute = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      DagNodeSnapshot['commands'][number],
      AbortSignal,
    ], Promise<void>>(directHarness.ctx.dag, 'executeCommand')

    await directExecute(directHarness.dispatcher, directNode, directCommand, new AbortController().signal)
    expect(directRedirect).toHaveBeenCalledOnce()
    expect(directHarness.ctx.dag.state(directHarness.dispatcher)?.nodes[0]?.commands.at(-1))
      .toMatchObject({ kind: 'steer', state: 'settled', outcome: 'succeeded' })

    const ownerHarness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(ownerHarness, SessionId('owner-steer-complete-child'))
    const started = appendOwnerInProgress(ownerHarness, owner)
    const steered = reduceDagState(started, {
      type: 'steer', nodeId: DagNodeId('a'), message: 'Owner replacement.',
    }).state
    ownerHarness.dispatcher.session.append('dag/state', { state: steered })
    const ownerNode = steered.nodes[0]!
    const ownerCommand = ownerNode.commands.at(-1)!
    serviceField<WeakMap<typeof ownerHarness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      ownerHarness.ctx.dag,
      'pumps',
    ).set(ownerHarness.dispatcher.session, new Set([ownerNode.id]))
    const finishSteer = serviceMethod<[
      Agent,
      DagNodeSnapshot['id'],
      ReturnType<typeof DagCommandId>,
      number,
      ReturnType<typeof DagOperationId>,
    ], unknown>(ownerHarness.ctx.dag, 'finishSteer')
    vi.spyOn(ownerHarness.ctx.subagents, 'redirect').mockImplementation(async () => {
      finishSteer(
        ownerHarness.dispatcher,
        ownerNode.id,
        ownerCommand.id,
        ownerCommand.generation,
        ownerCommand.operationId,
      )
      return MessageId(`${ownerCommand.id}-message`)
    })
    const ownerExecute = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      DagNodeSnapshot['commands'][number],
      AbortSignal,
    ], Promise<void>>(ownerHarness.ctx.dag, 'executeCommand')

    await ownerExecute(ownerHarness.dispatcher, ownerNode, ownerCommand, new AbortController().signal)
    expect(ownerHarness.ctx.dag.state(ownerHarness.dispatcher)?.nodes[0]?.commands.at(-1))
      .toMatchObject({ kind: 'steer', state: 'settled', outcome: 'succeeded' })
  })

  it('rejects incomplete starting facts before it runs Git or child effects', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness, SessionId('invalid-start-child'))
    const started = appendOwnerInProgress(harness, owner)
    const service = harness.ctx.dag
    const prepare = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      DagNodeSnapshot['commands'][number],
      AbortSignal,
    ], Promise<void>>(service, 'prepareAndStart')
    const originalRequireState = serviceField<(agent: Agent) => DagState>(service, 'requireState')
    const command = owner.node.commands[0]!
    const frozenWaveBase = started.nodes[0]!.frozenWaveBase
    if (frozenWaveBase === undefined) throw new Error('prepared test node has no frozen wave base')
    const nodeAtStart = { ...owner.node, frozenWaveBase }
    const signal = new AbortController().signal
    const expectStateFailure = async (
      state: DagState,
      message: string,
      dispatcher: Agent = harness.dispatcher,
    ): Promise<void> => {
      Reflect.set(service, 'requireState', () => state)
      await expect(prepare(dispatcher, nodeAtStart, command, signal)).rejects.toThrow(message)
    }

    try {
      await expectStateFailure({ ...started, nodes: [] }, 'committed Git and child identities')
      for (const missing of ['branch', 'worktree', 'childSessionId'] as const) {
        const { [missing]: _removed, ...nodeWithoutFact } = started.nodes[0]!
        await expectStateFailure({ ...started, nodes: [nodeWithoutFact] }, 'committed Git and child identities')
      }
      const { frozenWaveBase: _base, ...withoutBase } = started.nodes[0]!
      await expectStateFailure({ ...started, nodes: [withoutBase] }, 'frozen wave base')
      await expectStateFailure({ ...started, waves: [] }, 'open frozen wave')
      await expectStateFailure({
        ...started,
        waves: started.waves.map(wave => ({ ...wave, status: 'settled' })),
      }, 'open frozen wave')
      await expectStateFailure({
        ...started,
        waves: started.waves.map(wave => ({ ...wave, rootHead: '2'.repeat(40) })),
      }, 'open frozen wave')
      await expectStateFailure({
        ...started,
        waves: started.waves.map(wave => ({ ...wave, nodeIds: [] })),
      }, 'open frozen wave')
      await expectStateFailure({
        ...started,
        nodes: [{ ...started.nodes[0]!, deps: [DagNodeId('missing-dependency')] }],
      }, 'exact dependency commits')
      await expectStateFailure(
        started,
        'dispatcher session has no cwd',
        {
          id: harness.dispatcher.id,
          session: { header: {}, snapshotEvents: () => harness.dispatcher.session.snapshotEvents() },
        } as unknown as Agent,
      )
      const { preparedFrom: _preparedFrom, ...withoutPreparedFrom } = started.nodes[0]!
      for (const preparedNode of [
        { ...withoutPreparedFrom, preparedHead: '1'.repeat(40) },
        { ...started.nodes[0]!, preparedHead: '1'.repeat(40), preparedFrom: '2'.repeat(40) },
      ]) {
        await expectStateFailure({ ...started, nodes: [preparedNode] }, 'prepared worktree is missing')
      }
    } finally {
      Reflect.set(service, 'requireState', originalRequireState)
    }
  })

  it('validates wave ownership and cancels an unowned shared probe', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness, SessionId('wave-edge-child'))
    const service = harness.ctx.dag
    const ensureWave = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      AbortSignal,
    ], Promise<void>>(service, 'ensureWave')
    const originalRequireState = serviceField<(agent: Agent) => DagState>(service, 'requireState')
    const waveId = owner.node.waveId!
    const signal = new AbortController().signal
    const { waveId: _waveId, ...nodeWithoutWave } = owner.node

    await expect(ensureWave(
      harness.dispatcher,
      nodeWithoutWave,
      signal,
    )).rejects.toThrow('starting node lacks a wave')

    const unrelatedWave: DagState['waves'][number] = {
      id: waveId,
      nodeIds: [],
      rootBranch: 'main',
      rootHead: '1'.repeat(40),
      status: 'open',
      pendingNodeIds: [],
      completedNodeIds: [],
      failedNodeIds: [],
    }
    Reflect.set(service, 'requireState', () => ({ ...owner.state, waves: [unrelatedWave] }))
    await expect(ensureWave(harness.dispatcher, owner.node, signal))
      .rejects.toThrow(`wave ${waveId} does not contain active node a`)

    const settledCommands = owner.node.commands.map(command => ({
      ...command,
      state: 'settled' as const,
      outcome: 'cancelled' as const,
    }))
    Reflect.set(service, 'requireState', () => ({
      ...owner.state,
      nodes: [{ ...owner.node, commands: settledCommands }],
      activeCommandIds: [],
    }))
    await expect(ensureWave(harness.dispatcher, owner.node, signal))
      .rejects.toThrow(`wave ${waveId} has no active dispatch commands`)

    const missingRootDispatcher = {
      id: harness.dispatcher.id,
      session: {
        header: { ...harness.dispatcher.session.header, cwd: undefined },
        snapshotEvents: () => harness.dispatcher.session.snapshotEvents(),
      },
    } as unknown as Agent
    Reflect.set(service, 'requireState', () => owner.state)
    await expect(ensureWave(missingRootDispatcher, owner.node, signal))
      .rejects.toThrow('DAG dispatcher session has no cwd')
    Reflect.set(service, 'requireState', originalRequireState)

    serviceField<WeakMap<typeof harness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      service,
      'pumps',
    ).set(harness.dispatcher.session, new Set([owner.node.id]))
    const probes = serviceField<Map<string, {
      readonly controller: AbortController
      readonly promise: Promise<void>
      readonly agent: Agent
      readonly fences: readonly []
      waiters: number
    }>>(service, 'waveProbes')
    const staleController = new AbortController()
    probes.set(`${harness.dispatcher.id}:${waveId}`, {
      controller: staleController,
      promise: Promise.resolve(),
      agent: { id: harness.dispatcher.id } as unknown as Agent,
      fences: [],
      waiters: 0,
    })

    await ensureWave(harness.dispatcher, owner.node, signal)
    expect(staleController.signal.aborted).toBe(true)
    await ensureWave(
      harness.dispatcher,
      harness.ctx.dag.state(harness.dispatcher)!.nodes[0]!,
      signal,
    )

    const sharedHarness = await setup(new GatedAdapter([]))
    const sharedOwner = appendStartingOwner(sharedHarness, SessionId('shared-wave-child'))
    const sharedService = sharedHarness.ctx.dag
    const sharedEnsure = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      AbortSignal,
    ], Promise<void>>(sharedService, 'ensureWave')
    const gitRuntime = serviceField<{
      probeRoot: (root: string, signal: AbortSignal) => Promise<{ readonly branch: string; readonly head: string }>
    }>(sharedService, 'git')
    let probeSignal: AbortSignal | undefined
    const probeRoot = vi.spyOn(gitRuntime, 'probeRoot').mockImplementation(async (_root, activeSignal) => {
      probeSignal = activeSignal
      return await new Promise((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => {
          const reason = activeSignal.reason as unknown
          reject(reason instanceof Error ? reason : new Error('shared probe aborted', { cause: reason }))
        }, { once: true })
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    serviceField<WeakMap<typeof sharedHarness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      sharedService,
      'pumps',
    ).set(sharedHarness.dispatcher.session, new Set([sharedOwner.node.id]))
    const first = sharedEnsure(sharedHarness.dispatcher, sharedOwner.node, firstController.signal)
    await vi.waitFor(() => { expect(probeRoot).toHaveBeenCalledOnce() })
    const second = sharedEnsure(sharedHarness.dispatcher, sharedOwner.node, secondController.signal)
    sharedService.stop(sharedHarness.dispatcher, sharedOwner.node.id, 'Cancel the shared wave.')
    firstController.abort(new Error('first waiter stopped'))
    secondController.abort(new Error('second waiter stopped'))

    await expect(first).rejects.toThrow('first waiter stopped')
    await expect(second).rejects.toThrow('second waiter stopped')
    await vi.waitFor(() => { expect(probeSignal?.aborted).toBe(true) })
  })

  it('reconciles every existing and missing child delivery result', async () => {
    const preparedDelivery = async (suffix: string): Promise<{
      readonly harness: TestHarness
      readonly node: DagNodeSnapshot
      readonly command: DagNodeSnapshot['commands'][number]
      readonly invoke: (instruction?: string) => Promise<void>
    }> => {
      const harness = await setup(new GatedAdapter([]))
      const owner = appendStartingOwner(harness, SessionId(`delivery-${suffix}-child`))
      const prepared = appendOwnerPrepared(harness, owner)
      const node = prepared.nodes[0]!
      const command = node.commands[0]!
      const deliver = serviceMethod<[
        Agent,
        DagNodeSnapshot,
        DagNodeSnapshot['commands'][number],
        ReturnType<typeof SessionId>,
        string,
        string,
        string,
        string,
        string,
        readonly string[],
        readonly string[],
        AbortSignal,
        string?,
      ], Promise<void>>(harness.ctx.dag, 'deliverStart')
      serviceField<WeakMap<typeof harness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
        harness.ctx.dag,
        'pumps',
      ).set(harness.dispatcher.session, new Set([node.id]))
      return {
        harness,
        node,
        command,
        invoke: async (instruction?: string): Promise<void> => {
          await deliver(
            harness.dispatcher,
            node,
            command,
            node.childSessionId!,
            node.branch!,
            node.worktree!,
            node.frozenWaveBase!,
            node.preparedFrom ?? node.frozenWaveBase!,
            node.preparedHead!,
            node.dependencyCommits,
            node.conflictedFiles,
            new AbortController().signal,
            instruction,
          )
        },
      }
    }

    const refused = await preparedDelivery('refused')
    vi.spyOn(refused.harness.ctx.subagents, 'followup')
      .mockRejectedValueOnce(new SubagentError('followup refused', 'UNAUTHORIZED'))
    await expect(refused.invoke()).rejects.toThrow('followup refused')

    const missing = await preparedDelivery('missing')
    const missingFollowup = vi.spyOn(missing.harness.ctx.subagents, 'followup')
      .mockResolvedValueOnce(MessageId(`${missing.command.id}-message`))
    await missing.invoke()
    expect(missingFollowup).toHaveBeenCalledOnce()

    const existing = await preparedDelivery('existing')
    await existing.harness.ctx.agentLoop.create(
      existing.node.childSessionId!,
      { provider: 'mock', model: 'mock' },
      { cwd: existing.node.worktree! },
    )
    const existingFollowup = vi.spyOn(existing.harness.ctx.subagents, 'followup')
      .mockResolvedValueOnce(MessageId(`${existing.command.id}-message`))
    await existing.invoke('Continue the prepared work.')
    expect(existingFollowup).toHaveBeenCalledOnce()

    const recorded = await preparedDelivery('recorded')
    const recordedChild = await recorded.harness.ctx.agentLoop.create(
      recorded.node.childSessionId!,
      { provider: 'mock', model: 'mock' },
      { cwd: recorded.node.worktree! },
    )
    recordedChild.inject(userMessageForTest(`${recorded.command.id}-message`))
    const recordedFollowup = vi.spyOn(recorded.harness.ctx.subagents, 'followup')
    await recorded.invoke()
    expect(recordedFollowup).not.toHaveBeenCalled()
  })

  it('renders dependency and conflict facts in the child prompt', async () => {
    const { ctx, dispatcher } = await setup(new GatedAdapter([]))
    ctx.dag.write(dispatcher, { nodes: [node()] })
    const dependencyCommit = '1'.repeat(40)
    const prompt = serviceMethod<[
      DagNodeSnapshot,
      string,
      readonly string[],
      readonly string[],
    ], string>(ctx.dag, 'nodePrompt')
    const rendered = prompt(ctx.dag.inspect(dispatcher, DagNodeId('a')), '/tmp/worktree', [dependencyCommit], ['owned.txt'])

    expect(rendered).toContain(`Dependency commits: ${dependencyCommit}`)
    expect(rendered).toContain('Conflicted files for manual integration: owned.txt.')
  })

  it('ignores stale activation settlement facts and fails one matching activation', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const command = owner.node.commands[0]!
    const base = {
      binding: owner.binding,
      childId: owner.node.childSessionId!,
      parentSessionId: harness.dispatcher.id,
      stopReason: 'completed' as const,
      messageId: MessageId(`${command.id}-message`),
    }
    harness.ctx.dag.settled({ ...base, binding: { ...owner.binding, metadata: { ...owner.binding.metadata, dispatcherSessionId: SessionId('missing') } } })
    harness.ctx.dag.settled({ ...base, childId: SessionId('other') })
    const { messageId: _messageId, ...settlementWithoutMessage } = base
    harness.ctx.dag.settled(settlementWithoutMessage)
    expect(harness.ctx.dag.state(harness.dispatcher)?.revision).toBe(owner.state.revision)

    harness.ctx.dag.settled({ ...base, messageId: MessageId('unmatched-message') })
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]?.status).toBe('failed')
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]?.settlement).toMatchObject({
      reason: 'DAG child turn ended with completed without dag_node_complete or dag_node_block.',
    })

    const staleHarness = await setup(new GatedAdapter([]))
    const staleOwner = appendStartingOwner(staleHarness, SessionId('stale-owner-child'))
    const started = appendOwnerInProgress(staleHarness, staleOwner)
    const steered = reduceDagState(started, {
      type: 'steer', nodeId: DagNodeId('a'), message: 'replace',
    }).state
    staleHarness.dispatcher.session.append('dag/state', { state: steered })
    staleHarness.ctx.dag.settled({
      ...base,
      binding: staleOwner.binding,
      childId: staleOwner.node.childSessionId!,
      parentSessionId: staleHarness.dispatcher.id,
      messageId: MessageId(`${staleOwner.node.commands[0]!.id}-message`),
    })
    expect(staleHarness.ctx.dag.state(staleHarness.dispatcher)).toMatchObject({
      revision: steered.revision,
      nodes: [{ status: 'in_progress', generation: steered.nodes[0]!.generation }],
    })

    const matchingHarness = await setup(new GatedAdapter([]))
    const matchingOwner = appendStartingOwner(matchingHarness, SessionId('matching-owner-child'))
    const matchingCommand = matchingOwner.node.commands[0]!
    matchingHarness.ctx.dag.settled({
      binding: matchingOwner.binding,
      childId: matchingOwner.node.childSessionId!,
      parentSessionId: matchingHarness.dispatcher.id,
      stopReason: 'error',
      messageId: MessageId(`${matchingCommand.id}-message`),
      error: 'matching activation failed',
    })
    expect(matchingHarness.ctx.dag.state(matchingHarness.dispatcher)?.nodes[0]).toMatchObject({
      status: 'failed',
      settlement: { kind: 'failed', reason: 'matching activation failed' },
    })
  })

  it('stops terminal ordinary settlements and ignores stale or cancelled steer turns', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const command = owner.node.commands[0]!
    const child = { id: owner.node.childSessionId } as unknown as Agent
    const stop = vi.fn()
    const base = {
      binding: owner.binding,
      child,
      parentSessionId: harness.dispatcher.id,
      turn: 1,
      stopReason: 'completed' as const,
      messageId: MessageId(`${command.id}-message`),
      stop,
    }

    harness.ctx.dag.turnSettled({ ...base, binding: { ...owner.binding, metadata: { ...owner.binding.metadata, dispatcherSessionId: SessionId('missing') } } })
    harness.ctx.dag.turnSettled({ ...base, child: { id: SessionId('other') } as unknown as Agent })
    const stopped = reduceDagState(owner.state, { type: 'stop', nodeId: DagNodeId('a'), reason: 'stop' }).state
    harness.dispatcher.session.append('dag/state', { state: stopped })
    harness.ctx.dag.turnSettled(base)
    expect(stop).toHaveBeenCalledOnce()

    stop.mockClear()
    harness.ctx.dag.turnSettled({ ...base, messageId: MessageId('unmatched-terminal-turn') })
    expect(stop).toHaveBeenCalledOnce()

    stop.mockClear()
    const steerHarness = await setup(new GatedAdapter([]))
    const steerOwner = appendStartingOwner(steerHarness, SessionId('steer-owner-child'))
    const started = appendOwnerInProgress(steerHarness, steerOwner)
    const steered = reduceDagState(started, {
      type: 'steer', nodeId: DagNodeId('a'), message: 'replace',
    }).state
    steerHarness.dispatcher.session.append('dag/state', { state: steered })
    steerHarness.ctx.dag.turnSettled({
      ...base,
      binding: steerOwner.binding,
      child: { id: steerOwner.node.childSessionId } as unknown as Agent,
      parentSessionId: steerHarness.dispatcher.id,
      messageId: MessageId('generic'),
      stopReason: 'aborted',
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it('routes owner stops through one durable transition and reuses interruption state', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const child = { id: owner.node.childSessionId } as unknown as Agent
    const stop = vi.fn()
    const request = {
      binding: owner.binding,
      child,
      authority: { kind: 'user' as const, parentSessionId: harness.dispatcher.id },
      stop,
    }
    harness.ctx.dag.stop(request)
    expect(stop).toHaveBeenCalledOnce()
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]).toMatchObject({ status: 'interrupted' })
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]?.commands.at(-1)).toMatchObject({
      kind: 'stop', state: 'settled', outcome: 'succeeded',
    })

    harness.ctx.dag.stop(request)
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('rejects missing owner routes, stale bindings, and unowned child agents', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const child = { id: owner.node.childSessionId } as unknown as Agent
    const message = userMessageForTest('owner-route')
    const redirect = vi.fn()

    expect(() => harness.ctx.dag.redirect({
      binding: { ...owner.binding, metadata: { ...owner.binding.metadata, nodeId: 'missing' } },
      child,
      message,
      redirect,
    })).toThrow(expect.objectContaining({ code: 'dag-node-not-found' }))
    expect(() => harness.ctx.dag.redirect({
      binding: { ...owner.binding, metadata: { ...owner.binding.metadata, dispatcherSessionId: SessionId('missing') } },
      child,
      message,
      redirect,
    })).toThrow(expect.objectContaining({ code: 'dag-dispatcher-not-live' }))

    const unrelated = await harness.ctx.agentLoop.create(
      SessionId('unowned-child'),
      { provider: 'mock', model: 'mock' },
      { cwd: harness.root },
    )
    expect(() => harness.ctx.dag.statusFrom(unrelated))
      .toThrow(expect.objectContaining({ code: 'dag-child-owner-missing' }))
    const stale = { id: unrelated.id, session: unrelated.session } as unknown as Agent
    expect(() => harness.ctx.dag.statusFrom(stale))
      .toThrow(expect.objectContaining({ code: 'dag-child-not-live' }))

    const assertBinding = serviceMethod<[
      Agent,
      {
        readonly version: 1
        readonly dispatcherSessionId: ReturnType<typeof SessionId>
        readonly nodeId: ReturnType<typeof DagNodeId>
      },
      ReturnType<typeof SessionId>,
    ], DagNodeSnapshot>(harness.ctx.dag, 'assertBinding')
    expect(() => assertBinding(
      harness.dispatcher,
      { ...owner.binding.metadata, nodeId: DagNodeId('missing') },
      owner.node.childSessionId!,
    )).toThrow(expect.objectContaining({ code: 'dag-stale-child-binding' }))
    expect(() => assertBinding(
      harness.dispatcher,
      owner.binding.metadata,
      SessionId('wrong-child'),
    )).toThrow(expect.objectContaining({ code: 'dag-stale-child-binding' }))

    const command = owner.node.commands[0]!
    const finishSteer = serviceMethod<[
      Agent,
      DagNodeSnapshot['id'],
      ReturnType<typeof DagCommandId>,
      number,
      ReturnType<typeof DagOperationId>,
    ], unknown>(harness.ctx.dag, 'finishSteer')
    expect(() => {
      finishSteer(
        harness.dispatcher,
        DagNodeId('missing'),
        command.id,
        command.generation,
        command.operationId,
      )
    }).toThrow('steer requires a prepared child binding')
  })

  it('rejects owner redirect delivery after service disposal', async () => {
    const harness = await setup(new GatedAdapter([]))
    const service = harness.ctx.dag
    const owner = appendStartingOwner(harness)
    const command = owner.node.commands[0]!
    const deliver = serviceMethod<[
      Agent,
      DagNodeSnapshot['id'],
      DagNodeSnapshot['commands'][number],
      {
        readonly binding: typeof owner.binding
        readonly child: Agent
        readonly message: ReturnType<typeof userMessageForTest>
        readonly redirect: () => void
      },
    ], Promise<void>>(service, 'deliverOwnerRedirect')
    await harness.disposeDag()

    await expect(deliver(harness.dispatcher, owner.node.id, command, {
      binding: owner.binding,
      child: { id: owner.node.childSessionId } as unknown as Agent,
      message: userMessageForTest('disposed-owner-redirect'),
      redirect: vi.fn(),
    })).rejects.toMatchObject({ code: 'dag-service-disposed' })
  })

  it('contains post-commit and reconciliation work after disposal starts', async () => {
    const harness = await setup(new GatedAdapter([]))
    const reconcile = serviceMethod<[Agent], unknown>(harness.ctx.dag, 'reconcile')
    const scheduleFlush = serviceMethod<[Agent], unknown>(harness.ctx.dag, 'scheduleFlush')

    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    reconcile(harness.dispatcher)
    Reflect.set(harness.ctx.dag, 'disposed', true)
    scheduleFlush(harness.dispatcher)
    await Promise.resolve()
    expect(serviceField<Set<Promise<void>>>(harness.ctx.dag, 'flushTasks').size).toBe(0)
    Reflect.set(harness.ctx.dag, 'disposed', false)
  })

  it('settles an admitted owner stop and uses dispatcher authority text', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const stop = vi.fn()
    harness.ctx.dag.stop({
      binding: owner.binding,
      child: { id: owner.node.childSessionId } as unknown as Agent,
      authority: { kind: 'ancestor', agent: harness.dispatcher },
      stop,
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(harness.ctx.dag.state(harness.dispatcher)?.nodes[0]?.settlement).toEqual({
      kind: 'interrupted',
      reason: 'Stopped by the dispatcher.',
    })

    const activeHarness = await setup(new GatedAdapter([]))
    const activeOwner = appendStartingOwner(activeHarness, SessionId('active-stop-child'))
    const interrupted = reduceDagState(activeOwner.state, {
      type: 'stop', nodeId: DagNodeId('a'), reason: 'Already accepted.',
    }).state
    activeHarness.dispatcher.session.append('dag/state', { state: interrupted })
    const activeStop = vi.fn()
    activeHarness.ctx.dag.stop({
      binding: activeOwner.binding,
      child: { id: activeOwner.node.childSessionId } as unknown as Agent,
      authority: { kind: 'user', parentSessionId: activeHarness.dispatcher.id },
      stop: activeStop,
    })
    expect(activeStop).toHaveBeenCalledOnce()
    expect(activeHarness.ctx.dag.state(activeHarness.dispatcher)?.nodes[0]?.commands.at(-1))
      .toMatchObject({ kind: 'stop', state: 'settled', outcome: 'succeeded' })

    expect(() => {
      activeHarness.ctx.dag.stop({
        binding: { ...activeOwner.binding, metadata: { ...activeOwner.binding.metadata, nodeId: 'missing' } },
        child: { id: activeOwner.node.childSessionId } as unknown as Agent,
        authority: { kind: 'user', parentSessionId: activeHarness.dispatcher.id },
        stop: vi.fn(),
      })
    }).toThrow(expect.objectContaining({ code: 'dag-node-not-found' }))
  })

  it('guards scheduler entry points for empty, stale, and disposed activations', async () => {
    const harness = await setup(new GatedAdapter([]))
    const schedule = serviceMethod<[Agent], unknown>(harness.ctx.dag, 'schedule')
    const deliverNotices = serviceMethod<[Agent], unknown>(harness.ctx.dag, 'deliverNotices')
    const reconcile = serviceMethod<[Agent], unknown>(harness.ctx.dag, 'reconcile')
    const canRun = serviceMethod<[Agent], boolean>(harness.ctx.dag, 'canRun')
    const stale = { id: harness.dispatcher.id, session: harness.dispatcher.session } as unknown as Agent

    schedule(harness.dispatcher)
    schedule(stale)
    deliverNotices(harness.dispatcher)
    deliverNotices(stale)
    reconcile(harness.dispatcher)
    expect(canRun(stale)).toBe(false)

    const service = harness.ctx.dag
    await harness.disposeDag()
    schedule(harness.dispatcher)
    expect(canRun(harness.dispatcher)).toBe(false)
    expect(() => { deliverNotices(stale) }).not.toThrow()
    expect(service).toBeDefined()
  })

  it('settles a stopped effect as cancelled before it drains the stop command', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness, SessionId('cancelled-effect-child'))
    const service = harness.ctx.dag
    const pump = serviceMethod<[Agent, DagNodeSnapshot['id']], Promise<void>>(service, 'pump')
    const originalExecute = serviceMethod<[
      Agent,
      DagNodeSnapshot,
      DagNodeSnapshot['commands'][number],
      AbortSignal,
    ], Promise<void>>(service, 'executeCommand')
    serviceField<WeakMap<typeof harness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      service,
      'pumps',
    ).set(harness.dispatcher.session, new Set([owner.node.id]))
    vi.spyOn(harness.ctx.subagents, 'interrupt').mockImplementation(() => {})
    Reflect.set(service, 'executeCommand', async (
      dispatcher: Agent,
      nodeAtStart: DagNodeSnapshot,
      command: DagNodeSnapshot['commands'][number],
      signal: AbortSignal,
    ) => {
      if (command.kind === 'dispatch') {
        service.stop(dispatcher, nodeAtStart.id, 'Cancel the running effect.')
        signal.throwIfAborted()
      }
      await originalExecute(dispatcher, nodeAtStart, command, signal)
    })

    await pump(harness.dispatcher, owner.node.id)

    expect(service.state(harness.dispatcher)?.nodes[0]).toMatchObject({ status: 'interrupted' })
    expect(service.state(harness.dispatcher)?.nodes[0]?.commands.at(-1))
      .toMatchObject({ kind: 'stop', state: 'settled', outcome: 'succeeded' })
  })

  it('drops an effect failure after its DAG service activation is disposed', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness, SessionId('disposed-effect-child'))
    const service = harness.ctx.dag
    const pump = serviceMethod<[Agent, DagNodeSnapshot['id']], Promise<void>>(service, 'pump')
    serviceField<WeakMap<typeof harness.dispatcher.session, Set<ReturnType<typeof DagNodeId>>>>(
      service,
      'pumps',
    ).set(harness.dispatcher.session, new Set([owner.node.id]))
    Reflect.set(service, 'executeCommand', async () => {
      await harness.disposeDag()
      throw new Error('late disposed effect failure')
    })

    await pump(harness.dispatcher, owner.node.id)

    expect(serviceField<Map<symbol, unknown>>(service, 'effects').size).toBe(0)
    expect(serviceField<boolean>(service, 'disposed')).toBe(true)
  })

  it('aborts owned effects and shared probes during service disposal', async () => {
    const harness = await setup(new GatedAdapter([]))
    const effectController = new AbortController()
    const probeController = new AbortController()
    const effects = serviceField<Map<symbol, {
      readonly controller: AbortController
      readonly session: typeof harness.dispatcher.session
      readonly nodeId: ReturnType<typeof DagNodeId>
      readonly commandId: ReturnType<typeof DagCommandId>
    }>>(harness.ctx.dag, 'effects')
    const probes = serviceField<Map<string, {
      readonly controller: AbortController
      readonly promise: Promise<void>
      readonly agent: Agent
      readonly fences: readonly []
      waiters: number
    }>>(harness.ctx.dag, 'waveProbes')
    effects.set(Symbol('effect'), {
      controller: effectController,
      session: harness.dispatcher.session,
      nodeId: DagNodeId('a'),
      commandId: DagCommandId('command'),
    })
    probes.set('probe', {
      controller: probeController,
      promise: Promise.resolve(),
      agent: harness.dispatcher,
      fences: [],
      waiters: 0,
    })

    await harness.disposeDag()

    expect(effectController.signal.aborted).toBe(true)
    expect(probeController.signal.aborted).toBe(true)
    expect(effects.size).toBe(0)
    expect(probes.size).toBe(0)
  })

  it('cancels only stale effects owned by the committed dispatcher session', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const cancel = serviceMethod<[typeof harness.dispatcher.session, DagState], unknown>(harness.ctx.dag, 'cancelStaleEffects')
    const effects = serviceField<Map<symbol, {
      readonly controller: AbortController
      readonly session: typeof harness.dispatcher.session
      readonly nodeId: ReturnType<typeof DagNodeId>
      readonly commandId: ReturnType<typeof DagCommandId>
    }>>(harness.ctx.dag, 'effects')
    const exact = new AbortController()
    const missing = new AbortController()
    const foreign = new AbortController()
    const command = owner.node.commands[0]!
    effects.set(Symbol('exact'), {
      controller: exact, session: harness.dispatcher.session, nodeId: owner.node.id, commandId: command.id,
    })
    effects.set(Symbol('missing'), {
      controller: missing, session: harness.dispatcher.session, nodeId: DagNodeId('missing'), commandId: command.id,
    })
    effects.set(Symbol('foreign'), {
      controller: foreign, session: {} as typeof harness.dispatcher.session, nodeId: owner.node.id, commandId: command.id,
    })

    cancel(harness.dispatcher.session, owner.state)
    expect(exact.signal.aborted).toBe(false)
    expect(missing.signal.aborted).toBe(true)
    expect(foreign.signal.aborted).toBe(false)

    cancel(harness.dispatcher.session, {
      ...owner.state,
      nodes: [{ ...owner.node, commands: [{ ...command, state: 'settled' }] }],
    })
    expect(exact.signal.aborted).toBe(true)
  })

  it('contains reconciliation and scheduled-flush failures', async () => {
    const harness = await setup(new GatedAdapter([]))
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => harness.ctx.logger)
    harness.ctx.dag.write(harness.dispatcher, { nodes: [node()] })
    const originalDelivery = serviceField<(agent: Agent) => void>(harness.ctx.dag, 'deliverNotices')
    Reflect.set(harness.ctx.dag, 'deliverNotices', () => { throw new Error('delivery failed') })
    serviceMethod<[Agent], unknown>(harness.ctx.dag, 'reconcile')(harness.dispatcher)
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notice reconciliation failed'))
    Reflect.set(harness.ctx.dag, 'deliverNotices', originalDelivery)

    const originalFlush = serviceField<(agent: Agent) => Promise<void>>(harness.ctx.dag, 'flushAndSchedule')
    Reflect.set(harness.ctx.dag, 'flushAndSchedule', () => Promise.reject(new Error('post-commit failed')))
    serviceMethod<[Agent], unknown>(harness.ctx.dag, 'scheduleFlush')(harness.dispatcher)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('post-commit scheduling failed'))
    Reflect.set(harness.ctx.dag, 'flushAndSchedule', originalFlush)
  })

  it('validates the exact command message admitted to a child turn', async () => {
    const harness = await setup(new GatedAdapter([]))
    const owner = appendStartingOwner(harness)
    const command = owner.node.commands[0]!
    const assertTurn = serviceMethod<[DagNodeSnapshot, Agent], unknown>(harness.ctx.dag, 'assertCurrentChildTurn')
    const child = (events: readonly unknown[]): Agent => ({
      session: { snapshotEvents: () => events },
    }) as unknown as Agent
    const start = { type: 'turn/start', data: { turn: 1 } }
    const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    const currentMessage = {
      type: 'user/message',
      data: userMessageForTest(`${command.id}-message`),
    }

    const { currentOperationId: _operationId, ...nodeWithoutOperation } = owner.node
    expect(() => { assertTurn({ ...nodeWithoutOperation, commands: [] }, child([start])) })
      .toThrow(expect.objectContaining({ code: 'dag-stale-child-turn' }))
    expect(() => { assertTurn(owner.node, child([])) })
      .toThrow(/requires an active turn/)
    expect(() => { assertTurn(owner.node, child([start, end])) })
      .toThrow(/requires an active turn/)
    expect(() => { assertTurn(owner.node, child([start, currentMessage])) }).not.toThrow()
    expect(() => { assertTurn(owner.node, child([currentMessage, start])) }).not.toThrow()
    expect(() => { assertTurn(owner.node, child([start])) })
      .toThrow(/invalidated turn/)

    const old = {
      ...command,
      id: DagCommandId('op-0-a-g0-old'),
      operationId: DagOperationId('op-0'),
      generation: 0,
      bindingGeneration: 0,
    }
    expect(() => {
      assertTurn({ ...owner.node, commands: [old, command] }, child([
        start,
        { type: 'user/message', data: userMessageForTest(`${old.id}-message`) },
      ]))
    }).toThrow(/invalidated turn/)
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
      source: { kind: 'agent-message', form: 'relay', senderSessionId: dispatcher.id },
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
        source: { kind: 'agent-message', form: 'relay', senderSessionId: dispatcher.id },
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
    expect(worker.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === acceptedId)).toBe(true)

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
    await harness.ctx.agentLoop.create(
      SessionId('reload-empty-dispatcher'),
      { provider: 'mock', model: 'mock' },
      { cwd: harness.root },
    )
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
    await settleServiceDelivery(first)
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
    const inserted = second.dispatcher.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
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
    const inserted = harness.dispatcher.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
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
    await settleServiceDelivery(first)
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
    const inserted = second.dispatcher.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)
      : [])

    expect(inserted).toHaveLength(2)
    expect([...second.dispatcher.inbox.nextTurn, ...second.dispatcher.inbox.nextStep]
      .filter(message => message.source.kind === 'dag-notice' && message.source.noticeId === notice.id)).toHaveLength(1)
  })
})
