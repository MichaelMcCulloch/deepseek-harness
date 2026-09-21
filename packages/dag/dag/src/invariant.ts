/** Durable native DAG stream invariants. @module @deepseek-ai/dsh-dag/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { projectDag } from './reducer.ts'
import type { DagNodeSnapshot, DagState } from './types.ts'
import { DAG_STATE_VERSION } from './types.ts'
import { changedDefinitionFields } from './validation.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-dag'

/** Cordis companion plugin name. */
export const name = 'dag-invariant'
/** Service required before this companion reserves package ownership. */
export const inject = ['invariants']

/** Legal durable status edges, including state-preserving operation snapshots. */
const LEGAL_EDGES: Readonly<Record<DagNodeSnapshot['status'], readonly DagNodeSnapshot['status'][]>> = {
  pending: ['pending', 'starting'],
  starting: ['starting', 'in_progress', 'failed', 'interrupted'],
  in_progress: ['in_progress', 'completed', 'blocked', 'failed', 'interrupted'],
  completed: ['completed'],
  blocked: ['blocked', 'starting', 'interrupted'],
  failed: ['failed', 'pending', 'starting'],
  interrupted: ['interrupted', 'starting'],
}

const OPERATION_CAUSES = [
  'write',
  'amend',
  'dispatch',
  'redispatch',
  'resume',
  'steer',
  'stop',
  'reset',
  'complete',
  'block',
] as const
type OperationCause = typeof OPERATION_CAUSES[number]
const OPERATION_CAUSE_SET = new Set<string>(OPERATION_CAUSES)

/** Narrow a durable receipt cause to the scheduler vocabulary. */
function isOperationCause(cause: string): cause is OperationCause {
  return OPERATION_CAUSE_SET.has(cause)
}

/** Check the node edge attached to one newly accepted public operation. */
function matchesAcceptedEdge(
  cause: OperationCause,
  prior: DagNodeSnapshot | undefined,
  next: DagNodeSnapshot,
): boolean {
  if (cause === 'write') return prior === undefined ? next.status === 'pending' : next.status === prior.status
  /* v8 ignore next -- the caller rejects a new node before checking a non-write accepted edge. */
  if (prior === undefined) return false
  const existing = prior
  if (cause === 'amend') return next.status === existing.status
  if (cause === 'dispatch') return existing.status === 'pending' && next.status === 'starting'
  if (cause === 'redispatch') return existing.status === 'failed' && next.status === 'pending'
  if (cause === 'resume') return (existing.status === 'blocked' || existing.status === 'interrupted' || existing.status === 'failed')
    && next.status === 'starting'
  if (cause === 'steer') return (existing.status === 'in_progress' && next.status === 'in_progress')
    || ((existing.status === 'blocked' || existing.status === 'interrupted' || existing.status === 'failed') && next.status === 'starting')
  if (cause === 'stop') return (existing.status === 'starting' || existing.status === 'in_progress' || existing.status === 'blocked')
    && next.status === 'interrupted'
  if (cause === 'reset') return (existing.status === 'pending' || existing.status === 'failed') && next.status === existing.status
  if (cause === 'complete') return existing.status === 'in_progress' && next.status === 'in_progress'
  return existing.status === 'in_progress' && next.status === 'blocked'
}

/**
 * Validate one complete state and its edge from the previous state.
 * @param previous - Prior durable state, or null before the first state.
 * @param state - Candidate complete state.
 */
export function validateDagState(previous: DagState | null, state: DagState): void {
  if (state.version !== DAG_STATE_VERSION) {
    throw new Error(`state version must be ${String(DAG_STATE_VERSION)}`)
  }
  if (state.noticeNamespace.trim().length === 0) throw new Error('noticeNamespace must be non-empty')
  if (previous !== null && state.noticeNamespace !== previous.noticeNamespace) throw new Error('noticeNamespace changed')
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error('revision must be a positive safe integer')
  if (previous !== null && state.revision !== previous.revision + 1) throw new Error(`revision ${state.revision} does not follow ${previous.revision}`)
  if (!Number.isSafeInteger(state.graphGeneration) || state.graphGeneration < 1) throw new Error('graphGeneration must be positive')
  if (previous !== null && (state.graphGeneration < previous.graphGeneration || state.graphGeneration > previous.graphGeneration + 1)) {
    throw new Error('graphGeneration must stay monotonic and increase by at most one')
  }
  if (!Number.isSafeInteger(state.operationCounter) || state.operationCounter < 1) throw new Error('operationCounter must be a positive safe integer')
  if (previous !== null && state.operationCounter < previous.operationCounter) throw new Error('operationCounter regressed')
  const priorOperationCounter = previous?.operationCounter ?? 0
  const operationDelta = state.operationCounter - priorOperationCounter
  if (operationDelta !== 0 && operationDelta !== 1) throw new Error('one snapshot can accept at most one operation')
  const priorReceiptCount = previous?.receipts.length ?? 0
  const addedReceipts = state.receipts.slice(priorReceiptCount)
  if (addedReceipts.length !== operationDelta) throw new Error('operation delta does not match new receipts')
  const acceptedOperation = addedReceipts[0]
  if (acceptedOperation !== undefined) {
    if (!isOperationCause(acceptedOperation.cause)) throw new Error(`unknown operation cause ${JSON.stringify(acceptedOperation.cause)}`)
    if (acceptedOperation.acceptedRevision !== state.revision) throw new Error('new operation receipt does not name its snapshot revision')
    if (new Set(acceptedOperation.nodeIds).size !== acceptedOperation.nodeIds.length) throw new Error('new operation receipt repeats node ids')
  }
  if (previous === null && acceptedOperation?.cause !== 'write') throw new Error('the first DAG snapshot must be a write operation')
  const graphGenerationDelta = state.graphGeneration - (previous?.graphGeneration ?? 0)
  if ((acceptedOperation?.cause === 'write') !== (graphGenerationDelta === 1)) {
    throw new Error('graphGeneration must increase exactly for write operations')
  }
  const ids = new Set<string>()
  const commandIds = new Set<string>()
  const receiptIds = new Set<string>()
  const noticeIds = new Set<string>()
  const waveIds = new Set<string>()
  for (const node of state.nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate node ${JSON.stringify(node.id)}`)
    ids.add(node.id)
    if (!Number.isSafeInteger(node.generation) || !Number.isSafeInteger(node.bindingGeneration)
      || node.generation < 0 || node.bindingGeneration < 0 || node.bindingGeneration > node.generation) {
      throw new Error(`node ${JSON.stringify(node.id)} has invalid generations`)
    }
    const prior = previous?.nodes.find(row => row.id === node.id)
    const accepted = acceptedOperation?.nodeIds.includes(node.id) === true ? acceptedOperation : undefined
    if (prior === undefined && accepted?.cause !== 'write') {
      throw new Error(`node ${JSON.stringify(node.id)} appeared without a write operation`)
    }
    if (accepted !== undefined && !matchesAcceptedEdge(accepted.cause as OperationCause, prior, node)) {
      throw new Error(`node ${JSON.stringify(node.id)} does not match accepted ${accepted.cause} operation`)
    }
    if (prior !== undefined) {
      const changed = changedDefinitionFields(prior, node)
      const declared = accepted?.cause === 'write' || accepted?.cause === 'amend'
      if (changed.length > 0 && !declared) {
        throw new Error(`node ${JSON.stringify(node.id)} changed its definition without a declaration operation`)
      }
      if (changed.includes('deps') && (prior.frozenWaveBase !== undefined
        || prior.dependencyCommits.length > 0 || prior.preparedHead !== undefined || prior.completedCommit !== undefined)) {
        throw new Error(`node ${JSON.stringify(node.id)} changed dependencies after recording local Git preparation`)
      }
    }
    if (prior !== undefined && !LEGAL_EDGES[prior.status].includes(node.status)) {
      throw new Error(`node ${JSON.stringify(node.id)} has illegal edge ${prior.status} -> ${node.status}`)
    }
    if (prior !== undefined) {
      const generationDelta = node.generation - prior.generation
      const bindingDelta = node.bindingGeneration - prior.bindingGeneration
      if ((generationDelta !== 0 && generationDelta !== 1) || bindingDelta !== generationDelta) {
        throw new Error(`node ${JSON.stringify(node.id)} changed generations without one invalidating operation`)
      }
      const invalidatingCauses = ['dispatch', 'redispatch', 'resume', 'steer', 'stop', 'reset']
      const invalidating = accepted !== undefined && invalidatingCauses.includes(accepted.cause)
      if ((generationDelta === 1) !== invalidating) {
        throw new Error(`node ${JSON.stringify(node.id)} generation does not match its accepted operation`)
      }
      if (node.commands.length < prior.commands.length) throw new Error(`node ${JSON.stringify(node.id)} removed mailbox history`)
      for (const [index, priorCommand] of prior.commands.entries()) {
        const nextCommand = node.commands[index]
        if (nextCommand === undefined || nextCommand.id !== priorCommand.id
          || nextCommand.operationId !== priorCommand.operationId
          || nextCommand.kind !== priorCommand.kind
          || nextCommand.generation !== priorCommand.generation
          || nextCommand.bindingGeneration !== priorCommand.bindingGeneration
          || nextCommand.message !== priorCommand.message
          || nextCommand.target !== priorCommand.target
          || nextCommand.acceptedRevision !== priorCommand.acceptedRevision) {
          throw new Error(`node ${JSON.stringify(node.id)} rewrote mailbox history`)
        }
        if (priorCommand.state === 'settled' && JSON.stringify(nextCommand) !== JSON.stringify(priorCommand)) {
          throw new Error(`node ${JSON.stringify(node.id)} changed a settled command`)
        }
        if (priorCommand.state === 'running' && nextCommand.state === 'accepted') {
          throw new Error(`node ${JSON.stringify(node.id)} moved a running command backward`)
        }
      }
      const requiresAcceptedOperation = (prior.status === 'pending' && node.status === 'starting')
        || (prior.status === 'failed' && (node.status === 'pending' || node.status === 'starting'))
        || ((prior.status === 'blocked' || prior.status === 'interrupted') && node.status === 'starting')
        || (node.status === 'interrupted' && prior.status !== 'interrupted')
        || (prior.status === 'in_progress' && node.status === 'blocked')
      if (requiresAcceptedOperation && accepted === undefined) {
        throw new Error(`node ${JSON.stringify(node.id)} changed status without an accepted operation`)
      }
    }
    if (prior?.status === 'completed' && node.completedCommit !== prior.completedCommit) {
      throw new Error(`completed node ${JSON.stringify(node.id)} changed its commit`)
    }
    if (node.status === 'completed' && node.completedCommit === undefined) {
      throw new Error(`completed node ${JSON.stringify(node.id)} lacks Git evidence`)
    }
    if (node.completedCommit !== undefined && !/^[0-9a-f]{40,64}$/iu.test(node.completedCommit)) {
      throw new Error(`node ${JSON.stringify(node.id)} has invalid completion Git evidence`)
    }
    const hasBinding = node.childSessionId !== undefined || node.branch !== undefined || node.worktree !== undefined
    if (hasBinding && (node.childSessionId === undefined || node.branch === undefined || node.worktree === undefined)) {
      throw new Error(`node ${JSON.stringify(node.id)} has an incomplete child binding`)
    }
    if (node.status === 'completed' && (node.frozenWaveBase === undefined || node.preparedHead === undefined || node.settlement?.kind !== 'completed')) {
      throw new Error(`completed node ${JSON.stringify(node.id)} lacks prepared Git or child settlement evidence`)
    }
    if (node.frozenWaveBase !== undefined && (!/^[0-9a-f]{40,64}$/iu.test(node.frozenWaveBase)
      || node.dependencyCommits.length !== node.deps.length)) {
      throw new Error(`node ${JSON.stringify(node.id)} has invalid frozen wave evidence`)
    }
    if (node.preparedHead !== undefined && (node.frozenWaveBase === undefined || !/^[0-9a-f]{40,64}$/iu.test(node.preparedHead))) {
      throw new Error(`node ${JSON.stringify(node.id)} has invalid prepared Git evidence`)
    }
    if (node.preparedFrom !== undefined && (node.frozenWaveBase === undefined || !/^[0-9a-f]{40,64}$/iu.test(node.preparedFrom))) {
      throw new Error(`node ${JSON.stringify(node.id)} has invalid pre-preparation Git evidence`)
    }
    const activeCommands: DagNodeSnapshot['commands'][number][] = []
    for (const command of node.commands) {
      if (commandIds.has(command.id)) throw new Error(`duplicate command ${JSON.stringify(command.id)}`)
      commandIds.add(command.id)
      if (!Number.isSafeInteger(command.generation) || !Number.isSafeInteger(command.bindingGeneration)
        || command.bindingGeneration < 0 || command.bindingGeneration > command.generation) {
        throw new Error(`command ${JSON.stringify(command.id)} has invalid generations`)
      }
      if (command.acceptedRevision < 1 || command.acceptedRevision > state.revision) {
        throw new Error(`command ${JSON.stringify(command.id)} has an invalid accepted revision`)
      }
      if (command.state !== 'settled') {
        activeCommands.push(command)
      }
    }
    if (activeCommands.length > 1) throw new Error(`node ${JSON.stringify(node.id)} has more than one active command`)
    const active = activeCommands[0]
    if (active !== undefined && (active.generation !== node.generation
      || active.bindingGeneration !== node.bindingGeneration
      || active.operationId !== node.currentOperationId)) {
      throw new Error(`node ${JSON.stringify(node.id)} has an unfenced active command`)
    }
    if (active !== undefined) {
      const compatible = (active.kind === 'dispatch' && node.status === 'starting')
        || (active.kind === 'resume' && node.status === 'starting')
        || (active.kind === 'steer' && (node.status === 'starting' || node.status === 'in_progress'))
        || (active.kind === 'stop' && node.status === 'interrupted')
        || (active.kind === 'reset' && (node.status === 'pending' || node.status === 'failed'))
        || (active.kind === 'complete' && node.status === 'in_progress')
      if (!compatible) throw new Error(`node ${JSON.stringify(node.id)} has an active ${active.kind} command in ${node.status}`)
    }
    if (node.status === 'starting' && active === undefined) {
      throw new Error(`starting node ${JSON.stringify(node.id)} lacks an active command`)
    }
    if (node.currentOperationId !== undefined) {
      const current = node.commands.filter(command => command.operationId === node.currentOperationId
        && command.generation === node.generation && command.bindingGeneration === node.bindingGeneration)
      if (current.length !== 1) throw new Error(`node ${JSON.stringify(node.id)} current operation does not name one current-generation command`)
    }
  }
  if (acceptedOperation !== undefined && acceptedOperation.nodeIds.some(id => !ids.has(id))) {
    throw new Error('new operation receipt names an unknown node')
  }
  if (acceptedOperation?.cause === 'write' && acceptedOperation.nodeIds.length !== ids.size) {
    throw new Error('write operation receipt does not name the complete declaration')
  }
  const ordered = new Set(state.topologicalOrder)
  if (
    state.topologicalOrder.length !== state.nodes.length
    || ordered.size !== state.nodes.length
    || state.topologicalOrder.some(id => !ids.has(id))
  ) {
    throw new Error('topologicalOrder does not name every node once')
  }
  if (previous !== null && acceptedOperation?.cause !== 'write' && acceptedOperation?.cause !== 'amend'
    && JSON.stringify(state.topologicalOrder) !== JSON.stringify(previous.topologicalOrder)) {
    throw new Error('topologicalOrder changed without a write operation')
  }
  for (const node of state.nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep) || state.topologicalOrder.indexOf(dep) >= state.topologicalOrder.indexOf(node.id)) {
        throw new Error(`node ${JSON.stringify(node.id)} has an invalid topological dependency ${JSON.stringify(dep)}`)
      }
      if (node.status !== 'pending' && state.nodes.find(row => row.id === dep)?.status !== 'completed') {
        throw new Error(`node ${JSON.stringify(node.id)} started before dependency ${JSON.stringify(dep)} completed`)
      }
    }
  }
  for (const prior of previous?.nodes ?? []) {
    if ((prior.status === 'starting' || prior.status === 'in_progress' || prior.status === 'blocked') && !ids.has(prior.id)) {
      throw new Error(`active node ${JSON.stringify(prior.id)} was removed`)
    }
  }
  const view = projectDag(state)
  for (const status of ['pending', 'starting', 'in_progress', 'completed', 'blocked', 'failed', 'interrupted'] as const) {
    const expected = state.nodes.filter(node => node.status === status).length
    if (view.counts[status] !== expected) throw new Error(`status count ${status} does not match the node board`)
  }
  const ready = state.topologicalOrder.filter((id) => {
    const node = state.nodes.find(row => row.id === id)
    return node?.status === 'pending'
      && node.deps.every(dep => state.nodes.find(row => row.id === dep)?.status === 'completed')
  })
  if (JSON.stringify(state.readyNodeIds) !== JSON.stringify(ready)) throw new Error('readyNodeIds does not match the node board')
  const active = state.nodes.flatMap(node => node.commands.filter(command => command.state !== 'settled').map(command => command.id))
  if (JSON.stringify(active) !== JSON.stringify(state.activeCommandIds)) throw new Error('activeCommandIds does not match node mailboxes')
  if (state.receipts.length !== state.operationCounter) throw new Error('operationCounter does not match operation receipts')
  for (const receipt of state.receipts) {
    if (receiptIds.has(receipt.id)) throw new Error(`duplicate operation receipt ${JSON.stringify(receipt.id)}`)
    receiptIds.add(receipt.id)
    if (receipt.acceptedRevision < 1 || receipt.acceptedRevision > state.revision) throw new Error(`receipt ${JSON.stringify(receipt.id)} has an invalid revision`)
  }
  for (const [index, receipt] of state.receipts.entries()) {
    if (receipt.id !== `op-${String(index + 1)}`) throw new Error(`operation receipt ${JSON.stringify(receipt.id)} is out of sequence`)
    const prior = previous?.receipts[index]
    if (prior !== undefined && JSON.stringify(receipt) !== JSON.stringify(prior)) {
      throw new Error(`operation receipt ${JSON.stringify(receipt.id)} changed`)
    }
  }
  for (const command of state.nodes.flatMap(node => node.commands)) {
    if (!receiptIds.has(command.operationId)) throw new Error(`command ${JSON.stringify(command.id)} lacks an operation receipt`)
  }
  for (const notice of state.notices) {
    if (noticeIds.has(notice.id)) throw new Error(`duplicate notice ${JSON.stringify(notice.id)}`)
    noticeIds.add(notice.id)
    if (notice.revision < 1 || notice.revision > state.revision) throw new Error(`notice ${JSON.stringify(notice.id)} has an invalid revision`)
    if (notice.delivered !== (notice.deliveredRevision !== undefined)) {
      throw new Error(`notice ${JSON.stringify(notice.id)} has inconsistent delivery evidence`)
    }
    if (notice.deliveredRevision !== undefined
      && (!Number.isSafeInteger(notice.deliveredRevision)
        || notice.deliveredRevision < notice.revision
        || notice.deliveredRevision > state.revision)) {
      throw new Error(`notice ${JSON.stringify(notice.id)} has an invalid delivery revision`)
    }
    const prior = previous?.notices.find(row => row.id === notice.id)
    if (prior?.delivered === true && !notice.delivered) throw new Error(`notice ${JSON.stringify(notice.id)} lost delivery state`)
    if (prior !== undefined) {
      const { delivered: _priorDelivered, deliveredRevision: _priorDeliveryRevision, ...priorFacts } = prior
      const { delivered: _noticeDelivered, deliveredRevision: _noticeDeliveryRevision, ...noticeFacts } = notice
      if (JSON.stringify(noticeFacts) !== JSON.stringify(priorFacts)) throw new Error(`notice ${JSON.stringify(notice.id)} changed`)
      if (!prior.delivered && notice.delivered && notice.deliveredRevision !== state.revision) {
        throw new Error(`notice ${JSON.stringify(notice.id)} delivery does not name its snapshot revision`)
      }
      if (prior.delivered && notice.deliveredRevision !== prior.deliveredRevision) {
        throw new Error(`notice ${JSON.stringify(notice.id)} changed its delivery revision`)
      }
    }
  }
  for (const prior of previous?.notices ?? []) {
    if (!state.notices.some(notice => notice.id === prior.id)) throw new Error(`notice ${JSON.stringify(prior.id)} was removed`)
  }
  for (const wave of state.waves) {
    if (waveIds.has(wave.id)) throw new Error(`duplicate wave ${JSON.stringify(wave.id)}`)
    waveIds.add(wave.id)
    const members = new Set(wave.nodeIds)
    if (wave.rootBranch.trim().length === 0 || !/^[0-9a-f]{40,64}$/iu.test(wave.rootHead)) {
      throw new Error(`wave ${JSON.stringify(wave.id)} has invalid frozen root evidence`)
    }
    if (members.size !== wave.nodeIds.length || wave.nodeIds.some(id => !ids.has(id))) throw new Error(`wave ${JSON.stringify(wave.id)} has invalid node ids`)
    for (const row of [wave.pendingNodeIds, wave.completedNodeIds, wave.failedNodeIds]) {
      if (new Set(row).size !== row.length || row.some(id => !members.has(id))) throw new Error(`wave ${JSON.stringify(wave.id)} has invalid settlement slots`)
    }
    const settled = [...wave.pendingNodeIds, ...wave.completedNodeIds, ...wave.failedNodeIds]
    if (new Set(settled).size !== settled.length || settled.length !== wave.nodeIds.length) throw new Error(`wave ${JSON.stringify(wave.id)} settles a slot more than once`)
    if (wave.status === 'settled' && wave.pendingNodeIds.length !== 0) {
      throw new Error(`closed wave ${JSON.stringify(wave.id)} has pending slots`)
    }
    const prior = previous?.waves.find(row => row.id === wave.id)
    if (prior !== undefined && (JSON.stringify(prior.nodeIds) !== JSON.stringify(wave.nodeIds)
      || prior.rootBranch !== wave.rootBranch || prior.rootHead !== wave.rootHead)) {
      throw new Error(`wave ${JSON.stringify(wave.id)} changed its frozen identity`)
    }
    if (prior !== undefined && (prior.completedNodeIds.some(id => !wave.completedNodeIds.includes(id))
      || prior.failedNodeIds.some(id => !wave.failedNodeIds.includes(id)))) {
      throw new Error(`wave ${JSON.stringify(wave.id)} changed an already settled slot`)
    }
    if (prior?.status === 'settled' && JSON.stringify(prior) !== JSON.stringify(wave)) {
      throw new Error(`closed wave ${JSON.stringify(wave.id)} changed`)
    }
  }
  for (const prior of previous?.waves ?? []) {
    if (state.waves.some(wave => wave.id === prior.id)) continue
    if (acceptedOperation?.cause !== 'write' || prior.nodeIds.every(id => ids.has(id))) {
      throw new Error(`wave ${JSON.stringify(prior.id)} disappeared without removal of a declared node`)
    }
  }
}

/** Fold one candidate event with package attribution. */
function applyEvent(previous: DagState | null, event: SessionEvent, fail: InvariantFailure): DagState | null {
  if (event.type !== 'dag/state') return previous
  try {
    validateDagState(previous, event.data.state)
    return event.data.state
  } catch (error) {
    fail(`session event ${event.seq} violates the durable DAG stream: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Install an independent incremental validation fold. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, DagState | null>()
  const staged = new WeakMap<SessionEvent, { readonly session: Session; readonly state: DagState | null }>()
  const seed = (session: Session): DagState | null => {
    let state: DagState | null = null
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) state = applyEvent(state, event, fail)
    states.set(session, state)
    return state
  }
  const stage = (session: Session, event: SessionEvent): void => {
    /* v8 ignore next -- session/event always follows list() or session/created seeding */
    const previous = states.get(session) ?? seed(session)
    staged.set(event, { session, state: applyEvent(previous, event, fail) })
  }
  const publish = (session: Session, event: SessionEvent): void => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      fail('session/event reached publication without matching DAG validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }
  for (const session of ctx.sessions.list()) {
    seed(session)
  }
  ctx.on('session/created', (session) => { void seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'session/event') {
      const [session, event] = args as [Session, SessionEvent]
      stage(session, event)
    }
  }, { global: true })
  ctx.on('session/event', publish, { global: true })
}, { inject: ['sessions'] })

/** Register the DAG stream invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
