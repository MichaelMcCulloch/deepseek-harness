import { describe, expect, it } from 'vitest'
import {
  DagCommandId,
  DagNodeId,
  DagNoticeId,
  DagOperationId,
  DagWaveId,
} from '../src/ids.ts'
import type { DagReducerCommand } from '../src/reducer.ts'
import {
  abstractDagState,
  referenceReduceDagState,
} from '../src/reference-reducer.ts'
import type {
  DagReferenceNode,
  DagReferenceState,
} from '../src/reference-reducer.ts'
import { DAG_STATE_VERSION } from '../src/types.ts'
import type { DagNodeSnapshot, DagState, DagStatusCounts } from '../src/types.ts'

const brief = 'VALIDATION: run tests.\nACCEPTANCE: commit clean work.'

function referenceNode(overrides: Partial<DagReferenceNode> = {}): DagReferenceNode {
  return {
    id: DagNodeId('a'),
    deps: [],
    status: 'pending',
    generation: 0,
    bindingGeneration: 0,
    ...overrides,
  }
}

function referenceState(
  nodes: readonly DagReferenceNode[] = [referenceNode()],
  overrides: Partial<DagReferenceState> = {},
): DagReferenceState {
  return {
    revision: 1,
    graphGeneration: 1,
    operationCounter: 1,
    nodes,
    ...overrides,
  }
}

function activeReference(
  kind = 'dispatch',
  overrides: Partial<DagReferenceNode> = {},
): DagReferenceNode {
  return referenceNode({
    status: 'starting',
    generation: 1,
    bindingGeneration: 1,
    operationId: DagOperationId('op-1'),
    commandId: DagCommandId(`op-1-a-g1-${kind}`),
    commandState: 'accepted',
    ...overrides,
  })
}

function fence(node: DagReferenceNode) {
  return {
    nodeId: node.id,
    commandId: node.commandId!,
    generation: node.generation,
    bindingGeneration: node.bindingGeneration,
    operationId: node.operationId!,
  }
}

function definition(id: string) {
  return {
    id: DagNodeId(id),
    content: `Do ${id}`,
    brief,
    deps: [],
    kind: 'task' as const,
    policy: 'delegate' as const,
    files: [`src/${id}.ts`],
  }
}

function counts(): DagStatusCounts {
  return {
    pending: 0,
    starting: 0,
    in_progress: 0,
    completed: 1,
    blocked: 0,
    failed: 0,
    interrupted: 0,
  }
}

describe('DAG reference reducer edges', () => {
  it('rejects commands before declaration and unknown node ids', () => {
    expect(() => referenceReduceDagState(null, {
      type: 'notice-delivered',
      noticeId: DagNoticeId('notice'),
    })).toThrow(/not declared/)
    expect(() => referenceReduceDagState(referenceState([]), {
      type: 'block',
      nodeId: DagNodeId('missing'),
      reason: 'blocked',
    })).toThrow(/unknown node/)
  })

  it('rewrites declarations by retaining existing nodes and creating new nodes', () => {
    const existing = referenceNode({ status: 'completed', completedCommit: '1'.repeat(40) })
    const next = referenceReduceDagState(referenceState([existing]), {
      type: 'write',
      noticeNamespace: 'dispatcher',
      nodes: [
        { definition: definition('a'), status: 'pending' },
        { definition: definition('b'), status: 'pending' },
      ],
      topologicalOrder: [DagNodeId('a'), DagNodeId('b')],
    })

    expect(next).toMatchObject({ revision: 2, graphGeneration: 2, operationCounter: 2 })
    expect(next.nodes).toEqual([
      existing,
      expect.objectContaining({ id: 'b', status: 'pending', generation: 0, bindingGeneration: 0 }),
    ])
  })

  it('rewrites one declaration through an amendment without touching scheduler facts', () => {
    const existing = referenceNode({ status: 'failed', generation: 2, bindingGeneration: 2 })
    const other = referenceNode({ id: DagNodeId('b'), deps: [DagNodeId('a')] })
    const next = referenceReduceDagState(referenceState([existing, other]), {
      type: 'amend',
      nodeId: DagNodeId('a'),
      definition: { ...definition('a'), deps: [DagNodeId('b')] },
      topologicalOrder: [DagNodeId('b'), DagNodeId('a')],
    })

    expect(next).toMatchObject({ revision: 2, operationCounter: 2 })
    expect(next.nodes[0]).toMatchObject({ id: 'a', deps: ['b'], status: 'failed', generation: 2 })
    expect(next.nodes[1]).toBe(other)
  })

  it('dispatches selected nodes and preserves other rows', () => {
    const other = referenceNode({ id: DagNodeId('b') })
    const next = referenceReduceDagState(referenceState([referenceNode(), other]), {
      type: 'dispatch',
      nodeIds: [DagNodeId('a')],
      bindings: {},
    })

    expect(next.nodes[0]).toMatchObject({ status: 'starting', generation: 1, commandState: 'accepted' })
    expect(next.nodes[1]).toBe(other)
  })

  it('accepts only matching wave probes and failed-probe fences', () => {
    const active = activeReference()
    const other = referenceNode({ id: DagNodeId('b') })
    const current = referenceState([active, other])
    const exact = fence(active)

    expect(referenceReduceDagState(current, {
      type: 'wave-probed', waveId: DagWaveId('wave'), fences: [{ ...exact, generation: 2 }],
      branch: 'main', head: '1'.repeat(40),
    })).toBe(current)
    expect(referenceReduceDagState(current, {
      type: 'wave-probed', waveId: DagWaveId('wave'), fences: [exact],
      branch: 'main', head: '1'.repeat(40),
    }).revision).toBe(2)

    expect(referenceReduceDagState(current, {
      type: 'wave-probe-failed', waveId: DagWaveId('wave'), fences: [], reason: 'failed',
    })).toBe(current)
    const failed = referenceReduceDagState(current, {
      type: 'wave-probe-failed', waveId: DagWaveId('wave'), fences: [exact], reason: 'failed',
    })
    expect(failed.nodes[0]).toMatchObject({ status: 'failed' })
    expect(failed.nodes[1]).toBe(other)
  })

  it('records notice delivery without node lookup', () => {
    expect(referenceReduceDagState(referenceState(), {
      type: 'notice-delivered', noticeId: DagNoticeId('notice'),
    }).revision).toBe(2)
  })

  it('models every accepted public node operation', () => {
    const other = referenceNode({ id: DagNodeId('b') })
    const failed = referenceNode({ status: 'failed', operationId: DagOperationId('old'), commandId: DagCommandId('old-reset'), commandState: 'running' })
    const redispatched = referenceReduceDagState(referenceState([failed, other]), { type: 'redispatch', nodeId: failed.id })
    expect(redispatched.nodes[0]).toMatchObject({ status: 'pending', generation: 1, bindingGeneration: 1 })
    expect(redispatched.nodes[0]).not.toHaveProperty('operationId')
    expect(redispatched.nodes[1]).toBe(other)

    const blocked = referenceNode({ status: 'blocked' })
    expect(referenceReduceDagState(referenceState([blocked]), {
      type: 'resume', nodeId: blocked.id, message: 'resume',
    }).nodes[0]).toMatchObject({ status: 'starting', generation: 1 })
    expect(referenceReduceDagState(referenceState([blocked]), {
      type: 'steer', nodeId: blocked.id, message: 'redirect',
    }).nodes[0]).toMatchObject({ status: 'starting' })

    const progressing = referenceNode({ status: 'in_progress' })
    expect(referenceReduceDagState(referenceState([progressing]), {
      type: 'steer', nodeId: progressing.id, message: 'redirect',
    }).nodes[0]).toMatchObject({ status: 'in_progress' })
    expect(referenceReduceDagState(referenceState([progressing]), {
      type: 'stop', nodeId: progressing.id, reason: 'stop',
    }).nodes[0]).toMatchObject({ status: 'interrupted' })
    expect(referenceReduceDagState(referenceState([failed]), {
      type: 'reset', nodeId: failed.id, target: '1'.repeat(40),
    }).nodes[0]).toMatchObject({ status: 'failed' })
    expect(referenceReduceDagState(referenceState([progressing]), {
      type: 'complete', nodeId: progressing.id, summary: 'done', artifacts: [],
    }).nodes[0]).toMatchObject({ status: 'in_progress', generation: 0, bindingGeneration: 0 })

    const blockedResult = referenceReduceDagState(referenceState([progressing, other]), {
      type: 'block', nodeId: progressing.id, reason: 'blocked',
    })
    expect(blockedResult.nodes[0]).toMatchObject({ status: 'blocked' })
    expect(blockedResult.nodes[1]).toBe(other)
  })

  it('fences child settlement by generation, binding, and active status', () => {
    const active = activeReference('dispatch', { status: 'in_progress' })
    const command: DagReducerCommand = {
      type: 'child-ended',
      ...fence(active),
      reason: 'missing report',
    }
    expect(referenceReduceDagState(referenceState([active]), { ...command, generation: 2 })).toEqual(referenceState([active]))
    expect(referenceReduceDagState(referenceState([{ ...active, status: 'blocked' }]), command)).toEqual(referenceState([{ ...active, status: 'blocked' }]))
    expect(referenceReduceDagState(referenceState([active]), command).nodes[0]).toMatchObject({ status: 'failed' })
  })

  it('models fenced effect outcomes and terminal command settlement', () => {
    const active = activeReference()
    const current = referenceState([active])
    expect(referenceReduceDagState(current, {
      type: 'command-running', ...fence(active), generation: 2,
    })).toBe(current)

    const running = referenceReduceDagState(current, { type: 'command-running', ...fence(active) })
    expect(running.nodes[0]).toMatchObject({ commandState: 'running' })
    expect(referenceReduceDagState(running, { type: 'command-running', ...fence(running.nodes[0]!) })).toBe(running)
    expect(referenceReduceDagState(current, {
      type: 'git-prepared', ...fence(active),
      evidence: {
        branch: 'branch', worktree: '/tmp/a', frozenWaveBase: '1'.repeat(40),
        preparedFrom: '1'.repeat(40), preparedHead: '2'.repeat(40), dependencyCommits: [], conflictedFiles: [],
        childSessionId: 'child-a' as never,
      },
    }).revision).toBe(2)
    expect(referenceReduceDagState(current, {
      type: 'start-succeeded', ...fence(active),
      evidence: {
        branch: 'branch', worktree: '/tmp/a', frozenWaveBase: '1'.repeat(40),
        preparedFrom: '1'.repeat(40), preparedHead: '2'.repeat(40), dependencyCommits: [], conflictedFiles: [],
        childSessionId: 'child-a' as never,
      },
    }).nodes[0]).toMatchObject({ status: 'in_progress', commandState: 'settled' })

    const completion = activeReference('complete', { status: 'in_progress' })
    expect(referenceReduceDagState(referenceState([completion]), {
      type: 'completion-succeeded', ...fence(completion), evidence: { commit: '3'.repeat(40) },
    }).nodes[0]).toMatchObject({ status: 'completed', completedCommit: '3'.repeat(40) })

    expect(referenceReduceDagState(referenceState([active]), {
      type: 'command-failed', ...fence(active), reason: 'failed',
    }).nodes[0]).toMatchObject({ status: 'failed' })
    const interrupted = activeReference('stop', { status: 'interrupted' })
    expect(referenceReduceDagState(referenceState([interrupted]), {
      type: 'command-failed', ...fence(interrupted), reason: 'cancelled',
    }).nodes[0]).toMatchObject({ status: 'interrupted' })

    expect(referenceReduceDagState(current, {
      type: 'command-settled', ...fence(active),
    })).toBe(current)
    for (const kind of ['stop', 'reset']) {
      const settling = activeReference(kind)
      expect(referenceReduceDagState(referenceState([settling]), {
        type: 'command-settled', ...fence(settling),
      }).nodes[0]).not.toHaveProperty('operationId')
    }
  })

  it('abstracts active, missing, and completed optional execution facts', () => {
    const operationId = DagOperationId('op-1')
    const commandId = DagCommandId('op-1-a-g1-complete')
    const full: DagNodeSnapshot = {
      ...definition('a'),
      status: 'completed',
      generation: 1,
      bindingGeneration: 1,
      dependencyCommits: [],
      conflictedFiles: [],
      currentOperationId: operationId,
      completedCommit: '4'.repeat(40),
      commands: [{
        id: commandId,
        operationId,
        kind: 'complete',
        state: 'settled',
        generation: 1,
        bindingGeneration: 1,
        acceptedRevision: 1,
        outcome: 'succeeded',
      }],
    }
    const missingCommand: DagNodeSnapshot = {
      ...definition('b'),
      status: 'pending',
      generation: 0,
      bindingGeneration: 0,
      dependencyCommits: [],
      conflictedFiles: [],
      currentOperationId: DagOperationId('missing'),
      commands: [],
    }
    const minimal: DagNodeSnapshot = {
      ...definition('c'),
      status: 'pending',
      generation: 0,
      bindingGeneration: 0,
      dependencyCommits: [],
      conflictedFiles: [],
      commands: [],
    }
    const production: DagState = {
      version: DAG_STATE_VERSION,
      noticeNamespace: 'dispatcher',
      revision: 3,
      graphGeneration: 1,
      operationCounter: 1,
      nodes: [full, missingCommand, minimal],
      topologicalOrder: [full.id, missingCommand.id, minimal.id],
      readyNodeIds: [missingCommand.id, minimal.id],
      counts: counts(),
      waves: [],
      activeCommandIds: [],
      receipts: [],
      notices: [],
    }

    const rows = abstractDagState(production).nodes
    expect(rows.slice(0, 2)).toEqual([
      expect.objectContaining({ operationId, commandId, commandState: 'settled', completedCommit: '4'.repeat(40) }),
      expect.objectContaining({ operationId: 'missing' }),
    ])
    expect(rows[2]).not.toHaveProperty('operationId')
  })
})
