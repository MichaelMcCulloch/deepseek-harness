/** Native event-sourced DAG service, effect pumps, notices, and local Git orchestration. @module @deepseek-ai/dsh-dag */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentOwnerBinding,
  SubagentOwnerController,
  SubagentOwnerRedirectRequest,
  SubagentOwnerSettlement,
  SubagentOwnerStopRequest,
  SubagentOwnerTurnSettlement,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subprocess'
import { dagWorktreeRoot, DagGit } from './git.ts'
import type { DagGitConfig, DagPreparedWorktree } from './git.ts'
import { dagSlug, dispatcherHash, shortHash } from './ids.ts'
import {
  actionable,
  asError,
  errorText,
  hasActiveFence,
  messageRecorded,
  messageText,
  nonEmpty,
  noticeRecorded,
  ownerMetadata,
  resolveDagConfig,
  requiredOperation,
  requiredValue,
  waitForShared,
  waveFences,
} from './runtime.ts'
import type { DagOwnerMetadata, DagRuntimeConfig } from './runtime.ts'
import { projectDag, reduceDagState, DagStateError } from './reducer.ts'
import type { DagDeclaredNode, DagEffectFence, DagReduceResult, DagReducerCommand } from './reducer.ts'
import { validateDagDeclaration } from './validation.ts'
import type {
  DagCommandAccepted,
  DagCommitted,
  DagNodeId,
  DagNodeSnapshot,
  DagNotice,
  DagNoticeId,
  DagOperationId,
  DagProjection,
  DagRevisionGuard,
  DagState,
  DagWriteRequest,
  DagWriteResult,
} from './types.ts'

export type * from './types.ts'
export { DAG_STATE_VERSION } from './types.ts'
export { DagCommandId, DagNodeId, DagNoticeId, DagOperationId, DagWaveId } from './ids.ts'
export { DagDeclarationError, validateDagDeclaration } from './validation.ts'
export { DagStateError, projectDag, reduceDagState } from './reducer.ts'
export type { DagReducerCommand } from './reducer.ts'
export { DagGitError } from './git.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dag: DagService
  }

  interface Events {
    /**
     * A complete DAG state value was appended to the dispatcher session.
     * @param payload.agent - exact live dispatcher Agent.
     * @param payload.committed - immutable committed state facts.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that dispatcher.
     * @mode emit
     */
    'dag/committed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { readonly agent: Agent; readonly committed: DagCommitted }): void
  }
}

/** Durable source for an injected DAG notice. */
export interface DagNoticeMessageSource {
  readonly kind: 'dag-notice'
  readonly form: 'notice'
  readonly noticeId: DagNoticeId
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dag-notice': DagNoticeMessageSource
  }
}

/** Deployment choices for the local DAG runtime. */
export interface Config extends DagRuntimeConfig {}

/** One active `dag_wait` call. */
interface DagWaiter {
  readonly afterRevision: number
  readonly resolve: (value: DagWaitResult) => void
  readonly reject: (error: unknown) => void
  readonly onAbort: () => void
  readonly signal: AbortSignal
}

/** One service-owned root probe shared by every node in a dispatch wave. */
interface DagWaveProbe {
  readonly controller: AbortController
  readonly promise: Promise<void>
  readonly agent: Agent
  readonly fences: readonly DagEffectFence[]
  waiters: number
}

/** Result returned when a later actionable notice is durable and injected. */
export interface DagWaitResult {
  readonly revision: number
  readonly notices: readonly DagNotice[]
  readonly state: DagProjection
}

/** Internal signal that leaves durable mailbox work for explicit reconciliation. */
class DagPersistenceBarrierError extends Error {
  constructor(cause: unknown) {
    super(`DAG session flush failed: ${errorText(cause)}`, { cause })
    this.name = 'DagPersistenceBarrierError'
  }
}

const statusSchema = zod.enum(['pending', 'starting', 'in_progress', 'completed', 'blocked', 'failed', 'interrupted'])
const countsSchema = zod.object({
  pending: zod.number().int().nonnegative(),
  starting: zod.number().int().nonnegative(),
  in_progress: zod.number().int().nonnegative(),
  completed: zod.number().int().nonnegative(),
  blocked: zod.number().int().nonnegative(),
  failed: zod.number().int().nonnegative(),
  interrupted: zod.number().int().nonnegative(),
})
const settlementSchema = zod.union([
  zod.object({ kind: zod.literal('completed'), summary: zod.string(), artifacts: zod.array(zod.json()) }),
  zod.object({ kind: zod.literal('blocked'), reason: zod.string() }),
  zod.object({ kind: zod.literal('failed'), reason: zod.string() }),
  zod.object({ kind: zod.literal('interrupted'), reason: zod.string() }),
])
const waveSchema = zod.object({
  id: zod.string(),
  nodeIds: zod.array(zod.string()),
  rootBranch: zod.string(),
  rootHead: zod.string(),
  status: zod.enum(['open', 'settled']),
  pendingNodeIds: zod.array(zod.string()),
  completedNodeIds: zod.array(zod.string()),
  failedNodeIds: zod.array(zod.string()),
})
const dagProjectionSchema = zod.object({
  revision: zod.number().int().positive(),
  graphGeneration: zod.number().int().positive(),
  nodes: zod.array(zod.object({
    id: zod.string(),
    content: zod.string(),
    deps: zod.array(zod.string()),
    kind: zod.enum(['task', 'integration']),
    policy: zod.enum(['delegate', 'ours', 'theirs']),
    files: zod.array(zod.string()),
    status: statusSchema,
    generation: zod.number().int().nonnegative(),
    branch: zod.string().optional(),
    waveId: zod.string().optional(),
    dependencyCommits: zod.array(zod.string()),
    conflictedFiles: zod.array(zod.string()),
    settlement: settlementSchema.optional(),
    completedCommit: zod.string().optional(),
  })),
  counts: countsSchema,
  readyNodeIds: zod.array(zod.string()),
  openWaves: zod.array(waveSchema),
}) as unknown as ZodType<DagProjection>

/** Native DAG service backed only by complete session-log state values. */
export class DagService extends Service implements SubagentOwnerController {
  static inject = ['agents', 'subagents', 'subprocess', 'sessions']

  static Config: z<Config> = z.object({
    dshHome: z.string().default(''),
    gitExecutable: z.string().default('git'),
    commandDeadlineMs: z.number().default(120_000),
    terminationGraceMs: z.number().default(5_000),
    outputLimitBytes: z.number().default(8 * 1024 * 1024),
    subagentProvider: z.string().default('spawn'),
  })

  private readonly git: DagGit
  private readonly config: Required<Config>
  private readonly committing = new WeakSet<Session>()
  private readonly pumps = new WeakMap<Session, Set<DagNodeId>>()
  private readonly pumpTasks = new Set<Promise<void>>()
  private readonly flushTasks = new Set<Promise<void>>()
  private readonly waveProbes = new Map<string, DagWaveProbe>()
  private readonly effects = new Map<symbol, {
    readonly controller: AbortController
    readonly session: Session
    readonly nodeId: DagNodeId
    readonly commandId: import('./types.ts').DagCommandId
  }>()
  private readonly waiters = new Map<Session, DagWaiter>()
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dag')
    this.config = resolveDagConfig(config)
    const gitConfig: DagGitConfig = {
      dshHome: this.config.dshHome,
      gitExecutable: this.config.gitExecutable,
      commandDeadlineMs: this.config.commandDeadlineMs,
      terminationGraceMs: this.config.terminationGraceMs,
      outputLimitBytes: this.config.outputLimitBytes,
    }
    this.git = new DagGit(ctx, gitConfig)
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'dag', DagProjection | null>({
        key: 'dag',
        stateSchema: zod.union([dagProjectionSchema, zod.null()]),
        init: () => null,
        apply: (state, event) => event.type === 'dag/state' ? projectDag(event.data.state) : state,
        wire: { viewSchema: zod.union([dagProjectionSchema, zod.null()]), view: state => state },
        stateVersion: 1,
      })
    })
    ctx.subagents.registerOwnerController('dag', this)
    ctx.on('agent/session-start', ({ agent }) => { this.reconcile(agent) })
    for (const agent of ctx.agents.list()) {
      if (latestState(agent.session) !== null) this.scheduleFlush(agent)
    }
    ctx.effect(() => async () => {
      this.disposed = true
      for (const effect of this.effects.values()) effect.controller.abort(new Error('DAG service disposed'))
      for (const probe of this.waveProbes.values()) probe.controller.abort(new Error('DAG service disposed'))
      for (const [session, waiter] of this.waiters) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new Error(`DAG service disposed while session ${JSON.stringify(session.id)} was waiting`))
      }
      await Promise.allSettled([...this.pumpTasks, ...this.flushTasks])
      this.effects.clear()
      this.waveProbes.clear()
      this.waiters.clear()
    }, 'dag.effects()')
  }

  /**
   * Return the latest durable state for one dispatcher.
   * @param agent - Live dispatcher agent.
   * @returns Latest state, or null before the first write.
   */
  state(agent: Agent): DagState | null {
    this.assertLive(agent)
    return latestState(agent.session)
  }

  /**
   * Return the complete dispatcher board.
   * @param agent - Live dispatcher agent.
   * @returns Safe board projection, or null before the first write.
   */
  status(agent: Agent): DagProjection | null {
    const state = this.state(agent)
    return state === null ? null : projectDag(state)
  }

  /**
   * Return one node card, including dispatcher-only local execution facts.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Node to inspect.
   * @returns Complete durable node card.
   */
  inspect(agent: Agent, nodeId: DagNodeId): DagNodeSnapshot {
    const state = this.requireState(agent)
    const node = state.nodes.find(row => row.id === nodeId)
    if (node === undefined) throw new DagStateError(`unknown DAG node ${JSON.stringify(nodeId)}`, 'dag-node-not-found')
    return node
  }

  /**
   * Return topology and execution facts for the exact owner-bound child.
   * @param child - Live DAG child agent.
   * @returns Topology and the child's safe node facts.
   */
  statusFrom(child: Agent): {
    readonly revision: number
    readonly topology: readonly { readonly id: DagNodeId; readonly deps: readonly DagNodeId[]; readonly status: DagNodeSnapshot['status'] }[]
    readonly own: DagProjection['nodes'][number]
  } {
    const { dispatcher, metadata } = this.dispatcherFor(child)
    this.assertBinding(dispatcher, metadata, child.id)
    const projection = projectDag(this.requireState(dispatcher))
    const own = requiredValue(
      projection.nodes.find(node => node.id === metadata.nodeId),
      new DagStateError('DAG child projection lacks its owner node', 'dag-invalid-state'),
    )
    return {
      revision: projection.revision,
      topology: projection.nodes.map(node => ({ id: node.id, deps: node.deps, status: node.status })),
      own,
    }
  }

  /**
   * Replace the declaration after canonical validation.
   * @param agent - Live dispatcher agent.
   * @param request - Full node declaration and optional revision guard.
   * @returns Accepted write receipt, preserved artifacts, and advisory conflicts.
   */
  write(agent: Agent, request: DagWriteRequest): DagWriteResult {
    this.assertRevision(agent, request.if_revision)
    const validated = validateDagDeclaration(request.nodes)
    const byId = new Map(request.nodes.map(node => [node.id.trim(), node]))
    const rows: DagDeclaredNode[] = validated.definitions.map(definition => ({
      definition,
      status: requiredValue(
        byId.get(definition.id),
        new DagStateError('validated DAG declaration lacks its source node', 'dag-invalid-state'),
      ).status,
    }))
    const result = this.mutate(agent, request.if_revision, 'write', {
      type: 'write',
      noticeNamespace: agent.id,
      nodes: rows,
      topologicalOrder: validated.topologicalOrder,
    })
    return {
      accepted: true,
      revision: result.state.revision,
      operationId: requiredOperation(result),
      dropped: requiredValue(result.dropped, new DagStateError('accepted DAG write lacks dropped artifacts', 'dag-invalid-state')),
      conflicts: requiredValue(result.conflicts, new DagStateError('accepted DAG write lacks conflict rows', 'dag-invalid-state')),
    }
  }

  /**
   * Start dependency-ready pending nodes without waiting for effects.
   * @param agent - Live dispatcher agent.
   * @param nodeIds - Pending nodes to start.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  dispatch(agent: Agent, nodeIds: readonly DagNodeId[], guard: DagRevisionGuard = {}): DagCommandAccepted {
    this.assertRevision(agent, guard.if_revision)
    const state = this.requireState(agent)
    const sessionHash = dispatcherHash(agent.id)
    const bindings = Object.fromEntries(nodeIds.map((nodeId) => {
      const node = state.nodes.find(row => row.id === nodeId)
      const suffix = `${dagSlug(nodeId)}-${shortHash(nodeId)}`
      return [nodeId, {
        childSessionId: node?.childSessionId ?? this.childSessionId(agent.id, state.graphGeneration, nodeId),
        branch: node?.branch ?? `dsh/dag/${sessionHash}/g${state.graphGeneration}/${suffix}`,
        worktree: node?.worktree ?? join(dagWorktreeRoot(this.config.dshHome, sessionHash, state.graphGeneration), suffix),
      }]
    }))
    return this.accept(agent, guard, 'dispatch', { type: 'dispatch', nodeIds, bindings })
  }

  /**
   * Re-enter a failed node with its durable child identity.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Failed node to dispatch again.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  redispatch(agent: Agent, nodeId: DagNodeId, guard: DagRevisionGuard = {}): DagCommandAccepted {
    return this.accept(agent, guard, 'redispatch', { type: 'redispatch', nodeId })
  }

  /**
   * Resume a blocked or interrupted node.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Suspended node to resume.
   * @param message - New work message for the child.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  resume(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted {
    return this.accept(agent, guard, 'resume', { type: 'resume', nodeId, message })
  }

  /**
   * Replace a node's active work, or restart a suspended node.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Node to steer.
   * @param message - Replacement work message.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  steer(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted {
    return this.accept(agent, guard, 'steer', { type: 'steer', nodeId, message })
  }

  /**
   * Reset tracked worktree state to one allowed local target.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Pending or failed node to reset.
   * @param target - Frozen base, exact commit, or local branch ref.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  reset(agent: Agent, nodeId: DagNodeId, target: string, guard: DagRevisionGuard = {}): DagCommandAccepted {
    this.assertRevision(agent, guard.if_revision)
    return this.accept(agent, guard, 'reset', { type: 'reset', nodeId, target: nonEmpty(target, 'reset target') })
  }

  /**
   * Mark the calling DAG child blocked.
   * @param child - Live DAG child agent.
   * @param reason - Reason that work cannot continue.
   * @returns Accepted command receipt.
   */
  blockFrom(child: Agent, reason: string): DagCommandAccepted {
    const { dispatcher, metadata } = this.dispatcherFor(child)
    const node = this.assertBinding(dispatcher, metadata, child.id)
    this.assertCurrentChildTurn(node, child)
    return this.accept(dispatcher, {}, 'block', { type: 'block', nodeId: metadata.nodeId, reason: nonEmpty(reason, 'block reason') })
  }

  /**
   * Request completion validation for the calling DAG child.
   * @param child - Live DAG child agent.
   * @param summary - Result summary for the dispatcher.
   * @param artifacts - Optional JSON result records.
   * @returns Accepted command receipt.
   */
  completeFrom(child: Agent, summary: string, artifacts: readonly JsonValue[] = []): DagCommandAccepted {
    const { dispatcher, metadata } = this.dispatcherFor(child)
    const node = this.assertBinding(dispatcher, metadata, child.id)
    this.assertCurrentChildTurn(node, child)
    return this.accept(dispatcher, {}, 'complete', {
      type: 'complete',
      nodeId: metadata.nodeId,
      summary: nonEmpty(summary, 'completion summary'),
      artifacts,
    })
  }

  /**
   * Wait for an injected actionable notice after one revision.
   * @param agent - Live dispatcher agent.
   * @param afterRevision - Last revision already handled by the caller.
   * @param signal - Cancellation signal for this wait.
   * @returns First available later notice and current safe board.
   */
  wait(agent: Agent, afterRevision: number, signal: AbortSignal): Promise<DagWaitResult> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new DagStateError('dag_wait after_revision must be a non-negative safe integer', 'dag-invalid-revision')
    }
    const state = this.requireState(agent)
    const current = actionable(state, afterRevision)
    if (current.length > 0) return Promise.resolve({ revision: state.revision, notices: current, state: projectDag(state) })
    if (this.waiters.has(agent.session)) throw new DagStateError('one dag_wait is already active for this dispatcher', 'dag-wait-active')
    return new Promise<DagWaitResult>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.delete(agent.session)
        reject(asError(signal.reason, 'dag_wait was aborted'))
      }
      const waiter: DagWaiter = { afterRevision, resolve, reject, onAbort, signal }
      this.waiters.set(agent.session, waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Commit one authorized owner stop and then cancel the child turn.
   * @param request - Authorized owner stop request.
   */
  stop(request: SubagentOwnerStopRequest): void
  /**
   * Commit a dispatcher stop without waiting for cancellation.
   * @param agent - Live dispatcher agent.
   * @param nodeId - Active or blocked node to stop.
   * @param reason - Optional interruption reason.
   * @param guard - Optional expected revision.
   * @returns Accepted command receipt.
   */
  stop(agent: Agent, nodeId: DagNodeId, reason?: string, guard?: DagRevisionGuard): DagCommandAccepted
  stop(
    requestOrAgent: SubagentOwnerStopRequest | Agent,
    nodeId?: DagNodeId,
    reason = 'Stopped by the dispatcher.',
    guard: DagRevisionGuard = {},
  ): void | DagCommandAccepted {
    if ('binding' in requestOrAgent) {
      this.ownerStop(requestOrAgent)
      return
    }
    if (nodeId === undefined) throw new DagStateError('stop requires a node id', 'dag-node-not-found')
    this.assertRevision(requestOrAgent, guard.if_revision)
    return this.accept(requestOrAgent, guard, 'stop', { type: 'stop', nodeId, reason: nonEmpty(reason, 'stop reason') })
  }

  /**
   * Commit one authorized redirect and then replace the child turn.
   * @param request - Authorized owner redirect request.
   */
  redirect(request: SubagentOwnerRedirectRequest): Promise<void> {
    const metadata = ownerMetadata(request.binding)
    const dispatcher = this.liveDispatcher(metadata.dispatcherSessionId)
    const current = this.requireState(dispatcher)
    const node = current.nodes.find(row => row.id === metadata.nodeId)
    if (node === undefined) throw new DagStateError(`unknown DAG node ${JSON.stringify(metadata.nodeId)}`, 'dag-node-not-found')
    if (node.childSessionId !== request.child.id) {
      throw new DagStateError('DAG child binding is stale', 'dag-stale-child-binding')
    }
    const text = messageText(request.message)
    let operationId = node.currentOperationId
    let commandId = node.commands.find(row => row.operationId === operationId && row.kind === 'steer' && row.state !== 'settled')?.id
    if (commandId === undefined) {
      const accepted = this.steer(dispatcher, node.id, text)
      const next = this.requireState(dispatcher).nodes.find(row => row.id === node.id)
      operationId = accepted.operationId
      commandId = next?.commands.find(row => row.operationId === operationId)?.id
    }
    const currentNode = requiredValue(
      this.requireState(dispatcher).nodes.find(row => row.id === node.id),
      new DagStateError('accepted DAG steer lost its node', 'dag-invalid-state'),
    )
    const command = requiredValue(
      currentNode.commands.find(row => row.id === commandId),
      new DagStateError('accepted DAG steer lacks its mailbox command', 'dag-invalid-state'),
    )
    return this.deliverOwnerRedirect(dispatcher, node.id, command, request)
  }

  /** Flush one owner steer before its replacement enters the child inbox. */
  private async deliverOwnerRedirect(
    dispatcher: Agent,
    nodeId: DagNodeId,
    command: DagNodeSnapshot['commands'][number],
    request: SubagentOwnerRedirectRequest,
  ): Promise<void> {
    await this.ctx.sessions.flush(dispatcher.session)
    if (this.disposed) throw new DagStateError('DAG service is disposed', 'dag-service-disposed')
    this.requireCurrentCommand(dispatcher, nodeId, command)
    const messageId = MessageId(`${command.id}-message`)
    request.redirect(request.message.id === messageId
      ? request.message
      : freezeMessage({
        id: messageId,
        role: 'user',
        content: [...request.message.content],
        source: request.message.source,
      }))
    this.finishSteer(dispatcher, nodeId, command.id, command.generation, command.operationId)
  }

  /**
   * Convert an unreported owner-child turn end to failure.
   * @param settlement - Authorized child turn settlement.
   */
  settled(settlement: SubagentOwnerSettlement): void {
    const metadata = ownerMetadata(settlement.binding)
    const dispatcher = this.ctx.agents.get(metadata.dispatcherSessionId)
    if (dispatcher === undefined) return
    const node = latestState(dispatcher.session)?.nodes.find(row => row.id === metadata.nodeId)
    if (node === undefined || node.childSessionId !== settlement.childId || settlement.messageId === undefined
      || (node.status !== 'starting' && node.status !== 'in_progress') || node.settlement?.kind === 'completed') return
    const messageCommand = node.commands.find(row => `${row.id}-message` === settlement.messageId)
    if (messageCommand !== undefined) {
      if (messageCommand.operationId !== node.currentOperationId) return
      /* v8 ignore next -- a valid node changes both generations only as part of a new operation. */
      if (messageCommand.generation !== node.generation || messageCommand.bindingGeneration !== node.bindingGeneration) return
    }
    const command = requiredValue(
      messageCommand ?? node.commands.find(row => row.operationId === node.currentOperationId
        && row.generation === node.generation
        && row.bindingGeneration === node.bindingGeneration),
      new DagStateError('active DAG node lacks its current mailbox command', 'dag-invalid-state'),
    )
    const error = settlement.error ?? `DAG child turn ended with ${settlement.stopReason} without dag_node_complete or dag_node_block.`
    this.mutate(dispatcher, undefined, 'child-ended', {
      type: 'child-ended',
      nodeId: metadata.nodeId,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: node.bindingGeneration,
      operationId: command.operationId,
      reason: error,
    })
  }

  /**
   * Fail one current child turn that ended without a final DAG report.
   * @param settlement - Authorized ordinary-turn settlement facts.
   */
  turnSettled(settlement: SubagentOwnerTurnSettlement): void {
    const metadata = ownerMetadata(settlement.binding)
    const dispatcher = this.ctx.agents.get(metadata.dispatcherSessionId)
    if (dispatcher === undefined) return
    const node = latestState(dispatcher.session)?.nodes.find(row => row.id === metadata.nodeId)
    if (node === undefined || node.childSessionId !== settlement.child.id) return
    const messageCommand = node.commands.find(row => `${row.id}-message` === settlement.messageId)
    if (messageCommand !== undefined && (messageCommand.operationId !== node.currentOperationId
      || messageCommand.generation !== node.generation
      || messageCommand.bindingGeneration !== node.bindingGeneration)) {
      if (node.status === 'blocked' || node.status === 'failed' || node.status === 'completed'
        || node.status === 'interrupted' || node.settlement?.kind === 'completed') settlement.stop()
      return
    }
    if (node.status === 'blocked' || node.status === 'failed' || node.status === 'completed'
      || node.status === 'interrupted' || node.settlement?.kind === 'completed') {
      settlement.stop()
      return
    }
    const command = requiredValue(
      messageCommand ?? node.commands.find(row => row.operationId === node.currentOperationId
        && row.generation === node.generation
        && row.bindingGeneration === node.bindingGeneration),
      new DagStateError('active DAG node lacks its current mailbox command', 'dag-invalid-state'),
    )
    if (messageCommand === undefined
      && settlement.stopReason === 'aborted'
      && command.kind === 'steer') return
    const error = settlement.error
      ?? `DAG child turn ended with ${settlement.stopReason} without dag_node_complete or dag_node_block.`
    this.mutate(dispatcher, undefined, 'child-ended', {
      type: 'child-ended',
      nodeId: metadata.nodeId,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
      reason: error,
    })
    settlement.stop()
  }

  /** Shared immediate acknowledgement for a public mutation. */
  private accept(agent: Agent, guard: DagRevisionGuard, cause: string, command: DagReducerCommand): DagCommandAccepted {
    const result = this.mutate(agent, guard.if_revision, cause, command)
    return { accepted: true, revision: result.state.revision, operationId: requiredOperation(result) }
  }

  /** Append exactly one pure state reduction without an await. */
  private mutate(agent: Agent, ifRevision: number | undefined, cause: string, command: DagReducerCommand): DagReduceResult {
    const current = this.assertRevision(agent, ifRevision)
    const result = reduceDagState(current, command)
    if (result.state === current) return result
    let snapshot: DagState
    this.committing.add(agent.session)
    try {
      snapshot = agent.session.append('dag/state', { state: result.state }).data.state
    } finally {
      this.committing.delete(agent.session)
    }
    const committed = { ...result, state: snapshot }
    this.cancelStaleEffects(agent.session, snapshot)
    queueMicrotask(() => {
      agentEvents(this.ctx, agent).emit('dag/committed', {
        committed: {
          dispatcherSession: agent.id,
          revision: snapshot.revision,
          graphGeneration: snapshot.graphGeneration,
          cause,
          snapshot,
        },
      })
      if (this.disposed) return
      this.scheduleFlush(agent)
    })
    return committed
  }

  /** Read one mutation base and fail before other command validation on conflict. */
  private assertRevision(agent: Agent, ifRevision: number | undefined): DagState | null {
    this.assertLive(agent)
    const current = latestState(agent.session)
    const currentRevision = current?.revision ?? 0
    if (this.committing.has(agent.session) || (ifRevision !== undefined && ifRevision !== currentRevision)) {
      throw new DagStateError(`DAG revision conflict; current revision is ${currentRevision}`, 'dag-revision-conflict')
    }
    return current
  }

  /** Start one process-local FIFO pump for each node that has pending work. */
  private schedule(agent: Agent): void {
    if (this.disposed) return
    if (this.ctx.agents.get(agent.id) !== agent) return
    const state = latestState(agent.session)
    if (state === null) return
    let active = this.pumps.get(agent.session)
    if (active === undefined) {
      active = new Set()
      this.pumps.set(agent.session, active)
    }
    for (const node of state.nodes) {
      if (!node.commands.some(command => command.state !== 'settled') || active.has(node.id)) continue
      active.add(node.id)
      let reschedule = true
      const task = this.pump(agent, node.id)
        .catch((error: unknown) => {
          if (error instanceof DagPersistenceBarrierError) reschedule = false
          this.ctx.logger.warn(`DAG pump ${node.id} failed: ${errorText(error)}`)
        })
        .finally(() => {
          this.pumpTasks.delete(task)
          active.delete(node.id)
          if (reschedule && !this.disposed && this.ctx.agents.get(agent.id) === agent) {
            queueMicrotask(() => { this.schedule(agent) })
          }
        })
      this.pumpTasks.add(task)
    }
  }

  /** Reconcile and execute one node mailbox in FIFO order. */
  private async pump(agent: Agent, nodeId: DagNodeId): Promise<void> {
    while (!this.disposed && this.ctx.agents.get(agent.id) === agent) {
      const state = latestState(agent.session)
      const node = state?.nodes.find(row => row.id === nodeId)
      const command = node?.commands.find(row => row.state !== 'settled')
      if (state === null || node === undefined || command === undefined) return
      if (command.state === 'accepted') {
        this.mutate(agent, undefined, `${command.kind}-running`, {
          type: 'command-running',
          nodeId,
          commandId: command.id,
          generation: command.generation,
          bindingGeneration: command.bindingGeneration,
          operationId: command.operationId,
        })
      }
      try {
        await this.ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        throw new DagPersistenceBarrierError(error)
      }
      if (!this.canRun(agent)) return
      this.requireCurrentCommand(agent, nodeId, command)
      const controller = new AbortController()
      const effectKey = Symbol(`${agent.id}:${nodeId}:${command.id}`)
      this.effects.set(effectKey, { controller, session: agent.session, nodeId, commandId: command.id })
      try {
        await this.executeCommand(agent, node, command, controller.signal)
      } catch (error) {
        if (!this.canRun(agent)) return
        const currentNode = latestState(agent.session)?.nodes.find(row => row.id === nodeId)
        if (controller.signal.aborted && currentNode?.status === 'interrupted') {
          this.mutate(agent, undefined, `${command.kind}-cancelled`, {
            type: 'command-settled', nodeId, commandId: command.id, generation: command.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId,
          })
        } else {
          this.mutate(agent, undefined, `${command.kind}-failed`, {
            type: 'command-failed', nodeId, commandId: command.id, generation: command.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId, reason: errorText(error),
          })
        }
      } finally {
        this.effects.delete(effectKey)
      }
    }
  }

  /** Return whether this activation can still run DAG effects. */
  private canRun(agent: Agent): boolean {
    return !this.disposed && this.ctx.agents.get(agent.id) === agent
  }

  /** Execute one durable mailbox command. */
  private async executeCommand(
    dispatcher: Agent,
    nodeAtStart: DagNodeSnapshot,
    command: DagNodeSnapshot['commands'][number],
    signal: AbortSignal,
  ): Promise<void> {
    if (command.kind === 'dispatch' || command.kind === 'resume'
      || (command.kind === 'steer' && nodeAtStart.status === 'starting')) {
      await this.prepareAndStart(dispatcher, nodeAtStart, command, signal)
      return
    }
    if (command.kind === 'steer') {
      if (nodeAtStart.childSessionId === undefined) throw new Error('steer requires an existing child')
      if (command.message === undefined) throw new Error('steer requires a replacement message')
      await this.ctx.subagents.redirect(dispatcher, nodeAtStart.childSessionId, [{ type: 'text', text: command.message }], {
        source: { kind: 'agent-message', form: 'relay', senderSessionId: dispatcher.id },
        messageId: MessageId(`${command.id}-message`),
        cause: { kind: 'parent' },
        signal,
      })
      signal.throwIfAborted()
      const commandAfterRedirect = this.requireState(dispatcher).nodes.find(row => row.id === nodeAtStart.id)
        ?.commands.find(row => row.id === command.id)
      if (commandAfterRedirect?.state === 'settled') return
      this.requireCurrentCommand(dispatcher, nodeAtStart.id, command)
      this.finishSteer(dispatcher, nodeAtStart.id, command.id, command.generation, command.operationId)
      return
    }
    if (command.kind === 'stop') {
      if (nodeAtStart.childSessionId !== undefined) this.ctx.subagents.interrupt(nodeAtStart.childSessionId, { kind: 'ancestor', agent: dispatcher })
      this.mutate(dispatcher, undefined, 'stop-succeeded', {
        type: 'command-settled', nodeId: nodeAtStart.id, commandId: command.id, generation: command.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId,
      })
      return
    }
    if (command.kind === 'reset') {
      if (command.target === undefined) throw new Error('reset requires a target')
      const result = await this.git.reset(nodeAtStart, command.target, signal)
      signal.throwIfAborted()
      this.requireCurrentCommand(dispatcher, nodeAtStart.id, command)
      const detail = result.remainingDirt.length === 0
        ? `Reset to ${result.targetCommit}; worktree is clean.`
        : `Reset to ${result.targetCommit}; preserved remaining dirt: ${result.remainingDirt.join(', ')}`
      this.mutate(dispatcher, undefined, 'reset-succeeded', {
        type: 'command-settled', nodeId: nodeAtStart.id, commandId: command.id, generation: command.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId, detail,
      })
      return
    }
    const commit = await this.git.validateCompletion(nodeAtStart, signal)
    signal.throwIfAborted()
    this.requireCurrentCommand(dispatcher, nodeAtStart.id, command)
    this.mutate(dispatcher, undefined, 'completion-succeeded', {
      type: 'completion-succeeded',
      nodeId: nodeAtStart.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
      evidence: { commit },
    })
  }

  /** Prepare frozen Git state and deliver one dispatch or resume command idempotently. */
  private async prepareAndStart(
    dispatcher: Agent,
    nodeAtStart: DagNodeSnapshot,
    command: DagNodeSnapshot['commands'][number],
    signal: AbortSignal,
  ): Promise<void> {
    if (nodeAtStart.frozenWaveBase === undefined) await this.ensureWave(dispatcher, nodeAtStart, signal)
    const state = this.requireState(dispatcher)
    const node = state.nodes.find(row => row.id === nodeAtStart.id)
    if (node === undefined || node.branch === undefined || node.worktree === undefined || node.childSessionId === undefined) {
      throw new Error('starting node lacks committed Git and child identities')
    }
    const base = node.frozenWaveBase
    if (base === undefined) throw new Error('starting node lacks the frozen wave base')
    if (command.kind === 'dispatch' || nodeAtStart.frozenWaveBase === undefined) {
      const wave = state.waves.find(row => row.id === node.waveId)
      if (wave?.status !== 'open' || wave.rootHead !== base || !wave.nodeIds.includes(node.id)) {
        throw new Error('starting node does not have an open frozen wave')
      }
    }
    if (node.dependencyCommits.length !== node.deps.length) throw new Error('starting node lacks exact dependency commits')
    const root = dispatcher.session.header.cwd
    if (root === undefined) throw new Error('DAG dispatcher session has no cwd')
    let prepared: DagPreparedWorktree
    if (node.preparedHead === undefined) {
      prepared = await this.git.prepare(root, node, node.branch, node.worktree, base, node.dependencyCommits, signal)
    } else {
      await this.git.verifyPrepared(root, node, signal)
      prepared = {
        branch: node.branch,
        worktree: node.worktree,
        head: node.preparedHead,
        dependencyCommits: node.dependencyCommits,
        conflictedFiles: node.conflictedFiles,
      }
    }
    signal.throwIfAborted()
    if (node.preparedHead === undefined) {
      this.mutate(dispatcher, undefined, 'git-prepared', {
        type: 'git-prepared',
        nodeId: node.id,
        commandId: command.id,
        generation: command.generation,
        bindingGeneration: command.bindingGeneration,
        operationId: command.operationId,
        evidence: {
          branch: prepared.branch,
          worktree: prepared.worktree,
          frozenWaveBase: base,
          preparedHead: prepared.head,
          dependencyCommits: prepared.dependencyCommits,
          conflictedFiles: prepared.conflictedFiles,
          childSessionId: node.childSessionId,
        },
      })
      await this.ctx.sessions.flush(dispatcher.session)
      signal.throwIfAborted()
    }
    this.requireCurrentCommand(dispatcher, node.id, command)
    const instruction = command.kind === 'dispatch' ? undefined : command.message
    await this.deliverStart(
      dispatcher,
      node,
      command,
      node.childSessionId,
      prepared.branch,
      prepared.worktree,
      base,
      prepared.head,
      prepared.dependencyCommits,
      prepared.conflictedFiles,
      signal,
      instruction,
    )
  }

  /** Run one shared root probe and commit its result before node preparation. */
  private async ensureWave(dispatcher: Agent, node: DagNodeSnapshot, signal: AbortSignal): Promise<void> {
    if (node.waveId === undefined) throw new Error('starting node lacks a wave')
    const waveId = node.waveId
    const state = this.requireState(dispatcher)
    const wave = state.waves.find(row => row.id === waveId)
    if (wave?.status === 'open' && wave.nodeIds.includes(node.id)) return
    if (wave !== undefined) throw new Error(`wave ${node.waveId} does not contain active node ${node.id}`)
    const key = `${dispatcher.id}:${waveId}`
    let probe = this.waveProbes.get(key)
    if (probe !== undefined && probe.agent !== dispatcher) {
      probe.controller.abort(new Error('DAG dispatcher activation changed'))
      this.waveProbes.delete(key)
      probe = undefined
    }
    if (probe === undefined) {
      const fences = waveFences(state, waveId)
      if (fences.length === 0) throw new Error(`wave ${waveId} has no active dispatch commands`)
      const controller = new AbortController()
      const promise = (async () => {
        try {
          const root = dispatcher.session.header.cwd
          if (root === undefined) throw new Error('DAG dispatcher session has no cwd')
          const result = await this.git.probeRoot(root, controller.signal)
          controller.signal.throwIfAborted()
          this.mutate(dispatcher, undefined, 'wave-probed', { type: 'wave-probed', waveId, fences, branch: result.branch, head: result.head })
          await this.ctx.sessions.flush(dispatcher.session)
        } catch (error) {
          if (!this.disposed && this.ctx.agents.get(dispatcher.id) === dispatcher) {
            this.mutate(dispatcher, undefined, 'wave-probe-failed', { type: 'wave-probe-failed', waveId, fences, reason: errorText(error) })
          }
          throw error
        } finally {
          if (this.waveProbes.get(key)?.controller === controller) this.waveProbes.delete(key)
        }
      })()
      probe = { controller, promise, agent: dispatcher, fences, waiters: 0 }
      this.waveProbes.set(key, probe)
    }
    probe.waiters++
    try {
      await waitForShared(probe.promise, signal)
    } finally {
      probe.waiters--
      if (probe.waiters === 0
        && this.waveProbes.get(key) === probe
        && !hasActiveFence(latestState(dispatcher.session), probe.fences)) {
        probe.controller.abort(new Error('DAG wave has no active node effects'))
      }
    }
  }

  /** Materialize a child with deterministic identities and no generic settlement delivery. */
  private async deliverStart(
    dispatcher: Agent,
    node: DagNodeSnapshot,
    command: DagNodeSnapshot['commands'][number],
    childSessionId: SessionIdType,
    branch: string,
    worktree: string,
    base: string,
    preparedHead: string,
    dependencyCommits: readonly string[],
    conflicts: readonly string[],
    signal: AbortSignal,
    instruction?: string,
  ): Promise<void> {
    const metadata = {
      version: 1,
      dispatcherSessionId: dispatcher.id,
      nodeId: node.id,
    } satisfies Record<string, JsonValue>
    const owner: SubagentOwnerBinding = { controller: 'dag', metadata }
    const messageId = MessageId(`${command.id}-message`)
    const brief = this.nodePrompt(node, worktree, dependencyCommits, conflicts)
    const prompt = instruction === undefined ? brief : `${brief}\n\nResume instruction: ${instruction}`
    const child = this.ctx.agents.get(childSessionId)
    if (child !== undefined && !messageRecorded(child, messageId)) {
      await this.ctx.subagents.followup(dispatcher, childSessionId, [{ type: 'text', text: prompt }], {
        source: { kind: 'agent-message', form: 'relay', senderSessionId: dispatcher.id },
        messageId,
        signal,
      })
    } else if (child === undefined) {
      try {
        await this.ctx.subagents.followup(dispatcher, childSessionId, [{ type: 'text', text: prompt }], {
          source: { kind: 'agent-message', form: 'relay', senderSessionId: dispatcher.id },
          messageId,
          signal,
        })
      } catch (error: unknown) {
        if (!(error instanceof SubagentError) || error.code !== 'NOT_RESUMABLE') throw error
        await this.ctx.subagents.startContinuable({
          provider: this.config.subagentProvider,
          label: `DAG: ${node.content}`,
          childId: childSessionId,
          messageId,
          cwd: worktree,
          owner,
          settlementDelivery: 'none',
          request: { parent: dispatcher, prompt: [{ type: 'text', text: prompt }] },
          signal,
        })
      }
    }
    signal.throwIfAborted()
    this.requireCurrentCommand(dispatcher, node.id, command)
    this.mutate(dispatcher, undefined, 'start-succeeded', {
      type: 'start-succeeded', nodeId: node.id, commandId: command.id, generation: command.generation, bindingGeneration: command.bindingGeneration, operationId: command.operationId,
      evidence: { branch, worktree, frozenWaveBase: base, preparedHead, dependencyCommits, conflictedFiles: conflicts, childSessionId },
    })
  }

  /** Build the child execution brief. */
  private nodePrompt(node: DagNodeSnapshot, worktree: string, dependencyCommits: readonly string[], conflicts: readonly string[]): string {
    const conflictText = conflicts.length === 0 ? '' : `\nConflicted files for manual integration: ${conflicts.join(', ')}.`
    return `You own DAG node ${node.id}: ${node.content}\n\n${node.brief}\n\nWork only in ${worktree}. Dependency commits: ${dependencyCommits.join(', ') || 'none'}.${conflictText}\nUse dag_node_complete only after you commit clean accepted work. Use dag_node_block when you cannot continue. A stop cancels your current turn. Steering cancels and replaces current work.`
  }

  /** Inject each pending notice once, then resolve a matching waiter. */
  private deliverNotices(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) return
    let state = latestState(agent.session)
    if (state === null) return
    for (const notice of state.notices) {
      if (notice.delivered) continue
      if (!noticeRecorded(agent, notice.id)) {
        const message: UserMessage = freezeMessage({
          id: MessageId(`dag-notice-${notice.id}`),
          role: 'user',
          content: [{ type: 'text', text: notice.text }],
          source: { kind: 'dag-notice', form: 'notice', noticeId: notice.id, summary: notice.text },
        })
        agent.inject(message)
      }
      this.mutate(agent, undefined, 'notice-delivered', { type: 'notice-delivered', noticeId: notice.id })
      state = requiredValue(
        latestState(agent.session),
        new DagStateError('notice delivery lost the committed DAG state', 'dag-invalid-state'),
      )
    }
    const waiter = this.waiters.get(agent.session)
    if (waiter === undefined) return
    const notices = actionable(state, waiter.afterRevision)
    if (notices.length === 0) return
    this.waiters.delete(agent.session)
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve({ revision: state.revision, notices, state: projectDag(state) })
  }

  /** Reconcile durable commands and notices when a dispatcher session starts. */
  private reconcile(agent: Agent): void {
    const state = latestState(agent.session)
    if (state === null) return
    queueMicrotask(() => {
      if (this.disposed) return
      this.schedule(agent)
      try {
        this.deliverNotices(agent)
      } catch (error: unknown) {
        this.ctx.logger.warn(`DAG notice reconciliation failed: ${errorText(error)}`)
      }
    })
  }

  /** Cancel effects whose generation or operation no longer owns the node. */
  private cancelStaleEffects(session: Session, state: DagState): void {
    for (const effect of this.effects.values()) {
      if (effect.session !== session) continue
      const node = state.nodes.find(row => row.id === effect.nodeId)
      const command = node?.commands.find(row => row.id === effect.commandId)
      if (command === undefined || command.state === 'settled' || node?.currentOperationId !== command.operationId || node.generation !== command.generation) {
        effect.controller.abort(new Error('DAG effect fence changed'))
      }
    }
  }

  /** Cross the persistence barrier before scheduling effects or notice delivery. */
  private async flushAndSchedule(agent: Agent): Promise<void> {
    try {
      await this.ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(`DAG session flush failed: ${errorText(error)}`)
      return
    }
    if (this.disposed || this.ctx.agents.get(agent.id) !== agent) return
    this.schedule(agent)
    this.deliverNotices(agent)
  }

  /** Track one persistence barrier through service disposal. */
  private scheduleFlush(agent: Agent): void {
    if (this.disposed) return
    const task = this.flushAndSchedule(agent)
      .catch((error: unknown) => {
        this.ctx.logger.warn(`DAG post-commit scheduling failed: ${errorText(error)}`)
      })
      .finally(() => { this.flushTasks.delete(task) })
    this.flushTasks.add(task)
  }

  /** Require that one asynchronous command still owns its node. */
  private requireCurrentCommand(
    dispatcher: Agent,
    nodeId: DagNodeId,
    command: DagNodeSnapshot['commands'][number],
  ): void {
    const node = this.requireState(dispatcher).nodes.find(row => row.id === nodeId)
    const current = node?.commands.find(row => row.id === command.id)
    if (node === undefined || current === undefined || current.state === 'settled'
      || node.generation !== command.generation
      || node.bindingGeneration !== command.bindingGeneration
      || node.currentOperationId !== command.operationId) {
      throw new Error('DAG command fence changed during its effect')
    }
  }

  /** Owner hook for Web and generic interrupt calls. */
  private ownerStop(request: SubagentOwnerStopRequest): void {
    const metadata = ownerMetadata(request.binding)
    const dispatcher = this.liveDispatcher(metadata.dispatcherSessionId)
    const state = this.requireState(dispatcher)
    const node = state.nodes.find(row => row.id === metadata.nodeId)
    if (node === undefined) throw new DagStateError(`unknown DAG node ${JSON.stringify(metadata.nodeId)}`, 'dag-node-not-found')
    if (node.childSessionId !== request.child.id) {
      throw new DagStateError('DAG child binding is stale', 'dag-stale-child-binding')
    }
    let operationId = node.currentOperationId
    let generation = node.generation
    let commandId = node.commands.find(row => row.operationId === operationId && row.kind === 'stop' && row.state !== 'settled')?.id
    if (node.status !== 'interrupted') {
      const accepted = this.stop(dispatcher, node.id, request.authority.kind === 'user' ? 'Stopped by a user.' : 'Stopped by the dispatcher.')
      const next = requiredValue(
        this.requireState(dispatcher).nodes.find(row => row.id === node.id),
        new DagStateError('accepted DAG stop lost its node', 'dag-invalid-state'),
      )
      operationId = accepted.operationId
      generation = next.generation
      commandId = requiredValue(
        next.commands.find(row => row.operationId === operationId),
        new DagStateError('accepted DAG stop lacks its mailbox command', 'dag-invalid-state'),
      ).id
    }
    request.stop()
    if (operationId !== undefined && commandId !== undefined) {
      const currentNode = requiredValue(
        this.requireState(dispatcher).nodes.find(row => row.id === node.id),
        new DagStateError('accepted DAG stop lost its node', 'dag-invalid-state'),
      )
      const bindingGeneration = currentNode.bindingGeneration
      this.mutate(dispatcher, undefined, 'stop-delivered', { type: 'command-settled', nodeId: node.id, commandId, generation, bindingGeneration, operationId })
    }
  }

  /** Mark an admitted replacement turn as the current node turn. */
  private finishSteer(
    dispatcher: Agent,
    nodeId: DagNodeId,
    commandId: import('./types.ts').DagCommandId,
    generation: number,
    operationId: DagOperationId,
  ): void {
    const node = this.requireState(dispatcher).nodes.find(row => row.id === nodeId)
    if (node === undefined || node.childSessionId === undefined || node.branch === undefined || node.worktree === undefined
      || node.frozenWaveBase === undefined || node.preparedHead === undefined) {
      throw new Error('steer requires a prepared child binding')
    }
    this.mutate(dispatcher, undefined, 'steer-succeeded', {
      type: 'start-succeeded',
      nodeId,
      commandId,
      generation,
      bindingGeneration: node.bindingGeneration,
      operationId,
      evidence: {
        branch: node.branch,
        worktree: node.worktree,
        frozenWaveBase: node.frozenWaveBase,
        preparedHead: node.preparedHead,
        dependencyCommits: node.dependencyCommits,
        conflictedFiles: node.conflictedFiles,
        childSessionId: node.childSessionId,
      },
    })
  }

  /** Resolve the dispatcher and validate child metadata. */
  private dispatcherFor(child: Agent): { readonly dispatcher: Agent; readonly metadata: DagOwnerMetadata } {
    if (this.ctx.agents.get(child.id) !== child) throw new DagStateError('DAG child is not the exact live Agent', 'dag-child-not-live')
    const descriptor = [...child.session.snapshotEvents()].reverse().find(event => event.type === 'subagent/descriptor')
    if (descriptor?.type !== 'subagent/descriptor' || descriptor.data.mode !== 'continuable' || descriptor.data.owner?.controller !== 'dag') {
      throw new DagStateError('child has no durable DAG owner metadata', 'dag-child-owner-missing')
    }
    const metadata = ownerMetadata(descriptor.data.owner)
    // proxy-exempt: `dispatcher` names the Agent that dispatches DAG nodes, not a fetch transport option.
    return { dispatcher: this.liveDispatcher(metadata.dispatcherSessionId), metadata }
  }

  /** Require the latest binding generation for a child command. */
  private assertBinding(
    dispatcher: Agent,
    metadata: DagOwnerMetadata,
    childSessionId: SessionIdType,
  ): DagNodeSnapshot {
    const node = this.requireState(dispatcher).nodes.find(row => row.id === metadata.nodeId)
    if (node === undefined || node.childSessionId !== childSessionId) {
      throw new DagStateError('DAG child binding is stale', 'dag-stale-child-binding')
    }
    return node
  }

  /** Require a child report to come from work admitted for the current node generation. */
  private assertCurrentChildTurn(node: DagNodeSnapshot, child: Agent): void {
    const current = node.commands.find(command => command.operationId === node.currentOperationId
      && command.generation === node.generation
      && command.bindingGeneration === node.bindingGeneration)
    if (current === undefined) {
      throw new DagStateError('DAG child turn has no current command binding', 'dag-stale-child-turn')
    }
    const events = child.session.snapshotEvents()
    const boundaryIndex = events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
    const boundary = events[boundaryIndex]
    if (boundary?.type !== 'turn/start') {
      throw new DagStateError('DAG child report requires an active turn', 'dag-stale-child-turn')
    }
    const turnMessageIds = new Set(events.slice(boundaryIndex + 1).flatMap(event =>
      event.type === 'user/message' ? [event.data.id] : []))
    const commandsInTurn = node.commands.filter(command => turnMessageIds.has(MessageId(`${command.id}-message`)))
    if (commandsInTurn.some(command => command.id === current.id)) return
    if (commandsInTurn.length > 0) {
      throw new DagStateError('DAG child report came from an invalidated turn', 'dag-stale-child-turn')
    }
    const currentMessageIndex = events.findIndex(event => event.type === 'user/message'
      && event.data.id === MessageId(`${current.id}-message`))
    if (currentMessageIndex < 0) {
      throw new DagStateError('DAG child report came from an invalidated turn', 'dag-stale-child-turn')
    }
  }

  /** Resolve an exact live dispatcher by durable session identity. */
  private liveDispatcher(sessionId: SessionIdType): Agent {
    const dispatcher = this.ctx.agents.get(sessionId)
    if (dispatcher === undefined) throw new DagStateError(`DAG dispatcher ${JSON.stringify(sessionId)} is not live`, 'dag-dispatcher-not-live')
    return dispatcher
  }

  /** Require one declared state. */
  private requireState(agent: Agent): DagState {
    const state = this.state(agent)
    if (state === null) throw new DagStateError('DAG has no declaration', 'dag-not-declared')
    return state
  }

  /** Require exact live-Agent identity. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new DagStateError(`agent ${JSON.stringify(agent.id)} is not live`, 'dag-agent-not-live')
  }

  /** Return the deterministic child session id for one node. */
  private childSessionId(dispatcherSessionId: SessionIdType, graphGeneration: number, nodeId: DagNodeId): SessionIdType {
    return SessionId(`dag-${dispatcherHash(dispatcherSessionId)}-g${graphGeneration}-${shortHash(nodeId)}`)
  }
}

/**
 * Return the last state event without a process-local mirror.
 * @param session - Dispatcher session log.
 * @returns Latest complete state, or null before the first declaration.
 */
export function latestState(session: Session): DagState | null {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'dag/state') return event.data.state
  }
  return null
}

export default DagService
