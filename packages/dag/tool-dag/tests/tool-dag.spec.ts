import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DagService } from '@deepseek-ai/dsh-dag'
import { DagNodeId, DagOperationId } from '@deepseek-ai/dsh-dag'
import type { DagNodeSnapshot, DagProjection } from '@deepseek-ai/dsh-dag'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'
import { childBlockTool, childCompleteTool, childStatusTool, DISPATCHER_TOOLS } from '../src/index.ts'

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
    openWaves: [],
  }
}

function inspected(): DagNodeSnapshot {
  return {
    id: DagNodeId('a'), content: 'Implement a', brief: 'VALIDATION: test.\nACCEPTANCE: commit.', deps: [], kind: 'task',
    policy: 'delegate', files: ['src/a.ts'], status: 'in_progress', generation: 1, bindingGeneration: 1,
    childSessionId: SessionId('child-a'), branch: 'dsh/dag/test/g1/a', worktree: '/tmp/dag/a', frozenWaveBase: '1'.repeat(40),
    preparedHead: '1'.repeat(40), dependencyCommits: [], conflictedFiles: [], currentOperationId: DagOperationId('op-2'), commands: [],
  }
}

function fakeDag() {
  const calls: { name: string; args: unknown[] }[] = []
  const accepted = { accepted: true as const, revision: 5, operationId: DagOperationId('op-5') }
  const record = (name: string, value: unknown) => (...args: unknown[]) => {
    calls.push({ name, args })
    return value
  }
  const service = {
    write: record('write', {
      ...accepted,
      dropped: [{ id: DagNodeId('old'), childSessionId: SessionId('child-old'), branch: 'old-branch', worktree: '/tmp/old' }],
      conflicts: [{ ids: [DagNodeId('a'), DagNodeId('b')], files: ['src/shared.ts'], reason: 'declared-files-overlap' }],
    }),
    dispatch: record('dispatch', accepted),
    wait: record('wait', Promise.resolve({ revision: 5, notices: [], state: projection() })),
    status: record('status', projection()),
    inspect: record('inspect', inspected()),
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

async function dispatcherBench() {
  const ctx = new Context()
  contexts.push(ctx)
  const dag = fakeDag()
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
      dropped: [{ id: 'old', childSessionId: 'child-old', branch: 'old-branch', worktree: '/tmp/old' }],
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
      bindingGeneration: 1,
    })
  })

  it('unregisters tools and prompt text when its plugin fiber unloads', async () => {
    const { ctx, fiber } = await dispatcherBench()
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => DISPATCHER_TOOLS.includes(schema.name as typeof DISPATCHER_TOOLS[number]))).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(row => row.name === 'dag:dispatcher')).toBe(false)
  })
})

describe('owner-bound child tools', () => {
  it('gets status and reports completion or block through the child identity only', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const dag = fakeDag()
    ctx.provide('dag', dag.service)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime).await()
    ctx.tools.register(childStatusTool(ctx))
    ctx.tools.register(childCompleteTool(ctx))
    ctx.tools.register(childBlockTool(ctx))
    const child = owner('child-a')

    const status = await execute(ctx, 'dag_status', {}, child)
    const complete = await execute(ctx, 'dag_node_complete', {
      summary: 'Committed work.',
      artifacts: [{ kind: 'commit', value: 'abc123' }],
    }, child)
    const block = await execute(ctx, 'dag_node_block', { reason: 'Need a decision.' }, child)

    expect(status.isError).toBe(false)
    expect(complete.isError).toBe(false)
    expect(block.isError).toBe(false)
    expect(complete).toMatchObject({ concludesTurn: true })
    expect(block).toMatchObject({ concludesTurn: true })
    expect(dag.calls.map(call => call.name)).toEqual(['statusFrom', 'completeFrom', 'blockFrom'])
    expect(dag.calls.every(call => call.args[0] === child)).toBe(true)
  })

  it('has no dispatcher control tool in its scoped set', () => {
    expect(DISPATCHER_TOOLS).not.toContain('dag_node_complete')
    expect(DISPATCHER_TOOLS).not.toContain('dag_node_block')
  })
})
