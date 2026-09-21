import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DagNodeId } from '../src/ids.ts'
import { reduceDagState } from '../src/reducer.ts'
import type { DagReducerCommand } from '../src/reducer.ts'
import { abstractDagState, referenceReduceDagState } from '../src/reference-reducer.ts'
import { validateDagDeclaration } from '../src/validation.ts'
import type { DagNodeInput, DagState } from '../src/types.ts'

const brief = 'Implement the node.\nVALIDATION: run the focused test.\nACCEPTANCE: commit clean work.'

const input = (id: string, deps: string[] = [], kind: 'task' | 'integration' = 'task'): DagNodeInput => ({
  id,
  content: `Do ${id}`,
  brief,
  deps,
  status: 'pending',
  kind,
  ...kind === 'integration' ? { policy: 'delegate' as const } : {},
  files: [`src/${id}.ts`],
})

function write(nodes: DagNodeInput[]): DagReducerCommand {
  const declaration = validateDagDeclaration(nodes)
  return {
    type: 'write',
    noticeNamespace: 'test-dispatcher',
    nodes: declaration.definitions.map(definition => ({ definition, status: 'pending' })),
    topologicalOrder: declaration.topologicalOrder,
  }
}

function step(state: DagState | null, command: DagReducerCommand): DagState {
  return reduceDagState(state, command).state
}

describe('native DAG reducer', () => {
  it('builds stable topology for roots, fan-out, fan-in, integration, and tail nodes', () => {
    const state = step(null, write([
      input('a'), input('b'), input('c', ['a']), input('d', ['a']),
      input('e', ['c', 'd', 'b'], 'integration'), input('f', ['e']),
    ]))
    expect(state.topologicalOrder).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(state.readyNodeIds).toEqual(['a', 'b'])
    expect(state.counts.pending).toBe(6)
  })

  it('matches the independent reference reducer across start, stop, stale completion, redispatch, and completion', () => {
    let production: DagState | null = null
    let reference: import('../src/reference-reducer.ts').DagReferenceState | null = null
    const commands: DagReducerCommand[] = [
      write([input('a')]),
      { type: 'dispatch', nodeIds: [DagNodeId('a')], bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } } },
    ]
    for (const command of commands) {
      production = step(production, command)
      reference = referenceReduceDagState(reference, command)
      expect(abstractDagState(production)).toEqual(reference)
    }
    if (production === null) throw new Error('model state is missing')
    const node = production.nodes[0]!
    const mailbox = node.commands[0]!
    const running: DagReducerCommand = { type: 'command-running', nodeId: node.id, commandId: mailbox.id, generation: node.generation, bindingGeneration: mailbox.bindingGeneration, operationId: mailbox.operationId }
    production = step(production, running)
    reference = referenceReduceDagState(reference, running)
    expect(abstractDagState(production)).toEqual(reference)

    const stopped = reduceDagState(production, { type: 'stop', nodeId: node.id, reason: 'user stop' })
    production = stopped.state
    reference = referenceReduceDagState(reference, { type: 'stop', nodeId: node.id, reason: 'user stop' })
    expect(production.nodes[0]?.status).toBe('interrupted')
    expect(production.nodes[0]?.commands).toMatchObject([
      { id: mailbox.id, state: 'settled', outcome: 'cancelled' },
      { kind: 'stop', state: 'accepted' },
    ])
    expect(production.activeCommandIds).toEqual([production.nodes[0]?.commands[1]?.id])
    expect(abstractDagState(production)).toEqual(reference)

    const stale = step(production, {
      type: 'start-succeeded', nodeId: node.id, commandId: mailbox.id, generation: node.generation, bindingGeneration: mailbox.bindingGeneration, operationId: mailbox.operationId,
      evidence: { branch: 'old', worktree: '/old', frozenWaveBase: '0'.repeat(40), preparedFrom: '0'.repeat(40), preparedHead: '0'.repeat(40), dependencyCommits: [], conflictedFiles: [], childSessionId: SessionId('child-a') },
    })
    expect(stale).toBe(production)
  })

  it('creates a wave only after a matching fenced root probe succeeds', () => {
    let state = step(null, write([input('a'), input('b')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      bindings: {
        a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' },
        b: { childSessionId: SessionId('child-b'), branch: 'branch-b', worktree: '/tmp/b' },
      },
    })
    expect(state.waves).toEqual([])
    const first = state.nodes[0]!
    const second = state.nodes[1]!
    const firstCommand = first.commands[0]!
    const secondCommand = second.commands[0]!
    if (first.waveId === undefined || second.waveId !== first.waveId) throw new Error('dispatch did not reserve one wave id')
    const fences = [firstCommand, secondCommand].map((command, index) => ({
      nodeId: state.nodes[index]!.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    }))
    const stale = step(state, {
      type: 'wave-probed',
      waveId: first.waveId,
      fences: fences.map(row => ({ ...row, bindingGeneration: row.bindingGeneration + 1 })),
      branch: 'main',
      head: '1'.repeat(40),
    })
    expect(stale).toBe(state)
    state = step(state, { type: 'wave-probed', waveId: first.waveId, fences, branch: 'main', head: '1'.repeat(40) })
    expect(state.waves).toEqual([expect.objectContaining({
      id: first.waveId,
      status: 'open',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      rootBranch: 'main',
      rootHead: '1'.repeat(40),
    })])
  })

  it('applies a failed probe only to dispatch commands whose full fences still match', () => {
    let state = step(null, write([input('a'), input('b')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      bindings: {
        a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' },
        b: { childSessionId: SessionId('child-b'), branch: 'branch-b', worktree: '/tmp/b' },
      },
    })
    const first = state.nodes[0]!
    const second = state.nodes[1]!
    const firstCommand = first.commands[0]!
    const secondCommand = second.commands[0]!
    if (first.waveId === undefined) throw new Error('dispatch did not reserve a wave id')
    state = step(state, { type: 'stop', nodeId: first.id, reason: 'stop one root' })
    state = step(state, {
      type: 'wave-probe-failed',
      waveId: first.waveId,
      fences: [
        {
          nodeId: first.id,
          commandId: firstCommand.id,
          generation: firstCommand.generation,
          bindingGeneration: firstCommand.bindingGeneration,
          operationId: firstCommand.operationId,
        },
        {
          nodeId: second.id,
          commandId: secondCommand.id,
          generation: secondCommand.generation,
          bindingGeneration: secondCommand.bindingGeneration,
          operationId: secondCommand.operationId,
        },
      ],
      reason: 'root is dirty',
    })
    expect(state.nodes.map(row => row.status)).toEqual(['interrupted', 'failed'])
    expect(state.waves).toEqual([])
    expect(state.activeCommandIds).toEqual([state.nodes[0]?.commands.at(-1)?.id])
  })

  it('settles an already-created wave when the probe persistence barrier fails', () => {
    let state = step(null, write([input('a'), input('b')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      bindings: {
        a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' },
        b: { childSessionId: SessionId('child-b'), branch: 'branch-b', worktree: '/tmp/b' },
      },
    })
    const waveId = state.nodes[0]!.waveId!
    const fences = state.nodes.map(node => ({
      nodeId: node.id,
      commandId: node.commands[0]!.id,
      generation: node.generation,
      bindingGeneration: node.bindingGeneration,
      operationId: node.commands[0]!.operationId,
    }))
    state = step(state, { type: 'wave-probed', waveId, fences, branch: 'main', head: '1'.repeat(40) })

    state = step(state, {
      type: 'wave-probe-failed',
      waveId,
      fences,
      reason: 'the wave snapshot did not flush',
    })

    expect(state.nodes.map(node => node.status)).toEqual(['failed', 'failed'])
    expect(state.waves[0]).toMatchObject({
      id: waveId,
      status: 'settled',
      pendingNodeIds: [],
      failedNodeIds: ['a', 'b'],
    })
    expect(state.notices.filter(notice => notice.kind === 'wave-settled')).toHaveLength(1)
  })

  it('requires Git evidence before completion becomes terminal', () => {
    let state = step(null, write([input('a')]))
    state = step(state, { type: 'dispatch', nodeIds: [DagNodeId('a')], bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } } })
    let node = state.nodes[0]!
    let command = node.commands[0]!
    state = step(state, {
      type: 'wave-probed', waveId: node.waveId!,
      fences: [{
        nodeId: node.id,
        commandId: command.id,
        generation: command.generation,
        bindingGeneration: command.bindingGeneration,
        operationId: command.operationId,
      }],
      branch: 'main', head: '1'.repeat(40),
    })
    node = state.nodes[0]!
    command = node.commands[0]!
    const evidence = { branch: 'branch-a', worktree: '/tmp/a', frozenWaveBase: '1'.repeat(40), preparedFrom: '1'.repeat(40), preparedHead: '1'.repeat(40), dependencyCommits: [], conflictedFiles: [], childSessionId: SessionId('child-a') }
    state = step(state, {
      type: 'git-prepared', nodeId: node.id, commandId: command.id, generation: node.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId,
      evidence,
    })
    state = step(state, {
      type: 'start-succeeded', nodeId: node.id, commandId: command.id, generation: node.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId,
      evidence,
    })
    const accepted = reduceDagState(state, { type: 'complete', nodeId: node.id, summary: 'done', artifacts: [] })
    state = accepted.state
    expect(state.nodes[0]?.status).toBe('in_progress')
    const completeCommand = state.nodes[0]!.commands.at(-1)!
    state = step(state, {
      type: 'completion-succeeded', nodeId: node.id, commandId: completeCommand.id,
      generation: completeCommand.generation,
      bindingGeneration: completeCommand.bindingGeneration,
      operationId: completeCommand.operationId,
      evidence: { commit: '2'.repeat(40) },
    })
    expect(state.nodes[0]?.status).toBe('completed')
    expect(state.nodes[0]?.completedCommit).toBe('2'.repeat(40))
  })

  it('keeps a failed node failed through reset until redispatch rearms it', () => {
    let state = step(null, write([input('a')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
    })
    const dispatch = state.nodes[0]!.commands[0]!
    state = step(state, {
      type: 'command-failed',
      nodeId: DagNodeId('a'),
      commandId: dispatch.id,
      generation: dispatch.generation,
      bindingGeneration: dispatch.bindingGeneration,
      operationId: dispatch.operationId,
      reason: 'preparation failed',
    })
    state = step(state, { type: 'reset', nodeId: DagNodeId('a'), target: '1'.repeat(40) })

    expect(state.nodes[0]?.status).toBe('failed')
    expect(state.nodes[0]?.settlement).toEqual({ kind: 'failed', reason: 'preparation failed' })

    state = step(state, { type: 'redispatch', nodeId: DagNodeId('a') })
    expect(state.nodes[0]?.status).toBe('pending')
  })

  it('clears old wave preparation before a redispatched node starts a new wave', () => {
    let state = step(null, write([input('a')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
    })
    const first = state.nodes[0]!
    const firstCommand = first.commands.at(-1)!
    state = step(state, {
      type: 'wave-probed',
      waveId: first.waveId!,
      fences: [{
        nodeId: first.id,
        commandId: firstCommand.id,
        generation: firstCommand.generation,
        bindingGeneration: firstCommand.bindingGeneration,
        operationId: firstCommand.operationId,
      }],
      branch: 'main',
      head: '1'.repeat(40),
    })
    const prepared = state.nodes[0]!
    const preparedCommand = prepared.commands.at(-1)!
    state = step(state, {
      type: 'git-prepared',
      nodeId: prepared.id,
      commandId: preparedCommand.id,
      generation: preparedCommand.generation,
      bindingGeneration: preparedCommand.bindingGeneration,
      operationId: preparedCommand.operationId,
      evidence: {
        branch: 'branch-a',
        worktree: '/tmp/a',
        frozenWaveBase: '1'.repeat(40),
        preparedFrom: '1'.repeat(40),
        preparedHead: '1'.repeat(40),
        dependencyCommits: [],
        conflictedFiles: [],
        childSessionId: SessionId('child-a'),
      },
    })
    state = step(state, {
      type: 'command-failed',
      nodeId: prepared.id,
      commandId: preparedCommand.id,
      generation: preparedCommand.generation,
      bindingGeneration: preparedCommand.bindingGeneration,
      operationId: preparedCommand.operationId,
      reason: 'child failed',
    })
    state = step(state, { type: 'redispatch', nodeId: DagNodeId('a') })
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
    })

    expect(state.nodes[0]).toMatchObject({ status: 'starting', dependencyCommits: [], conflictedFiles: [] })
    expect(state.nodes[0]?.frozenWaveBase).toBeUndefined()
    expect(state.nodes[0]?.preparedHead).toBeUndefined()
  })

  it.each(['main', 'HEAD', 'origin/main', 'refs/remotes/origin/main', 'refs/heads/bad..name'])(
    'rejects ambiguous or remote reset target %s before command acceptance',
    (target) => {
      const state = step(null, write([input('a')]))
      expect(() => reduceDagState(state, { type: 'reset', nodeId: DagNodeId('a'), target }))
        .toThrow(expect.objectContaining({ code: 'dag-invalid-reset-target' }))
    },
  )

  it('never moves a settled wave slot after a node is redispatched', () => {
    let state = step(null, write([input('a'), input('b')]))
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      bindings: {
        a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' },
        b: { childSessionId: SessionId('child-b'), branch: 'branch-b', worktree: '/tmp/b' },
      },
    })
    const firstWave = state.nodes[0]!.waveId!
    const firstFences = state.nodes.map(node => ({
      nodeId: node.id,
      commandId: node.commands.at(-1)!.id,
      generation: node.generation,
      bindingGeneration: node.bindingGeneration,
      operationId: node.currentOperationId!,
    }))
    state = step(state, { type: 'wave-probed', waveId: firstWave, fences: firstFences, branch: 'main', head: '1'.repeat(40) })
    const failedCommand = state.nodes[0]!.commands.at(-1)!
    state = step(state, {
      type: 'command-failed',
      nodeId: DagNodeId('a'),
      commandId: failedCommand.id,
      generation: failedCommand.generation,
      bindingGeneration: failedCommand.bindingGeneration,
      operationId: failedCommand.operationId,
      reason: 'first attempt failed',
    })
    expect(state.waves[0]).toMatchObject({ pendingNodeIds: ['b'], failedNodeIds: ['a'] })

    state = step(state, { type: 'redispatch', nodeId: DagNodeId('a') })
    state = step(state, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
    })
    const retried = state.nodes[0]!
    const retryCommand = retried.commands.at(-1)!
    state = step(state, {
      type: 'wave-probed',
      waveId: retried.waveId!,
      fences: [{
        nodeId: retried.id,
        commandId: retryCommand.id,
        generation: retryCommand.generation,
        bindingGeneration: retryCommand.bindingGeneration,
        operationId: retryCommand.operationId,
      }],
      branch: 'main',
      head: '1'.repeat(40),
    })
    state = step(state, {
      type: 'git-prepared',
      nodeId: retried.id,
      commandId: retryCommand.id,
      generation: retryCommand.generation,
      bindingGeneration: retryCommand.bindingGeneration,
      operationId: retryCommand.operationId,
      evidence: {
        branch: 'branch-a', worktree: '/tmp/a', frozenWaveBase: '1'.repeat(40), preparedFrom: '1'.repeat(40), preparedHead: '1'.repeat(40),
        dependencyCommits: [], conflictedFiles: [], childSessionId: SessionId('child-a'),
      },
    })
    state = step(state, {
      type: 'start-succeeded',
      nodeId: retried.id,
      commandId: retryCommand.id,
      generation: retryCommand.generation,
      bindingGeneration: retryCommand.bindingGeneration,
      operationId: retryCommand.operationId,
      evidence: {
        branch: 'branch-a', worktree: '/tmp/a', frozenWaveBase: '1'.repeat(40), preparedFrom: '1'.repeat(40), preparedHead: '1'.repeat(40),
        dependencyCommits: [], conflictedFiles: [], childSessionId: SessionId('child-a'),
      },
    })
    state = step(state, { type: 'complete', nodeId: retried.id, summary: 'done', artifacts: [] })
    const completion = state.nodes[0]!.commands.at(-1)!
    state = step(state, {
      type: 'completion-succeeded',
      nodeId: retried.id,
      commandId: completion.id,
      generation: completion.generation,
      bindingGeneration: completion.bindingGeneration,
      operationId: completion.operationId,
      evidence: { commit: '2'.repeat(40) },
    })

    expect(state.waves.find(wave => wave.id === firstWave)).toMatchObject({
      status: 'open', pendingNodeIds: ['b'], completedNodeIds: [], failedNodeIds: ['a'],
    })
  })
})
