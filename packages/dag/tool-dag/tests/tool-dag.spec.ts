import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DagService } from '@deepseek-ai/dsh-dag'
import { DagNodeId, DagOperationId, DagWaveId } from '@deepseek-ai/dsh-dag'
import type { DagNodeSnapshot, DagProjection } from '@deepseek-ai/dsh-dag'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableSetupContribution, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as childTool from '../src/child.ts'
import * as tool from '../src/index.ts'
import { DISPATCHER_TOOLS } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function projection(): DagProjection {
  return {
    revision: 4,
    graphGeneration: 1,
    nodes: [{
      id: DagNodeId('a'), content: 'Implement a', deps: [], kind: 'task', policy: 'delegate', files: ['src/a.ts'],
      status: 'in_progress', generation: 1, branch: 'dsh/dag/test/g1/a', dependencyCommits: [], conflictedFiles: [],
    }],
    counts: { pending: 0, starting: 0, in_progress: 1, completed: 0, blocked: 0, failed: 0, interrupted: 0 },
    readyNodeIds: [],
    openWaves: [{
      id: DagWaveId('wave-1'), nodeIds: [DagNodeId('a')], rootBranch: 'main', rootHead: '1'.repeat(40),
      status: 'open', pendingNodeIds: [DagNodeId('a')], completedNodeIds: [], failedNodeIds: [],
    }],
  }
}

function inspected(): DagNodeSnapshot {
  return {
    id: DagNodeId('a'), content: 'Implement a', brief: 'VALIDATION: test.\nACCEPTANCE: commit.', deps: [], kind: 'task',
    policy: 'delegate', files: ['src/a.ts'], status: 'in_progress', generation: 1, bindingGeneration: 1,
    childSessionId: SessionId('child-a'), branch: 'dsh/dag/test/g1/a', worktree: '/tmp/dag/a', frozenWaveBase: '1'.repeat(40),
    waveId: DagWaveId('wave-1'), preparedFrom: '1'.repeat(40), preparedHead: '1'.repeat(40), dependencyCommits: [], conflictedFiles: [],
    currentOperationId: DagOperationId('op-2'), settlement: { kind: 'completed', summary: 'Done.', artifacts: [] },
    completedCommit: '2'.repeat(40), commands: [],
  }
}

function sparseInspected(): DagNodeSnapshot {
  return {
    id: DagNodeId('sparse'), content: 'Sparse node', brief: 'VALIDATION: test.\nACCEPTANCE: commit.', deps: [],
    kind: 'task', policy: 'delegate', files: [], status: 'pending', generation: 0, bindingGeneration: 0,
    dependencyCommits: [], conflictedFiles: [], commands: [],
  }
}

interface FakeDagOptions {
  status?: DagProjection | null
  inspected?: DagNodeSnapshot
}

function fakeDag(options: FakeDagOptions = {}) {
  const calls: { name: string; args: unknown[] }[] = []
  const accepted = { accepted: true as const, revision: 5, operationId: DagOperationId('op-5') }
  const record = (name: string, value: unknown) => (...args: unknown[]) => {
    calls.push({ name, args })
    return value
  }
  const service = {
    write: record('write', {
      ...accepted,
      dropped: [
        { id: DagNodeId('old'), childSessionId: SessionId('child-old'), branch: 'old-branch', worktree: '/tmp/old' },
        { id: DagNodeId('unstarted') },
      ],
      amended: [{ id: DagNodeId('fixed'), fields: ['files'] }],
      rewired: [{ id: DagNodeId('dependent'), removedDeps: [DagNodeId('old')] }],
      conflicts: [{ ids: [DagNodeId('a'), DagNodeId('b')], files: ['src/shared.ts'], reason: 'declared-files-overlap' }],
    }),
    amend: record('amend', accepted),
    dispatch: record('dispatch', accepted),
    wait: record('wait', Promise.resolve({ revision: 5, notices: [], state: projection() })),
    status: record('status', options.status === undefined ? projection() : options.status),
    inspect: record('inspect', options.inspected ?? inspected()),
    redispatch: record('redispatch', accepted),
    resume: record('resume', accepted),
    steer: record('steer', accepted),
    stop: record('stop', accepted),
    reset: record('reset', accepted),
    completeFrom: record('completeFrom', accepted),
    blockFrom: record('blockFrom', accepted),
    statusFrom: record('statusFrom', { revision: 4, topology: [{ id: DagNodeId('a'), deps: [], status: 'in_progress' }], own: projection().nodes[0] }),
  }
  return { service: service as unknown as DagService, calls }
}

async function dispatcherBench(options: FakeDagOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const dag = fakeDag(options)
  ctx.provide('dag', dag.service)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin(tool)
  await fiber.await()
  return { ctx, fiber, ...dag }
}

function owner(id = 'dispatcher'): Agent {
  return { id: SessionId(id) } as Agent
}

let calls = 0
function execute(ctx: Context, name: string, arguments_: unknown, agent = owner()) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`dag-call-${++calls}`),
    name,
    arguments: arguments_,
    agent,
  })
}

describe('native DAG tools', () => {
  it('registers the exact dispatcher tool set and the wait instruction', async () => {
    const { ctx } = await dispatcherBench()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([...DISPATCHER_TOOLS].sort())
    const section = (await ctx.systemPrompt.assemble()).sections.find(row => row.name === 'dag:dispatcher')
    expect(section?.text).toContain('call dag_wait')
    expect(section?.text).toContain('Do not poll dag_status')
    expect(ctx.tools.schemas().some(schema => schema.name === 'dag_node_interrupt')).toBe(false)
  })

  it('returns command acceptance and preserved artifacts without a file presenter', async () => {
    const { ctx } = await dispatcherBench()
    const result = await execute(ctx, 'dag_write', {
      nodes: [{
        id: 'a', content: 'Implement a', brief: 'VALIDATION: test.\nACCEPTANCE: commit.', deps: [], status: 'pending',
      }],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('dag_write failed')
    expect(result.value).toMatchObject({
      accepted: true,
      revision: 5,
      operationId: 'op-5',
      dropped: [
        { id: 'old', childSessionId: 'child-old', branch: 'old-branch', worktree: '/tmp/old' },
        { id: 'unstarted' },
      ],
      amended: [{ id: 'fixed', fields: ['files'] }],
      rewired: [{ id: 'dependent', removedDeps: ['old'] }],
      conflicts: [{ ids: ['a', 'b'], files: ['src/shared.ts'], reason: 'declared-files-overlap' }],
    })
    expect(result.content.every(block => block.type === 'text')).toBe(true)
  })

  it('returns complete dispatcher-only node execution facts', async () => {
    const { ctx } = await dispatcherBench()
    const result = await execute(ctx, 'dag_node_inspect', { node_id: 'a' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('dag_node_inspect failed')
    const value = result.value as { text: string }
    expect(JSON.parse(value.text)).toMatchObject({
      childSessionId: 'child-a',
      worktree: '/tmp/dag/a',
      frozenWaveBase: '1111111111111111111111111111111111111111',
      preparedFrom: '1111111111111111111111111111111111111111',
      bindingGeneration: 1,
      waveId: 'wave-1',
      completedCommit: '2222222222222222222222222222222222222222',
    })
  })

  it('omits unavailable dispatcher-only node execution facts', async () => {
    const { ctx } = await dispatcherBench({ inspected: sparseInspected() })
    const result = await execute(ctx, 'dag_node_inspect', { node_id: 'sparse' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('dag_node_inspect failed')
    expect(JSON.parse((result.value as { text: string }).text)).toEqual({
      id: 'sparse',
      content: 'Sparse node',
      brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
      deps: [],
      kind: 'task',
      policy: 'delegate',
      files: [],
      status: 'pending',
      generation: 0,
      bindingGeneration: 0,
      dependencyCommits: [],
      conflictedFiles: [],
      commands: [],
    })
  })

  it('routes dispatcher reads and mutations with their optional fields', async () => {
    const { ctx, calls: dagCalls } = await dispatcherBench()
    const invocations: [string, object][] = [
      ['dag_write', { nodes: [], if_revision: 3 }],
      ['dag_node_amend', { node_id: 'a', files: ['src/a.ts'], kind: 'task', if_revision: 3 }],
      ['dag_node_amend', { node_id: 'a', content: 'Corrected.' }],
      ['dag_node_amend', { node_id: 'a', brief: 'VALIDATION: x.\nACCEPTANCE: y.', deps: [], policy: 'ours' }],
      ['dag_dispatch', { node_ids: ['a'], if_revision: 4 }],
      ['dag_dispatch', { node_ids: ['a'] }],
      ['dag_wait', { after_revision: 4 }],
      ['dag_status', {}],
      ['dag_node_redispatch', { node_id: 'a' }],
      ['dag_node_resume', { node_id: 'a', message: 'Continue.', if_revision: 5 }],
      ['dag_node_steer', { node_id: 'a', message: 'Use the new input.' }],
      ['dag_node_stop', { node_id: 'a', reason: 'Stop now.', if_revision: 6 }],
      ['dag_node_stop', { node_id: 'a' }],
      ['dag_node_reset', { node_id: 'a', target: 'refs/heads/main' }],
    ]
    for (const [name, args] of invocations) {
      const result = await execute(ctx, name, args)
      expect(result.isError, name).toBe(false)
    }

    expect(dagCalls.map(call => call.name)).toEqual([
      'write', 'amend', 'amend', 'amend', 'dispatch', 'dispatch', 'wait', 'status', 'redispatch', 'resume', 'steer', 'stop', 'stop', 'reset',
    ])
    expect(dagCalls.filter(call => call.name === 'amend').map(call => call.args[2]))
      .toEqual([
        { files: ['src/a.ts'], kind: 'task', if_revision: 3 },
        { content: 'Corrected.' },
        { brief: 'VALIDATION: x.\nACCEPTANCE: y.', deps: [], policy: 'ours' },
      ])
    expect(dagCalls.filter(call => call.name === 'dispatch').map(call => call.args[2]))
      .toEqual([{ if_revision: 4 }, {}])
    expect(dagCalls.filter(call => call.name === 'stop').map(call => call.args.slice(2)))
      .toEqual([['Stop now.', { if_revision: 6 }], [undefined, {}]])

    const status = await execute(ctx, 'dag_status', {})
    expect(status.isError).toBe(false)
    if (status.isError) throw new Error('dag_status failed')
    expect(JSON.parse((status.value as { text: string }).text)).toMatchObject({
      nodes: [{ id: 'a', status: 'in_progress' }],
      waves: [{ id: 'wave-1', status: 'open', pending: ['a'] }],
    })
  })

  it('reports an undeclared board and rejects calls without an owning agent', async () => {
    const { ctx } = await dispatcherBench({ status: null })
    const status = await execute(ctx, 'dag_status', {})
    expect(status).toMatchObject({ isError: false, value: { text: 'No DAG declaration.' } })

    const withoutAgent = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`dag-call-${++calls}`),
      name: 'dag_status',
      arguments: {},
    })
    expect(withoutAgent.isError).toBe(true)
    expect(withoutAgent.content).toEqual([{ type: 'text', text: 'Error: dag_status requires an owning agent' }])
  })

  it('unregisters tools and prompt text when its plugin fiber unloads', async () => {
    const { ctx, fiber } = await dispatcherBench()
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => DISPATCHER_TOOLS.includes(schema.name as typeof DISPATCHER_TOOLS[number]))).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(row => row.name === 'dag:dispatcher')).toBe(false)
  })
})

describe('owner-bound child tools', () => {
  it('uses the host DAG service when the child context does not inject it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const dag = fakeDag()
    let setup: ContinuableSetupContribution | undefined
    const subagents = {
      registerContinuableSetup(contribution: ContinuableSetupContribution) {
        setup = contribution
        return () => { setup = undefined }
      },
    } as unknown as SubagentRuntime
    ctx.provide('dag', dag.service)
    ctx.provide('subagents', subagents)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime).await()
    const childFiberPlugin = ctx.plugin(childTool)
    await childFiberPlugin.await()
    expect(setup).toBeDefined()

    const child = owner('child-a')
    const childRoot = new Context()
    contexts.push(childRoot)
    const childFiber = childRoot.plugin(function childScope() {})
    await childFiber.await()
    const childCtx = childFiber.ctx.extend({
      tools: {
        restrict: () => () => {},
        register: (definition: ToolDefinition) => ctx.tools.register(definition),
      } as unknown as Context['tools'],
      systemPrompt: ctx.systemPrompt,
    })
    expect(() => childCtx.dag).toThrow('cannot get property "dag" without inject')
    setup?.(childCtx, undefined)()
    const dispose = setup?.(childCtx, { controller: 'dag', metadata: { nodeId: 'a' } })
    expect(dispose).toBeDefined()

    const status = await execute(ctx, 'dag_status', {}, child)
    const complete = await execute(ctx, 'dag_node_complete', {
      summary: 'Committed work.',
      artifacts: [{ kind: 'commit', value: 'abc123' }],
    }, child)
    const completeWithoutArtifacts = await execute(ctx, 'dag_node_complete', { summary: 'Committed work.' }, child)
    const block = await execute(ctx, 'dag_node_block', { reason: 'Need a decision.' }, child)

    expect(status.isError).toBe(false)
    expect(complete.isError).toBe(false)
    expect(completeWithoutArtifacts.isError).toBe(false)
    expect(block.isError).toBe(false)
    expect(complete).toMatchObject({ concludesTurn: true })
    expect(block).toMatchObject({ concludesTurn: true })
    expect(dag.calls.map(call => call.name)).toEqual(['statusFrom', 'completeFrom', 'completeFrom', 'blockFrom'])
    expect(dag.calls.every(call => call.args[0] === child)).toBe(true)
    expect(dag.calls[2]?.args[2]).toEqual([])
    dispose?.()

    await childFiberPlugin.dispose()
    expect(setup).toBeUndefined()
  })

  it('has no dispatcher control tool in its scoped set', () => {
    expect(DISPATCHER_TOOLS).not.toContain('dag_node_complete')
    expect(DISPATCHER_TOOLS).not.toContain('dag_node_block')
  })
})
