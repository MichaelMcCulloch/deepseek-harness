import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DagNodeId } from '../src/ids.ts'
import { validateDagState } from '../src/invariant.ts'
import { reduceDagState } from '../src/reducer.ts'
import type { DagReducerCommand } from '../src/reducer.ts'
import type { DagState } from '../src/types.ts'
import { validateDagDeclaration } from '../src/validation.ts'

function declaration(): DagReducerCommand {
  const declared = validateDagDeclaration([{
    id: 'a',
    content: 'Implement a',
    brief: 'VALIDATION: run the focused test.\nACCEPTANCE: commit clean work.',
    deps: [],
    status: 'pending',
    files: ['owned.txt'],
  }])
  return {
    type: 'write',
    noticeNamespace: 'invariant-dispatcher',
    nodes: declared.definitions.map(definition => ({ definition, status: 'pending' })),
    topologicalOrder: declared.topologicalOrder,
  }
}

function failedProbe(): DagState {
  const declared = reduceDagState(null, declaration()).state
  const dispatched = reduceDagState(declared, {
    type: 'dispatch',
    nodeIds: [DagNodeId('a')],
    bindings: {
      a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' },
    },
  }).state
  const node = dispatched.nodes[0]!
  const command = node.commands[0]!
  return reduceDagState(dispatched, {
    type: 'wave-probe-failed',
    waveId: node.waveId!,
    fences: [{
      nodeId: node.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    }],
    reason: 'probe failed',
  }).state
}

describe('durable DAG stream invariant', () => {
  it('rejects a generation change without its invalidating operation receipt', () => {
    const previous = reduceDagState(null, declaration()).state
    const node = previous.nodes[0]!
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      nodes: [{ ...node, generation: node.generation + 1, bindingGeneration: node.bindingGeneration + 1 }],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/generation does not match its accepted operation/)
  })

  it('rejects failed to pending without redispatch', () => {
    const previous = failedProbe()
    const node = previous.nodes[0]!
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      nodes: [{ ...node, status: 'pending' }],
      counts: { ...previous.counts, pending: 1, failed: 0 },
      readyNodeIds: [node.id],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/without an accepted operation/)
  })

  it('rejects mutation of settled mailbox history', () => {
    const previous = failedProbe()
    const node = previous.nodes[0]!
    const command = node.commands[0]!
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      nodes: [{
        ...node,
        commands: [{ ...command, outcome: 'succeeded' }],
      }],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/changed a settled command/)
  })

  it('rejects mutation of an accepted operation receipt', () => {
    const previous = reduceDagState(null, declaration()).state
    const receipt = previous.receipts[0]!
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      receipts: [{ ...receipt, cause: 'reset' }],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/operation receipt.*changed/)
  })

  it('rejects more than one accepted operation in one snapshot', () => {
    const previous = reduceDagState(null, declaration()).state
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      operationCounter: previous.operationCounter + 2,
      receipts: [
        ...previous.receipts,
        { id: 'op-2' as DagState['receipts'][number]['id'], cause: 'reset', acceptedRevision: 2, nodeIds: [DagNodeId('a')] },
        { id: 'op-3' as DagState['receipts'][number]['id'], cause: 'reset', acceptedRevision: 2, nodeIds: [DagNodeId('a')] },
      ],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/at most one operation/)
  })

  it('rejects a node or topology change without a write operation', () => {
    const previous = reduceDagState(null, declaration()).state
    const node = previous.nodes[0]!
    const injected = { ...node, id: DagNodeId('injected'), content: 'Injected' }
    const candidate: DagState = {
      ...previous,
      revision: previous.revision + 1,
      nodes: [node, injected],
      topologicalOrder: [node.id, injected.id],
      counts: { ...previous.counts, pending: 2 },
      readyNodeIds: [node.id, injected.id],
    }

    expect(() => { validateDagState(previous, candidate) }).toThrow(/appeared without a write operation/)
  })
})
