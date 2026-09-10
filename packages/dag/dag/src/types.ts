/** Durable and wire-safe types for native DAG orchestration. @module @deepseek-ai/dsh-dag/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Identifies a declared DAG node. */
export type DagNodeId = Branded<'DagNodeId'>
/** Identifies one accepted DAG operation. */
export type DagOperationId = Branded<'DagOperationId'>
/** Identifies one durable node command. */
export type DagCommandId = Branded<'DagCommandId'>
/** Identifies one dispatch wave. */
export type DagWaveId = Branded<'DagWaveId'>
/** Identifies one durable dispatcher notice. */
export type DagNoticeId = Branded<'DagNoticeId'>

/** Format version of a complete `dag/state` value. */
export const DAG_STATE_VERSION = 1

/** Durable node lifecycle state. */
export type DagNodeStatus =
  | 'pending'
  | 'starting'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'interrupted'

/** Work performed by a node. */
export type DagNodeKind = 'task' | 'integration'
/** Conflict policy for an integration node. */
export type DagIntegrationPolicy = 'delegate' | 'ours' | 'theirs'

/** Immutable model declaration of one node. */
export interface DagNodeDefinition {
  readonly id: DagNodeId
  readonly content: string
  readonly brief: string
  readonly deps: readonly DagNodeId[]
  readonly kind: DagNodeKind
  readonly policy: DagIntegrationPolicy
  readonly files: readonly string[]
}

/** Completion or suspension data written by a child. */
export type DagNodeSettlement =
  | { readonly kind: 'completed'; readonly summary: string; readonly artifacts: readonly JsonValue[] }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'interrupted'; readonly reason: string }

/** Operation placed in one node's durable FIFO mailbox. */
export interface DagNodeCommand {
  readonly id: DagCommandId
  readonly operationId: DagOperationId
  readonly kind: 'dispatch' | 'resume' | 'steer' | 'stop' | 'reset' | 'complete'
  readonly state: 'accepted' | 'running' | 'settled'
  readonly generation: number
  readonly bindingGeneration: number
  readonly message?: string
  readonly target?: string
  readonly acceptedRevision: number
  readonly outcome?: 'succeeded' | 'failed' | 'cancelled'
  readonly detail?: string
  readonly error?: string
}

/** Full durable execution card for one node. */
export interface DagNodeSnapshot extends DagNodeDefinition {
  readonly status: DagNodeStatus
  readonly generation: number
  readonly bindingGeneration: number
  readonly childSessionId?: SessionId
  readonly branch?: string
  readonly worktree?: string
  readonly waveId?: DagWaveId
  readonly frozenWaveBase?: string
  /** Exact worktree HEAD after deterministic dependency preparation. */
  readonly preparedHead?: string
  readonly dependencyCommits: readonly string[]
  readonly conflictedFiles: readonly string[]
  readonly currentOperationId?: DagOperationId
  readonly settlement?: DagNodeSettlement
  readonly completedCommit?: string
  readonly commands: readonly DagNodeCommand[]
}

/** Root Git evidence frozen for a group of node starts. */
export interface DagWaveSnapshot {
  readonly id: DagWaveId
  readonly nodeIds: readonly DagNodeId[]
  readonly rootBranch: string
  readonly rootHead: string
  readonly status: 'open' | 'settled'
  readonly pendingNodeIds: readonly DagNodeId[]
  readonly completedNodeIds: readonly DagNodeId[]
  readonly failedNodeIds: readonly DagNodeId[]
}

/** Durable acknowledgement of one accepted operation. */
export interface DagOperationReceipt {
  readonly id: DagOperationId
  readonly cause: string
  readonly acceptedRevision: number
  readonly nodeIds: readonly DagNodeId[]
}

/** Durable notification for a dispatcher. */
export interface DagNotice {
  readonly id: DagNoticeId
  readonly kind: 'node-failed' | 'node-blocked' | 'node-interrupted' | 'node-completed' | 'wave-settled'
  readonly revision: number
  readonly graphGeneration: number
  readonly nodeId?: DagNodeId
  readonly waveId?: DagWaveId
  readonly text: string
  readonly delivered: boolean
  /** Snapshot revision that recorded injection into the dispatcher inbox. */
  readonly deliveredRevision?: number
}

/** Status totals stored in every state value. */
export type DagStatusCounts = Readonly<Record<DagNodeStatus, number>>

/** Complete authoritative DAG state written on each accepted change. */
export interface DagState {
  readonly version: number
  /** Stable dispatcher namespace used in deterministic notice identities. */
  readonly noticeNamespace: string
  readonly revision: number
  readonly graphGeneration: number
  readonly operationCounter: number
  readonly nodes: readonly DagNodeSnapshot[]
  readonly topologicalOrder: readonly DagNodeId[]
  readonly readyNodeIds: readonly DagNodeId[]
  readonly counts: DagStatusCounts
  readonly waves: readonly DagWaveSnapshot[]
  readonly activeCommandIds: readonly DagCommandId[]
  readonly receipts: readonly DagOperationReceipt[]
  readonly notices: readonly DagNotice[]
}

/** Safe node row sent to browser clients. */
export interface DagProjectionNode {
  readonly id: DagNodeId
  readonly content: string
  readonly deps: readonly DagNodeId[]
  readonly kind: DagNodeKind
  readonly policy: DagIntegrationPolicy
  readonly files: readonly string[]
  readonly status: DagNodeStatus
  readonly generation: number
  readonly branch?: string
  readonly waveId?: DagWaveId
  readonly dependencyCommits: readonly string[]
  readonly conflictedFiles: readonly string[]
  readonly settlement?: DagNodeSettlement
  readonly completedCommit?: string
}

/** Read-only browser view derived from one state value. */
export interface DagProjection {
  readonly revision: number
  readonly graphGeneration: number
  readonly nodes: readonly DagProjectionNode[]
  readonly counts: DagStatusCounts
  readonly readyNodeIds: readonly DagNodeId[]
  readonly openWaves: readonly DagWaveSnapshot[]
}

/** Compare-and-set field accepted by mutating calls. */
export interface DagRevisionGuard {
  readonly if_revision?: number
}

/** A model declaration record before canonical validation. */
export interface DagNodeInput {
  readonly id: string
  readonly content: string
  readonly brief: string
  readonly deps: readonly string[]
  readonly status: DagNodeStatus
  readonly kind?: DagNodeKind
  readonly policy?: DagIntegrationPolicy
  readonly files?: readonly string[]
}

/** Full-list declaration request. */
export interface DagWriteRequest extends DagRevisionGuard {
  readonly nodes: readonly DagNodeInput[]
}

/** Accepted asynchronous command acknowledgement. */
export interface DagCommandAccepted {
  readonly accepted: true
  readonly revision: number
  readonly operationId: DagOperationId
}

/** Full-list declaration response. */
export interface DagWriteResult extends DagCommandAccepted {
  readonly dropped: readonly {
    readonly id: DagNodeId
    readonly childSessionId?: SessionId
    readonly branch?: string
    readonly worktree?: string
  }[]
  readonly conflicts: readonly {
    readonly ids: readonly [DagNodeId, DagNodeId]
    readonly files: readonly string[]
    readonly reason: 'declared-files-overlap' | 'contract-pin-overlap'
  }[]
}

/** A successful state change published after its append. */
export interface DagCommitted {
  readonly dispatcherSession: SessionId
  readonly revision: number
  readonly graphGeneration: number
  readonly cause: string
  readonly snapshot: DagState
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One complete immutable native DAG state value. */
    'dag/state': { readonly state: DagState }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    dag: DagProjection | null
  }
  interface SessionProjectionMap {
    /** Current native DAG board, or null before the first write. */
    dag: DagProjection | null
  }
}
