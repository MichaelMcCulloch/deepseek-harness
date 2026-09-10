/** Pure and asynchronous runtime helpers for the native DAG service. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { SubagentOwnerBinding } from '@deepseek-ai/dsh-subagent'
import { DagStateError } from './reducer.ts'
import type { DagEffectFence, DagReduceResult } from './reducer.ts'
import type {
  DagNodeId,
  DagNotice,
  DagNoticeId,
  DagOperationId,
  DagState,
  DagWaveId,
} from './types.ts'

/** Parsed owner metadata for one DAG child binding. */
export interface DagOwnerMetadata {
  readonly version: 1
  readonly dispatcherSessionId: SessionIdType
  readonly nodeId: DagNodeId
}

/** Deployment choices accepted by the local DAG runtime. */
export interface DagRuntimeConfig {
  /** Optional DSH home. A blank value uses normal DSH_HOME resolution. */
  readonly dshHome?: string
  /** Git executable name or absolute path. */
  readonly gitExecutable?: string
  /** Deadline for each Git process. */
  readonly commandDeadlineMs?: number
  /** TERM-to-KILL grace for each Git process. */
  readonly terminationGraceMs?: number
  /** Per-stream collected Git output limit. */
  readonly outputLimitBytes?: number
  /** Continuable in-process provider used for DAG children. */
  readonly subagentProvider?: string
}

/**
 * Resolve and validate every deployment choice once during service construction.
 * @param config - Deployment choices from the DAG plugin configuration.
 * @returns the complete validated runtime configuration.
 */
export function resolveDagConfig(config: DagRuntimeConfig): Required<DagRuntimeConfig> {
  return {
    dshHome: resolveDshHome(config.dshHome?.trim() || undefined),
    gitExecutable: nonEmpty(config.gitExecutable ?? 'git', 'gitExecutable'),
    commandDeadlineMs: positiveInteger(config.commandDeadlineMs ?? 120_000, 'commandDeadlineMs'),
    terminationGraceMs: positiveInteger(config.terminationGraceMs ?? 5_000, 'terminationGraceMs'),
    outputLimitBytes: positiveInteger(config.outputLimitBytes ?? 8 * 1024 * 1024, 'outputLimitBytes'),
    subagentProvider: nonEmpty(config.subagentProvider ?? 'spawn', 'subagentProvider'),
  }
}

/**
 * Extract a required operation identity from an accepted reduction.
 * @param result - Accepted reducer result that must contain an operation identity.
 * @returns the operation identity.
 */
export function requiredOperation(result: DagReduceResult): DagOperationId {
  if (result.operationId === undefined) throw new DagStateError('accepted DAG command lacks an operation id', 'dag-invalid-state')
  return result.operationId
}

/**
 * Return notices whose injection follows the requested revision.
 * @param state - Current authoritative DAG state.
 * @param afterRevision - Last revision observed by the caller.
 * @returns delivered notices from later revisions.
 */
export function actionable(state: DagState, afterRevision: number): readonly DagNotice[] {
  return state.notices.filter(notice => notice.delivered
    && (notice.deliveredRevision ?? notice.revision) > afterRevision)
}

/**
 * Validate a positive safe integer configuration value.
 * @param value - Configuration value to validate.
 * @param name - Configuration field name used in diagnostics.
 * @returns the validated value.
 */
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

/**
 * Validate and trim a required string.
 * @param value - Configuration value to validate.
 * @param name - Configuration field name used in diagnostics.
 * @returns the trimmed non-empty value.
 */
export function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${name} must be non-empty`)
  return trimmed
}

/**
 * Return one required value or throw its caller-owned diagnostic.
 * @param value - Value that must be present.
 * @param error - Error to throw when the value is absent.
 * @returns the present value.
 */
export function requiredValue<T>(value: T | null | undefined, error: Error): T {
  if (value === undefined || value === null) throw error
  return value
}

/**
 * Render an unknown effect failure.
 * @param error - Rejected value from an effect.
 * @returns a diagnostic string.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Convert an unknown promise failure to an Error.
 * @param reason - Rejected value from a promise.
 * @param message - Diagnostic used when the rejected value is not an Error.
 * @returns the original Error or a new Error with the rejected value as its cause.
 */
export function asError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason })
}

/**
 * Extract ordinary text from an authorized redirect.
 * @param message - Authorized replacement message.
 * @returns the joined, trimmed text content.
 */
export function messageText(message: UserMessage): string {
  const text = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) throw new DagStateError('DAG steering requires text content', 'dag-invalid-message')
  return text
}

/**
 * Parse and validate durable owner metadata.
 * @param binding - Subagent owner binding from durable child metadata.
 * @returns validated DAG owner metadata.
 */
export function ownerMetadata(binding: SubagentOwnerBinding): DagOwnerMetadata {
  const value = binding.metadata
  const keys = value !== null && !Array.isArray(value) && typeof value === 'object'
    ? Object.keys(value)
    : []
  if (binding.controller !== 'dag' || value === null || Array.isArray(value) || typeof value !== 'object'
    || keys.length !== 3 || !keys.every(key => key === 'version' || key === 'dispatcherSessionId' || key === 'nodeId')
    || value['version'] !== 1 || typeof value['dispatcherSessionId'] !== 'string'
    || value['dispatcherSessionId'].length === 0 || typeof value['nodeId'] !== 'string' || value['nodeId'].length === 0) {
    throw new DagStateError('invalid durable DAG owner metadata', 'dag-invalid-owner')
  }
  return {
    version: 1,
    dispatcherSessionId: SessionId(value['dispatcherSessionId']),
    nodeId: value['nodeId'] as DagNodeId,
  }
}

/**
 * Check whether one deterministic inbox message reached a session event.
 * @param agent - Child agent that owns the inbox and session.
 * @param messageId - Deterministic message identity.
 * @returns whether the message is pending or recorded in the session.
 */
export function messageRecorded(agent: Agent, messageId: MessageId): boolean {
  return agent.inbox.nextTurn.some(message => message.id === messageId)
    || agent.inbox.nextStep.some(message => message.id === messageId)
    || agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === messageId)
}

/**
 * Check notice delivery against the live pending inbox and claimed session events.
 * @param agent - Dispatcher agent that receives DAG notices.
 * @param noticeId - Deterministic notice identity.
 * @returns whether the notice is pending or recorded in the session.
 */
export function noticeRecorded(agent: Agent, noticeId: DagNoticeId): boolean {
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  if (pending.some(message => message.source.kind === 'dag-notice' && message.source.noticeId === noticeId)) return true
  return agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.source.kind === 'dag-notice'
    && event.data.source.noticeId === noticeId)
}

/**
 * Capture every active dispatch fence assigned to one not-yet-created wave.
 * @param state - Current authoritative DAG state.
 * @param waveId - Reserved wave identity.
 * @returns active effect fences assigned to the wave.
 */
export function waveFences(state: DagState, waveId: DagWaveId): readonly DagEffectFence[] {
  return state.nodes.flatMap((node) => {
    if (node.waveId !== waveId || node.currentOperationId === undefined) return []
    const command = node.commands.find(row => row.operationId === node.currentOperationId
      && row.generation === node.generation
      && row.bindingGeneration === node.bindingGeneration
      && (row.kind === 'dispatch' || row.kind === 'resume' || row.kind === 'steer')
      && row.state !== 'settled')
    return command === undefined
      ? []
      : [{
        nodeId: node.id,
        commandId: command.id,
        generation: command.generation,
        bindingGeneration: command.bindingGeneration,
        operationId: command.operationId,
      }]
  })
}

/**
 * Return whether at least one captured effect fence still owns its node.
 * @param state - Current DAG state, or null before declaration.
 * @param fences - Previously captured effect fences.
 * @returns whether any fence still matches the active node operation.
 */
export function hasActiveFence(state: DagState | null, fences: readonly DagEffectFence[]): boolean {
  if (state === null) return false
  return fences.some((fence) => {
    const node = state.nodes.find(row => row.id === fence.nodeId)
    return node?.generation === fence.generation
      && node.bindingGeneration === fence.bindingGeneration
      && node.currentOperationId === fence.operationId
      && node.commands.some(command => command.id === fence.commandId && command.state !== 'settled')
  })
}

/**
 * Wait for a shared effect without giving one caller ownership of that effect.
 * @param promise - Shared effect promise.
 * @param signal - Caller cancellation signal.
 * @returns the shared result or the caller's cancellation failure.
 */
export function waitForShared<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(asError(signal.reason, 'shared DAG effect wait was aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error, 'shared DAG effect failed'))
      },
    )
  })
}
