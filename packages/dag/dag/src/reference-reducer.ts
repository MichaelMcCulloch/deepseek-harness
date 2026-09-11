/** Independent abstract reference reducer for native DAG model checking. */

import type { DagReducerCommand } from './reducer.ts'
import type { DagCommandId, DagNodeId, DagNodeStatus, DagOperationId } from './types.ts'

/** Reference node facts needed to prove state-machine behavior. */
export interface DagReferenceNode {
  readonly id: DagNodeId
  readonly deps: readonly DagNodeId[]
  readonly status: DagNodeStatus
  readonly generation: number
  readonly bindingGeneration: number
  readonly operationId?: DagOperationId
  readonly commandId?: DagCommandId
  readonly commandState?: 'accepted' | 'running' | 'settled'
  readonly completedCommit?: string
}

/** Small independent model of externally visible scheduler state. */
export interface DagReferenceState {
  readonly revision: number
  readonly graphGeneration: number
  readonly operationCounter: number
  readonly nodes: readonly DagReferenceNode[]
}

/** Return a node from the abstract model. */
function nodeOf(state: DagReferenceState, id: DagNodeId): DagReferenceNode {
  const node = state.nodes.find(row => row.id === id)
  if (node === undefined) throw new Error(`unknown node ${id}`)
  return node
}

/** Replace one node in the abstract model. */
function replace(state: DagReferenceState, node: DagReferenceNode): DagReferenceState {
  return { ...state, revision: state.revision + 1, nodes: state.nodes.map(row => row.id === node.id ? node : row) }
}

/** Remove current-operation fields without writing undefined into JSON-like records. */
function clearOperation(node: DagReferenceNode): DagReferenceNode {
  const { operationId: _operationId, commandId: _commandId, commandState: _commandState, ...retained } = node
  return retained
}

/** Accept one public node operation and assign its deterministic ids. */
function accept(
  state: DagReferenceState,
  node: DagReferenceNode,
  cause: string,
  status: DagNodeStatus,
  incrementGeneration = true,
): DagReferenceState {
  const counter = state.operationCounter + 1
  const generation = node.generation + (incrementGeneration ? 1 : 0)
  const operationId = `op-${counter}` as DagOperationId
  const commandId = `${operationId}-${node.id}-g${generation}-${cause}` as DagCommandId
  return {
    ...state,
    revision: state.revision + 1,
    operationCounter: counter,
    nodes: state.nodes.map(row => row.id === node.id
      ? {
        ...node,
        status,
        generation,
        bindingGeneration: node.bindingGeneration + (incrementGeneration ? 1 : 0),
        operationId,
        commandId,
        commandState: 'accepted',
      }
      : row),
  }
}

/**
 * Apply one command without sharing production transition code.
 * @param current - Current reference state, or null before declaration.
 * @param command - Command also applied to the production reducer.
 * @returns Next reference state.
 */
export function referenceReduceDagState(current: DagReferenceState | null, command: DagReducerCommand): DagReferenceState {
  if (command.type === 'write') {
    const counter = (current?.operationCounter ?? 0) + 1
    const old = new Map(current?.nodes.map(node => [node.id, node]) ?? [])
    return {
      revision: (current?.revision ?? 0) + 1,
      graphGeneration: (current?.graphGeneration ?? 0) + 1,
      operationCounter: counter,
      nodes: command.nodes.map(({ definition, status }) => {
        const prior = old.get(definition.id)
        return prior === undefined
          ? {
            id: definition.id,
            deps: definition.deps,
            status,
            generation: 0,
            bindingGeneration: 0,
          }
          : { ...prior, deps: definition.deps }
      }),
    }
  }
  if (current === null) throw new Error('DAG is not declared')
  if (command.type === 'dispatch') {
    let state = { ...current, revision: current.revision + 1, operationCounter: current.operationCounter + 1 }
    const operationId = `op-${state.operationCounter}` as DagOperationId
    state = {
      ...state,
      nodes: state.nodes.map((node) => {
        if (!command.nodeIds.includes(node.id)) return node
        const generation = node.generation + 1
        return {
          ...node,
          status: 'starting' as const,
          generation,
          bindingGeneration: node.bindingGeneration + 1,
          operationId,
          commandId: `${operationId}-${node.id}-g${generation}-dispatch` as DagCommandId,
          commandState: 'accepted' as const,
        }
      }),
    }
    return state
  }
  if (command.type === 'wave-probed') {
    const matched = command.fences.some((fence) => {
      const node = current.nodes.find(row => row.id === fence.nodeId)
      return node?.status === 'starting'
        && node.generation === fence.generation
        && node.bindingGeneration === fence.bindingGeneration
        && node.operationId === fence.operationId
        && node.commandId === fence.commandId
        && node.commandState !== 'settled'
    })
    return matched ? { ...current, revision: current.revision + 1 } : current
  }
  if (command.type === 'wave-probe-failed') {
    const nodes = current.nodes.map((node) => {
      const fence = command.fences.find(row => row.nodeId === node.id)
      const matched = fence !== undefined
        && node.status === 'starting'
        && node.generation === fence.generation
        && node.bindingGeneration === fence.bindingGeneration
        && node.operationId === fence.operationId
        && node.commandId === fence.commandId
        && node.commandState !== 'settled'
      if (!matched) return node
      return { ...clearOperation(node), status: 'failed' as const }
    })
    if (nodes.every((node, index) => node === current.nodes[index])) return current
    return {
      ...current,
      revision: current.revision + 1,
      nodes,
    }
  }
  if (command.type === 'notice-delivered') return { ...current, revision: current.revision + 1 }
  const node = nodeOf(current, command.nodeId)
  if (command.type === 'amend') {
    return {
      ...current,
      revision: current.revision + 1,
      operationCounter: current.operationCounter + 1,
      nodes: current.nodes.map(row => row.id === node.id ? { ...row, deps: command.definition.deps } : row),
    }
  }
  if (command.type === 'redispatch') {
    return {
      ...current,
      revision: current.revision + 1,
      operationCounter: current.operationCounter + 1,
      nodes: current.nodes.map(row => row.id === node.id
        ? {
          ...clearOperation(node),
          status: 'pending',
          generation: node.generation + 1,
          bindingGeneration: node.bindingGeneration + 1,
        }
        : row),
    }
  }
  if (command.type === 'resume') return accept(current, node, 'resume', 'starting')
  if (command.type === 'steer') return accept(current, node, 'steer', node.status === 'in_progress' ? 'in_progress' : 'starting')
  if (command.type === 'stop') return accept(current, node, 'stop', 'interrupted')
  if (command.type === 'reset') return accept(current, node, 'reset', node.status)
  if (command.type === 'complete') return accept(current, node, 'complete', 'in_progress', false)
  if (command.type === 'block') {
    return {
      ...current,
      revision: current.revision + 1,
      operationCounter: current.operationCounter + 1,
      nodes: current.nodes.map(row => row.id === node.id ? { ...clearOperation(node), status: 'blocked' as const } : row),
    }
  }
  if (command.type === 'child-ended') {
    if (node.generation !== command.generation || node.bindingGeneration !== command.bindingGeneration
      || (node.status !== 'starting' && node.status !== 'in_progress')) return current
    return replace(current, { ...clearOperation(node), status: 'failed' })
  }
  if (node.generation !== command.generation || node.operationId !== command.operationId || node.commandId !== command.commandId || node.commandState === 'settled') return current
  if (command.type === 'command-running') return node.commandState === 'running'
    ? current
    : replace(current, { ...node, commandState: 'running' })
  if (command.type === 'git-prepared') return replace(current, node)
  if (command.type === 'start-succeeded') return replace(current, { ...node, status: 'in_progress', commandState: 'settled' })
  if (command.type === 'completion-succeeded') return replace(current, { ...clearOperation(node), status: 'completed', completedCommit: command.evidence.commit })
  if (command.type === 'command-failed') return replace(current, { ...clearOperation(node), status: node.status === 'interrupted' ? 'interrupted' : 'failed' })
  const kind = command.commandId.split('-').at(-1)
  if (kind !== 'stop' && kind !== 'reset') return current
  return replace(current, clearOperation(node))
}

/**
 * Project a production state into the independent oracle vocabulary.
 * @param state - Production state to compare.
 * @returns Equivalent reference state.
 */
export function abstractDagState(state: import('./types.ts').DagState): DagReferenceState {
  return {
    revision: state.revision,
    graphGeneration: state.graphGeneration,
    operationCounter: state.operationCounter,
    nodes: state.nodes.map((node) => {
      const command = node.currentOperationId === undefined
        ? undefined
        : [...node.commands].reverse().find(row => row.operationId === node.currentOperationId)
      return {
        id: node.id,
        deps: node.deps,
        status: node.status,
        generation: node.generation,
        bindingGeneration: node.bindingGeneration,
        ...node.currentOperationId === undefined ? {} : { operationId: node.currentOperationId },
        ...command === undefined ? {} : { commandId: command.id, commandState: command.state },
        ...node.completedCommit === undefined ? {} : { completedCommit: node.completedCommit },
      }
    }),
  }
}
