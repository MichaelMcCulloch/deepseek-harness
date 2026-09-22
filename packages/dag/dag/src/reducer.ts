/** Pure native DAG state transition function. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { DagCommandId, DagNoticeId, DagOperationId, DagWaveId } from './ids.ts'
import { changedDefinitionFields, dependencyOwnershipViolations } from './validation.ts'
import type {
  DagCommandId as CommandId,
  DagIntegrationPolicy,
  DagNodeDefinition,
  DagNodeDefinitionField,
  DagNodeId,
  DagNodeInput,
  DagNodeSnapshot,
  DagNodeStatus,
  DagNotice,
  DagOperationId as OperationId,
  DagOperationReceipt,
  DagState,
  DagWaveSnapshot,
  DagWriteResult,
} from './types.ts'
import { DAG_STATE_VERSION } from './types.ts'

/** Stable command rejection from the pure state machine. */
export class DagStateError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'DagStateError'
  }
}

/** One canonical declaration row passed to the reducer. */
export interface DagDeclaredNode {
  readonly definition: DagNodeDefinition
  readonly status: DagNodeStatus
}

/** Git evidence that makes a starting node runnable. */
export interface DagStartEvidence {
  readonly branch: string
  readonly worktree: string
  readonly frozenWaveBase: string
  readonly preparedFrom: string
  readonly preparedHead: string
  readonly dependencyCommits: readonly string[]
  readonly conflictedFiles: readonly string[]
  readonly childSessionId: SessionId
}

/** Completion evidence read from one local worktree. */
export interface DagCompletionEvidence {
  readonly commit: string
}

/** Deterministic identities committed before one dispatch effect starts. */
export interface DagDispatchBinding {
  readonly childSessionId: SessionId
  readonly branch: string
  readonly worktree: string
}

/** Exact node command identity captured by one asynchronous effect. */
export interface DagEffectFence {
  readonly nodeId: DagNodeId
  readonly commandId: CommandId
  readonly generation: number
  readonly bindingGeneration: number
  readonly operationId: OperationId
}

/** Every state transition accepted by the production reducer. */
export type DagReducerCommand =
  | { readonly type: 'write'; readonly noticeNamespace: string; readonly nodes: readonly DagDeclaredNode[]; readonly topologicalOrder: readonly DagNodeId[] }
  | { readonly type: 'amend'; readonly nodeId: DagNodeId; readonly definition: DagNodeDefinition; readonly topologicalOrder: readonly DagNodeId[] }
  | { readonly type: 'dispatch'; readonly nodeIds: readonly DagNodeId[]; readonly bindings: Readonly<Record<string, DagDispatchBinding>> }
  | { readonly type: 'redispatch'; readonly nodeId: DagNodeId }
  | { readonly type: 'resume'; readonly nodeId: DagNodeId; readonly message: string }
  | { readonly type: 'steer'; readonly nodeId: DagNodeId; readonly message: string }
  | { readonly type: 'stop'; readonly nodeId: DagNodeId; readonly reason: string }
  | { readonly type: 'reset'; readonly nodeId: DagNodeId; readonly target: string }
  | { readonly type: 'block'; readonly nodeId: DagNodeId; readonly reason: string }
  | { readonly type: 'child-ended'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly reason: string }
  | { readonly type: 'complete'; readonly nodeId: DagNodeId; readonly summary: string; readonly artifacts: readonly import('@deepseek-ai/dsh-util-values').JsonValue[] }
  | { readonly type: 'command-running'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId }
  | { readonly type: 'git-prepared'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly evidence: DagStartEvidence }
  | { readonly type: 'start-succeeded'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly evidence: DagStartEvidence }
  | { readonly type: 'completion-succeeded'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly evidence: DagCompletionEvidence }
  | { readonly type: 'command-failed'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly reason: string }
  | { readonly type: 'command-settled'; readonly nodeId: DagNodeId; readonly commandId: CommandId; readonly generation: number; readonly bindingGeneration: number; readonly operationId: OperationId; readonly detail?: string }
  | { readonly type: 'wave-probed'; readonly waveId: import('./types.ts').DagWaveId; readonly fences: readonly DagEffectFence[]; readonly branch: string; readonly head: string }
  | { readonly type: 'wave-probe-failed'; readonly waveId: import('./types.ts').DagWaveId; readonly fences: readonly DagEffectFence[]; readonly reason: string }
  | { readonly type: 'notice-delivered'; readonly noticeId: import('./types.ts').DagNoticeId }

/** Metadata returned beside an accepted state. */
export interface DagReduceResult {
  readonly state: DagState
  readonly operationId?: OperationId
  readonly dropped?: DagWriteResult['dropped']
  readonly amended?: DagWriteResult['amended']
  readonly conflicts?: DagWriteResult['conflicts']
}

const STATUSES: readonly DagNodeStatus[] = [
  'pending',
  'starting',
  'in_progress',
  'completed',
  'blocked',
  'failed',
  'interrupted',
]

/** Return an empty status counter. */
function emptyCounts(): Record<DagNodeStatus, number> {
  return {
    pending: 0,
    starting: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    interrupted: 0,
  }
}

/** Recompute all values derived from the node board. */
function completeState(input: Omit<DagState, 'counts' | 'readyNodeIds' | 'activeCommandIds'>): DagState {
  const counts = emptyCounts()
  const byId = new Map(input.nodes.map(node => [node.id, node]))
  const activeCommandIds: CommandId[] = []
  for (const node of input.nodes) {
    counts[node.status]++
    for (const command of node.commands) {
      if (command.state !== 'settled') activeCommandIds.push(command.id)
    }
  }
  const readyNodeIds = input.topologicalOrder.filter((id) => {
    const node = byId.get(id)
    return node?.status === 'pending' && node.deps.every(dep => byId.get(dep)?.status === 'completed')
  })
  return { ...input, counts: counts, readyNodeIds, activeCommandIds }
}

/** Create a new operation identity and receipt. */
function operation(state: DagState | null, cause: string, nodeIds: readonly DagNodeId[]): {
  readonly counter: number
  readonly id: OperationId
  readonly receipt: DagOperationReceipt
} {
  const counter = (state?.operationCounter ?? 0) + 1
  const id = DagOperationId(`op-${counter}`)
  return {
    counter,
    id,
    receipt: { id, cause, acceptedRevision: (state?.revision ?? 0) + 1, nodeIds: [...nodeIds] },
  }
}

/** Return a node or reject an unknown identifier. */
function requireNode(nodes: readonly DagNodeSnapshot[], nodeId: DagNodeId): DagNodeSnapshot {
  const node = nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new DagStateError(`unknown DAG node ${JSON.stringify(nodeId)}`, 'dag-node-not-found')
  return node
}

/** Replace one node while retaining topological array order. */
function replaceNode(nodes: readonly DagNodeSnapshot[], next: DagNodeSnapshot): readonly DagNodeSnapshot[] {
  return nodes.map(node => node.id === next.id ? next : node)
}

/** Build one accepted mailbox item. */
function mailboxCommand(
  operationId: OperationId,
  nodeId: DagNodeId,
  kind: DagNodeSnapshot['commands'][number]['kind'],
  generation: number,
  bindingGeneration: number,
  revision: number,
  message?: string,
  target?: string,
): DagNodeSnapshot['commands'][number] {
  return {
    id: DagCommandId(`${operationId}-${nodeId}-g${generation}-${kind}`),
    operationId,
    kind,
    state: 'accepted',
    generation,
    bindingGeneration,
    acceptedRevision: revision,
    ...message === undefined ? {} : { message },
    ...target === undefined ? {} : { target },
  }
}

/** Settle commands invalidated by a newer node generation or operation. */
function cancelActiveCommands(
  commands: DagNodeSnapshot['commands'],
  detail: string,
): DagNodeSnapshot['commands'] {
  return commands.map(command => command.state === 'settled'
    ? command
    : { ...command, state: 'settled' as const, outcome: 'cancelled' as const, detail })
}

/** Add a notice once by deterministic identity. */
function addNotice(state: DagState, notice: DagNotice): readonly DagNotice[] {
  return state.notices.some(row => row.id === notice.id) ? state.notices : [...state.notices, notice]
}

/** Create one node or wave notice. */
function notice(
  state: DagState,
  kind: DagNotice['kind'],
  text: string,
  node?: DagNodeSnapshot,
  wave?: DagWaveSnapshot,
): DagNotice {
  let discriminator: string
  if (node !== undefined) discriminator = `n${node.id}-g${node.generation}`
  else {
    /* v8 ignore next -- each notice without a node is owned by a wave. */
    if (wave === undefined) throw new DagStateError('DAG notice lacks an owner', 'dag-invalid-state')
    discriminator = `w${wave.id}`
  }
  return {
    id: DagNoticeId(`${state.noticeNamespace}-g${state.graphGeneration}-${discriminator}-${kind}`),
    kind,
    revision: state.revision + 1,
    graphGeneration: state.graphGeneration,
    ...node === undefined ? {} : { nodeId: node.id },
    ...wave === undefined ? {} : { waveId: wave.id },
    text,
    delivered: false,
  }
}

/** Update a mailbox item only when every fence still matches. */
function fencedCommand(
  node: DagNodeSnapshot,
  commandId: CommandId,
  generation: number,
  bindingGeneration: number,
  operationId: OperationId,
): DagNodeSnapshot['commands'][number] | undefined {
  if (
    node.generation !== generation
    || node.bindingGeneration !== bindingGeneration
    || node.currentOperationId !== operationId
  ) return undefined
  return node.commands.find(command => command.id === commandId
    && command.generation === generation
    && command.bindingGeneration === bindingGeneration
    && command.operationId === operationId
    && command.state !== 'settled')
}

/** Require one effect result to retain the binding and frozen Git inputs it started with. */
function startEvidenceMatches(node: DagNodeSnapshot, evidence: DagStartEvidence, prepared: boolean): boolean {
  return node.branch === evidence.branch
    && node.worktree === evidence.worktree
    && node.childSessionId === evidence.childSessionId
    && node.frozenWaveBase === evidence.frozenWaveBase
    && node.dependencyCommits.length === evidence.dependencyCommits.length
    && node.dependencyCommits.every((commit, index) => commit === evidence.dependencyCommits[index])
    && (!prepared || ((node.preparedFrom ?? node.frozenWaveBase) === evidence.preparedFrom
      && node.preparedHead === evidence.preparedHead
      && node.conflictedFiles.length === evidence.conflictedFiles.length
      && node.conflictedFiles.every((path, index) => path === evidence.conflictedFiles[index])))
}

/** Whether a reset name is one unambiguous local target form. */
function validResetTarget(target: string, frozenWaveBase: string | undefined): boolean {
  if (target === frozenWaveBase || /^[0-9a-f]{40,64}$/iu.test(target)) return true
  if (!target.startsWith('refs/heads/')) return false
  const name = target.slice('refs/heads/'.length)
  return name.length > 0
    && !name.startsWith('/')
    && !name.endsWith('/')
    && !name.endsWith('.')
    && !name.includes('..')
    && !name.includes('//')
    && !name.includes('@{')
    && !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(name)
    && name.split('/').every(component => !component.startsWith('.') && !component.endsWith('.lock'))
}

/** Apply one corrected declaration without touching the node's execution facts. */
function applyDefinition(node: DagNodeSnapshot, definition: DagNodeDefinition): DagNodeSnapshot {
  return {
    ...node,
    id: definition.id,
    content: definition.content,
    brief: definition.brief,
    deps: definition.deps,
    kind: definition.kind,
    policy: definition.policy,
    files: definition.files,
  }
}

/** Return whether one node already recorded local Git evidence derived from its declared dependencies. */
function hasPreparedDependencies(node: DagNodeSnapshot): boolean {
  return node.frozenWaveBase !== undefined
    || node.dependencyCommits.length > 0
    || node.preparedHead !== undefined
    || node.completedCommit !== undefined
}

/**
 * Require that one field correction is legal for the node's live lifecycle state.
 * Active nodes hold a child turn built from the old brief, and a node that already
 * merged dependency commits at preparation time has fixed the commit list a
 * dependency change would invalidate.
 */
function requireAmendable(node: DagNodeSnapshot, fields: readonly DagNodeDefinitionField[]): void {
  if (node.status === 'starting' || node.status === 'in_progress' || node.status === 'blocked') {
    throw new DagStateError(
      `dag cannot change the declaration of ${JSON.stringify(node.id)} while it is ${node.status}; stop it first`,
      'dag-definition-locked',
    )
  }
  if (fields.includes('deps') && hasPreparedDependencies(node)) {
    throw new DagStateError(
      `node ${JSON.stringify(node.id)} cannot change dependencies after it recorded local Git preparation`,
      'dag-dependency-frozen',
    )
  }
}

/**
 * Return declared-file ownership, overlap, and contract-pin rows.
 *
 * A declared-file ownership violation along a dependency edge is reported under
 * its own reason and once: the caller repairing a graph needs to see exactly
 * which edges are still outstanding, not the same pair under two reasons.
 */
function advisoryConflicts(nodes: readonly DagNodeDefinition[]): DagWriteResult['conflicts'] {
  const rows: DagWriteResult['conflicts'][number][] = []
  const ownership = dependencyOwnershipViolations(nodes)
  const violated = new Set(ownership.map(row => conflictKey(row.claimant, row.dependency)))
  const contractPins = (brief: string): readonly string[] => [...brief.matchAll(/^\s*CONTRACT:\s*(.+)$/gim)]
    .map(match => match[0].replace(/^\s*CONTRACT:\s*/iu, '').trim()).filter(value => value.length > 0)
  for (const [left, a] of nodes.entries()) {
    for (const b of nodes.slice(left + 1)) {
      const shared = violated.has(conflictKey(a.id, b.id))
      if (!shared) {
        const files = a.files.filter(value => b.files.includes(value))
        if (files.length > 0) rows.push({ ids: [a.id, b.id], files, reason: 'declared-files-overlap' })
      }
      const pins = contractPins(a.brief).filter(value => contractPins(b.brief).includes(value))
      if (pins.length > 0) rows.push({ ids: [a.id, b.id], files: pins, reason: 'contract-pin-overlap' })
    }
  }
  for (const row of ownership) {
    rows.push({ ids: [row.claimant, row.dependency], files: row.files, reason: 'dependency-file-overlap' })
  }
  return rows
}

/** Return one order-independent identity for a pair of node ids. */
function conflictKey(left: DagNodeId, right: DagNodeId): string {
  return [left, right].sort().join('\u0000')
}

/** Rebuild wave settlement after one node settles. */
function settleWaves(
  state: DagState,
  nodes: readonly DagNodeSnapshot[],
): { waves: readonly DagWaveSnapshot[]; notices: readonly DagNotice[] } {
  let notices = state.notices
  const waves = state.waves.map((wave) => {
    if (wave.status !== 'open') return wave
    const pending = new Set<DagNodeId>()
    const completed = new Set(wave.completedNodeIds)
    const failed = new Set(wave.failedNodeIds)
    for (const id of wave.pendingNodeIds) {
      const status = requireNode(nodes, id).status
      if (status === 'completed') completed.add(id)
      else if (status === 'failed' || status === 'interrupted') failed.add(id)
      else pending.add(id)
    }
    const pendingNodeIds = wave.nodeIds.filter(id => pending.has(id))
    const completedNodeIds = wave.nodeIds.filter(id => completed.has(id))
    const failedNodeIds = wave.nodeIds.filter(id => failed.has(id))
    const next: DagWaveSnapshot = {
      ...wave,
      pendingNodeIds,
      completedNodeIds,
      failedNodeIds,
      status: pendingNodeIds.length === 0 ? 'settled' : 'open',
    }
    if (next.status === 'settled') {
      const candidate = notice(state, 'wave-settled', `DAG wave ${wave.id} settled.`, undefined, next)
      if (!notices.some(row => row.id === candidate.id)) notices = [...notices, candidate]
    }
    return next
  })
  return { waves, notices }
}

/** Replace one node, settle its wave, and append optional accepted-operation facts. */
function transitionNode(
  state: DagState,
  next: DagNodeSnapshot,
  notices: readonly DagNotice[],
  accepted?: ReturnType<typeof operation>,
): DagState {
  const nodes = replaceNode(state.nodes, next)
  const waveResult = settleWaves({ ...state, notices }, nodes)
  const base = {
    ...state,
    revision: state.revision + 1,
    nodes,
    waves: waveResult.waves,
    notices: waveResult.notices,
  }
  return completeState(accepted === undefined
    ? base
    : {
      ...base,
      operationCounter: accepted.counter,
      receipts: [...state.receipts, accepted.receipt],
    })
}

/**
 * Apply one accepted command and return a new complete state value.
 * @param current - Latest durable state, or null before declaration.
 * @param command - Validated state-machine command.
 * @returns Accepted state and optional operation metadata.
 */
export function reduceDagState(current: DagState | null, command: DagReducerCommand): DagReduceResult {
  if (command.type === 'write') {
    if (command.noticeNamespace.trim().length === 0 || (current !== null && command.noticeNamespace !== current.noticeNamespace)) {
      throw new DagStateError('DAG notice namespace must be stable and non-empty', 'dag-invalid-notice-namespace')
    }
    const op = operation(current, 'write', command.nodes.map(row => row.definition.id))
    const previous = new Map(current?.nodes.map(node => [node.id, node]) ?? [])
    const declared = new Set(command.nodes.map(row => row.definition.id))
    const dropped = (current?.nodes ?? []).filter(node => !declared.has(node.id)).map(node => ({
      id: node.id,
      ...node.childSessionId === undefined ? {} : { childSessionId: node.childSessionId },
      ...node.branch === undefined ? {} : { branch: node.branch },
      ...node.worktree === undefined ? {} : { worktree: node.worktree },
    }))
    for (const node of current?.nodes ?? []) {
      if (!declared.has(node.id) && (node.status === 'starting' || node.status === 'in_progress' || node.status === 'blocked')) {
        throw new DagStateError(`dag_write cannot remove active node ${JSON.stringify(node.id)}; stop it first`, 'dag-active-node-removal')
      }
    }
    const amended: DagWriteResult['amended'][number][] = []
    const nodes = command.nodes.map(({ definition, status }) => {
      const old = previous.get(definition.id)
      if (old === undefined) {
        if (status !== 'pending') throw new DagStateError(`new node ${JSON.stringify(definition.id)} must be pending`, 'dag-invalid-new-status')
        return {
          ...definition,
          status,
          generation: 0,
          bindingGeneration: 0,
          dependencyCommits: [],
          conflictedFiles: [],
          commands: [],
        } satisfies DagNodeSnapshot
      }
      if (status !== old.status) {
        throw new DagStateError(`existing node ${JSON.stringify(definition.id)} must repeat live status ${old.status}`, 'dag-status-conflict')
      }
      const fields = changedDefinitionFields(old, definition)
      if (fields.length === 0) return old
      requireAmendable(old, fields)
      amended.push({ id: definition.id, fields })
      return applyDefinition(old, definition)
    })
    const state = completeState({
      version: DAG_STATE_VERSION,
      noticeNamespace: command.noticeNamespace,
      revision: (current?.revision ?? 0) + 1,
      graphGeneration: (current?.graphGeneration ?? 0) + 1,
      operationCounter: op.counter,
      nodes,
      topologicalOrder: command.topologicalOrder,
      waves: (current?.waves ?? []).filter(wave => wave.nodeIds.every(id => declared.has(id))),
      receipts: [...current?.receipts ?? [], op.receipt],
      notices: current?.notices ?? [],
    })
    return { state, operationId: op.id, dropped, amended, conflicts: advisoryConflicts(command.nodes.map(row => row.definition)) }
  }
  if (current === null) throw new DagStateError('DAG has no declaration', 'dag-not-declared')

  if (command.type === 'amend') {
    const node = requireNode(current.nodes, command.nodeId)
    const fields = changedDefinitionFields(node, command.definition)
    if (fields.length === 0) {
      throw new DagStateError(`node ${JSON.stringify(node.id)} already matches the requested declaration`, 'dag-definition-unchanged')
    }
    requireAmendable(node, fields)
    const op = operation(current, 'amend', [node.id])
    return {
      operationId: op.id,
      amended: [{ id: node.id, fields }],
      conflicts: advisoryConflicts(current.nodes.map(row => row.id === node.id ? command.definition : row)),
      state: completeState({
        ...current,
        revision: current.revision + 1,
        operationCounter: op.counter,
        nodes: replaceNode(current.nodes, applyDefinition(node, command.definition)),
        topologicalOrder: command.topologicalOrder,
        receipts: [...current.receipts, op.receipt],
      }),
    }
  }

  if (command.type === 'dispatch') {
    if (command.nodeIds.length === 0 || new Set(command.nodeIds).size !== command.nodeIds.length) {
      throw new DagStateError('dag_dispatch requires distinct node ids', 'dag-invalid-dispatch')
    }
    const byId = new Map(current.nodes.map(node => [node.id, node]))
    for (const nodeId of command.nodeIds) {
      const node = requireNode(current.nodes, nodeId)
      if (node.status !== 'pending') throw new DagStateError(`node ${JSON.stringify(nodeId)} is ${node.status}, not pending`, 'dag-invalid-transition')
      for (const dep of node.deps) {
        if (byId.get(dep)?.status !== 'completed') throw new DagStateError(`node ${JSON.stringify(nodeId)} has incomplete dependency ${JSON.stringify(dep)}`, 'dag-dependency-incomplete')
      }
    }
    const op = operation(current, 'dispatch', command.nodeIds)
    const waveId = DagWaveId(`g${current.graphGeneration}-wave-${op.counter}`)
    const nextNodes = current.nodes.map((node) => {
      if (!command.nodeIds.includes(node.id)) return node
      const generation = node.generation + 1
      const bindingGeneration = node.bindingGeneration + 1
      const mailbox = mailboxCommand(op.id, node.id, 'dispatch', generation, bindingGeneration, current.revision + 1)
      const binding = command.bindings[node.id]
      if (binding === undefined) throw new DagStateError(`dispatch lacks a binding for ${JSON.stringify(node.id)}`, 'dag-invalid-dispatch')
      const {
        settlement: _settlement,
        completedCommit: _completedCommit,
        preparedFrom: _preparedFrom,
        preparedHead: _preparedHead,
        frozenWaveBase: _frozenWaveBase,
        dependencyCommits: _dependencyCommits,
        conflictedFiles: _conflictedFiles,
        currentOperationId: _currentOperationId,
        ...retained
      } = node
      return {
        ...retained,
        status: 'starting' as const,
        generation,
        bindingGeneration,
        waveId,
        childSessionId: binding.childSessionId,
        branch: binding.branch,
        worktree: binding.worktree,
        dependencyCommits: [],
        conflictedFiles: [],
        currentOperationId: op.id,
        commands: [...cancelActiveCommands(node.commands, 'Invalidated by dispatch.'), mailbox],
      }
    })
    return {
      operationId: op.id,
      state: completeState({
        ...current,
        revision: current.revision + 1,
        operationCounter: op.counter,
        nodes: nextNodes,
        waves: current.waves,
        receipts: [...current.receipts, op.receipt],
      }),
    }
  }

  if (command.type === 'wave-probed') {
    if (command.branch.trim().length === 0 || !/^[0-9a-f]{40,64}$/iu.test(command.head)) {
      throw new DagStateError('root probe returned invalid local Git evidence', 'dag-invalid-git-evidence')
    }
    if (current.waves.some(row => row.id === command.waveId)) return { state: current }
    const nodeIds = command.fences.flatMap((fence) => {
      const node = current.nodes.find(row => row.id === fence.nodeId)
      if (node === undefined || node.waveId !== command.waveId || node.status !== 'starting') return []
      const active = fencedCommand(node, fence.commandId, fence.generation, fence.bindingGeneration, fence.operationId)
      return active?.kind === 'dispatch' || active?.kind === 'resume' || active?.kind === 'steer' ? [node.id] : []
    })
    const distinctNodeIds = [...new Set(nodeIds)]
    if (distinctNodeIds.length === 0) return { state: current }
    const byId = new Map(current.nodes.map(node => [node.id, node]))
    const nodes = current.nodes.map((node) => {
      if (!distinctNodeIds.includes(node.id)) return node
      const dependencyCommits = node.deps.map((dep) => {
        const commit = byId.get(dep)?.completedCommit
        if (commit === undefined) throw new DagStateError(`dependency ${JSON.stringify(dep)} lacks a completed commit`, 'dag-invalid-state')
        return commit
      })
      const preparationMatches = node.frozenWaveBase === command.head
        && node.dependencyCommits.length === dependencyCommits.length
        && node.dependencyCommits.every((commit, index) => commit === dependencyCommits[index])
      if (preparationMatches) return node
      const { preparedHead: _preparedHead, preparedFrom: _preparedFrom, ...retained } = node
      return {
        ...retained,
        frozenWaveBase: command.head,
        dependencyCommits,
        conflictedFiles: [],
      }
    })
    const wave: DagWaveSnapshot = {
      id: command.waveId,
      nodeIds: distinctNodeIds,
      rootBranch: command.branch,
      rootHead: command.head,
      status: 'open',
      pendingNodeIds: distinctNodeIds,
      completedNodeIds: [],
      failedNodeIds: [],
    }
    return { state: completeState({ ...current, revision: current.revision + 1, nodes, waves: [...current.waves, wave] }) }
  }

  if (command.type === 'wave-probe-failed') {
    let notices = current.notices
    const nodes = current.nodes.map((node) => {
      const fence = command.fences.find(row => row.nodeId === node.id)
      if (fence === undefined || node.waveId !== command.waveId || node.status !== 'starting') return node
      const active = fencedCommand(node, fence.commandId, fence.generation, fence.bindingGeneration, fence.operationId)
      if (active?.kind !== 'dispatch' && active?.kind !== 'resume' && active?.kind !== 'steer') return node
      const { currentOperationId: _operation, ...retained } = node
      const commands = retained.commands.map(row => row.id === active.id
        ? { ...row, state: 'settled' as const, outcome: 'failed' as const, error: command.reason }
        : row)
      const failed: DagNodeSnapshot = { ...retained, commands, status: 'failed', settlement: { kind: 'failed', reason: command.reason } }
      notices = addNotice({ ...current, notices }, notice(current, 'node-failed', command.reason, failed))
      return failed
    })
    if (nodes.every((node, index) => node === current.nodes[index])) return { state: current }
    const waveResult = settleWaves({ ...current, notices }, nodes)
    return {
      state: completeState({
        ...current,
        revision: current.revision + 1,
        nodes,
        notices: waveResult.notices,
        waves: waveResult.waves,
      }),
    }
  }

  if (command.type === 'notice-delivered') {
    const notices = current.notices.map(row => row.id === command.noticeId && !row.delivered
      ? { ...row, delivered: true, deliveredRevision: current.revision + 1 }
      : row)
    if (notices.every((row, index) => row === current.notices[index])) return { state: current }
    return { state: completeState({ ...current, revision: current.revision + 1, notices }) }
  }

  const node = requireNode(current.nodes, command.nodeId)

  if (command.type === 'redispatch') {
    if (node.status !== 'failed') throw new DagStateError(`node ${JSON.stringify(node.id)} is not failed`, 'dag-invalid-transition')
    const op = operation(current, 'redispatch', [node.id])
    const {
      currentOperationId: _currentOperation,
      settlement: _settlement,
      completedCommit: _completedCommit,
      ...retained
    } = node
    const next: DagNodeSnapshot = {
      ...retained,
      status: 'pending',
      generation: node.generation + 1,
      bindingGeneration: node.bindingGeneration + 1,
      commands: cancelActiveCommands(node.commands, 'Invalidated by redispatch.'),
    }
    return {
      operationId: op.id,
      state: completeState({
        ...current,
        revision: current.revision + 1,
        operationCounter: op.counter,
        nodes: replaceNode(current.nodes, next),
        receipts: [...current.receipts, op.receipt],
      }),
    }
  }

  if (command.type === 'resume' || command.type === 'steer'
    || command.type === 'stop' || command.type === 'reset' || command.type === 'complete') {
    const op = operation(current, command.type, [node.id])
    let status = node.status
    let generation = node.generation + 1
    let settlement = node.settlement
    let kind: DagNodeSnapshot['commands'][number]['kind'] = command.type
    let message: string | undefined
    let target: string | undefined
    if (command.type === 'resume') {
      if (node.status !== 'blocked' && node.status !== 'interrupted' && node.status !== 'failed') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot resume from ${node.status}`, 'dag-invalid-transition')
      if (command.message.trim().length === 0) throw new DagStateError('resume message must be non-empty', 'dag-invalid-message')
      status = 'starting'
      message = command.message.trim()
      settlement = undefined
    } else if (command.type === 'steer') {
      if (node.status !== 'in_progress' && node.status !== 'blocked' && node.status !== 'interrupted' && node.status !== 'failed') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot steer from ${node.status}`, 'dag-invalid-transition')
      if (command.message.trim().length === 0) throw new DagStateError('steer message must be non-empty', 'dag-invalid-message')
      status = node.status === 'in_progress' ? 'in_progress' : 'starting'
      message = command.message.trim()
      settlement = undefined
    } else if (command.type === 'stop') {
      if (node.status !== 'starting' && node.status !== 'in_progress' && node.status !== 'blocked') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot stop from ${node.status}`, 'dag-invalid-transition')
      status = 'interrupted'
      message = command.reason
      settlement = { kind: 'interrupted', reason: command.reason }
    } else if (command.type === 'reset') {
      if (node.status !== 'pending' && node.status !== 'failed') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot reset from ${node.status}`, 'dag-invalid-transition')
      if (!validResetTarget(command.target, node.frozenWaveBase)) {
        throw new DagStateError('DAG reset target must be the frozen base, an exact commit, or an explicit local refs/heads/* ref', 'dag-invalid-reset-target')
      }
      target = command.target
      status = node.status
      settlement = node.settlement
    } else {
      if (node.status !== 'in_progress') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot complete from ${node.status}`, 'dag-invalid-transition')
      if (node.commands.some(row => row.state !== 'settled')) {
        throw new DagStateError(`node ${JSON.stringify(node.id)} already has an active command`, 'dag-command-active')
      }
      generation = node.generation
      kind = 'complete'
      settlement = { kind: 'completed', summary: command.summary.trim(), artifacts: [...command.artifacts] }
      if (command.summary.trim().length === 0) throw new DagStateError('completion summary must be non-empty', 'dag-invalid-summary')
    }
    const bindingGeneration = command.type === 'complete' ? node.bindingGeneration : node.bindingGeneration + 1
    const mailbox = mailboxCommand(op.id, node.id, kind, generation, bindingGeneration, current.revision + 1, message, target)
    const { settlement: _oldSettlement, ...retained } = node
    const next: DagNodeSnapshot = {
      ...retained,
      status,
      generation,
      bindingGeneration,
      currentOperationId: op.id,
      ...(command.type === 'resume' || command.type === 'steer') && node.frozenWaveBase === undefined
        ? { waveId: DagWaveId(`g${current.graphGeneration}-wave-${op.counter}`) }
        : {},
      ...settlement === undefined ? {} : { settlement },
      commands: [
        ...(command.type === 'complete'
          ? node.commands
          : cancelActiveCommands(node.commands, `Invalidated by ${command.type}.`)),
        mailbox,
      ],
    }
    let notices = current.notices
    if (command.type === 'stop') notices = addNotice(current, notice(current, 'node-interrupted', command.reason, next))
    return {
      operationId: op.id,
      state: transitionNode(current, next, notices, op),
    }
  }

  if (command.type === 'block') {
    if (node.status !== 'in_progress') throw new DagStateError(`node ${JSON.stringify(node.id)} cannot block from ${node.status}`, 'dag-invalid-transition')
    if (command.reason.trim().length === 0) throw new DagStateError('block reason must be non-empty', 'dag-invalid-reason')
    const op = operation(current, 'block', [node.id])
    const { currentOperationId: _currentOperation, ...retained } = node
    const next: DagNodeSnapshot = {
      ...retained,
      status: 'blocked',
      settlement: { kind: 'blocked', reason: command.reason.trim() },
      commands: cancelActiveCommands(node.commands, 'Invalidated by block.'),
    }
    const notices = addNotice(current, notice(current, 'node-blocked', command.reason.trim(), next))
    return {
      operationId: op.id,
      state: transitionNode(current, next, notices, op),
    }
  }

  if (command.type === 'child-ended') {
    if (node.generation !== command.generation || node.bindingGeneration !== command.bindingGeneration
      || node.currentOperationId !== command.operationId
      || !node.commands.some(row => row.id === command.commandId
        && row.operationId === command.operationId
        && row.generation === command.generation
        && row.bindingGeneration === command.bindingGeneration)
      || (node.status !== 'starting' && node.status !== 'in_progress')
      || node.settlement?.kind === 'completed') return { state: current }
    const { currentOperationId: _currentOperation, ...retained } = node
    const commands = retained.commands.map(row => row.id === command.commandId && row.state !== 'settled'
      ? { ...row, state: 'settled' as const, outcome: 'failed' as const, error: command.reason }
      : row)
    const next: DagNodeSnapshot = {
      ...retained,
      status: 'failed',
      settlement: { kind: 'failed', reason: command.reason },
      commands,
    }
    const notices = addNotice(current, notice(current, 'node-failed', command.reason, next))
    return { state: transitionNode(current, next, notices) }
  }

  const fenced = fencedCommand(node, command.commandId, command.generation, command.bindingGeneration, command.operationId)
  if (fenced === undefined) return { state: current }
  if (command.type === 'command-running') {
    if (fenced.state === 'running') return { state: current }
    const commands = node.commands.map(row => row.id === fenced.id ? { ...row, state: 'running' as const } : row)
    return {
      state: completeState({
        ...current,
        revision: current.revision + 1,
        nodes: replaceNode(current.nodes, { ...node, commands }),
      }),
    }
  }

  if (command.type === 'git-prepared') {
    if (node.status !== 'starting' || (fenced.kind !== 'dispatch' && fenced.kind !== 'resume' && fenced.kind !== 'steer')) return { state: current }
    // Preparation records two phases through this one command: the first sets
    // `preparedFrom` and `preparedHead` to the same pre-merge HEAD, and the
    // second advances only `preparedHead` past the dependency merges. A node
    // whose merge is already recorded ignores a further phase.
    const preMergePhase = node.preparedHead === undefined || node.preparedHead === node.preparedFrom
    if (!preMergePhase) return { state: current }
    if (!startEvidenceMatches(node, command.evidence, false)
      || !/^[0-9a-f]{40,64}$/iu.test(command.evidence.preparedHead)
      || (node.preparedFrom !== undefined && node.preparedFrom !== command.evidence.preparedFrom)) {
      throw new DagStateError('prepared Git evidence does not match the current node binding', 'dag-invalid-git-evidence')
    }
    const next: DagNodeSnapshot = { ...node, ...command.evidence, preparedFrom: node.preparedFrom ?? command.evidence.preparedFrom }
    return { state: completeState({ ...current, revision: current.revision + 1, nodes: replaceNode(current.nodes, next) }) }
  }

  if (command.type === 'start-succeeded') {
    const startingTurn = node.status === 'starting'
      && (fenced.kind === 'dispatch' || fenced.kind === 'resume' || fenced.kind === 'steer')
    const activeSteer = node.status === 'in_progress' && fenced.kind === 'steer'
    if (!startingTurn && !activeSteer) return { state: current }
    if (!startEvidenceMatches(node, command.evidence, true)) {
      throw new DagStateError('child start evidence does not match the prepared node binding', 'dag-invalid-git-evidence')
    }
    const commands = node.commands.map(row => row.id === fenced.id
      ? { ...row, state: 'settled' as const, outcome: 'succeeded' as const }
      : row)
    const next: DagNodeSnapshot = {
      ...node,
      ...command.evidence,
      status: 'in_progress',
      commands,
    }
    return { state: completeState({ ...current, revision: current.revision + 1, nodes: replaceNode(current.nodes, next) }) }
  }

  if (command.type === 'completion-succeeded') {
    if (
      node.status !== 'in_progress'
      || fenced.kind !== 'complete'
      || node.settlement?.kind !== 'completed'
    ) return { state: current }
    if (!/^[0-9a-f]{40,64}$/iu.test(command.evidence.commit)) {
      throw new DagStateError('completion returned invalid local Git evidence', 'dag-invalid-git-evidence')
    }
    const commands = node.commands.map(row => row.id === fenced.id
      ? { ...row, state: 'settled' as const, outcome: 'succeeded' as const }
      : row)
    const { currentOperationId: _currentOperation, ...retained } = node
    const next: DagNodeSnapshot = {
      ...retained,
      status: 'completed',
      completedCommit: command.evidence.commit,
      commands,
    }
    const insideOpenWave = node.waveId !== undefined
      && current.waves.some(wave => wave.id === node.waveId && wave.status === 'open')
    const notices = insideOpenWave
      ? current.notices
      : addNotice(current, notice(current, 'node-completed', `Node ${node.id} completed at ${command.evidence.commit}.`, next))
    return { state: transitionNode(current, next, notices) }
  }

  if (command.type === 'command-failed') {
    const commands = node.commands.map(row => row.id === fenced.id
      ? { ...row, state: 'settled' as const, outcome: 'failed' as const, error: command.reason }
      : row)
    const { currentOperationId: _currentOperation, ...retained } = node
    const next: DagNodeSnapshot = {
      ...retained,
      status: node.status === 'interrupted' ? 'interrupted' : 'failed',
      ...node.status === 'interrupted' ? {} : { settlement: { kind: 'failed' as const, reason: command.reason } },
      commands,
    }
    let notices = current.notices
    if (next.status === 'failed') notices = addNotice(current, notice(current, 'node-failed', command.reason, next))
    return { state: transitionNode(current, next, notices) }
  }

  if (fenced.kind !== 'stop' && fenced.kind !== 'reset') return { state: current }
  const commands = node.commands.map(row => row.id === fenced.id
    ? {
      ...row,
      state: 'settled' as const,
      outcome: 'succeeded' as const,
      ...command.detail === undefined ? {} : { detail: command.detail },
    }
    : row)
  const { currentOperationId: _currentOperation, ...retained } = node
  return {
    state: completeState({
      ...current,
      revision: current.revision + 1,
      nodes: replaceNode(current.nodes, { ...retained, commands }),
    }),
  }
}

/**
 * Build a projection that contains no absolute worktree path.
 * @param state - Complete durable state.
 * @returns Browser-safe DAG projection.
 */
export function projectDag(state: DagState): import('./types.ts').DagProjection {
  const byId = new Map(state.nodes.map(node => [node.id, node]))
  return {
    revision: state.revision,
    graphGeneration: state.graphGeneration,
    nodes: state.topologicalOrder.map((id) => {
      const node = byId.get(id)
      if (node === undefined) throw new DagStateError(`topological order names unknown node ${JSON.stringify(id)}`, 'dag-invalid-state')
      return {
        id: node.id,
        content: node.content,
        deps: node.deps,
        kind: node.kind,
        policy: node.policy,
        files: node.files,
        status: node.status,
        generation: node.generation,
        ...node.branch === undefined ? {} : { branch: node.branch },
        ...node.waveId === undefined ? {} : { waveId: node.waveId },
        dependencyCommits: node.dependencyCommits,
        conflictedFiles: node.conflictedFiles,
        ...node.settlement === undefined ? {} : { settlement: node.settlement },
        ...node.completedCommit === undefined ? {} : { completedCommit: node.completedCommit },
      }
    }),
    counts: state.counts,
    readyNodeIds: state.readyNodeIds,
    openWaves: state.waves.filter(wave => wave.status === 'open'),
  }
}

/**
 * Validate an integration policy without importing the tool schema.
 * @param value - Candidate policy text.
 * @returns Whether the text is an integration policy.
 */
export function isDagIntegrationPolicy(value: string): value is DagIntegrationPolicy {
  return value === 'delegate' || value === 'ours' || value === 'theirs'
}

/** Type-only check that the reducer covers all declared node statuses. */
export const DAG_NODE_STATUSES: readonly DagNodeStatus[] = STATUSES

/** Type-only declaration input alias for consumers that build reducer tests. */
export type { DagNodeInput }
