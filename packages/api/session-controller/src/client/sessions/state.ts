/**
 * Client Session store vocabulary: the list row, its arrival phase, the
 * projection snapshot, and the logical binding shared by the sessions service
 * (which produces them) and the outward sessions contract (which reads them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEventSource } from '../contract/events.ts'
import type { SessionFace } from '../contract/session.ts'
import type { AgentContext } from '../scope.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  /** Host running state for `ids` members; a display fallback for other rows. */
  running: boolean
  /**
   * Local ownership counts; Host metadata refreshes cannot overwrite them.
   * Source keys declaration-merge on the package entry point, which re-exports
   * this leaf, so the counts stay structural instead of importing back into it.
   */
  readonly retainedBy: Readonly<Partial<Record<string, number>>>
  /**
   * New Session presentation and reuse eligibility, derived from the Host
   * summary, `sessionListMetadata`, and client acceptance/running observations.
   * New Session reuses a blank one targeting the same workspace. Filtering
   * stays with the consumer: the store carries every row, while the Workspace
   * browser shows only the selected blank entry.
   */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** Shared projection values and the lifecycle of their explicit baseline read. */
export interface SessionProjectionSnapshot {
  readonly values: Readonly<Partial<SessionProjectionMap>>
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: RemoteFailure | null
}

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** Catalog metadata and local source counts; catalog membership owns no Client generation. */
export interface SessionListState {
  /** Host list order; every id has a matching byId row in the same snapshot. */
  ids: SessionId[]
  /** Host/catalog rows plus retained subagent fallbacks; only `ids` expresses Host-list membership. */
  byId: Record<SessionId, SessionSummary>
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  /** Shared projection values and explicit-read state, including unopened Sessions. */
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
}

/** Identity-stable logical binding for one materialized Client Session. */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  /** Contiguous event window reserved for Conversation assembly. */
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
